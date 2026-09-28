/**
 * Lottie Service
 *
 * Resolves iconic concepts to the bundled Lottie animations in
 * public/shapes/lottie/ via a manifest-driven tag match. No network.
 *
 * Matching is whole-token only: the concept's kebab key must equal a tag,
 * or (for multi-word concepts) every word of the key must be a word of one
 * of the animation's tags. Substring matching was removed — it sent
 * "car" → heart (via "cardio"), "ship" → rocket, "art" → atom, etc.
 *
 * The LottieFiles API tier was removed: the endpoint returned HTTP 403 on
 * every call, carried no license data, fetched arbitrary URLs from the
 * search response, and could cache animations with remote image assets.
 *
 * Returns { name, url, source, type: 'lottie' } or null.
 */

const fs = require('fs');
const path = require('path');
const { toKebab } = require('./utils');

const ROOT = path.resolve(__dirname, '..');
const BUNDLED_DIR = path.join(ROOT, 'public', 'shapes', 'lottie');
const MANIFEST_PATH = path.join(BUNDLED_DIR, 'manifest.json');

let manifest = null;
const tagIndex = new Map();   // full tag (kebab) → slug
const slugWords = new Map();  // slug → Set of words across slug + tags

function loadManifest() {
  if (manifest) return;
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.warn('[lottie-service] no manifest found at', MANIFEST_PATH);
    manifest = {};
    return;
  }
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    for (const [slug, entry] of Object.entries(manifest)) {
      const words = new Set();
      const addTag = (tag) => {
        const key = toKebab(tag);
        if (!key) return;
        tagIndex.set(key, slug);
        for (const w of key.split('-')) if (w) words.add(w);
      };
      for (const tag of entry.tags || []) addTag(tag);
      addTag(slug);
      slugWords.set(slug, words);
    }
    console.log(`[lottie-service] manifest loaded: ${Object.keys(manifest).length} bundled animations`);
  } catch (err) {
    console.warn('[lottie-service] manifest parse failed:', err.message);
    manifest = {};
  }
}

function hit(slug) {
  return {
    name: slug,
    url: `/shapes/lottie/${manifest[slug].file}`,
    source: 'lottie-bundled',
    type: 'lottie',
  };
}

function matchBundled(iconic) {
  loadManifest();
  const key = toKebab(iconic);
  if (!key) return null;

  if (tagIndex.has(key)) return hit(tagIndex.get(key));

  // Multi-word concepts: every word must belong to the animation's tag
  // vocabulary ("dna double helix" → dna; "fire truck" → nothing, because
  // "truck" is not a fire word). Single words must match a tag exactly.
  const words = key.split('-').filter(Boolean);
  if (words.length < 2) return null;
  for (const [slug, vocab] of slugWords) {
    if (words.every(w => vocab.has(w))) return hit(slug);
  }
  return null;
}

async function findAnimation(iconic) {
  const bundled = matchBundled(iconic);
  if (bundled) console.log(`[lottie-service] bundled match: "${iconic}" → ${bundled.name}`);
  return bundled;
}

module.exports = {
  findAnimation,
  matchBundled,
  loadManifest,
};
