#!/usr/bin/env node
/**
 * build-embeddings.js
 *
 * Reads public/shapes/library-manifest.json, computes a 384-dim MiniLM
 * embedding for each icon's displayName, writes the full matrix to
 * data/library-embeddings.json (~15 MB for ~5,500 icons).
 *
 * Idempotent: if the output file already exists AND its manifest checksum
 * matches the current manifest, skips the rebuild.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'public', 'shapes', 'library-manifest.json');
const OUT_PATH = path.join(ROOT, 'data', 'library-embeddings.json');
const BATCH_SIZE = 32;

const embeddingService = require('../services/embedding-service');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[build-embeddings] manifest missing — run `npm run fetch-icons` first.');
    process.exit(1);
  }

  const manifestText = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const manifest = JSON.parse(manifestText);
  const manifestChecksum = sha256(manifestText);

  // Skip if already built with same checksum
  if (fs.existsSync(OUT_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
      if (existing.manifestChecksum === manifestChecksum) {
        console.log('[build-embeddings] up to date — nothing to do.');
        return;
      }
      console.log('[build-embeddings] manifest changed — rebuilding...');
    } catch (_) {
      // malformed — fall through to rebuild
    }
  }

  console.log(`[build-embeddings] embedding ${manifest.icons.length} icons via ${embeddingService.MODEL_NAME}...`);
  console.log('[build-embeddings] first run will download the model (~30 MB)...');

  const entries = [];
  let done = 0;
  const startTime = Date.now();

  for (let i = 0; i < manifest.icons.length; i += BATCH_SIZE) {
    const batch = manifest.icons.slice(i, i + BATCH_SIZE);
    const texts = batch.map(ic => ic.displayName);

    const vectors = await embeddingService.embedBatch(texts);

    for (let j = 0; j < batch.length; j++) {
      entries.push({
        name: batch[j].name,
        embedding: Array.from(vectors[j]), // Float32Array → plain array for JSON
      });
    }

    done += batch.length;
    if (done % 320 === 0 || done === manifest.icons.length) {
      const pct = ((done / manifest.icons.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${done}/${manifest.icons.length} (${pct}%) — ${elapsed}s elapsed`);
    }
  }

  const output = {
    model: embeddingService.MODEL_NAME,
    dim: embeddingService.EMBED_DIM,
    manifestChecksum,
    generatedAt: new Date().toISOString(),
    entries,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));

  const sizeMB = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[build-embeddings] done. ${entries.length} vectors × ${output.dim} dims = ${sizeMB} MB in ${totalSec}s`);
  console.log(`[build-embeddings] wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch(err => {
  console.error('[build-embeddings] failed:', err);
  process.exit(1);
});
