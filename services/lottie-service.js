/**
 * Lottie Service
 *
 * Resolves iconic concepts to Lottie animation files.
 *
 * Two tiers:
 *   A. Bundled (instant): hand-curated animations in public/shapes/lottie/
 *      with a manifest-driven tag match. No network, no latency.
 *   B. LottieFiles API (cache-miss): searches the LottieFiles REST API,
 *      downloads the Lottie JSON, validates, and caches locally. 2s timeout.
 *
 * Returns { name, url, source, type: 'lottie' } or null.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUNDLED_DIR = path.join(ROOT, 'public', 'shapes', 'lottie');
const CACHE_DIR = path.join(ROOT, 'public', 'shapes', 'lottie-cache');
const MANIFEST_PATH = path.join(BUNDLED_DIR, 'manifest.json');

const API_BASE = 'https://lottiefiles.com/api';
const FETCH_TIMEOUT_MS = 2000;
const MAX_JSON_BYTES = 100_000;
const MAX_LAYERS = 50;

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ── Tier A: Bundled manifest ──

let manifest = null;
let tagIndex = new Map(); // tag → slug

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
      for (const tag of entry.tags || []) {
        tagIndex.set(tag.toLowerCase(), slug);
      }
      tagIndex.set(slug.toLowerCase(), slug);
    }
    console.log(`[lottie-service] manifest loaded: ${Object.keys(manifest).length} bundled animations`);
  } catch (err) {
    console.warn('[lottie-service] manifest parse failed:', err.message);
    manifest = {};
  }
}

function toKebab(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function matchBundled(iconic) {
  loadManifest();
  const key = toKebab(iconic);
  if (!key) return null;

  // Exact tag match
  if (tagIndex.has(key)) {
    const slug = tagIndex.get(key);
    return {
      name: slug,
      url: `/shapes/lottie/${manifest[slug].file}`,
      source: 'lottie-bundled',
      type: 'lottie',
    };
  }

  // Substring match: check if any tag is contained in the iconic or vice versa
  for (const [tag, slug] of tagIndex) {
    if (key.includes(tag) || tag.includes(key)) {
      return {
        name: slug,
        url: `/shapes/lottie/${manifest[slug].file}`,
        source: 'lottie-bundled',
        type: 'lottie',
      };
    }
  }

  return null;
}

// ── Tier B: LottieFiles API search ──

async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ThinkingCanvas/1.0' },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function validateLottieJson(jsonStr) {
  if (!jsonStr || jsonStr.length > MAX_JSON_BYTES) return null;
  try {
    const data = JSON.parse(jsonStr);
    if (!data.v || !data.layers || !Array.isArray(data.layers)) return null;
    if (data.layers.length > MAX_LAYERS) return null;
    if (typeof data.w !== 'number' || typeof data.h !== 'number') return null;
    return jsonStr;
  } catch {
    return null;
  }
}

async function searchAPI(iconic) {
  const kebab = toKebab(iconic);
  if (!kebab) return null;

  // Disk cache hit
  const cachePath = path.join(CACHE_DIR, `${kebab}.json`);
  if (fs.existsSync(cachePath)) {
    console.log(`[lottie-service] API cache hit: ${kebab}.json`);
    return {
      name: kebab,
      url: `/shapes/lottie-cache/${kebab}.json`,
      source: 'lottie-api',
      type: 'lottie',
    };
  }

  // Search the LottieFiles API
  try {
    const searchUrl = `${API_BASE}/search/get-animations?query=${encodeURIComponent(iconic)}&limit=5&format=json`;
    const res = await fetchWithTimeout(searchUrl);
    if (!res.ok) {
      console.warn(`[lottie-service] API search HTTP ${res.status} for "${iconic}"`);
      return null;
    }

    const searchData = JSON.parse(res.text);
    const items = searchData?.data?.data?.data
      || searchData?.data?.data
      || [];

    if (!Array.isArray(items) || items.length === 0) {
      console.log(`[lottie-service] API: no results for "${iconic}"`);
      return null;
    }

    // Try each result until one passes validation
    for (const item of items) {
      const lottieUrl = item.lottieUrl || item.jsonUrl || item.lottie;
      if (!lottieUrl) continue;

      try {
        const dlRes = await fetchWithTimeout(lottieUrl, { timeoutMs: 3000 });
        if (!dlRes.ok) continue;
        const valid = validateLottieJson(dlRes.text);
        if (!valid) continue;

        fs.writeFileSync(cachePath, valid, 'utf-8');
        console.log(`[lottie-service] API: cached "${iconic}" → ${kebab}.json`);
        return {
          name: kebab,
          url: `/shapes/lottie-cache/${kebab}.json`,
          source: 'lottie-api',
          type: 'lottie',
        };
      } catch (err) {
        continue;
      }
    }

    console.log(`[lottie-service] API: no usable result for "${iconic}"`);
  } catch (err) {
    console.warn(`[lottie-service] API search failed for "${iconic}":`, err.message);
  }

  return null;
}

// ── Public API ──

async function findAnimation(iconic) {
  // Tier A: bundled
  const bundled = matchBundled(iconic);
  if (bundled) {
    console.log(`[lottie-service] bundled match: "${iconic}" → ${bundled.name}`);
    return bundled;
  }

  // Tier B: LottieFiles API (best-effort, may be blocked by Cloudflare)
  const api = await searchAPI(iconic);
  if (api) return api;

  return null;
}

module.exports = {
  findAnimation,
  matchBundled,
  loadManifest,
  CACHE_DIR,
};
