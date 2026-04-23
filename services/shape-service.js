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
const emojiService = require('./emoji-service');
const svgGenerator = require('./svg-generator');
const lottieService = require('./lottie-service');
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
 *   excludeNames: Set<string> of resolved names already taken by earlier
 *                 concepts in the same turn. When a tier's candidate is in
 *                 this set, we skip it and fall through — otherwise two
 *                 related concepts (e.g. "chromosome" and "dna double
 *                 helix", both of which tag to the bundled `dna` Lottie)
 *                 would collide and one would be deduped away by the
 *                 streaming caller, leaving the carousel with a short count.
 * Returns { name, concept, dynamic, source, score? }
 *   - `concept` is the display label (Haiku's original iconic phrase, falling
 *     back to the builtin shape name if iconic was absent).
 */
async function resolveVisual(visual, excludeNames = new Set()) {
  const iconic = visual && visual.iconic ? String(visual.iconic).trim() : '';
  const builtinFallback = normalizeBuiltin(visual && visual.shape);
  // Display label: prefer the human-readable iconic phrase; fall back to the
  // builtin name (which is already a common word like "dog" or "house").
  const concept = iconic || builtinFallback;

  if (iconic) {
    // 0. Lottie animation — bundled or LottieFiles API. Checked FIRST
    // because animated shapes (orbiting electrons, pulsing heart) are
    // categorically better than any static icon or curated override.
    try {
      const lottieMatch = await lottieService.findAnimation(iconic);
      if (lottieMatch && !excludeNames.has(lottieMatch.name)) {
        return {
          name: lottieMatch.name,
          concept,
          dynamic: lottieMatch.url,
          source: lottieMatch.source,
          type: 'lottie',
          score: 1.0,
        };
      }
    } catch (err) {
      console.warn('[shape-service] lottie lookup failed:', err.message);
    }

    // 0.5. Hand-curated override — wins over the matcher and generator
    // for concepts where they pick the wrong icon or produce a blob.
    const curated = resolveCurated(iconic, concept);
    if (curated && !excludeNames.has(curated.name)) return curated;

    // 0.7. Library exact-match — if the iconic phrase kebab-matches a library
    // icon name directly (e.g. "lightbulb" → lightbulb.svg, "volcano" →
    // volcano.svg), use it before the fuzzy emoji/iconify tiers have a
    // chance to return a wrong match (plug for lightbulb, person for volcano).
    if (await iconMatcher.hasExactMatch(iconic)) {
      const exactMatch = await iconMatcher.findBestMatch(iconic, { threshold: 0 });
      if (exactMatch && exactMatch.score >= 1.0 && !excludeNames.has(exactMatch.name)) {
        const subdir = exactMatch.source === 'generated' ? svgGenerator.GENERATED_SUBDIR : 'library';
        return {
          name: exactMatch.name,
          concept,
          dynamic: `/shapes/${subdir}/${exactMatch.name}.svg`,
          source: 'library-exact',
          score: 1.0,
        };
      }
    }

    // 1. OpenMoji line-art emoji — ~2,400 hand-drawn SVG silhouettes, local.
    // Runs FIRST among non-curated tiers because these glyphs were drawn by
    // professional illustrators and combine with the stroke-following
    // rasterizer (public/js/shapes.js → particlesFromGeomElements) to give
    // the "brush on canvas" aesthetic that filled-silhouette icons can't.
    //
    // Gated by a noun-overlap check inside findBestMatch so high-cosine but
    // wrong-concept matches (e.g. "wild hair" → "wildfire") are rejected.
    // On miss the pipeline falls through to the much larger Iconify catalog
    // for UI-type concepts ("laptop", "arrow up") where geometric precision
    // beats hand-drawn character.
    try {
      const emoji = await emojiService.findBestMatch(iconic);
      if (emoji && !excludeNames.has(`emoji-${emoji.hexcode}`)) {
        return {
          name: `emoji-${emoji.hexcode}`,
          concept,
          dynamic: emoji.url,
          source: 'emoji',
          score: emoji.score,
        };
      }
    } catch (err) {
      console.warn('[shape-service] emoji lookup failed:', err.message);
    }

    // 2. Iconify web search — 200k+ icons across 150+ open-licensed sets.
    // Reached when the emoji tier misses. Cache-miss path takes ~200-500ms
    // (two HTTP calls); cache-hit path is disk-only (~1ms). License-filtered
    // to commercial-safe OSS sets; palette-filtered to single-color
    // silhouettes. On any failure (timeout, no match, sanitize reject)
    // returns null and we fall through to the local matcher.
    const iconify = await iconifyService.findAndCache(iconic);
    if (iconify && !excludeNames.has(iconify.name)) {
      return {
        name: iconify.name,
        concept,
        dynamic: iconify.url,
        source: 'iconify',
        score: 1.0,
      };
    }

    // 3. Library / cached-generated match
    const match = await iconMatcher.findBestMatch(iconic, { threshold: EMBEDDING_THRESHOLD });
    if (match && !excludeNames.has(match.name)) {
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
    if (gen && gen.ok && !excludeNames.has(gen.name)) {
      return {
        name: gen.name,
        concept,
        dynamic: gen.url,
        source: gen.cached ? 'generated-cached' : 'generated',
      };
    }
  }

  // 3.5. Substring fallback: drop leading words to find the core noun
  // "chicago bulls jersey" → try "bulls jersey" → try "jersey"
  if (iconic) {
    const words = iconic.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const suffix = words.slice(i).join(' ');
      const iconify = await iconifyService.findAndCache(suffix);
      if (iconify && !excludeNames.has(iconify.name)) {
        return { name: iconify.name, concept, dynamic: iconify.url, source: 'iconify', score: 1.0 };
      }
      const match = await iconMatcher.findBestMatch(suffix, { threshold: EMBEDDING_THRESHOLD });
      if (match && !excludeNames.has(match.name)) {
        const subdir = match.source === 'generated' ? svgGenerator.GENERATED_SUBDIR : 'library';
        return {
          name: match.name, concept,
          dynamic: `/shapes/${subdir}/${match.name}.svg`,
          source: match.source, score: match.score,
        };
      }
    }
  }

  // 4. Built-in fallback
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
    const resolved = await resolveVisual(visual, seen);
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
