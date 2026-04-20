/**
 * Iconify Service
 *
 * Resolves a free-form iconic concept (e.g., "octopus", "teacup") to a
 * path-based single-color SVG pulled from api.iconify.design.
 *
 * Runs BEFORE the local icon-matcher in shape-service.resolveVisual, so a
 * successful Iconify hit preempts our embedding-based library lookup. This
 * gives us ~200,000 icons across 150+ sets (Material Symbols, Tabler,
 * Phosphor, Lucide, Heroicons, Carbon, MDI, Game Icons, and more) instead
 * of just the 5,497 FA Solid + Material Symbols icons in our local library.
 *
 * Pipeline (cache-miss path):
 *   1. GET /search?query={q}&limit=8           — returns ranked icons + collection metadata
 *   2. Filter results by:
 *        - License in LICENSE_WHITELIST (commercial-safe OSS)
 *        - collections[prefix].palette === false  (single-color, not multicolor emoji)
 *        - collections[prefix].tags does not include "Uses Stroke" (our rasterizer
 *          renders fills only; stroke-only icons would vanish)
 *   3. GET /{prefix}/{name}.svg for the top-ranked passing result
 *   4. Sanitize (see sanitizeSvg below); if rejected, try the next candidate
 *   5. Write to public/shapes/iconify-cache/{kebab}.svg + return
 *
 * Cache-hit path: check public/shapes/iconify-cache/{kebab}.svg → return the
 * URL without calling the API.
 *
 * Non-blocking by design: all calls are wrapped in a 2-second AbortController
 * timeout. On timeout/network error, the function returns null and the
 * shape-service falls through to the local matcher.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'public', 'shapes', 'iconify-cache');
const CACHE_URL_PREFIX = '/shapes/iconify-cache';

// Iconify public API (Cloudflare-fronted, free, unauthenticated)
const API_BASE = 'https://api.iconify.design';
const FETCH_TIMEOUT_MS = 2000;
const MAX_SVG_BYTES = 20_000;
const SEARCH_LIMIT = 8;

// Commercial-safe OSS licenses only. Iconify exposes the SPDX ID per set in
// the search response (collections[prefix].license.spdx). We exclude
// share-alike (CC-BY-SA) and non-commercial (CC-BY-NC*) because shipping a
// derivative under a proprietary-compatible license conflicts with the
// share-alike clause.
const LICENSE_WHITELIST = new Set([
  'MIT',
  'Apache-2.0',
  'OFL-1.1',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
]);

// Ensure cache dir exists on module load (cheap, idempotent)
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const { toKebab } = require('./utils');

/** Fetch with a hard timeout. Returns { ok, status, text } or throws on timeout/network. */
async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sanitize an SVG string. Returns the original string if clean, null if
 * rejected. Defensive — Iconify is usually trustworthy but we never cache
 * anything that can't be rasterized by our path-only parser or that could
 * introduce security risk.
 */
function sanitizeSvg(svg) {
  if (!svg) return null;
  // Must look like an SVG at the top (guards against HTML error pages being cached)
  const trimmed = svg.trimStart();
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<svg')) return null;
  if (svg.length > MAX_SVG_BYTES) return null;

  // Security + rasterizer-compatibility rejects
  if (/<script\b/i.test(svg)) return null;
  if (/<foreignObject\b/i.test(svg)) return null;
  if (/<image\b/i.test(svg)) return null;
  if (/<style\b/i.test(svg)) return null;
  if (/<animate/i.test(svg)) return null;
  if (/\bon\w+\s*=/i.test(svg)) return null;
  if (/xlink:href\s*=\s*["']https?:/i.test(svg)) return null;
  if (/href\s*=\s*["']https?:/i.test(svg)) return null;

  // Our rasterizer (public/js/shapes.js loadExternalShape) only processes
  // <path> elements. No <path> = nothing to render.
  if (!/<path\b/i.test(svg)) return null;

  // MVP: reject any <g transform>. Many Iconify sets use transforms for
  // grid-aligned layout; those render mis-scaled / mis-positioned because our
  // loadExternalShape ignores transforms. Log and fall through so the caller
  // tries the next candidate.
  if (/<g\s+[^>]*\btransform\s*=/i.test(svg)) return null;

  return svg;
}

/**
 * Decide whether a search-result entry passes our pre-filters (license,
 * palette, stroke-tag). Called before we spend a network round-trip on the
 * SVG body.
 */
function passesPreFilter(prefix, collections) {
  const col = collections && collections[prefix];
  if (!col) return false;
  const spdx = col.license && col.license.spdx;
  if (!spdx || !LICENSE_WHITELIST.has(spdx)) return false;
  // Multicolor emoji sets (palette: true) render as a blob through our
  // single-fill rasterizer. Skip.
  if (col.palette === true) return false;
  // Stroke-only sets (e.g., hugeicons) render as nothing through our fill-
  // based rasterizer. Skip.
  const tags = col.tags || [];
  if (tags.includes('Uses Stroke')) return false;
  return true;
}

/**
 * Given an iconic concept, try to find and cache an Iconify SVG for it.
 * Returns { name, url, prefix, license, source: 'iconify' } on success,
 * or null on any failure (fall through to matcher).
 *
 * The caller (shape-service.resolveVisual) treats null as "no match" and
 * continues to the next step in the resolution ladder.
 */
async function findAndCache(iconic) {
  const kebab = toKebab(iconic);
  if (!kebab) return null;

  // 1. Disk cache hit — no network
  const cachePath = path.join(CACHE_DIR, `${kebab}.svg`);
  if (fs.existsSync(cachePath)) {
    console.log(`[iconify] "${iconic}" → cache hit ${kebab}.svg`);
    return {
      name: kebab,
      url: `${CACHE_URL_PREFIX}/${kebab}.svg`,
      prefix: null, // unknown on cache hit
      license: null,
      source: 'iconify',
    };
  }

  // 2. Search Iconify
  let searchJson;
  try {
    const url = `${API_BASE}/search?query=${encodeURIComponent(iconic)}&limit=${SEARCH_LIMIT}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.warn(`[iconify] search HTTP ${res.status} for "${iconic}"`);
      return null;
    }
    searchJson = JSON.parse(res.text);
  } catch (err) {
    console.warn(`[iconify] search failed for "${iconic}":`, err.message);
    return null;
  }

  const icons = Array.isArray(searchJson.icons) ? searchJson.icons : [];
  const collections = searchJson.collections || {};
  if (icons.length === 0) {
    console.log(`[iconify] "${iconic}" → no match`);
    return null;
  }

  // 3. Walk ranked results; first one that passes pre-filter AND sanitize wins
  for (const id of icons) {
    const sep = id.indexOf(':');
    if (sep < 0) continue;
    const prefix = id.slice(0, sep);
    const iconName = id.slice(sep + 1);
    if (!passesPreFilter(prefix, collections)) continue;

    let svg;
    try {
      const url = `${API_BASE}/${prefix}/${iconName}.svg`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      svg = res.text;
    } catch (err) {
      console.warn(`[iconify] fetch ${prefix}:${iconName} failed:`, err.message);
      continue;
    }

    const clean = sanitizeSvg(svg);
    if (!clean) {
      // Quiet — we iterate; a common reason (transforms, strokes) happens often
      continue;
    }

    // 4. Cache to disk under the original concept's kebab so future lookups
    //    hit step 1. Not the icon's own name — we key on user intent.
    try {
      fs.writeFileSync(cachePath, clean, 'utf-8');
    } catch (err) {
      console.warn(`[iconify] cache write failed for "${iconic}":`, err.message);
      return null;
    }

    const license = (collections[prefix] && collections[prefix].license && collections[prefix].license.title) || 'unknown';
    console.log(`[iconify] "${iconic}" → ${prefix}:${iconName} (${license})`);
    return {
      name: kebab,
      url: `${CACHE_URL_PREFIX}/${kebab}.svg`,
      prefix,
      license,
      source: 'iconify',
    };
  }

  console.log(`[iconify] "${iconic}" → no usable match (${icons.length} candidates filtered out)`);
  return null;
}

module.exports = {
  findAndCache,
  // Exported for tests and for resolveVisual debugging
  CACHE_DIR,
  CACHE_URL_PREFIX,
  LICENSE_WHITELIST,
};
