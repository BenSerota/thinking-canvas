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
const svgGenerator = require('./svg-generator');

// Safety-net built-in shape names (must match keys in client shapes.js SHAPE_PATHS)
const BUILTIN_NAMES = new Set([
  'car', 'truck', 'bicycle', 'airplane', 'boat',
  'dog', 'cat', 'bird', 'fish', 'horse',
  'house', 'building', 'tree', 'mountain', 'sun', 'cloud', 'flower',
  'phone', 'computer', 'book', 'cup', 'guitar', 'key',
  'person', 'question', 'search', 'money', 'heart', 'star', 'food',
]);

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
    // 1. Library / cached-generated match
    const match = await iconMatcher.findBestMatch(iconic, { threshold: EMBEDDING_THRESHOLD });
    if (match) {
      // Determine which directory the SVG lives in
      const subdir = match.source === 'generated' ? 'generated' : 'library';
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

    // 2. On-demand generation with strict validation
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
