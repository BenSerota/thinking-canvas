/**
 * SVG Generator Service
 *
 * On-demand SVG generation for concepts that didn't match any library icon.
 * Calls Opus 5 (Sonnet 5 fallback) with low effort, validates strictly, and
 * caches to public/shapes/generated-v3/{kebab}.svg.
 *
 * Prompt v3 (2026-04-17): v2 forced Claude to enumerate iconic features
 * before drawing and added fill-rule="evenodd" for holes; v3 kept those
 * rules on a stronger model. Cache dir is bumped on each prompt revision.
 *
 * Strict validation (aligned with the client's Path2D.fill() rasterizer):
 *   - Parses as XML; no DOCTYPE/entities; comments ignored
 *   - Root <svg> with a viewBox of exactly four finite numbers, w/h > 0
 *   - Allowlist: the only elements are <svg> and <path> (no <g>, <a>, <set>,
 *     <use>, <defs>, <mask>, <text>, <script>, <style>, <image>, …)
 *   - Path attributes limited to d / fill / fill-rule (/ id / class); no
 *     style, transform, opacity, stroke or event-handler attributes anywhere
 *   - fill must be absent, currentColor, #000 or black — white/transparent
 *     "cut-out" layers would render as solid blobs
 *   - 1–16 paths; a single path with a single subpath is rejected as a blob
 *   - Sampled bbox ≥10% of viewBox, aspect 0.3–3.0, path length ≥50 units,
 *     and a filled-area proxy (per-subpath shoelace) ≥5% of the viewBox so
 *     a few sparse dots plus a hairline can't pass on bbox alone
 *
 * Concurrency + cost control:
 *   - One generation at a time; concurrent callers wait their turn and
 *     re-check the cache before generating (a turn's three concepts resolve
 *     in parallel — an instant-fail guard would have starved two of them)
 *   - Negative cache: a concept that failed validation, or whose API/FS call
 *     failed, is not retried this process lifetime
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { DOMParser } = require('@xmldom/xmldom');
const { svgPathProperties } = require('svg-path-properties');

const iconMatcher = require('./icon-matcher');
const embeddingService = require('./embedding-service');
const { toKebab } = require('./utils');

// Prompt version — bump when prompt changes semantics so the old cache is bypassed.
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

const PRIMARY_MODEL = 'claude-opus-5';
const FALLBACK_MODEL = 'claude-sonnet-5';
// Both models think adaptively when `thinking` is omitted; low effort keeps
// the private planning step short so a generation stays in the ~10 s range.
const REQUEST_OPTIONS = { max_tokens: 3000, output_config: { effort: 'low' } };
// Concept kebabs become file names; cap well under filesystem limits.
const MAX_KEBAB_CHARS = 100;
const MAX_PATHS = 16;
const MIN_BBOX_FRACTION = 0.10;
const MIN_AREA_FRACTION = 0.05;
const MIN_NORM_LENGTH = 50;

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

/**
 * Strip markdown fences, XML prologs, and extract the <svg> element if Claude
 * emitted a planning preamble before it.
 */
function cleanResponse(text) {
  let t = text.trim();
  t = t.replace(/^```(?:xml|svg)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
  t = t.replace(/^<\?xml[^?]*\?>\s*/i, '').trim();
  const svgMatch = t.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) t = svgMatch[0];
  return t;
}

// ─── Validation ───

const ALLOWED_ROOT_ATTRS = /^(xmlns(:[\w-]+)?|viewbox|width|height|version|fill|id|class|xml:space)$/i;
const ALLOWED_PATH_ATTRS = new Set(['d', 'fill', 'fill-rule', 'id', 'class']);
const ALLOWED_FILLS = new Set(['currentcolor', '#000', '#000000', 'black']);

function localName(el) {
  return String(el.localName || el.tagName || '').split(':').pop().toLowerCase();
}

function parseViewBox(value) {
  const parts = String(value || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return parts;
}

/** Absolute shoelace area of a closed polygon given as [{x,y}]. */
function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Strict validation — returns
 *   { ok: true, paths, viewBox, detail, pathCount, areaFraction } or
 *   { ok: false, reason }
 */
function validate(svgText, { iconic = '' } = {}) {
  const fail = (reason) => ({ ok: false, reason });

  if (typeof svgText !== 'string' || !svgText.startsWith('<svg')) return fail('does not start with <svg');
  if (/<!DOCTYPE|<!ENTITY/i.test(svgText)) return fail('doctype/entity present');
  const stripped = svgText.replace(/<!--[\s\S]*?-->/g, '');

  let doc;
  try {
    // @xmldom/xmldom ≥0.9 uses a single `onError(level, msg)` callback.
    doc = new DOMParser({
      onError: (level, msg) => { if (level === 'fatalError') throw new Error(msg); },
    }).parseFromString(stripped, 'image/svg+xml');
  } catch (e) {
    return fail('xml parse failure: ' + e.message);
  }

  const svgEl = doc.documentElement;
  if (!svgEl || localName(svgEl) !== 'svg') return fail('no <svg> root');

  const viewBox = parseViewBox(svgEl.getAttribute('viewBox'));
  if (!viewBox) return fail('missing or malformed viewBox (need 4 finite numbers, w/h > 0)');
  const [, , vw, vh] = viewBox;

  for (let i = 0; i < svgEl.attributes.length; i++) {
    const name = svgEl.attributes[i].name;
    if (/^on/i.test(name) || !ALLOWED_ROOT_ATTRS.test(name)) return fail(`root attribute not allowed: ${name}`);
  }

  const paths = [];
  for (let node = svgEl.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (node.nodeValue.trim()) return fail('stray text content');
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = localName(node);
    if (tag !== 'path') return fail(`element not allowed: <${tag}>`);
    for (let i = 0; i < node.attributes.length; i++) {
      const name = node.attributes[i].name.toLowerCase();
      if (!ALLOWED_PATH_ATTRS.has(name)) return fail(`path attribute not allowed: ${name}`);
    }
    const fill = node.getAttribute('fill');
    if (fill != null && !ALLOWED_FILLS.has(fill.trim().toLowerCase())) return fail(`non-black fill: ${fill}`);
    const rule = node.getAttribute('fill-rule');
    if (rule != null && !/^(nonzero|evenodd)$/i.test(rule.trim())) return fail(`bad fill-rule: ${rule}`);
    const d = node.getAttribute('d');
    if (!d || !d.trim()) return fail('path missing d attribute');
    paths.push(d.trim());
  }

  if (paths.length === 0) return fail('no <path> elements');
  if (paths.length > MAX_PATHS) return fail(`too many paths (${paths.length})`);

  // Detail-floor gate: a single <path> with a single subpath is a convex
  // blob describing a bounding shape, not an icon — for any concept.
  if (paths.length === 1 && (paths[0].match(/[Mm]/g) || []).length < 2) {
    return fail('single-path single-subpath blob');
  }

  // Geometry: sample every segment of every path to get the total length,
  // the bounding box, and a filled-area proxy (per-subpath shoelace area).
  let totalLength = 0;
  let filledArea = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  try {
    for (const d of paths) {
      const props = new svgPathProperties(d);
      const parts = props.getParts();
      let offset = 0;
      let poly = [];
      let prevEnd = null;
      const flush = () => { if (poly.length >= 3) filledArea += polygonArea(poly); poly = []; };
      for (const part of parts) {
        const len = part.length;
        const moved = prevEnd && (Math.abs(part.start.x - prevEnd.x) > 1e-6 || Math.abs(part.start.y - prevEnd.y) > 1e-6);
        if (moved) flush();
        const samples = Math.min(40, Math.max(2, Math.ceil(len / 2)));
        for (let i = poly.length ? 1 : 0; i <= samples; i++) {
          const pt = props.getPointAtLength(offset + (len * i) / samples);
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
          poly.push(pt);
        }
        offset += len;
        prevEnd = part.end;
      }
      flush();
      totalLength += props.getTotalLength();
    }
  } catch (e) {
    return fail('path sampling failed: ' + e.message);
  }

  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  if (!(bboxW > 0) || !(bboxH > 0)) return fail('degenerate bbox');
  const viewboxArea = vw * vh;
  const bboxFraction = (bboxW * bboxH) / viewboxArea;
  if (bboxFraction < MIN_BBOX_FRACTION) return fail(`bbox too small (${(bboxFraction * 100).toFixed(1)}% of viewBox)`);

  const aspect = bboxW / bboxH;
  if (aspect < 0.3 || aspect > 3.0) return fail(`aspect ratio out of range (${aspect.toFixed(2)})`);

  const normLength = totalLength * (100 / Math.max(vw, vh));
  if (normLength < MIN_NORM_LENGTH) return fail(`too little detail (path length ${normLength.toFixed(1)})`);

  const areaFraction = filledArea / viewboxArea;
  if (areaFraction < MIN_AREA_FRACTION) return fail(`too little filled area (${(areaFraction * 100).toFixed(1)}% of viewBox)`);

  return { ok: true, paths, viewBox: viewBox.join(' '), detail: normLength, pathCount: paths.length, areaFraction };
}

// ─── Generation ───

function cachedResult(kebab) {
  const outPath = path.join(GENERATED_DIR, `${kebab}.svg`);
  if (fs.existsSync(outPath)) {
    return { ok: true, name: kebab, url: `${GENERATED_URL_PREFIX}/${kebab}.svg`, cached: true };
  }
  if (failedCache.has(kebab)) {
    return { ok: false, reason: 'previously failed (negative cache)' };
  }
  return null;
}

async function callModel(iconic) {
  const reqParams = {
    ...REQUEST_OPTIONS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: USER_PROMPT_TEMPLATE(iconic) }],
  };
  try {
    return await anthropic.messages.create({ model: PRIMARY_MODEL, ...reqParams });
  } catch (primaryErr) {
    console.warn(`[svg-gen] ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}:`, primaryErr.message);
    return anthropic.messages.create({ model: FALLBACK_MODEL, ...reqParams });
  }
}

/**
 * Generate an SVG for the given iconic concept. Returns:
 *   { ok: true, name, url, detail?, cached? }
 *   { ok: false, reason }
 *
 * Safe to call concurrently — callers serialize on a single in-flight slot
 * and re-check the caches after waiting.
 */
async function generate(iconic) {
  const kebab = toKebab(iconic).slice(0, MAX_KEBAB_CHARS);
  if (!kebab) return { ok: false, reason: 'empty iconic' };

  const early = cachedResult(kebab);
  if (early) return early;

  while (inFlight) {
    await inFlight.catch(() => {});
  }
  const afterWait = cachedResult(kebab);
  if (afterWait) return afterWait;

  inFlight = (async () => {
    try {
      const resp = await callModel(iconic);
      // With adaptive thinking the first block can be a thinking block.
      const raw = resp.content.find(b => b.type === 'text')?.text;
      if (!raw) {
        failedCache.add(kebab);
        return { ok: false, reason: 'empty response' };
      }

      const svg = cleanResponse(raw);
      const check = validate(svg, { iconic });
      if (!check.ok) {
        failedCache.add(kebab);
        console.warn(`[svg-gen] rejected "${iconic}" — ${check.reason}`);
        return { ok: false, reason: check.reason };
      }

      const outPath = path.join(GENERATED_DIR, `${kebab}.svg`);
      fs.writeFileSync(outPath, svg, 'utf-8');

      // Register with the matcher so future variants can find it.
      let embedding = null;
      try {
        embedding = await embeddingService.embed(iconic);
      } catch (_) {
        // embedding failure is non-fatal — exact-match still works
      }
      await iconMatcher.registerGenerated(kebab, iconic, embedding);

      console.log(`[svg-gen] accepted "${iconic}" → ${GENERATED_SUBDIR}/${kebab}.svg (paths ${check.pathCount}, detail ${check.detail.toFixed(0)}, area ${(check.areaFraction * 100).toFixed(0)}%)`);
      return { ok: true, name: kebab, url: `${GENERATED_URL_PREFIX}/${kebab}.svg`, detail: check.detail };
    } catch (err) {
      // API or filesystem failure: don't re-spend on this concept this
      // process lifetime.
      failedCache.add(kebab);
      console.warn(`[svg-gen] error generating "${iconic}":`, err.message);
      return { ok: false, reason: 'generation error: ' + err.message };
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
