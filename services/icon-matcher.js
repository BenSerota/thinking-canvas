/**
 * Icon Matcher
 *
 * Resolves a free-form iconic concept (e.g., "top hat", "electron orbit") to
 * the closest matching SVG in public/shapes/library/ or the generated cache.
 *
 * Resolution order:
 *   1. Exact kebab match         ("top hat" → "top-hat.svg" if present)
 *   2. Cosine embedding match    (MiniLM-L6-v2 over display name + search
 *                                 terms; threshold set by the caller —
 *                                 shape-service.js uses EMBEDDING_THRESHOLD)
 *                                 scanned top-K with a head-noun gate: the
 *                                 concept's last content word must appear in
 *                                 the icon's text, so "bumpy head map" can't
 *                                 land on "tools flat head".
 *   3. null                      (caller handles fallback)
 *
 * Generated icons registered at runtime (svg-generator) join the cosine
 * search immediately and are persisted to data/generated-embeddings.json,
 * so they still take part after a restart.
 */

const fs = require('fs');
const path = require('path');
const embeddingService = require('./embedding-service');
const { toKebab } = require('./utils');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'public', 'shapes', 'library-manifest.json');
const EMBEDDINGS_PATH = path.join(ROOT, 'data', 'library-embeddings.json');
const INDEX_PATH = path.join(ROOT, 'data', 'library-embeddings.index.json');
const VECTORS_PATH = path.join(ROOT, 'data', 'library-embeddings.f32');
const GENERATED_EMBEDDINGS_PATH = path.join(ROOT, 'data', 'generated-embeddings.json');
// Generated-SVG cache directory — versioned so prompt changes bypass the old
// cache without manual cleanup. Kept in sync with svg-generator.js
// GENERATED_SUBDIR; bumping PROMPT_VERSION there requires bumping this too.
const GENERATED_DIR = path.join(ROOT, 'public', 'shapes', 'generated-v3');

const DEFAULT_THRESHOLD = 0.55;
const TOP_K = 8;

// Stopwords dropped when extracting "content words" for the noun-overlap
// gate. Intentionally tiny — MiniLM handles nuanced semantics; this only
// catches egregious false positives that share an adjective with an
// unrelated icon.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'with', 'on', 'in', 'at', 'to',
  'for', 'from', 'by', 'is', 'are', 'was', 'be', 'as', 'it',
]);

// In-memory state, populated on first init() call
const state = {
  ready: false,
  initPromise: null,
  // Parallel arrays, one entry per icon
  names: [],           // ["top-hat", "home", ...]
  sources: [],         // ["fa-solid", "material", "generated", ...]
  texts: [],           // lowercased display name + search terms, for the noun gate
  vectors: [],         // Float32Array[] — pre-normalized unit vectors
  nameToIdx: new Map(), // "top-hat" → index (-1 = exact-match only, no vector)
};

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Noun-overlap gate: the concept's *last* content word (almost always the
 * head noun in English — "wild HAIR", "bumpy head MAP") must appear in the
 * icon's text. Single-word concepts always pass.
 */
function passesNounOverlap(concept, iconText) {
  const words = contentWords(concept);
  if (words.length < 2) return true;
  return iconText.includes(words[words.length - 1]);
}

function pushIcon(name, source, text, vector) {
  state.names.push(name);
  state.sources.push(source);
  state.texts.push(String(text || name.replace(/-/g, ' ')).toLowerCase());
  state.vectors.push(vector);
  state.nameToIdx.set(name, state.names.length - 1);
}

function loadGeneratedEmbeddings() {
  if (!fs.existsSync(GENERATED_EMBEDDINGS_PATH)) return 0;
  let added = 0;
  try {
    const data = JSON.parse(fs.readFileSync(GENERATED_EMBEDDINGS_PATH, 'utf-8'));
    for (const entry of data.entries || []) {
      if (!entry || !entry.name || state.nameToIdx.has(entry.name)) continue;
      if (!Array.isArray(entry.embedding) || entry.embedding.length !== embeddingService.EMBED_DIM) continue;
      pushIcon(entry.name, 'generated', entry.iconic, new Float32Array(entry.embedding));
      added++;
    }
  } catch (err) {
    console.warn('[icon-matcher] generated-embeddings.json unreadable:', err.message);
  }
  return added;
}

/** Generated SVGs on disk without a persisted embedding: exact-match only. */
async function scanGeneratedDir() {
  if (!fs.existsSync(GENERATED_DIR)) return;
  for (const f of await fs.promises.readdir(GENERATED_DIR)) {
    if (!f.endsWith('.svg')) continue;
    const name = f.replace(/\.svg$/, '');
    if (!state.nameToIdx.has(name)) state.nameToIdx.set(name, -1);
  }
}

/**
 * Initialize the matcher — loads manifest + embeddings into memory.
 * Safe to call multiple times; actual work runs once. A failed init is not
 * cached — the next call retries.
 */
async function init() {
  if (state.ready) return;
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    if (!fs.existsSync(MANIFEST_PATH)) {
      console.warn('[icon-matcher] no manifest found — library matching disabled. Run `npm run fetch-icons`.');
      state.ready = true;
      return;
    }

    const manifest = JSON.parse(await fs.promises.readFile(MANIFEST_PATH, 'utf-8'));
    const byName = new Map();
    for (const ic of manifest.icons) byName.set(ic.name, ic);
    const textFor = (name) => {
      const ic = byName.get(name);
      if (!ic) return name.replace(/-/g, ' ');
      return ic.searchText ? `${ic.displayName} ${ic.searchText}` : ic.displayName;
    };
    const sourceFor = (name) => (byName.get(name) || {}).source || 'unknown';

    let loaded = false;
    if (fs.existsSync(INDEX_PATH) && fs.existsSync(VECTORS_PATH)) {
      const index = JSON.parse(await fs.promises.readFile(INDEX_PATH, 'utf-8'));
      const buf = await fs.promises.readFile(VECTORS_PATH);
      const expectedBytes = index.count * index.dim * 4;
      if (buf.length === expectedBytes) {
        const allVectors = new Float32Array(buf.buffer, buf.byteOffset, index.count * index.dim);
        for (let i = 0; i < index.count; i++) {
          const name = index.names[i];
          pushIcon(name, sourceFor(name), textFor(name), allVectors.subarray(i * index.dim, (i + 1) * index.dim));
        }
        loaded = true;
        console.log(`[icon-matcher] loaded binary: ${state.names.length} embedded icons`);
      } else {
        console.warn('[icon-matcher] binary file size mismatch, falling back to JSON');
      }
    }

    if (!loaded) {
      if (!fs.existsSync(EMBEDDINGS_PATH)) {
        console.warn('[icon-matcher] no embeddings found — library matching disabled. Run `npm run build-embeddings`.');
      } else {
        const embData = JSON.parse(await fs.promises.readFile(EMBEDDINGS_PATH, 'utf-8'));
        for (const entry of embData.entries) {
          pushIcon(entry.name, sourceFor(entry.name), textFor(entry.name), new Float32Array(entry.embedding));
        }
        console.log(`[icon-matcher] loaded json: ${state.names.length} embedded icons`);
      }
    }

    const generated = loadGeneratedEmbeddings();
    await scanGeneratedDir();
    state.ready = true;
    const exactOnly = state.nameToIdx.size - state.names.length;
    console.log(`[icon-matcher] ready: ${state.names.length} searchable (${generated} generated) + ${exactOnly} exact-only generated`);
  })().catch(err => {
    state.initPromise = null;
    throw err;
  });

  return state.initPromise;
}

/** Dot product of two same-length Float32Arrays. */
function dot(a, b) {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Find the best library match for an iconic concept.
 * Returns { name, score, source } or null if nothing meets the threshold.
 */
async function findBestMatch(iconic, { threshold = DEFAULT_THRESHOLD } = {}) {
  await init();
  if (state.names.length === 0 && state.nameToIdx.size === 0) return null;

  const kebab = toKebab(iconic);
  if (!kebab) return null;

  // 1. Exact kebab match (library or cached-generated)
  if (state.nameToIdx.has(kebab)) {
    const idx = state.nameToIdx.get(kebab);
    const source = idx >= 0 ? state.sources[idx] : 'generated';
    return { name: kebab, score: 1.0, source };
  }

  // 2. Embedding match (only if we have vectors loaded)
  if (state.vectors.length === 0) return null;

  let queryVec;
  try {
    queryVec = await embeddingService.embed(iconic);
  } catch (err) {
    console.warn('[icon-matcher] embedding failed for', iconic, err.message);
    return null;
  }

  // Keep the TOP_K best scores (insertion into a small sorted list) so the
  // noun gate has runners-up to fall through to.
  const top = [];
  for (let i = 0; i < state.vectors.length; i++) {
    const score = dot(queryVec, state.vectors[i]);
    if (top.length === TOP_K && score <= top[top.length - 1].score) continue;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].score < score) pos--;
    top.splice(pos, 0, { idx: i, score });
    if (top.length > TOP_K) top.pop();
  }

  for (const { idx, score } of top) {
    if (score < threshold) break;
    if (!passesNounOverlap(iconic, state.texts[idx])) continue;
    return { name: state.names[idx], score, source: state.sources[idx] };
  }
  return null;
}

/**
 * Called by svg-generator after it successfully generates and caches a new SVG.
 * Adds the icon to the matcher and persists its embedding so it takes part
 * in cosine search after a restart too.
 */
async function registerGenerated(name, displayName, embedding = null) {
  await init();
  const kebab = toKebab(name);
  if (state.nameToIdx.has(kebab) && state.nameToIdx.get(kebab) >= 0) return; // already searchable

  if (!embedding) {
    if (!state.nameToIdx.has(kebab)) state.nameToIdx.set(kebab, -1);
    return;
  }

  const vector = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  pushIcon(kebab, 'generated', displayName, vector);

  try {
    let data = { entries: [] };
    if (fs.existsSync(GENERATED_EMBEDDINGS_PATH)) {
      data = JSON.parse(fs.readFileSync(GENERATED_EMBEDDINGS_PATH, 'utf-8'));
      if (!Array.isArray(data.entries)) data.entries = [];
    }
    data.entries = data.entries.filter(e => e && e.name !== kebab);
    data.entries.push({ name: kebab, iconic: displayName, embedding: Array.from(vector) });
    fs.mkdirSync(path.dirname(GENERATED_EMBEDDINGS_PATH), { recursive: true });
    const tmp = `${GENERATED_EMBEDDINGS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, GENERATED_EMBEDDINGS_PATH);
  } catch (err) {
    console.warn('[icon-matcher] could not persist generated embedding:', err.message);
  }
}

/** Check if an icon exists in the library by exact kebab name. */
async function hasExactMatch(iconic) {
  await init();
  return state.nameToIdx.has(toKebab(iconic));
}

module.exports = {
  init,
  findBestMatch,
  registerGenerated,
  hasExactMatch,
  toKebab,
};
