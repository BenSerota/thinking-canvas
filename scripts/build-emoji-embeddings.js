#!/usr/bin/env node
/**
 * build-emoji-embeddings.js
 *
 * Reads `data/emoji-catalog.json` (written by fetch-emoji.js) and embeds each
 * entry's `annotation + tags` text with MiniLM-L6-v2 — the same model used
 * for library-embeddings.json. Writes `data/emoji-embeddings.json` (~8 MB for
 * ~2,400 entries).
 *
 * Why this file exists separately from library-embeddings: different catalog,
 * different source, different refresh cadence. Emoji updates ~twice a year
 * with Unicode releases; library updates whenever we bump FA/Material.
 *
 * Idempotent: if the output file matches the catalog's releaseTag, skip.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'emoji-catalog.json');
const OUT_PATH = path.join(ROOT, 'data', 'emoji-embeddings.json');
const BATCH_SIZE = 32;

const embeddingService = require('../services/embedding-service');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
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

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error('[build-emoji-embeddings] catalog missing — run `node scripts/fetch-emoji.js` first.');
    process.exit(1);
  }

  const catalogText = fs.readFileSync(CATALOG_PATH, 'utf-8');
  const catalog = JSON.parse(catalogText);
  const catalogChecksum = sha256(catalogText);

  if (fs.existsSync(OUT_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
      if (existing.catalogChecksum === catalogChecksum) {
        console.log('[build-emoji-embeddings] up to date — nothing to do.');
        return;
      }
      console.log('[build-emoji-embeddings] catalog changed — rebuilding...');
    } catch (_) { /* fall through to rebuild */ }
  }

  const entries = catalog.emoji;
  console.log(`[build-emoji-embeddings] embedding ${entries.length} emoji via ${embeddingService.MODEL_NAME}...`);

  const start = Date.now();
  const out = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const texts = batch.map(embedText);
    const vecs = await embeddingService.embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      out.push({
        hexcode: batch[j].hexcode,
        embedding: Array.from(vecs[j]),  // Float32Array → plain array for JSON
      });
    }
    if ((i / BATCH_SIZE) % 10 === 0) {
      const pct = Math.round(((i + batch.length) / entries.length) * 100);
      console.log(`[build-emoji-embeddings]   ${i + batch.length}/${entries.length} (${pct}%)`);
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    releaseTag: catalog.releaseTag,
    model: embeddingService.MODEL_NAME,
    dim: embeddingService.EMBED_DIM,
    catalogChecksum,
    builtAt: new Date().toISOString(),
    entries: out,
  }));

  const secs = Math.round((Date.now() - start) / 1000);
  console.log(`[build-emoji-embeddings] done — ${out.length} embeddings written to ${OUT_PATH} in ${secs}s`);
}

main().catch(err => {
  console.error('[build-emoji-embeddings] failed:', err.message);
  process.exit(1);
});
