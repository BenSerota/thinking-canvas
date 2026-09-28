#!/usr/bin/env node
/**
 * fetch-emoji.js
 *
 * Populates the OpenMoji emoji tier:
 *   1. Downloads OpenMoji's release metadata (`openmoji.json`, ~2 MB)
 *   2. Downloads `openmoji-svg-black.zip` from the latest release (~3 MB)
 *   3. Extracts black/line-art SVGs to `public/shapes/emoji/{HEXCODE}.svg`
 *   4. Writes `data/emoji-catalog.json` with just the fields we need:
 *        { hexcode, emoji, annotation, tags, group }
 *      Skintone variants are dropped — they all resolve to the same base
 *      silhouette, and our renderer draws black line art so skin color is
 *      moot. Catalog has ~2,400 entries after filtering.
 *
 * License:
 *   OpenMoji — CC-BY-SA 4.0 (© HfG Schwäbisch Gmünd / openmoji.org).
 *   Using the `black` (line-art) set. Note that "line art" is not
 *   "stroke-only": about a quarter of the files also contain filled
 *   geometry (eye dots, letter glyphs), most use basic shapes
 *   (<circle>/<rect>/<line>…), and ~5% carry transforms. The client loader
 *   (public/js/shapes.js → loadExternalShape) routes every element by its
 *   own resolved fill/stroke and honours transforms; the per-file `render`
 *   metadata recorded below documents what each file contains.
 *
 * Idempotent: checks `data/emoji-catalog.json` ↔ release tag; skips work if
 * already up to date — before any network call. Delete the catalog file to
 * force a re-fetch.
 *
 * The release is pinned (DEFAULT_TAG) so builds are reproducible and need
 * no GitHub API call. `OPENMOJI_TAG=latest` discovers the newest release
 * through the API (set GITHUB_TOKEN to lift the 60 req/h anonymous limit).
 * The zip is extracted with adm-zip — no system `unzip` dependency.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');

const GEOM_TAGS = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);

/** Nearest declared attribute up the ancestor chain (SVG inheritance). */
function resolveAttr(el, name) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const v = node.getAttribute(name);
    if (v != null && v !== '') return v.trim();
  }
  return null;
}

/**
 * Summarise what the client loader will find in an SVG: how many geometry
 * elements, what share of them are stroke-only, and whether any transform
 * is present. Purely informational — the loader dispatches per element.
 */
function describeSvg(svgText) {
  const doc = new DOMParser({ onError() {} }).parseFromString(svgText, 'image/svg+xml');
  const els = [];
  const walk = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (GEOM_TAGS.has(String(node.localName || node.tagName).toLowerCase())) els.push(node);
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(doc.documentElement);
  let strokeOnly = 0;
  for (const el of els) {
    const fill = resolveAttr(el, 'fill');
    const stroke = resolveAttr(el, 'stroke');
    if (fill === 'none' && stroke && stroke !== 'none') strokeOnly++;
  }
  return {
    geomCount: els.length,
    strokeOnlyRatio: els.length ? +(strokeOnly / els.length).toFixed(2) : 0,
    hasTransform: /\btransform\s*=/.test(svgText),
  };
}

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'shapes', 'emoji');
const CATALOG_PATH = path.join(ROOT, 'data', 'emoji-catalog.json');

const RELEASE_API = 'https://api.github.com/repos/hfg-gmuend/openmoji/releases/latest';
// Pinned OpenMoji release. Bump deliberately; `OPENMOJI_TAG=latest` asks the
// GitHub API for the newest one instead.
const DEFAULT_TAG = '16.0.0';
// The default asset name from OpenMoji releases.
const ASSET_NAME = 'openmoji-svg-black.zip';
const assetUrl = (tag) => `https://github.com/hfg-gmuend/openmoji/releases/download/${tag}/${ASSET_NAME}`;
const metadataUrl = (tag) => `https://raw.githubusercontent.com/hfg-gmuend/openmoji/${tag}/data/openmoji.json`;

function githubHeaders() {
  const headers = { 'user-agent': 'thinking-canvas/fetch-emoji' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** True when the catalog already matches `tag` and the SVGs are on disk. */
function isUpToDate(tag) {
  if (!fs.existsSync(CATALOG_PATH)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    if (existing.releaseTag !== tag || !existing.emoji || existing.emoji.length === 0) return false;
    const svgCount = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.svg')).length;
    if (svgCount < existing.emoji.length * 0.95) return false;
    console.log(`[fetch-emoji] up to date — ${existing.emoji.length} emoji catalogued against release ${tag}, ${svgCount} SVGs on disk.`);
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'data'))) fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) Resolve the release tag. The pinned default needs no API call at all.
  let tag = process.env.OPENMOJI_TAG || DEFAULT_TAG;
  if (tag !== 'latest' && isUpToDate(tag)) return;
  if (tag === 'latest') {
    console.log('[fetch-emoji] querying latest OpenMoji release...');
    const release = await fetchJson(RELEASE_API);
    tag = release.tag_name;
    if (isUpToDate(tag)) return;
  }

  // 2) Fetch metadata (annotations, tags, groups) for exactly this release.
  console.log(`[fetch-emoji] fetching openmoji.json metadata for ${tag}...`);
  const rawCatalog = await fetchJson(metadataUrl(tag));
  console.log(`[fetch-emoji]   ${rawCatalog.length} raw entries`);

  // 3) Download the SVG zip & extract to a staging tmp dir, then copy into OUT_DIR.
  console.log(`[fetch-emoji] downloading ${ASSET_NAME} for ${tag}...`);
  const zipBuf = await fetchBuffer(assetUrl(tag));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmoji-'));
  console.log(`[fetch-emoji] extracting ${Math.round(zipBuf.length / 1024 / 1024)} MB to ${tmpDir}...`);
  new AdmZip(zipBuf).extractAllTo(tmpDir, true);

  // The zip extracts to a `black/svg/` subdir (or directly into tmpDir on
  // some builds). Find the directory containing hex-named SVGs.
  let svgSrc = null;
  const walk = (dir, depth) => {
    if (svgSrc || depth > 4) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const anyHexSvg = entries.some(e => e.isFile() && /^[0-9A-F][0-9A-F-]+\.svg$/i.test(e.name));
    if (anyHexSvg) { svgSrc = dir; return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(tmpDir, 0);
  if (!svgSrc) throw new Error('Could not locate hex-named SVGs in the unzipped OpenMoji release');

  // 4) Filter + copy. Skip skintone variants (same silhouette as base emoji).
  //    Each kept SVG is copied verbatim (viewBox-correct as shipped) and
  //    described so the catalog records what the loader will encounter.
  const catalog = [];
  let copied = 0, skippedSkintone = 0, missingSvg = 0;
  for (const entry of rawCatalog) {
    if (entry.skintone && entry.skintone !== '') { skippedSkintone++; continue; }
    const fname = `${entry.hexcode}.svg`;
    const src = path.join(svgSrc, fname);
    if (!fs.existsSync(src)) { missingSvg++; continue; }
    const dst = path.join(OUT_DIR, fname);
    fs.copyFileSync(src, dst);
    let render = null;
    try {
      render = describeSvg(fs.readFileSync(src, 'utf-8'));
    } catch (_) {
      // Metadata is best-effort; the file itself is what matters.
    }
    catalog.push({
      hexcode: entry.hexcode,
      emoji: entry.emoji,
      annotation: entry.annotation,
      tags: entry.tags,
      group: entry.group,
      render,
    });
    copied++;
  }

  // 5) Write catalog — keep releaseTag so subsequent runs can skip.
  fs.writeFileSync(CATALOG_PATH, JSON.stringify({
    releaseTag: tag,
    fetchedAt: new Date().toISOString(),
    license: 'CC-BY-SA-4.0',
    attribution: 'OpenMoji (https://openmoji.org) — the open-source emoji and icon project. License: CC BY-SA 4.0',
    emoji: catalog,
  }, null, 2));

  // Clean up the tmp dir.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log(`[fetch-emoji] done — ${copied} emoji catalogued to ${CATALOG_PATH}`);
  console.log(`  skipped skintone variants: ${skippedSkintone}`);
  console.log(`  missing SVG files:         ${missingSvg}`);
  console.log(`  release tag:               ${tag}`);
}

main().catch(err => {
  console.error('[fetch-emoji] failed:', err.message);
  process.exit(1);
});
