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
 * Returns array of { name, dynamic, source, score? } ready for the SSE client.
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

const EMBEDDING_THRESHOLD = 0.55;

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
 * Returns { name, dynamic, source, score? }
 */
async function resolveVisual(visual) {
  const iconic = visual && visual.iconic ? String(visual.iconic).trim() : '';

  if (iconic) {
    // 1. Library / cached-generated match
    const match = await iconMatcher.findBestMatch(iconic, { threshold: EMBEDDING_THRESHOLD });
    if (match) {
      // Determine which directory the SVG lives in
      const subdir = match.source === 'generated' ? 'generated' : 'library';
      return {
        name: match.name,
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
        dynamic: gen.url,
        source: gen.cached ? 'generated-cached' : 'generated',
      };
    }
  }

  // 3. Built-in fallback
  const builtin = normalizeBuiltin(visual && visual.shape);
  return { name: builtin, dynamic: null, source: 'builtin' };
}

/**
 * Map an array of Haiku visuals to renderable shapes.
 * Deduplicates by resolved name and caps at `max`.
 */
async function mapConceptsToShapes(visuals, max = 3) {
  if (!Array.isArray(visuals) || visuals.length === 0) {
    return [{ name: 'question', dynamic: null, source: 'builtin' }];
  }

  const results = [];
  const seen = new Set();

  for (const visual of visuals) {
    if (results.length >= max) break;
    const resolved = await resolveVisual(visual);
    if (!seen.has(resolved.name)) {
      seen.add(resolved.name);
      results.push(resolved);
    }
  }

  return results.length > 0 ? results : [{ name: 'question', dynamic: null, source: 'builtin' }];
}

module.exports = {
  resolveVisual,
  mapConceptsToShapes,
  BUILTIN_NAMES,
};
