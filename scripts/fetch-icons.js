#!/usr/bin/env node
/**
 * fetch-icons.js
 *
 * Bulk-copies SVG icons from the two installed icon packages into
 *   public/shapes/library/{kebab-name}.svg
 *
 * Sources:
 *   Font Awesome Free (Solid) → node_modules/@fortawesome/fontawesome-free/svgs/solid/*.svg
 *   Material Symbols Filled  → node_modules/@material-symbols/svg-400/outlined/*-fill.svg
 *
 * Filter rules — reject any SVG that:
 *   - has no <path d="...">
 *   - has a <g transform="..."> wrapping paths (rasterizer ignores transforms)
 *   - has stroke but no fill (our rasterizer only fills)
 *   - has no valid viewBox
 *
 * Dedupe: on filename collision, Material Symbols wins. MS icons are simpler
 * flat silhouettes with fewer decorative subpaths, so at our 300px particle
 * rasterization they read as coherent shapes. FA icons often encode visible
 * seams (basketball, car wheels, skull eye sockets) which scale up to wide
 * voids at our render size; we fall back to them only when MS has no match.
 *
 * Output:
 *   public/shapes/library/{kebab}.svg
 *   public/shapes/library-manifest.json  — list of icon metadata
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'public', 'shapes', 'library');
const MANIFEST_PATH = path.join(ROOT, 'public', 'shapes', 'library-manifest.json');

const FA_DIR = path.join(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free', 'svgs', 'solid');
const MS_DIR = path.join(ROOT, 'node_modules', '@material-symbols', 'svg-400', 'outlined');

/** Convert arbitrary name to kebab-case. */
function toKebab(name) {
  return name
    .replace(/\.svg$/i, '')
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Humanize a kebab name for embedding ("top-hat" → "top hat"). */
function humanize(kebab) {
  return kebab.replace(/-/g, ' ');
}

// Font Awesome ships a label + search terms per icon ("hat-wizard" →
// "accessory, costume, fantasy, halloween, mage, magic, witch, wizard…").
// Embedding them alongside the display name makes retrieval far less
// literal. Material Symbols ships no such metadata.
const FA_META_PATH = path.join(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free', 'metadata', 'icon-families.json');
let faMeta = {};
try {
  faMeta = JSON.parse(fs.readFileSync(FA_META_PATH, 'utf-8'));
} catch (_) {
  console.warn('[fetch-icons] Font Awesome metadata not found — embeddings will use display names only');
}

function faSearchText(kebab) {
  const entry = faMeta[kebab];
  if (!entry) return '';
  const parts = [];
  if (typeof entry.label === 'string') parts.push(entry.label);
  const terms = entry.search && entry.search.terms;
  if (Array.isArray(terms)) for (const t of terms) if (typeof t === 'string') parts.push(t);
  return parts.join(', ');
}

/**
 * Fast structural check — returns { ok: boolean, reason?: string } without
 * full XML parsing (we do that at load time anyway, just need to filter here).
 */
function validateSvg(text) {
  // Must have a viewBox (otherwise rasterizer falls back to 0 0 100 100 which may crop)
  if (!/viewBox\s*=\s*["'][^"']+["']/i.test(text)) {
    return { ok: false, reason: 'no viewBox' };
  }

  // Must have at least one <path d="...">
  if (!/<path\b[^>]*\bd\s*=\s*["'][^"']+["']/i.test(text)) {
    return { ok: false, reason: 'no <path d=...>' };
  }

  // Reject any <g transform=...> wrapping paths (our rasterizer ignores transforms)
  if (/<g\b[^>]*\btransform\s*=/i.test(text)) {
    return { ok: false, reason: 'has <g transform=...>' };
  }

  // Reject path elements that stroke but don't fill
  // (attribute-scoped check — stroke="..." but no fill="..." on same tag)
  const pathTags = text.match(/<path\b[^>]*>/gi) || [];
  for (const tag of pathTags) {
    const hasStroke = /\bstroke\s*=\s*["'][^"']*["']/i.test(tag)
      && !/\bstroke\s*=\s*["']none["']/i.test(tag);
    const hasFillNone = /\bfill\s*=\s*["']none["']/i.test(tag);
    if (hasStroke && hasFillNone) {
      return { ok: false, reason: 'stroke without fill' };
    }
  }

  return { ok: true };
}

/** Strip a source SVG down to viewBox + paths only, for consistent loader behavior. */
function cleanSvg(text) {
  // Extract viewBox
  const vbMatch = text.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 100 100';

  // Extract path `d` attributes
  const pathTags = text.match(/<path\b[^>]*>/gi) || [];
  const paths = pathTags
    .map(tag => {
      const m = tag.match(/\bd\s*=\s*["']([^"']+)["']/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  if (paths.length === 0) return null;

  const pathXml = paths.map(d => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${pathXml}</svg>`;
}

/**
 * Collect candidate icons from a source directory.
 * nameTransform: function that takes raw filename (e.g. "home-fill.svg") and
 * returns either a normalized kebab-case name or null to skip.
 */
function collectIcons(dir, nameTransform) {
  if (!fs.existsSync(dir)) {
    console.warn(`  source missing: ${dir}`);
    return [];
  }

  const icons = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.svg'));

  for (const file of files) {
    const kebab = nameTransform(file);
    if (!kebab) continue;

    // Skip names that start with a digit — they're usually numeric glyphs,
    // not semantic concepts, and Haiku won't embed them meaningfully.
    if (/^\d/.test(kebab)) continue;

    // Skip single/double-letter names — too generic
    if (kebab.length < 3) continue;

    const srcPath = path.join(dir, file);
    const raw = fs.readFileSync(srcPath, 'utf-8');

    const check = validateSvg(raw);
    if (!check.ok) {
      // Silently skip — filter misses happen for a handful
      continue;
    }

    const cleaned = cleanSvg(raw);
    if (!cleaned) continue;

    icons.push({ name: kebab, displayName: humanize(kebab), cleaned });
  }

  return icons;
}

function main() {
  console.log('[fetch-icons] starting...');

  // Clear previous library contents so reruns are clean
  if (fs.existsSync(LIB_DIR)) {
    for (const f of fs.readdirSync(LIB_DIR)) {
      if (f.endsWith('.svg')) fs.unlinkSync(path.join(LIB_DIR, f));
    }
  } else {
    fs.mkdirSync(LIB_DIR, { recursive: true });
  }

  // 1. Font Awesome Solid — all files, just strip .svg
  console.log('[fetch-icons] scanning Font Awesome Solid...');
  const faIcons = collectIcons(FA_DIR, (file) => {
    return toKebab(file);
  }).map(i => ({ ...i, source: 'fa-solid', searchText: faSearchText(i.name) }));
  console.log(`  → ${faIcons.length} valid Font Awesome icons`);

  // 2. Material Symbols Filled — only *-fill.svg, strip "-fill" suffix
  console.log('[fetch-icons] scanning Material Symbols Filled...');
  const msIcons = collectIcons(MS_DIR, (file) => {
    if (!file.endsWith('-fill.svg')) return null;
    return toKebab(file.replace(/-fill\.svg$/, ''));
  }).map(i => ({ ...i, source: 'material', searchText: '' }));
  console.log(`  → ${msIcons.length} valid Material Symbols icons`);

  // 3. Merge, preferring Material Symbols on name collision (see header comment).
  const seen = new Map();
  for (const icon of msIcons) seen.set(icon.name, icon);
  let faAddedCount = 0;
  for (const icon of faIcons) {
    if (!seen.has(icon.name)) {
      seen.set(icon.name, icon);
      faAddedCount++;
    }
  }
  console.log(`[fetch-icons] merged: ${msIcons.length} MS + ${faAddedCount} unique FA = ${seen.size} total`);

  // 4. Write cleaned SVGs and build manifest
  const manifest = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    count: seen.size,
    icons: [],
  };

  for (const icon of seen.values()) {
    const outPath = path.join(LIB_DIR, `${icon.name}.svg`);
    fs.writeFileSync(outPath, icon.cleaned, 'utf-8');
    manifest.icons.push({
      name: icon.name,
      displayName: icon.displayName,
      source: icon.source,
      searchText: icon.searchText || '',
    });
  }

  // Alphabetize for readability
  manifest.icons.sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`[fetch-icons] done. ${seen.size} icons written to public/shapes/library/`);
  console.log(`[fetch-icons] manifest at ${path.relative(ROOT, MANIFEST_PATH)}`);
}

main();
