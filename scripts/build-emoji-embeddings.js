#!/usr/bin/env node
/**
 * build-emoji-embeddings.js
 *
 * Reads `data/emoji-catalog.json` (written by fetch-emoji.js) and embeds each
 * entry's `annotation + tags` text with MiniLM-L6-v2 — the same model used
 * for the icon library. Writes:
 *   data/emoji-embeddings.index.json  — hexcodes + checksum (tiny)
 *   data/emoji-embeddings.f32         — raw Float32 matrix (zero-parse)
 *   data/emoji-embeddings.json        — same data as JSON (fallback)
 *
 * Why this file exists separately from build-embeddings: different catalog,
 * different source, different refresh cadence. Emoji updates ~twice a year
 * with Unicode releases; library updates whenever we bump FA/Material.
 *
 * The binaries are written first, each to a temp file renamed into place,
 * and the JSON last — a crash can never leave a fresh JSON next to a stale
 * matrix. Idempotent: skips when the index's checksum and count match the
 * current catalog and the matrix has the expected size.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'emoji-catalog.json');
const OUT_PATH = path.join(DATA_DIR, 'emoji-embeddings.json');
const INDEX_PATH = path.join(DATA_DIR, 'emoji-embeddings.index.json');
const VECTORS_PATH = path.join(DATA_DIR, 'emoji-embeddings.f32');
const BATCH_SIZE = 32;

const embeddingService = require('../services/embedding-service');
const EMBED_DIM = embeddingService.EMBED_DIM;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * Build the text we embed per emoji. We combine the canonical annotation
 * with the keyword tags so a query like "wild hair" can match against
 * "person with curly hair" even if the exact annotation is different —
 * the tags carry the semantic bridge.
 *
 * Keep short; MiniLM truncates at ~256 tokens and the first ~40 words
 * matter most.
 */
function embedText(entry) {
  const annotation = (entry.annotation || '').trim();
  const tags = (entry.tags || '').trim();
  return tags ? `${annotation}, ${tags}` : annotation;
}

function isUpToDate(catalog, catalogChecksum) {
  try {
    if (!fs.existsSync(INDEX_PATH) || !fs.existsSync(VECTORS_PATH) || !fs.existsSync(OUT_PATH)) return false;
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    if (index.catalogChecksum !== catalogChecksum) return false;
    if (index.count !== catalog.emoji.length || index.dim !== EMBED_DIM) return false;
    return fs.statSync(VECTORS_PATH).size === index.count * index.dim * 4;
  } catch (_) {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error('[build-emoji-embeddings] catalog missing — run `node scripts/fetch-emoji.js` first.');
    process.exit(1);
  }

  const catalogText = fs.readFileSync(CATALOG_PATH, 'utf-8');
  const catalog = JSON.parse(catalogText);
  const catalogChecksum = sha256(catalogText);

  if (isUpToDate(catalog, catalogChecksum)) {
    console.log('[build-emoji-embeddings] up to date — nothing to do.');
    return;
  }

  const entries = catalog.emoji;
  console.log(`[build-emoji-embeddings] embedding ${entries.length} emoji via ${embeddingService.MODEL_NAME}...`);

  const start = Date.now();
  const hexcodes = [];
  const vectorBuf = Buffer.alloc(entries.length * EMBED_DIM * 4);
  const out = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const vecs = await embeddingService.embedBatch(batch.map(embedText));
    for (let j = 0; j < batch.length; j++) {
      const vec = vecs[j];
      if (!vec || vec.length !== EMBED_DIM) {
        throw new Error(`embedding for ${batch[j].hexcode} has ${vec ? vec.length : 0} dims, expected ${EMBED_DIM}`);
      }
      const row = hexcodes.length;
      hexcodes.push(batch[j].hexcode);
      for (let k = 0; k < EMBED_DIM; k++) {
        vectorBuf.writeFloatLE(vec[k], (row * EMBED_DIM + k) * 4);
      }
      out.push({ hexcode: batch[j].hexcode, embedding: Array.from(vec) });
    }
    if ((i / BATCH_SIZE) % 10 === 0) {
      const pct = Math.round(((i + batch.length) / entries.length) * 100);
      console.log(`[build-emoji-embeddings]   ${i + batch.length}/${entries.length} (${pct}%)`);
    }
  }

  const builtAt = new Date().toISOString();

  writeAtomic(VECTORS_PATH, vectorBuf);
  writeAtomic(INDEX_PATH, JSON.stringify({
    format: 'binary-f32',
    version: 1,
    model: embeddingService.MODEL_NAME,
    dim: EMBED_DIM,
    count: hexcodes.length,
    catalogChecksum,
    builtAt,
    releaseTag: catalog.releaseTag,
    hexcodes,
  }));
  writeAtomic(OUT_PATH, JSON.stringify({
    releaseTag: catalog.releaseTag,
    model: embeddingService.MODEL_NAME,
    dim: EMBED_DIM,
    catalogChecksum,
    builtAt,
    entries: out,
  }));

  const secs = Math.round((Date.now() - start) / 1000);
  const binMB = (vectorBuf.length / 1024 / 1024).toFixed(1);
  console.log(`[build-emoji-embeddings] done — ${out.length} embeddings in ${secs}s; binary ${path.relative(ROOT, VECTORS_PATH)} (${binMB} MB)`);
}

main().catch(err => {
  console.error('[build-emoji-embeddings] failed:', err.message);
  process.exit(1);
});
