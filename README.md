# Thinking Canvas

An AI chat interface where 12,000 sand-grain particles form shapes that visualize Claude's thoughts in real time. As you talk, watch the canvas -- you'll see concepts take shape as particle silhouettes, animated Lottie figures, and flowing formations.

## How It Works

1. You send a message in the chat panel
2. Claude (Sonnet 5, adaptive thinking) starts replying while, in parallel from t=0, a visual concept extractor (Haiku 4.5) turns your message plus the recent conversation into three iconic objects
3. Each concept is resolved to a shape through a multi-tier pipeline: curated icons, exact library matches, bundled Lottie animations, OpenMoji emoji, Iconify web icons, local library matching, or on-demand SVG generation — the three resolve concurrently and stream to the canvas as they land
4. Particles flow from a hurricane formation into each resolved shape, then cycle through concepts before arranging on a carousel

## Setup

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

### Installation

```bash
git clone https://github.com/BenSerota/thinking-canvas.git
cd thinking-canvas
npm install
```

### Configuration

Copy the example environment file and add your API key:

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY
```

### Build Assets

The icon library and emoji embeddings must be built before the first run:

```bash
npm run setup-icons    # Downloads ~5,500 icons and builds embeddings (~60s)
npm run setup-emoji    # Downloads OpenMoji SVGs and builds embeddings (~30s)
```

Lottie animations are pre-built and tracked in git. To regenerate them:

```bash
npm run generate-lottie
```

### Run

```bash
npm start
# Open http://localhost:3000
```

## Shape Resolution Pipeline

Concepts are resolved in priority order:

| Tier | Source | Speed | Coverage |
|------|--------|-------|----------|
| 1 | Curated icon overrides | Instant | ~140 hand-picked concepts |
| 2 | Library exact match | Instant | ~5,500 icons |
| 3 | Bundled Lottie animations | Instant | 8 animations, whole-word tag match |
| 4 | OpenMoji emoji | ~50ms | ~2,400 line-art SVGs |
| 5 | Iconify web search | ~200-500ms (cached after) | ~200,000 icons |
| 6 | Library embedding match | ~100ms | ~5,500 icons |
| 7 | On-demand SVG generation (Opus 5) | ~10s, once per concept | Unlimited |
| 8 | Built-in fallback shapes | Instant | 30 basic shapes |

Each concept gets a 20 s budget; the three concepts of a turn resolve in parallel and never block the reply text.

## Project Structure

```
server.js              Express entry point
services/              Backend services (chat, shapes, icons, emoji, Lottie, SVG gen)
public/js/             Frontend modules (canvas physics, chat UI, shape rasterizer)
public/shapes/         Shape assets (curated, emoji, Lottie, generated caches)
scripts/               Build scripts for icons, emoji, and Lottie assets
```

## Licenses

The code is MIT (see `LICENSE`). The shape assets are not: OpenMoji emoji are CC BY-SA 4.0, Font Awesome Free icons are CC BY 4.0, Material Symbols are Apache 2.0, and Iconify icons carry their own set's license (recorded in a sidecar JSON next to each cached file). See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for the full attributions, which must travel with any redistribution of `public/shapes/`.
