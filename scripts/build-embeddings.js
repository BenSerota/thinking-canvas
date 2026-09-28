#!/usr/bin/env node
/**
 * build-embeddings.js
 *
 * Reads public/shapes/library-manifest.json, computes a 384-dim MiniLM
 * embedding for each icon's display name (see embedText for why the search
 * terms are deliberately not folded in), and writes:
 *   data/library-embeddings.index.json  — names + checksum (tiny)
 *   data/library-embeddings.f32         — raw Float32 matrix (zero-parse)
 *   data/library-embeddings.json        — same data as JSON (fallback)
 *
 * The binaries are written first, each to a temp file renamed into place,
 * and the JSON last — a crash can never leave a fresh JSON next to a stale
 * matrix. Idempotent: skips when the index's checksum and count match the
 * current manifest and the matrix has the expected size.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'public', 'shapes', 'library-manifest.json');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'library-embeddings.json');
const INDEX_PATH = path.join(DATA_DIR, 'library-embeddings.index.json');
const VECTORS_PATH = path.join(DATA_DIR, 'library-embeddings.f32');
const BATCH_SIZE = 32;

const embeddingService = require('../services/embedding-service');
const EMBED_DIM = embeddingService.EMBED_DIM;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/** Write via a temp file + rename so readers never see a partial file. */
function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * The embedded text is the display name only. Measured 2026-09-28: folding
 * the Font Awesome search terms into the same string dilutes direct matches
 * (query "wizard hat" vs hat-wizard: 0.93 name-only → 0.56 with all terms,
 * 0.66 with six). The terms are still used at runtime by icon-matcher's
 * noun-overlap gate. Follow-up: embed the terms as a second vector per icon
 * and score max(name, terms).
 */
function embedText(icon) {
  return icon.displayName;
}

function isUpToDate(manifest, manifestChecksum) {
  try {
    if (!fs.existsSync(INDEX_PATH) || !fs.existsSync(VECTORS_PATH) || !fs.existsSync(OUT_PATH)) return false;
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    if (index.manifestChecksum !== manifestChecksum) return false;
    if (index.count !== manifest.icons.length || index.dim !== EMBED_DIM) return false;
    return fs.statSync(VECTORS_PATH).size === index.count * index.dim * 4;
  } catch (_) {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[build-embeddings] manifest missing — run `npm run fetch-icons` first.');
    process.exit(1);
  }

  const manifestText = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const manifest = JSON.parse(manifestText);
  const manifestChecksum = sha256(manifestText);

  if (isUpToDate(manifest, manifestChecksum)) {
    console.log('[build-embeddings] up to date — nothing to do.');
    return;
  }

  console.log(`[build-embeddings] embedding ${manifest.icons.length} icons via ${embeddingService.MODEL_NAME}...`);
  console.log('[build-embeddings] first run will download the model (~30 MB)...');

  const names = [];
  const vectorBuf = Buffer.alloc(manifest.icons.length * EMBED_DIM * 4);
  const entries = [];
  let done = 0;
  const startTime = Date.now();

  for (let i = 0; i < manifest.icons.length; i += BATCH_SIZE) {
    const batch = manifest.icons.slice(i, i + BATCH_SIZE);
    const vectors = await embeddingService.embedBatch(batch.map(embedText));

    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j];
      if (!vec || vec.length !== EMBED_DIM) {
        throw new Error(`embedding for "${batch[j].name}" has ${vec ? vec.length : 0} dims, expected ${EMBED_DIM}`);
      }
      const row = names.length;
      names.push(batch[j].name);
      for (let k = 0; k < EMBED_DIM; k++) {
        vectorBuf.writeFloatLE(vec[k], (row * EMBED_DIM + k) * 4);
      }
      entries.push({ name: batch[j].name, embedding: Array.from(vec) });
    }

    done += batch.length;
    if (done % 320 === 0 || done === manifest.icons.length) {
      const pct = ((done / manifest.icons.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${done}/${manifest.icons.length} (${pct}%) — ${elapsed}s elapsed`);
    }
  }

  const generatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Binaries first (what the server actually loads), JSON fallback last.
  writeAtomic(VECTORS_PATH, vectorBuf);
  writeAtomic(INDEX_PATH, JSON.stringify({
    format: 'binary-f32',
    version: 1,
    model: embeddingService.MODEL_NAME,
    dim: EMBED_DIM,
    count: names.length,
    manifestChecksum,
    generatedAt,
    names,
  }));
  writeAtomic(OUT_PATH, JSON.stringify({
    model: embeddingService.MODEL_NAME,
    dim: EMBED_DIM,
    manifestChecksum,
    generatedAt,
    entries,
  }));

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const binMB = (vectorBuf.length / 1024 / 1024).toFixed(1);
  console.log(`[build-embeddings] done. ${names.length} vectors × ${EMBED_DIM} dims in ${totalSec}s`);
  console.log(`[build-embeddings] binary: ${path.relative(ROOT, VECTORS_PATH)} (${binMB} MB), index + JSON alongside`);
}

main().catch(err => {
  console.error('[build-embeddings] failed:', err.message);
  process.exit(1);
});
