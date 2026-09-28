# Third-party licenses

The Thinking Canvas source code is MIT-licensed (see `LICENSE`). The visual assets it ships or fetches are not — each source below keeps its own license, and the attribution in this file must travel with any redistribution of `public/shapes/`.

## Emoji line art — OpenMoji

`public/shapes/emoji/*.svg` (tracked in git) are the "black" line-art set from [OpenMoji](https://openmoji.org) — the open-source emoji and icon project by HfG Schwäbisch Gmünd. **License: CC BY-SA 4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>). The files are copied unmodified; the per-file metadata in `data/emoji-catalog.json` is derived from OpenMoji's `openmoji.json`.

## Icon library — Font Awesome Free and Material Symbols

`public/shapes/library/*.svg` (gitignored, produced by `npm run setup-icons`) are cleaned copies of:

- **Font Awesome Free** (`@fortawesome/fontawesome-free`, solid style). Icons: **CC BY 4.0** (<https://fontawesome.com/license/free>) — attribution required; fonts: SIL OFL 1.1; code: MIT. Search metadata from `metadata/icon-families.json` is used for embedding text.
- **Material Symbols** (`@material-symbols/svg-400`, filled style) by Google. **Apache License 2.0** (<https://www.apache.org/licenses/LICENSE-2.0>).

## Iconify sets (runtime cache)

`public/shapes/iconify-cache/*.svg` (gitignored) are fetched on demand from <https://api.iconify.design>. Only sets with an open license are accepted (MIT, Apache-2.0, OFL-1.1, CC0-1.0, CC-BY-3.0/4.0, CC-BY-SA-4.0, ISC, BSD). Every cached icon has a sidecar `<name>.json` recording the set prefix, icon name, set author and license, so attribution can be produced per icon.

## Lottie animations

`public/shapes/lottie/*.json` are authored by this project (`scripts/generate-lottie-assets.js`) and are MIT like the code. They are rendered with **lottie-web** (`public/js/vendor/lottie_light.min.js`), MIT, © Airbnb.

## Fonts

The particle titles use **Love Light** from Google Fonts, SIL Open Font License 1.1.

## Models

Chat, extraction and SVG generation call the Anthropic API (Claude). Local retrieval uses `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (Apache-2.0).
