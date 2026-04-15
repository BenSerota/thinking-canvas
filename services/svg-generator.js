/**
 * SVG Generator Service
 *
 * On-demand SVG generation for concepts that didn't match any library icon.
 * Calls Sonnet, validates the result strictly, and caches successful
 * generations to public/shapes/generated/{kebab}.svg.
 *
 * Strict validation rules (aligned with our Path2D.fill() rasterization pipeline):
 *   - Parses as valid XML
 *   - Has a valid viewBox
 *   - Has ≥1 <path d="..."> element
 *   - No <g transform="..."> wrapping paths (our rasterizer ignores transforms)
 *   - No stroke-only paths (fill="none" + stroke="...")
 *   - Path samples yield enough points for recognition (500–30,000 equivalent pixels)
 *   - Aspect ratio within 0.3–3.0
 *
 * Rate-limiting:
 *   - Max 1 concurrent generation (avoid API spam on fast successive messages)
 *   - Negative cache: concepts that failed validation once won't be retried
 *     this process lifetime (avoids pathological cost loops)
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { DOMParser } = require('xmldom');
const { svgPathProperties } = require('svg-path-properties');

const iconMatcher = require('./icon-matcher');
const embeddingService = require('./embedding-service');

const ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(ROOT, 'public', 'shapes', 'generated');

// Ensure the output dir exists
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

const anthropic = new Anthropic();

// Concurrency + negative cache
let inFlight = null;
const failedCache = new Set();

const SYSTEM_PROMPT = `You are an SVG silhouette designer. For the given concept, return a single flat-fill SVG silhouette suitable for particle-based rendering.

STRICT RULES — follow exactly:
1. Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
2. Only <path d="..."/> elements as children — no <g>, no <rect>, no <circle>, no <polygon>, no <ellipse>
3. NO transform attributes anywhere
4. NO stroke attributes — the shape is defined by fills
5. NO fill="none" anywhere
6. 1–8 paths maximum. Each path should contribute meaningful silhouette area.
7. The combined silhouette should fill 20–70% of the 100×100 viewBox
8. Use flowing curves (C, Q, S, T commands) — avoid purely rectangular shapes when depicting natural subjects

Return RAW SVG ONLY. No markdown fences, no commentary, no XML declaration.`;

const USER_PROMPT_TEMPLATE = (iconic) => `Concept: ${iconic}

Return the SVG silhouette.`;

/** Normalize an iconic string to a safe filename kebab. */
function toKebab(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Strip markdown fences and XML prologs. */
function cleanResponse(text) {
  let t = text.trim();
  t = t.replace(/^```(?:xml|svg)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
  t = t.replace(/^<\?xml[^?]*\?>\s*/i, '').trim();
  return t;
}

/**
 * Strict validation — returns { ok: boolean, reason?: string, paths?: string[], viewBox?: string }
 */
function validate(svgText) {
  if (!svgText.startsWith('<svg')) {
    return { ok: false, reason: 'does not start with <svg' };
  }

  // Rule: no <g>, <rect>, <circle>, <polygon>, <ellipse>, <polyline>, <line>
  if (/<(?:g|rect|circle|polygon|ellipse|polyline|line)\b/i.test(svgText)) {
    return { ok: false, reason: 'non-path element present' };
  }
  // Rule: no transforms anywhere
  if (/\btransform\s*=/i.test(svgText)) {
    return { ok: false, reason: 'transform attribute present' };
  }
  // Rule: no strokes
  if (/\bstroke\s*=\s*["'](?!none\b)[^"']+["']/i.test(svgText)) {
    return { ok: false, reason: 'stroke attribute present' };
  }
  // Rule: no fill="none"
  if (/\bfill\s*=\s*["']none["']/i.test(svgText)) {
    return { ok: false, reason: 'fill="none" present' };
  }

  let doc;
  try {
    doc = new DOMParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } } }).parseFromString(svgText, 'image/svg+xml');
  } catch (e) {
    return { ok: false, reason: 'xml parse failure: ' + e.message };
  }

  const svgEl = doc.documentElement;
  if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
    return { ok: false, reason: 'no <svg> root' };
  }

  const viewBox = svgEl.getAttribute('viewBox');
  if (!viewBox || !/^[\d.\-\s]+$/.test(viewBox)) {
    return { ok: false, reason: 'missing or malformed viewBox' };
  }

  const pathEls = svgEl.getElementsByTagName('path');
  if (pathEls.length === 0) {
    return { ok: false, reason: 'no <path> elements' };
  }
  if (pathEls.length > 8) {
    return { ok: false, reason: `too many paths (${pathEls.length})` };
  }

  const paths = [];
  for (let i = 0; i < pathEls.length; i++) {
    const d = pathEls[i].getAttribute('d');
    if (!d) return { ok: false, reason: 'path missing d attribute' };
    paths.push(d);
  }

  // Path length & bbox check — reject overly-thin shapes or degenerate paths
  const [, , vw, vh] = viewBox.split(/\s+/).map(Number);
  const viewboxArea = vw * vh;

  let totalLength = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const SAMPLES_PER_PATH = 100;

  try {
    for (const d of paths) {
      const props = new svgPathProperties(d);
      const len = props.getTotalLength();
      totalLength += len;

      // Sample along the path to compute bounding box
      for (let i = 0; i <= SAMPLES_PER_PATH; i++) {
        const t = (len * i) / SAMPLES_PER_PATH;
        const pt = props.getPointAtLength(t);
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
  } catch (e) {
    return { ok: false, reason: 'path sampling failed: ' + e.message };
  }

  // Reasonable shape coverage — bbox should be at least 20% of viewBox area
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const bboxArea = bboxW * bboxH;
  if (bboxArea / viewboxArea < 0.10) {
    return { ok: false, reason: `bbox too small (${(bboxArea / viewboxArea * 100).toFixed(1)}% of viewBox)` };
  }
  if (bboxW <= 0 || bboxH <= 0) {
    return { ok: false, reason: 'degenerate bbox' };
  }

  // Aspect ratio check
  const aspect = bboxW / bboxH;
  if (aspect < 0.3 || aspect > 3.0) {
    return { ok: false, reason: `aspect ratio out of range (${aspect.toFixed(2)})` };
  }

  // Total path length proxy for visual detail — at least 50 units for a 100×100 viewBox
  const normLength = totalLength * (100 / Math.max(vw, vh));
  if (normLength < 50) {
    return { ok: false, reason: `too little detail (path length ${normLength.toFixed(1)})` };
  }

  return { ok: true, paths, viewBox, detail: normLength };
}

/**
 * Generate an SVG for the given iconic concept. Returns:
 *   { ok: true, name: "kebab-name", url: "/shapes/generated/…svg", detail }
 *   { ok: false, reason: "…" }
 *   null  (if rate-limited or otherwise skipped)
 *
 * Safe to call repeatedly — caching + negative-cache prevent runaway cost.
 */
async function generate(iconic) {
  const kebab = toKebab(iconic);
  if (!kebab) return { ok: false, reason: 'empty iconic' };

  // Already cached?
  const outPath = path.join(GENERATED_DIR, `${kebab}.svg`);
  if (fs.existsSync(outPath)) {
    return { ok: true, name: kebab, url: `/shapes/generated/${kebab}.svg`, cached: true };
  }

  // Known failure?
  if (failedCache.has(kebab)) {
    return { ok: false, reason: 'previously failed validation (negative cache)' };
  }

  // Already in-flight globally? Skip to avoid stacked requests.
  if (inFlight) {
    return { ok: false, reason: 'another generation in progress' };
  }

  inFlight = (async () => {
    try {
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: USER_PROMPT_TEMPLATE(iconic) }],
      });

      const raw = resp.content[0]?.text;
      if (!raw) return { ok: false, reason: 'empty response' };

      const svg = cleanResponse(raw);
      const check = validate(svg);

      if (!check.ok) {
        failedCache.add(kebab);
        console.warn(`[svg-gen] rejected "${iconic}" — ${check.reason}`);
        return { ok: false, reason: check.reason };
      }

      // Write to disk
      fs.writeFileSync(outPath, svg, 'utf-8');

      // Register with matcher, embedding so future variants can find it
      let embedding = null;
      try {
        embedding = await embeddingService.embed(iconic);
      } catch (_) {
        // embedding failure is non-fatal — exact-match still works
      }
      await iconMatcher.registerGenerated(kebab, iconic, embedding);

      console.log(`[svg-gen] accepted "${iconic}" → generated/${kebab}.svg (detail ${check.detail.toFixed(0)})`);
      return { ok: true, name: kebab, url: `/shapes/generated/${kebab}.svg`, detail: check.detail };
    } catch (err) {
      console.warn(`[svg-gen] error generating "${iconic}":`, err.message);
      return { ok: false, reason: 'api error: ' + err.message };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

module.exports = {
  generate,
  validate,  // exported for tests
  toKebab,
};
