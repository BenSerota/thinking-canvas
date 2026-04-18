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
 *   Using the `black` (line-art) set because our stroke-following rasterizer
 *   (public/js/shapes.js → particlesFromGeomElements) expects stroke geometry
 *   with fill="none".
 *
 * Idempotent: checks `data/emoji-catalog.json` ↔ release tag; skips work if
 * already up to date. Delete the catalog file to force a re-fetch.
 *
 * Requires the system `unzip` (macOS/Linux: pre-installed; Windows: WSL or
 * install via choco/winget) — we avoid pulling in a pure-JS zip dep.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'shapes', 'emoji');
const CATALOG_PATH = path.join(ROOT, 'data', 'emoji-catalog.json');

const RELEASE_API = 'https://api.github.com/repos/hfg-gmuend/openmoji/releases/latest';
const METADATA_URL = 'https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/data/openmoji.json';
// The default asset name from OpenMoji releases.
const ASSET_NAME = 'openmoji-svg-black.zip';

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'thinking-canvas/fetch-emoji', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'thinking-canvas/fetch-emoji' } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'data'))) fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) Find the latest release + the specific zip asset we want.
  console.log('[fetch-emoji] querying latest OpenMoji release...');
  const release = await fetchJson(RELEASE_API);
  const tag = release.tag_name;
  const asset = (release.assets || []).find(a => a.name === ASSET_NAME);
  if (!asset) throw new Error(`No asset named ${ASSET_NAME} in release ${tag}`);

  // Skip if we already have a catalog matching this tag.
  if (fs.existsSync(CATALOG_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
      if (existing.releaseTag === tag && existing.emoji && existing.emoji.length > 0) {
        const svgCount = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.svg')).length;
        if (svgCount >= existing.emoji.length * 0.95) {
          console.log(`[fetch-emoji] up to date — ${existing.emoji.length} emoji catalogued against release ${tag}, ${svgCount} SVGs on disk.`);
          return;
        }
      }
    } catch (_) { /* fall through to rebuild */ }
  }

  // 2) Fetch metadata (annotations, tags, groups).
  console.log('[fetch-emoji] fetching openmoji.json metadata...');
  const rawCatalog = await fetchJson(METADATA_URL);
  console.log(`[fetch-emoji]   ${rawCatalog.length} raw entries`);

  // 3) Download the SVG zip & extract to a staging tmp dir, then copy into OUT_DIR.
  console.log(`[fetch-emoji] downloading ${ASSET_NAME} (~${Math.round(asset.size / 1024 / 1024)} MB)...`);
  const zipBuf = await fetchBuffer(asset.browser_download_url);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmoji-'));
  const zipPath = path.join(tmpDir, ASSET_NAME);
  fs.writeFileSync(zipPath, zipBuf);
  console.log(`[fetch-emoji] unzipping to ${tmpDir}...`);
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmpDir], { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`unzip failed — install the system 'unzip' utility: ${e.message}`);
  }

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
  //    Each kept SVG is copied verbatim — OpenMoji files are already viewBox-
  //    correct with stroke-only paths that our new stroke rasterizer handles.
  const catalog = [];
  let copied = 0, skippedSkintone = 0, missingSvg = 0;
  for (const entry of rawCatalog) {
    if (entry.skintone && entry.skintone !== '') { skippedSkintone++; continue; }
    const fname = `${entry.hexcode}.svg`;
    const src = path.join(svgSrc, fname);
    if (!fs.existsSync(src)) { missingSvg++; continue; }
    const dst = path.join(OUT_DIR, fname);
    fs.copyFileSync(src, dst);
    catalog.push({
      hexcode: entry.hexcode,
      emoji: entry.emoji,
      annotation: entry.annotation,
      tags: entry.tags,
      group: entry.group,
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
