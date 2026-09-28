/**
 * Emoji Service
 *
 * Resolves a free-form iconic concept (e.g., "wild hair", "double helix",
 * "sound wave") to a single OpenMoji black/line-art SVG. These silhouettes
 * were drawn by professional illustrators and cover ~2,400 concepts — a
 * much richer and cleaner source than the LLM-authored SVG generator, and
 * a better aesthetic ("brush on canvas") than the filled library icons
 * when paired with the stroke-following rasterizer in public/js/shapes.js
 * (particlesFromGeomElements).
 *
 * Matching: MiniLM-L6-v2 cosine similarity between the concept and each
 * emoji's `annotation + tags` embedding (pre-built by
 * scripts/build-emoji-embeddings.js into data/emoji-embeddings.json).
 *
 * Pipeline position: tier 4 in shape-service.js resolveVisual — after the
 * curated, exact-library and bundled-Lottie tiers, BEFORE the online
 * Iconify search and the local library embedding match. The rationale:
 *   - Exact/curated icons first: a precise hit must beat a fuzzy one.
 *   - Emoji before Iconify, because for "vibes" concepts (wild hair, DNA,
 *     sound wave) the hand-drawn line art is the best silhouette we have,
 *     and the noun-overlap gate keeps its fuzziness honest.
 *   - Iconify and the library matcher after, as general fallbacks for
 *     concepts the emoji catalog doesn't cover with confidence.
 *
 * License: OpenMoji is CC-BY-SA 4.0. Attribution is included in
 * data/emoji-catalog.json and must be preserved in downstream distribution.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'emoji-catalog.json');
const EMBEDDINGS_PATH = path.join(ROOT, 'data', 'emoji-embeddings.json');
const INDEX_PATH = path.join(ROOT, 'data', 'emoji-embeddings.index.json');
const VECTORS_PATH = path.join(ROOT, 'data', 'emoji-embeddings.f32');
const SVG_DIR_URL = '/shapes/emoji';

// Emoji tier threshold. (The library matcher runs at 0.60 — see
// shape-service.js EMBEDDING_THRESHOLD — but its candidates have no
// noun-overlap gate, so it needs the stricter cut.) A lower threshold
// means more emoji hits but potentially worse specificity.
const DEFAULT_THRESHOLD = 0.55;

const embeddingService = require('./embedding-service');

const state = {
  ready: false,
  initPromise: null,
  // Parallel arrays. hexcodes[i] ↔ vectors[i] ↔ annotations[i].
  hexcodes: [],
  emojis: [],
  annotations: [],
  tags: [],
  vectors: [],       // Float32Array[], L2-normalized unit vectors
};

// Stopwords dropped when extracting "content words" for the noun-overlap
// safety check below. Intentionally tiny — MiniLM handles nuanced semantics,
// and this list exists only to catch egregious false positives where the
// concept shares an adjective with an unrelated emoji (e.g. "wild hair" →
// "wildfire", both containing "wild").
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'with', 'on', 'in', 'at', 'to',
  'for', 'from', 'by', 'is', 'are', 'was', 'be', 'as', 'it',
]);

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Noun-overlap gate: given a concept and an emoji's (annotation, tags),
 * require that the concept's *last* content word appears in the emoji's
 * text. The last word is almost always the head noun in English
 * ("wild HAIR", "blue DRESS", "sound WAVE", "double HELIX") — we care
 * whether the emoji is about that noun.
 *
 * Catches classics like "wild hair" → "wildfire" (shares "wild"), where
 * cosine is high (0.64) but the semantic overlap is with the wrong word.
 *
 * Single-word concepts always pass (nothing to disambiguate against).
 */
function passesNounOverlap(concept, emojiText) {
  const cwords = contentWords(concept);
  if (cwords.length < 2) return true;
  const headNoun = cwords[cwords.length - 1];
  const et = String(emojiText || '').toLowerCase();
  return et.includes(headNoun);
}

/**
 * Initialize — loads catalog + embeddings into memory once. Subsequent
 * calls return the same in-flight promise.
 *
 * Logs a single warning if either file is missing, leaving the service
 * in a "ready, but empty" state so callers can safely invoke findBestMatch
 * and receive null without crashing the pipeline.
 */
async function init() {
  if (state.ready) return;
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    if (!fs.existsSync(CATALOG_PATH)) {
      console.warn('[emoji-service] catalog missing — emoji tier disabled.');
      state.ready = true;
      return;
    }

    const catalog = JSON.parse(await fs.promises.readFile(CATALOG_PATH, 'utf-8'));
    const byHex = new Map();
    for (const e of catalog.emoji) byHex.set(e.hexcode, e);

    if (fs.existsSync(INDEX_PATH) && fs.existsSync(VECTORS_PATH)) {
      const index = JSON.parse(await fs.promises.readFile(INDEX_PATH, 'utf-8'));
      const buf = await fs.promises.readFile(VECTORS_PATH);
      const expectedBytes = index.count * index.dim * 4;

      if (buf.length === expectedBytes) {
        const allVectors = new Float32Array(buf.buffer, buf.byteOffset, index.count * index.dim);
        for (let i = 0; i < index.count; i++) {
          const hexcode = index.hexcodes[i];
          const meta = byHex.get(hexcode);
          if (!meta) continue;
          state.hexcodes.push(hexcode);
          state.emojis.push(meta.emoji);
          state.annotations.push(meta.annotation);
          state.tags.push(meta.tags || '');
          state.vectors.push(allVectors.subarray(i * index.dim, (i + 1) * index.dim));
        }
        state.ready = true;
        console.log(`[emoji-service] ready (binary) — ${state.hexcodes.length} emoji indexed (OpenMoji ${catalog.releaseTag})`);
        return;
      }
      console.warn('[emoji-service] binary file size mismatch, falling back to JSON');
    }

    if (!fs.existsSync(EMBEDDINGS_PATH)) {
      console.warn('[emoji-service] embeddings missing — emoji tier disabled.');
      state.ready = true;
      return;
    }

    const embData = JSON.parse(await fs.promises.readFile(EMBEDDINGS_PATH, 'utf-8'));
    for (const entry of embData.entries) {
      const meta = byHex.get(entry.hexcode);
      if (!meta) continue;
      state.hexcodes.push(entry.hexcode);
      state.emojis.push(meta.emoji);
      state.annotations.push(meta.annotation);
      state.tags.push(meta.tags || '');
      state.vectors.push(new Float32Array(entry.embedding));
    }
    state.ready = true;
    console.log(`[emoji-service] ready (json) — ${state.hexcodes.length} emoji indexed (OpenMoji ${catalog.releaseTag})`);
  })().catch(err => {
    state.initPromise = null;
    throw err;
  });

  return state.initPromise;
}

/** Cosine similarity between two unit-length Float32Array vectors. */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Find the best-matching emoji for a concept string.
 * Returns `{ hexcode, emoji, annotation, url, score }` or null if the
 * best match fell below `threshold`.
 *
 * URL format: `/shapes/emoji/{HEXCODE}.svg` — loadExternalShape on the
 * client will auto-dispatch to the stroke-following rasterizer because
 * OpenMoji black SVGs are stroke-only.
 */
async function findBestMatch(concept, { threshold = DEFAULT_THRESHOLD } = {}) {
  await init();
  if (state.hexcodes.length === 0) return null;
  const text = String(concept || '').trim();
  if (!text) return null;

  const queryVec = await embeddingService.embed(text);

  // Scan top-K candidates (not just argmax) so the noun-overlap gate has
  // something to fall through to if the cosine-best pick is a false
  // positive. K=8 is plenty — if the eighth candidate also fails, the
  // concept genuinely doesn't have a good emoji and we should let the
  // pipeline fall through.
  const K = 8;
  const scored = new Array(state.vectors.length);
  for (let i = 0; i < state.vectors.length; i++) {
    scored[i] = { idx: i, score: cosine(queryVec, state.vectors[i]) };
  }
  // Partial sort: we only need the top K, but N=2400 is small so a full
  // sort stays well under 1 ms.
  scored.sort((a, b) => b.score - a.score);

  for (let k = 0; k < Math.min(K, scored.length); k++) {
    const { idx, score } = scored[k];
    if (score < threshold) break;  // rest are worse; no point continuing

    const emojiText = `${state.annotations[idx]} ${state.tags[idx]}`;
    if (!passesNounOverlap(text, emojiText)) continue;

    const hexcode = state.hexcodes[idx];
    return {
      hexcode,
      emoji: state.emojis[idx],
      annotation: state.annotations[idx],
      url: `${SVG_DIR_URL}/${hexcode}.svg`,
      score,
    };
  }
  return null;
}

module.exports = {
  init,
  findBestMatch,
  DEFAULT_THRESHOLD,
};
