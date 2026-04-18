/**
 * SVG Generator Service
 *
 * On-demand SVG generation for concepts that didn't match any library icon.
 * Calls Sonnet, validates the result strictly, and caches successful
 * generations to public/shapes/generated-v2/{kebab}.svg.
 *
 * Prompt v2 (2026-04-15) — the v1 prompt produced featureless blobs
 * (colosseum → rounded rectangle, "leaning tower of pisa" → plain rectangle
 * with no lean). v2 forces Claude to enumerate iconic features BEFORE drawing,
 * permits fill-rule="evenodd" for holes (arches, eye sockets, donut gaps), and
 * shows 3 few-shot examples. The on-disk cache was moved to `generated-v2/` to
 * bust every v1 result — nothing references the old directory now.
 *
 * Strict validation rules (aligned with our Path2D.fill() rasterization pipeline):
 *   - Parses as valid XML
 *   - Has a valid viewBox
 *   - Has 2-16 <path d="..."> elements (single-path blobs rejected for
 *     multi-word concepts — blob-prevention heuristic)
 *   - No <g>, <rect>, <circle>, <polygon>, <ellipse>, <polyline>, <line>
 *   - No transforms
 *   - No stroke-only paths (stroke attrs are still rejected in v2 —
 *     rasterizer only fills; allowing strokes would render them invisible.
 *     Reintroduce with rasterizer stroke support in a future phase.)
 *   - No fill="none"
 *   - fill-rule="evenodd" is permitted (unlocks holes)
 *   - Bbox area ≥10% of viewBox
 *   - Aspect ratio within 0.3–3.0
 *   - Total path length ≥50 units (normalized to 100x100)
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

// Prompt version — bump when prompt changes semantics so the old cache is bypassed.
// v3: upgraded to Opus 4.7 (Sonnet 4.6 fallback) for much better silhouette quality.
const PROMPT_VERSION = 'v3';
const GENERATED_SUBDIR = `generated-${PROMPT_VERSION}`;

const ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(ROOT, 'public', 'shapes', GENERATED_SUBDIR);
const GENERATED_URL_PREFIX = `/shapes/${GENERATED_SUBDIR}`;

// Ensure the output dir exists
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

const anthropic = new Anthropic();

const PRIMARY_MODEL = 'claude-opus-4-7';
const FALLBACK_MODEL = 'claude-sonnet-4-6';

// Concurrency + negative cache
let inFlight = null;
const failedCache = new Set();

const SYSTEM_PROMPT = `You are an icon designer producing SVG silhouettes in the style of FontAwesome Solid and Material Symbols Filled. Your output is rendered as a particle silhouette on a dark canvas, so the shape must be INSTANTLY recognizable at 60x60 px from its outline and negative space alone.

WORKFLOW — do both steps:

Step 1 (plan privately before drawing): enumerate the 3 most iconic visual features of the concept — the features a child would use to identify it in pure silhouette.
  - "leaning tower of pisa" → (1) visible lean, 4-8° off vertical; (2) stacked cylindrical tiers with visible bands; (3) base noticeably wider than top.
  - "colosseum" → (1) tiered oval/round body; (2) arcade arches visible as holes on at least one tier; (3) ruined top edge (not a flat crown).
  - "brain" → (1) bilobed silhouette with a central gap or sulcus; (2) wrinkled convoluted outline (not smooth); (3) no extraneous parts — just the two hemispheres.

Step 2: emit an SVG whose silhouette contains all 3 iconic features.

STRUCTURAL RULES — follow exactly:

1. Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
2. Children: only <path d="..."/> elements. NO <g>, <rect>, <circle>, <polygon>, <ellipse>, <polyline>, <line>.
3. NO transform attributes anywhere.
4. Every path must have fill="currentColor" (or fill="#000"). NEVER fill="none".
5. NO stroke attributes — the shape is defined entirely by filled paths.
6. Use fill-rule="evenodd" on any path that contains holes (outer subpath + reversed inner subpath(s) within the same d attribute). This is how FontAwesome expresses arches, windows, eye sockets, donut gaps, the Colosseum's arcade openings, and the central sulcus of a brain silhouette. USE THIS LIBERALLY when the concept has obvious holes.
7. Use 2 to 16 paths. More paths = more detail. NEVER emit a single featureless blob path for a concept with more than one word.
8. Flowing curves (C, Q, S, T) for organic subjects; straight lines for architecture.
9. The combined bbox of all paths should cover 25–75% of the viewBox.

EXAMPLE 1 — "eye" (fill-rule="evenodd" for pupil hole):
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="currentColor" fill-rule="evenodd" d="M5 50 Q 50 15 95 50 Q 50 85 5 50 Z M32 50 A 18 18 0 1 0 68 50 A 18 18 0 1 0 32 50 Z"/><path fill="currentColor" d="M42 50 A 8 8 0 1 0 58 50 A 8 8 0 1 0 42 50 Z"/></svg>

EXAMPLE 2 — "castle" (multi-path: crenelated body, gate hole, windows):
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="currentColor" d="M15 85 L15 45 L22 45 L22 35 L30 35 L30 45 L40 45 L40 30 L48 30 L48 25 L52 25 L52 30 L60 30 L60 45 L70 45 L70 35 L78 35 L78 45 L85 45 L85 85 Z"/><path fill="currentColor" fill-rule="evenodd" d="M15 85 L85 85 L85 88 L15 88 Z M42 85 L58 85 L58 65 Q 50 55 42 65 Z"/><path fill="currentColor" d="M28 55 L36 55 L36 65 L28 65 Z"/><path fill="currentColor" d="M64 55 L72 55 L72 65 L64 65 Z"/></svg>

EXAMPLE 3 — "tree" (lobed canopy + trunk):
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="currentColor" d="M50 12 Q 28 20 26 40 Q 12 42 18 60 Q 15 78 38 72 L38 86 L62 86 L62 72 Q 85 78 82 60 Q 88 42 74 40 Q 72 20 50 12 Z"/><path fill="currentColor" d="M45 82 L55 82 L55 95 L45 95 Z"/></svg>

OUTPUT FORMAT:
Return only the final <svg>...</svg>. No markdown fences, no XML declaration, no commentary. If you accidentally include prose before the SVG, keep it brief — the postprocessor extracts the SVG element.`;

const USER_PROMPT_TEMPLATE = (iconic) => `Concept: ${iconic}

Before drawing, silently identify the 3 most iconic visual features of this concept — the ones that make its silhouette instantly unmistakable. Then draw an SVG in which all 3 features are visible at 60x60 px. Use fill-rule="evenodd" for any holes (arches, windows, sockets, gaps).

Output the <svg>...</svg> only.`;

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

/**
 * Strip markdown fences, XML prologs, and extract the <svg> element if Claude
 * emitted a planning preamble before it. The v2 prompt tells the model to plan
 * silently, but defend against prose bleed-through: match the first
 * <svg>...</svg> and drop anything outside.
 */
function cleanResponse(text) {
  let t = text.trim();
  t = t.replace(/^```(?:xml|svg)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
  t = t.replace(/^<\?xml[^?]*\?>\s*/i, '').trim();
  const svgMatch = t.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) t = svgMatch[0];
  return t;
}

/**
 * Strict validation — returns { ok: boolean, reason?: string, paths?: string[], viewBox?: string, detail?: number }
 */
function validate(svgText, { iconic = '' } = {}) {
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
  // Rule: no strokes (rasterizer fills only; strokes would render invisible)
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
  // v2: path cap raised 8 → 16 to allow more articulated silhouettes.
  if (pathEls.length > 16) {
    return { ok: false, reason: `too many paths (${pathEls.length})` };
  }

  const paths = [];
  for (let i = 0; i < pathEls.length; i++) {
    const d = pathEls[i].getAttribute('d');
    if (!d) return { ok: false, reason: 'path missing d attribute' };
    paths.push(d);
  }

  // Detail-floor gate (v2): for multi-word concepts, reject blob-like SVGs that
  // have only one path AND only one subpath-start. The user's Pisa and Colosseum
  // failures were exactly this case — single <path> with a single M command
  // describing a convex bounding shape. This heuristic catches them before they
  // ever reach the canvas.
  const isMultiWord = iconic.trim().split(/\s+/).length > 1;
  if (isMultiWord) {
    let totalSubpathStarts = 0;
    for (const d of paths) {
      // Count M/m commands (subpath starts) in the d attribute.
      const matches = d.match(/[Mm]/g);
      if (matches) totalSubpathStarts += matches.length;
    }
    if (paths.length === 1 && totalSubpathStarts < 2) {
      return { ok: false, reason: `single-path single-subpath blob (subpath starts: ${totalSubpathStarts})` };
    }
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

  // Reasonable shape coverage — bbox should be at least 10% of viewBox area
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

  return { ok: true, paths, viewBox, detail: normLength, pathCount: paths.length };
}

/**
 * Generate an SVG for the given iconic concept. Returns:
 *   { ok: true, name: "kebab-name", url: "/shapes/generated-v2/…svg", detail }
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
    return { ok: true, name: kebab, url: `${GENERATED_URL_PREFIX}/${kebab}.svg`, cached: true };
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
      let resp;
      const reqParams = {
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: USER_PROMPT_TEMPLATE(iconic) }],
      };
      try {
        resp = await anthropic.messages.create({ model: PRIMARY_MODEL, ...reqParams });
      } catch (primaryErr) {
        console.warn(`[svg-gen] ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}:`, primaryErr.message);
        resp = await anthropic.messages.create({ model: FALLBACK_MODEL, ...reqParams });
      }

      const raw = resp.content[0]?.text;
      if (!raw) return { ok: false, reason: 'empty response' };

      const svg = cleanResponse(raw);
      const check = validate(svg, { iconic });

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

      console.log(`[svg-gen] accepted "${iconic}" → ${GENERATED_SUBDIR}/${kebab}.svg (paths ${check.pathCount}, detail ${check.detail.toFixed(0)})`);
      return { ok: true, name: kebab, url: `${GENERATED_URL_PREFIX}/${kebab}.svg`, detail: check.detail };
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
  PROMPT_VERSION,
  GENERATED_SUBDIR,
  GENERATED_URL_PREFIX,
};
