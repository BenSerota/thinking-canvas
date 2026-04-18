/**
 * Icon Matcher
 *
 * Resolves a free-form iconic concept (e.g., "top hat", "electron orbit") to
 * the closest matching SVG in public/shapes/library/.
 *
 * Resolution order:
 *   1. Exact kebab match         ("top hat" → "top-hat.svg" if present)
 *   2. Cosine embedding match    (MiniLM-L6-v2, threshold 0.55)
 *   3. null                      (caller handles fallback)
 *
 * Runtime-registered icons (from svg-generator) are appended to the in-memory
 * set so future requests benefit from the cache.
 */

const fs = require('fs');
const path = require('path');
const embeddingService = require('./embedding-service');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'public', 'shapes', 'library-manifest.json');
const EMBEDDINGS_PATH = path.join(ROOT, 'data', 'library-embeddings.json');
// Generated-SVG cache directory — versioned so prompt changes bypass the old
// cache without manual cleanup. Kept in sync with svg-generator.js
// GENERATED_SUBDIR constant; changing the version there requires bumping
// PROMPT_VERSION and the old files become dead weight on disk (safe to delete).
const GENERATED_DIR = path.join(ROOT, 'public', 'shapes', 'generated-v3');

const DEFAULT_THRESHOLD = 0.55;

// In-memory state, populated on first init() call
const state = {
  ready: false,
  initPromise: null,
  // Parallel arrays, one entry per icon
  names: [],           // ["top-hat", "home", ...]
  sources: [],         // ["fa-solid", "material", "generated", ...]
  vectors: [],         // Float32Array[] — pre-normalized unit vectors
  nameToIdx: new Map(), // "top-hat" → index
};

/** Convert free-form text to kebab-case for exact-match lookup. */
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
 * Initialize the matcher — loads manifest + embeddings into memory.
 * Safe to call multiple times; actual work runs once.
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
    if (!fs.existsSync(EMBEDDINGS_PATH)) {
      console.warn('[icon-matcher] no embeddings found — library matching disabled. Run `npm run build-embeddings`.');
      state.ready = true;
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const embData = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf-8'));

    // Build source lookup from manifest
    const sourceByName = new Map();
    for (const ic of manifest.icons) sourceByName.set(ic.name, ic.source);

    // Join embeddings to manifest
    for (const entry of embData.entries) {
      const name = entry.name;
      const vec = new Float32Array(entry.embedding);
      // Vectors are already L2-normalized by the embedding service, but double-check
      state.names.push(name);
      state.sources.push(sourceByName.get(name) || 'unknown');
      state.vectors.push(vec);
      state.nameToIdx.set(name, state.names.length - 1);
    }

    // Scan GENERATED_DIR (versioned, currently `public/shapes/generated-v2/`)
    // for previously-cached generations and add them to the exact-match set.
    // Their embeddings get computed lazily on first embedding-match call if needed.
    // Old unversioned `generated/` directories from prior prompt versions are
    // deliberately NOT scanned — bumping the version effectively wipes the cache.
    if (fs.existsSync(GENERATED_DIR)) {
      for (const f of fs.readdirSync(GENERATED_DIR)) {
        if (!f.endsWith('.svg')) continue;
        const name = f.replace(/\.svg$/, '');
        if (!state.nameToIdx.has(name)) {
          // Register as exact-match only; no embedding yet
          state.nameToIdx.set(name, -1);
        }
      }
    }

    state.ready = true;
    console.log(`[icon-matcher] ready: ${state.names.length} embedded icons + ${state.nameToIdx.size - state.names.length} generated`);
  })();

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

  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < state.vectors.length; i++) {
    const score = dot(queryVec, state.vectors[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < threshold) return null;

  return {
    name: state.names[bestIdx],
    score: bestScore,
    source: state.sources[bestIdx],
  };
}

/**
 * Called by svg-generator after it successfully generates and caches a new SVG.
 * Adds the name to the matcher so repeated requests hit the cache.
 *
 * If embedding is provided, the generated icon participates in cosine search too.
 */
async function registerGenerated(name, displayName, embedding = null) {
  await init();
  const kebab = toKebab(name);
  if (state.nameToIdx.has(kebab)) return; // already registered

  if (embedding) {
    state.names.push(kebab);
    state.sources.push('generated');
    state.vectors.push(embedding instanceof Float32Array ? embedding : new Float32Array(embedding));
    state.nameToIdx.set(kebab, state.names.length - 1);
  } else {
    // Register for exact-match only
    state.nameToIdx.set(kebab, -1);
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
