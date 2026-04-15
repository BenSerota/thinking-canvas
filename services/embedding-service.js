/**
 * Embedding Service
 *
 * Thin wrapper around @xenova/transformers — runs MiniLM-L6-v2 locally
 * to produce 384-dim normalized sentence embeddings. No external API.
 *
 * Model files (~30 MB) cache in node_modules/@xenova/transformers on first run.
 * Subsequent loads are instant.
 */

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384;

let pipePromise = null;

/**
 * Lazy-load the feature-extraction pipeline. First call triggers model download.
 * Cached after first successful load.
 */
async function getPipeline() {
  if (!pipePromise) {
    pipePromise = (async () => {
      // Dynamic import — transformers.js is ESM-only
      const { pipeline } = await import('@xenova/transformers');
      const pipe = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true, // int8 weights, ~4x smaller model
      });
      return pipe;
    })().catch((err) => {
      // Reset so next call retries
      pipePromise = null;
      throw err;
    });
  }
  return pipePromise;
}

/**
 * Embed a single string → normalized 384-dim Float32Array.
 * Uses mean pooling + L2 normalization (MiniLM's recommended recipe).
 */
async function embed(text) {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array of length 384
  return output.data;
}

/**
 * Embed an array of strings in one pipeline call.
 * Much faster than repeated single-embed calls for bulk processing.
 */
async function embedBatch(texts) {
  const pipe = await getPipeline();
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  // output.data is a flat Float32Array of length texts.length * 384
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    const start = i * EMBED_DIM;
    vectors.push(output.data.slice(start, start + EMBED_DIM));
  }
  return vectors;
}

module.exports = {
  embed,
  embedBatch,
  EMBED_DIM,
  MODEL_NAME,
};
