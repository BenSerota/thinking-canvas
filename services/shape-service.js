/**
 * Shape Service
 *
 * Resolves Haiku-extracted visual concepts to renderable shape references.
 *
 * Resolution ladder per concept (first hit wins):
 *   1. curated override            services/curated-icons.json
 *   2. library exact kebab match   public/shapes/library or the generated cache
 *   3. bundled Lottie animation    whole-token tag match (services/lottie-service.js)
 *   4. OpenMoji emoji embedding    ~2,400 line-art SVGs, stroke rasterizer on the client
 *   5. Iconify web search          cached to public/shapes/iconify-cache
 *   6. library embedding match     MiniLM cosine ≥ EMBEDDING_THRESHOLD
 *   7. on-demand SVG generation    validated, cached, single-flight
 *   8. substring fallback          drop leading words, retry 5 + 6
 *   9. builtin client shape        Haiku's `shape` field
 *
 * The concepts of a turn resolve concurrently (streamConceptShapes); results
 * are yielded in input order as they settle, deduped by resolved name.
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
const { toKebab } = require('./utils');

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
const EMBEDDING_THRESHOLD = 0.60;

// Per-concept wall-clock budget. A concept that blows through it (slow
// network tier, long generation) yields its builtin fallback; the underlying
// work keeps running and still populates the caches for future turns.
const RESOLVE_TIMEOUT_MS = 20000;

/**
 * Consult the hand-curated map in `curated-icons.json`. Returns the resolved
 * shape object or null if no curated entry matches.
 *
 * Runs BEFORE every fuzzy tier so it can force the right icon for concepts
 * the matcher gets wrong (e.g. "colosseum" embeds closer to some random
 * sports icon than to building-columns) and for proper nouns the generator
 * blob-fails on ("leaning tower of pisa").
 */
function resolveCurated(iconic, concept) {
  const key = toKebab(iconic);
  if (!key) return null;
  const entry = curatedIcons[key];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.curated) {
    return { name: entry.curated, concept, dynamic: `/shapes/curated/${entry.curated}.svg`, source: 'curated', score: 1.0 };
  }
  if (entry.library) {
    return { name: entry.library, concept, dynamic: `/shapes/library/${entry.library}.svg`, source: 'curated', score: 1.0 };
  }
  return null;
}

/** Coerce Haiku's shape-fallback string to a valid built-in name. */
function normalizeBuiltin(shape) {
  const s = String(shape || '').toLowerCase().trim();
  return BUILTIN_NAMES.has(s) ? s : 'question';
}

function labelSource(source) {
  return source === 'generated' ? 'generated' : `library-${source}`;
}

/** Shape object for an icon-matcher result (library or cached-generated). */
function libraryShape(match, concept, sourceOverride) {
  const subdir = match.source === 'generated' ? svgGenerator.GENERATED_SUBDIR : 'library';
  return {
    name: match.name,
    concept,
    dynamic: `/shapes/${subdir}/${match.name}.svg`,
    source: sourceOverride || labelSource(match.source),
    score: match.score,
  };
}

/** Run one tier; a throwing tier is a miss, never a failed turn. */
async function tier(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[shape-service] ${label} tier failed:`, err.message);
    return null;
  }
}

function builtinShape(visual) {
  const fallback = normalizeBuiltin(visual && visual.shape);
  const iconic = visual && visual.iconic ? String(visual.iconic).trim() : '';
  return { name: fallback, concept: iconic || fallback, dynamic: null, source: 'builtin' };
}

/**
 * Resolve one Haiku visual to a renderable shape reference.
 *   visual: { iconic: string, shape: string }
 *   excludeNames: Set<string> of resolved names already taken by earlier
 *                 concepts in the same turn. When a tier's candidate is in
 *                 this set, we skip it and fall through — otherwise two
 *                 related concepts (e.g. "chromosome" and "dna double
 *                 helix", both of which tag to the bundled `dna` Lottie)
 *                 would collide and one would be deduped away.
 */
async function resolveVisual(visual, excludeNames = new Set()) {
  const iconic = visual && visual.iconic ? String(visual.iconic).trim() : '';
  const builtinFallback = normalizeBuiltin(visual && visual.shape);
  const concept = iconic || builtinFallback;
  const free = (name) => !excludeNames.has(name);

  if (iconic) {
    // 1. Hand-curated override.
    const curated = resolveCurated(iconic, concept);
    if (curated && free(curated.name)) return curated;

    // 2. Library exact-match — "lightbulb" → lightbulb.svg before the fuzzy
    //    tiers can return a wrong match (plug for lightbulb, person for volcano).
    const exact = await tier('exact', async () => {
      if (!(await iconMatcher.hasExactMatch(iconic))) return null;
      const m = await iconMatcher.findBestMatch(iconic, { threshold: 0 });
      return m && m.score >= 1.0 ? libraryShape(m, concept, 'library-exact') : null;
    });
    if (exact && free(exact.name)) return exact;

    // 3. Bundled Lottie animation — animated shapes beat static icons, but
    //    only after an exact icon has had its chance.
    const lottie = await tier('lottie', () => lottieService.findAnimation(iconic));
    if (lottie && free(lottie.name)) {
      return { name: lottie.name, concept, dynamic: lottie.url, source: lottie.source, type: 'lottie', score: 1.0 };
    }

    // 4. OpenMoji line-art emoji — hand-drawn silhouettes, rendered with the
    //    stroke-following rasterizer. Gated by a noun-overlap check inside
    //    findBestMatch so high-cosine but wrong-concept matches are rejected.
    const emoji = await tier('emoji', () => emojiService.findBestMatch(iconic));
    if (emoji && free(`emoji-${emoji.hexcode}`)) {
      return { name: `emoji-${emoji.hexcode}`, concept, dynamic: emoji.url, source: 'emoji', score: emoji.score };
    }

    // 5. Iconify web search — 200k+ icons; cache-miss path is two HTTP calls.
    const iconify = await tier('iconify', () => iconifyService.findAndCache(iconic));
    if (iconify && free(iconify.name)) {
      return { name: iconify.name, concept, dynamic: iconify.url, source: 'iconify', score: 1.0 };
    }

    // 6. Library / cached-generated embedding match.
    const match = await tier('matcher', () => iconMatcher.findBestMatch(iconic, { threshold: EMBEDDING_THRESHOLD }));
    if (match && free(match.name)) return libraryShape(match, concept);

    // 7. On-demand generation with strict validation.
    const gen = await tier('generator', () => svgGenerator.generate(iconic));
    if (gen && gen.ok && free(gen.name)) {
      return { name: gen.name, concept, dynamic: gen.url, source: gen.cached ? 'generated-cached' : 'generated' };
    }

    // 8. Substring fallback: drop leading words to find the core noun
    //    "chicago bulls jersey" → try "bulls jersey" → try "jersey"
    const words = iconic.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const suffix = words.slice(i).join(' ');
      const sub = await tier('iconify', () => iconifyService.findAndCache(suffix));
      if (sub && free(sub.name)) {
        return { name: sub.name, concept, dynamic: sub.url, source: 'iconify', score: 1.0 };
      }
      const subMatch = await tier('matcher', () => iconMatcher.findBestMatch(suffix, { threshold: EMBEDDING_THRESHOLD }));
      if (subMatch && free(subMatch.name)) return libraryShape(subMatch, concept);
    }
  }

  // 9. Built-in fallback
  return { name: builtinFallback, concept, dynamic: null, source: 'builtin' };
}

/**
 * resolveVisual that can neither reject nor hang: a thrown error or a
 * RESOLVE_TIMEOUT_MS overrun yields the builtin fallback for that visual.
 * The promise is created eagerly, so it must never settle unhandled while
 * the caller is awaiting an earlier one.
 */
function resolveSafely(visual, excludeNames) {
  const attempt = resolveVisual(visual, excludeNames).catch(err => {
    console.warn('[shape-service] resolveVisual failed:', err.message);
    return builtinShape(visual);
  });
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      console.warn(`[shape-service] "${visual && visual.iconic}" timed out after ${RESOLVE_TIMEOUT_MS} ms — using builtin fallback`);
      resolve(builtinShape(visual));
    }, RESOLVE_TIMEOUT_MS);
  });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Async generator: resolves all visuals concurrently and yields each shape
 * in input order the moment it (and every earlier one) is ready. Dedupes by
 * resolved name — on a collision the visual is re-resolved with the taken
 * names excluded so the tier fallthrough can find an alternative. Caps at `max`.
 */
async function* streamConceptShapes(visuals, max = 3) {
  if (!Array.isArray(visuals) || visuals.length === 0) return;

  const pending = visuals.map(v => resolveSafely(v, new Set()));
  const seen = new Set();
  let yielded = 0;

  for (let i = 0; i < visuals.length && yielded < max; i++) {
    let resolved = await pending[i];
    if (seen.has(resolved.name)) {
      resolved = await resolveSafely(visuals[i], new Set(seen));
      if (seen.has(resolved.name)) continue;
    }
    seen.add(resolved.name);
    yielded++;
    yield resolved;
  }
}

/**
 * Map an array of Haiku visuals to renderable shapes (non-streaming callers).
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

module.exports = {
  resolveVisual,
  mapConceptsToShapes,
  streamConceptShapes,
  normalizeBuiltin,
  BUILTIN_NAMES,
  EMBEDDING_THRESHOLD,
};
