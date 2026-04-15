/**
 * Shape Service
 *
 * Resolves Haiku-extracted visual concepts to renderable shape references.
 *
 * Resolution order per concept:
 *   1. iconMatcher.findBestMatch(iconic)  → library/generated SVG URL
 *   2. svgGenerator.generate(iconic)      → Sonnet-generated + validated SVG
 *   3. Haiku's `shape` fallback field     → one of 30 built-in client shapes
 *
 * Returns { name, concept, dynamic, source, score? } per shape:
 *   - `name` is the matched icon's kebab filename (routing key, e.g. "shoe-prints").
 *   - `concept` is Haiku's original iconic phrase (human-readable, e.g. "sneakers").
 *     The canvas uses `concept` as the label so users see Claude's intent,
 *     not the library-lookup artifact.
 */

const iconMatcher = require('./icon-matcher');
const iconifyService = require('./iconify-service');
const svgGenerator = require('./svg-generator');
const curatedIcons = require('./curated-icons.json');

// Safety-net built-in shape names (must match keys in client shapes.js SHAPE_PATHS)
const BUILTIN_NAMES = new Set([
  'car', 'truck', 'bicycle', 'airplane', 'boat',
  'dog', 'cat', 'bird', 'fish', 'horse',
  'house', 'building', 'tree', 'mountain', 'sun', 'cloud', 'flower',
  'phone', 'computer', 'book', 'cup', 'guitar', 'key',
  'person', 'question', 'search', 'money', 'heart', 'star', 'food',
]);

/** Normalize an iconic phrase to a kebab key for curated-map lookup. */
function curatedKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Consult the hand-curated map in `curated-icons.json`. Returns the resolved
 * shape object (same shape as resolveVisual's other return paths) or null if
 * no curated entry matches.
 *
 * This runs BEFORE the embedding matcher so it can force the right icon for
 * concepts the matcher gets wrong (e.g. "colosseum" embeds closer to some
 * random sports icon than to building-columns) and for proper nouns the
 * generator blob-fails on ("leaning tower of pisa"). Grow this list as the
 * server logs surface more bad-match or blob-gen cases.
 */
function resolveCurated(iconic, concept) {
  const key = curatedKey(iconic);
  if (!key) return null;
  const entry = curatedIcons[key];
  if (!entry || typeof entry !== 'object') return null;
  // Prefer `curated` (hand-drawn SVG in public/shapes/curated/ — survives
  // `npm run fetch-icons` because that dir is tracked and not regenerated).
  // Fall back to `library` (FontAwesome/Material asset in public/shapes/library/).
  if (entry.curated) {
    return {
      name: entry.curated,
      concept,
      dynamic: `/shapes/curated/${entry.curated}.svg`,
      source: 'curated',
      score: 1.0,
    };
  }
  if (entry.library) {
    return {
      name: entry.library,
      concept,
      dynamic: `/shapes/library/${entry.library}.svg`,
      source: 'curated',
      score: 1.0,
    };
  }
  return null;
}

// Raised from 0.55 → 0.60 after live testing. Borderline matches at 0.55-0.60
// tended to feel semantically off (e.g. "bumpy head map" → tools-flat-head at
// 0.56). Above 0.60, the concept falls through to svg-generator, which at
// least produces something *about* the concept instead of a lookup misfire.
// If too many concepts end up as `builtin` (svg-gen rejection), back off to 0.58.
const EMBEDDING_THRESHOLD = 0.60;

/**
 * Given a Haiku shape-fallback string, coerce it to a valid built-in name.
 * Defaults to 'question' if unrecognized.
 */
function normalizeBuiltin(shape) {
  const s = String(shape || '').toLowerCase().trim();
  return BUILTIN_NAMES.has(s) ? s : 'question';
}

/**
 * Resolve one Haiku visual to a renderable shape reference.
 *   visual: { iconic: string, shape: string }
 * Returns { name, concept, dynamic, source, score? }
 *   - `concept` is the display label (Haiku's original iconic phrase, falling
 *     back to the builtin shape name if iconic was absent).
 */
async function resolveVisual(visual) {
  const iconic = visual && visual.iconic ? String(visual.iconic).trim() : '';
  const builtinFallback = normalizeBuiltin(visual && visual.shape);
  // Display label: prefer the human-readable iconic phrase; fall back to the
  // builtin name (which is already a common word like "dog" or "house").
  const concept = iconic || builtinFallback;

  if (iconic) {
    // 0. Hand-curated override — wins over both the matcher and the generator
    // for concepts where the matcher picks the wrong icon or the generator
    // produces a blob. See `services/curated-icons.json`.
    const curated = resolveCurated(iconic, concept);
    if (curated) return curated;

    // 1. Iconify web search — 200k+ icons across 150+ open-licensed sets.
    // Runs BEFORE the local embedding matcher (user preference): the much
    // larger catalog tends to produce more specific matches than our 5,497-
    // icon local library. Cache-miss path takes ~200-500ms (two HTTP calls);
    // cache-hit path is disk-only (~1ms). License-filtered to commercial-safe
    // OSS sets; palette-filtered to single-color silhouettes. On any failure
    // (timeout, no match, sanitize reject) returns null and we fall through
    // to the local matcher, preserving every existing behavior.
    const iconify = await iconifyService.findAndCache(iconic);
    if (iconify) {
      return {
        name: iconify.name,
        concept,
        dynamic: iconify.url,
        source: 'iconify',
        score: 1.0,
      };
    }

    // 2. Library / cached-generated match
    const match = await iconMatcher.findBestMatch(iconic, { threshold: EMBEDDING_THRESHOLD });
    if (match) {
      // Determine which directory the SVG lives in. Generated icons live in
      // a versioned subdir (see svg-generator.js GENERATED_SUBDIR); library
      // icons live in `library/`.
      const subdir = match.source === 'generated' ? svgGenerator.GENERATED_SUBDIR : 'library';
      return {
        name: match.name,
        concept,
        dynamic: `/shapes/${subdir}/${match.name}.svg`,
        source: match.source === 'exact' || match.source === 'fa-solid' || match.source === 'material'
          ? (match.source === 'exact' ? 'library-exact' : `library-${match.source}`)
          : match.source,
        score: match.score,
      };
    }

    // 3. On-demand generation with strict validation
    const gen = await svgGenerator.generate(iconic);
    if (gen && gen.ok) {
      return {
        name: gen.name,
        concept,
        dynamic: gen.url,
        source: gen.cached ? 'generated-cached' : 'generated',
      };
    }
  }

  // 3. Built-in fallback
  return { name: builtinFallback, concept, dynamic: null, source: 'builtin' };
}

/**
 * Map an array of Haiku visuals to renderable shapes.
 * Deduplicates by resolved name and caps at `max`.
 * Kept as a thin wrapper over streamConceptShapes for non-streaming callers.
 */
async function mapConceptsToShapes(visuals, max = 3) {
  const results = [];
  for await (const shape of streamConceptShapes(visuals, max)) {
    results.push(shape);
  }
  return results.length > 0
    ? results
    : [{ name: 'question', concept: 'question', dynamic: null, source: 'builtin' }];
}

/**
 * Async generator: yields each resolved shape the moment it's ready, rather
 * than batching all 3 after the slowest resolution finishes. Preserves input
 * order (yields in the same order as `visuals`), dedupes by resolved name,
 * and caps at `max`.
 *
 * This is the streaming path used by server.js to forward per-shape SSE
 * events — so the canvas starts forming the first shape while shapes 2-3
 * (which may include slow svg-generator fallbacks) are still resolving.
 */
async function* streamConceptShapes(visuals, max = 3) {
  if (!Array.isArray(visuals) || visuals.length === 0) return;

  const seen = new Set();
  let yielded = 0;

  for (const visual of visuals) {
    if (yielded >= max) break;
    const resolved = await resolveVisual(visual);
    if (seen.has(resolved.name)) continue;
    seen.add(resolved.name);
    yielded++;
    yield resolved;
  }
}

module.exports = {
  resolveVisual,
  mapConceptsToShapes,
  streamConceptShapes,
  BUILTIN_NAMES,
};
