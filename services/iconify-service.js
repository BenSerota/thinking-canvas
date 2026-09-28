/**
 * Iconify Service
 *
 * Resolves a free-form iconic concept (e.g., "octopus", "teacup") to a
 * path-based single-color SVG pulled from api.iconify.design (~200,000
 * icons across 150+ sets: Material Symbols, Tabler, Phosphor, Lucide,
 * Heroicons, Carbon, MDI, Game Icons, and more).
 *
 * Pipeline (cache-miss path):
 *   1. GET /search?query={q}&limit=8           — ranked icons + collection metadata
 *   2. Filter results by:
 *        - License in LICENSE_WHITELIST
 *        - collections[prefix].palette === false  (single-color, not multicolor emoji)
 *        - collections[prefix].tags does not include "Uses Stroke"
 *   3. GET /{prefix}/{name}.svg for the top-ranked passing results (max 4)
 *   4. Sanitize (see sanitizeSvg); if rejected, try the next candidate
 *   5. Write to public/shapes/iconify-cache/{kebab}.svg + return
 *
 * Cache-hit path: public/shapes/iconify-cache/{kebab}.svg exists → return the
 * URL without calling the API. Confirmed misses are remembered in memory for
 * NEGATIVE_TTL_MS so repeat concepts don't re-pay the search round-trip.
 *
 * Non-blocking by design: every call has a hard timeout AND a byte cap on
 * the body (enforced while streaming, not after buffering). On any failure
 * the function returns null and the shape-service falls through.
 */

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const { toKebab } = require('./utils');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'public', 'shapes', 'iconify-cache');
const CACHE_URL_PREFIX = '/shapes/iconify-cache';

// Iconify public API (Cloudflare-fronted, free, unauthenticated)
const API_BASE = 'https://api.iconify.design';
const FETCH_TIMEOUT_MS = 2000;
const MAX_SVG_BYTES = 20_000;
const MAX_SEARCH_BYTES = 200_000;
const SEARCH_LIMIT = 8;
const MAX_CANDIDATE_FETCHES = 4;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

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

// concept kebab → timestamp of the last confirmed miss
const negativeCache = new Map();

function isNegativelyCached(kebab) {
  const at = negativeCache.get(kebab);
  if (at === undefined) return false;
  if (Date.now() - at > NEGATIVE_TTL_MS) {
    negativeCache.delete(kebab);
    return false;
  }
  return true;
}

/** Read a fetch body with a byte cap enforced as chunks arrive. */
async function readCapped(res, maxBytes, controller) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new Error(`body too large (${declared} > ${maxBytes} bytes)`);
  }
  if (!res.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`body exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch with a hard timeout and byte cap. Returns { ok, status, text } or throws. */
async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_SVG_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await readCapped(res, maxBytes, controller);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Sanitizer ───

const ALLOWED_ELEMENTS = new Set(['svg', 'g', 'path']);
const FORBIDDEN_ATTRS = new Set(['style', 'transform', 'href', 'xlink:href']);
// Presentation attributes the client rasterizer reads; resolved through the
// group hierarchy and written directly on each path so the output has no
// groups at all.
const INHERITED_ATTRS = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];

function localName(el) {
  return String(el.localName || el.tagName || '').split(':').pop().toLowerCase();
}

function parseViewBox(value) {
  const parts = String(value || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return parts;
}

function resolveAttr(el, name) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const v = node.getAttribute(name);
    if (v != null && v !== '') return v;
  }
  return null;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sanitize an SVG string by parsing it and re-serializing only what the
 * rasterizer needs: a viewBox and <path> elements with resolved presentation
 * attributes. Returns the clean string, or null if rejected.
 *
 * Rejects: anything that isn't svg/g/path (so <a>, <set>, <use>, <script>,
 * <style>, <image>, <foreignObject>, <animate*>, <defs>, <mask>, <text>…),
 * any on* / style / transform / href attribute, DOCTYPE/entities, a missing
 * or malformed viewBox, oversize bodies, and files with no visible path.
 *
 * Drops: paths whose effective fill is `none` and that have no stroke — the
 * invisible bounding-box placeholders some sets (mingcute) emit, which the
 * fill rasterizer would otherwise render as a speck or a solid square.
 */
function sanitizeSvg(svg) {
  if (!svg) return null;
  const trimmed = svg.trimStart();
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<svg')) return null;
  if (svg.length > MAX_SVG_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return null;

  let doc;
  try {
    doc = new DOMParser({
      onError: (level, msg) => { if (level === 'fatalError') throw new Error(msg); },
    }).parseFromString(svg, 'image/svg+xml');
  } catch (_) {
    return null;
  }
  const root = doc.documentElement;
  if (!root || localName(root) !== 'svg') return null;
  const viewBox = parseViewBox(root.getAttribute('viewBox'));
  if (!viewBox) return null;

  const paths = [];
  const walk = (el) => {
    if (!ALLOWED_ELEMENTS.has(localName(el))) throw new Error('element not allowed');
    for (let i = 0; i < el.attributes.length; i++) {
      const name = el.attributes[i].name.toLowerCase();
      if (name.startsWith('on') || FORBIDDEN_ATTRS.has(name)) throw new Error('attribute not allowed');
    }
    if (localName(el) === 'path') paths.push(el);
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) walk(c);
    }
  };
  try {
    walk(root);
  } catch (_) {
    return null;
  }

  const out = [];
  for (const p of paths) {
    const d = (p.getAttribute('d') || '').trim();
    if (!d) continue;
    const fill = resolveAttr(p, 'fill');
    const stroke = resolveAttr(p, 'stroke');
    const hasStroke = Boolean(stroke) && stroke !== 'none';
    const invisible = fill === 'none' || resolveAttr(p, 'opacity') === '0' || resolveAttr(p, 'fill-opacity') === '0';
    if (invisible && !hasStroke) continue;
    const attrs = [`d="${escapeAttr(d)}"`];
    for (const name of INHERITED_ATTRS) {
      const v = resolveAttr(p, name);
      if (v != null) attrs.push(`${name}="${escapeAttr(v)}"`);
    }
    out.push(`<path ${attrs.join(' ')}/>`);
  }
  if (out.length === 0) return null;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}">${out.join('')}</svg>`;
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
 * or null on any failure (fall through to the next tier).
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

  // 2. Remembered miss — skip the search round-trip
  if (isNegativelyCached(kebab)) return null;

  // 3. Search Iconify
  let searchJson;
  try {
    const url = `${API_BASE}/search?query=${encodeURIComponent(iconic)}&limit=${SEARCH_LIMIT}`;
    const res = await fetchWithTimeout(url, { maxBytes: MAX_SEARCH_BYTES });
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
    negativeCache.set(kebab, Date.now());
    return null;
  }

  // 4. Walk ranked results; first one that passes pre-filter AND sanitize wins
  let fetched = 0;
  for (const id of icons) {
    if (fetched >= MAX_CANDIDATE_FETCHES) break;
    const sep = id.indexOf(':');
    if (sep < 0) continue;
    const prefix = id.slice(0, sep);
    const iconName = id.slice(sep + 1);
    if (!passesPreFilter(prefix, collections)) continue;

    let svg;
    try {
      fetched++;
      const res = await fetchWithTimeout(`${API_BASE}/${prefix}/${iconName}.svg`);
      if (!res.ok) continue;
      svg = res.text;
    } catch (err) {
      console.warn(`[iconify] fetch ${prefix}:${iconName} failed:`, err.message);
      continue;
    }

    const clean = sanitizeSvg(svg);
    if (!clean) continue;

    // 5. Cache to disk under the original concept's kebab so future lookups
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
  negativeCache.set(kebab, Date.now());
  return null;
}

module.exports = {
  findAndCache,
  sanitizeSvg,
  CACHE_DIR,
  CACHE_URL_PREFIX,
  LICENSE_WHITELIST,
};
