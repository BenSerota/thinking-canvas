# Thinking Canvas

A chat interface where ~8,000 sand-grain particles form shapes that visualize what Claude is talking about. Each user message is answered by Claude (Sonnet 5, adaptive thinking) while a Haiku extractor turns the message plus recent conversation into three iconic objects; each object is resolved to an SVG/Lottie asset through a tiered ladder and streamed to the canvas, where particles gather into a hurricane, form each shape in turn, then ride a carousel. Express server, vanilla-JS client (ES modules, no build step), Anthropic SDK.

## Commands

```bash
npm start                    # dev/prod server, http://localhost:3000 (PORT env overrides)
npm run setup-icons          # one-time: download ~5,500 FA/Material icons + build embeddings (~60 s)
npm run setup-emoji          # one-time: download OpenMoji line art + build embeddings (~30 s)
npm run generate-lottie      # regenerate the 8 bundled Lottie animations (already tracked in git)
```

`.env` needs `ANTHROPIC_API_KEY` (see `.env.example`). The server exits at startup without it; every turn errors if the key's credit balance is exhausted (the UI shows an error bubble with Retry).

In the Claude Code desktop app, start the server through the Browser pane (`.claude/launch.json`, config `thinking-canvas`), not via a raw shell.

## File map

- `server.js` — Express app: rate limiting, request validation, CSP, `/api/chat/stream` (SSE) and `/api/chat` (JSON), static files; `/shapes/**` is served under a no-script sandbox CSP.
- `services/chat-service.js` — Sonnet 5 streaming with adaptive thinking; Haiku extractor kicked off in parallel; model fallback chain. **Model IDs live here** (`PRIMARY_MODEL`, `FALLBACK_MODEL`).
- `services/visual-extractor.js` — Haiku 4.5 concept extraction with a JSON-schema output (`MODEL`).
- `services/shape-service.js` — the resolution ladder (curated → exact → Lottie → emoji → Iconify → embedding matcher → generator → builtin), parallel per-concept resolution with a 20 s budget.
- `services/svg-generator.js` — Opus 5 (Sonnet 5 fallback) SVG generation, strict validator, single-flight, negative cache; cache in `public/shapes/generated-v3/` (`PRIMARY_MODEL`, `FALLBACK_MODEL`).
- `services/iconify-service.js` — Iconify search + DOM-allowlist sanitizer; cache in `public/shapes/iconify-cache/`.
- `services/emoji-service.js`, `services/icon-matcher.js`, `services/embedding-service.js` — MiniLM embedding matchers over the emoji catalog and the icon library (`data/`, gitignored, built by the setup scripts).
- `services/lottie-service.js`, `services/curated-icons.json`, `services/concept-service.js` (regex fallback when Haiku returns nothing).
- `public/js/app.js` — orchestrator: SSE consumer, turn lifecycle, timers guarded by a turn id.
- `public/js/canvas.js` — particle engine: physics (dt-scaled), layout replay on resize, adaptive particle count, sprite rendering.
- `public/js/shapes.js` — SVG/text → point clouds (per-element fill/stroke dispatch, transforms); `public/js/lottie-rasterizer.js` — Lottie → point-cloud frames; `public/js/chat.js` — chat panel.
- `public/shapes/` — assets: `library/` (gitignored, from setup-icons), `emoji/` (tracked, CC-BY-SA), `curated/`, `lottie/`, runtime caches.
- `scripts/` — asset fetch/build scripts. `FIXPLAN.md` — the 2026-08/09 audit fix plan (history of why things are the way they are).

## Verify

1. `npm start` (or the launch config). Startup logs must show `[icon-matcher] ready` and `[emoji-service] ready`.
2. One streamed turn from the shell (needs API credits):
   ```bash
   curl -sN -X POST localhost:3000/api/chat/stream -H 'Content-Type: application/json' \
     -d '{"message":"Tell me about ancient Rome","history":[]}' \
     | grep -E '"type":"(thinking_delta|concept_resolved|concepts_done|done|error)"'
   ```
   Expect zero or more `thinking_delta`, three `concept_resolved` (server log: `[icons] "…" → …`), one `concepts_done`, one `done`, no `error`. Don't pipe through `head` — closing the connection early aborts the stream server-side. A follow-up with the previous turn in `history` (`"tell me more about that"`) must still resolve on-topic shapes.
3. Browser: reload — the particle title "Thinking Canvas" forms in the Love Light face. Send a message: the corner indicator goes `gathering…` → `thinking…`, shapes crossfade in, then the carousel; the ring encompasses the shapes and each label is readable. No console errors.
4. Resize the window mid-carousel: shapes re-lay-out to the new size.
5. When the Browser pane is hidden, `requestAnimationFrame` throttles to ~1 fps and the panel can measure 0×0 — verify canvas state with JS probes (`window.app.canvas.state`, `.currentShapes`, `.activeParticleCount`, `._dtF`), not by eyeballing motion. The governor ignores hidden frames by design.
6. Rate limit: more than 20 `/api/*` requests per IP in 5 minutes return 429 (in-memory; restart clears it).
