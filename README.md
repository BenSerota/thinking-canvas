# Thinking Canvas

An AI chat interface where 8,000 sand-grain particles form shapes that visualize what Claude is working on, in real time. As you talk, watch the canvas -- you'll see concepts take shape as particle silhouettes, animated Lottie figures, and flowing formations.

## How It Works

1. You send a message in the chat panel
2. Claude responds with extended thinking while, in parallel, a visual concept extractor (Haiku) pulls key ideas from your message
3. Each concept is resolved to a shape through a multi-tier pipeline: Lottie animations, curated icons, OpenMoji emoji, Iconify web icons, local library matching, or on-demand SVG generation
4. Particles flow from a hurricane formation into the resolved shape, then cycle through concepts before arranging on a carousel

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
npm run setup-emoji    # Builds the emoji embeddings index (~30s; the OpenMoji SVGs ship with the repo)
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
| 0 | Lottie animations (bundled + API) | Instant / ~500ms | 8 bundled, unlimited via API |
| 0.5 | Curated icon overrides | Instant | ~20 hand-picked |
| 0.7 | Library exact match | Instant | ~5,500 icons |
| 1 | OpenMoji emoji | ~50ms | ~2,400 line-art SVGs |
| 2 | Iconify web search | ~200-500ms | ~200,000 icons |
| 3 | Library embedding match | ~100ms | ~5,500 icons |
| 3b | On-demand SVG generation (Opus) | ~3-5s | Unlimited |
| 4 | Built-in fallback shapes | Instant | 30 basic shapes |

## Project Structure

```
server.js              Express entry point
services/              Backend services (chat, shapes, icons, emoji, Lottie, SVG gen)
public/js/             Frontend modules (canvas physics, chat UI, shape rasterizer)
public/shapes/         Shape assets (curated, emoji, Lottie, generated caches)
scripts/               Build scripts for icons, emoji, and Lottie assets
```

## Attribution

- Emoji silhouettes: [OpenMoji](https://openmoji.org) (CC BY-SA 4.0, HfG Schwäbisch Gmünd) — ~2,400 SVGs vendored in `public/shapes/emoji/`.
- Animation playback: [lottie-web](https://github.com/airbnb/lottie-web) (MIT), vendored as `public/js/vendor/lottie_light.min.js`.

## License

MIT
