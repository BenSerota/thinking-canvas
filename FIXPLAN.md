# Thinking Canvas — Audit Fix Plan (2026-08-30, rev. 3 after re-audit 2026-09-06)

Execution plan for the fixes from the 2026-08 audit. Rev. 2 folded in the confirmed findings of a 5-lens adversarial review of the plan itself — paragraphs marked **[reviewed]** exist because a literal reading of the first draft would have produced a bug; follow them exactly. Rev. 3 folds in a second, independent audit of the (unchanged) codebase: four blind reviewers (security, frontend, AI pipeline, rasterizer) whose claims were then checked by twelve skeptic verifiers and, where possible, reproduced live. Items marked **[re-audit]** are new in rev. 3; Phases 7–10 are entirely new. Nothing in rev. 2 was retracted. Written to be executed **phase by phase, in order**, by a Claude Code session running in this directory (`thinking-canvas/`). Each phase ends with its own verification step and a commit on the work branch.

## ⚠️ Ground rules for the executor

1. **Trust the verified facts below over your training priors.** Every API shape and model ID in this plan was live-verified on 2026-08-30 against this project's installed SDK (`@anthropic-ai/sdk` ^0.78) and Ben's API key. In particular: `claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5` are **complete model IDs — do not append date suffixes**, and `thinking: {type: "adaptive", display: "summarized"}` is the correct thinking config (the old `{type: "enabled", budget_tokens: N}` is **rejected with a 400** on these models).
2. **Do not upgrade `@anthropic-ai/sdk`.** The 0.78 SDK passes unknown request params through to the API — `output_config`, `thinking: {type:"adaptive"}` etc. all work (verified). SDK upgrade is out of scope.
3. **Run the dev server via the Browser pane / `.claude/launch.json`** (config name `thinking-canvas`), never via raw `Bash`. Note: when the browser pane is hidden, `requestAnimationFrame` throttles to ~1 fps — verify canvas behavior with JS probes (`window.app.canvas...`), not by eyeballing animation smoothness.
4. **Don't touch** `data/`, `public/shapes/**` assets, or the hand-rolled `.env` loader in `server.js` (it exists because dotenvx interception broke dotenv).
5. Live API calls cost real money on Ben's key — keep verification calls modest (single turns, small max_tokens).
6. Work on a branch: `git checkout -b fix/audit-2026-08`. Commit at the end of each phase with a message describing what actually changed.

## Verified facts (live-tested 2026-08-30)

- `claude-sonnet-4-20250514` (current chat model in `services/chat-service.js`) → **404, retired**. This is why every chat turn currently fails. The existing "fallback" retries the same model, so it fails twice.
- `claude-sonnet-5` streaming with `thinking: {type: "adaptive", display: "summarized"}` → works. **But on a trivial prompt it produced 0 thinking characters** — adaptive thinking may skip thinking entirely on simple turns. UI must not depend on thinking events arriving (see Phase 4.4).
- `display: "summarized"` is required — the default is `"omitted"` which streams thinking blocks with **empty text**, silently killing the thinking UI.
- Sampling params (`temperature`/`top_p`/`top_k`) are **rejected** on Sonnet 5 / Opus 5. (Code doesn't use them today; don't add any.)
- Structured outputs via raw `output_config: {format: {type: "json_schema", schema: {...}}}` → works on `claude-haiku-4-5` through SDK 0.78. Guarantees the first text block is valid JSON.
- `claude-opus-4-7` (svg-generator) still works but took 11.5 s per generation. On `claude-opus-5`, omitting `thinking` runs **adaptive thinking by default** — pair with `output_config: {effort: "low"}` to keep generation fast.
- LottieFiles API (`services/lottie-service.js` tier B) returns **HTTP 403 on every call** (Cloudflare). Dead tier; every concept pays a failed network call.
- Haiku extractor with no conversation context on follow-ups (e.g. "tell me more about that") returns prose or JSON+trailing-prose → `JSON.parse` throws → no shapes. Verified twice.
- Shape resolution is sequential: measured timeline +158 ms / +11,728 ms / +12,087 ms — one slow svg-gen blocked the fast third concept for 11.5 s.
- Canvas layout bug reproduced live: app initialized while the panel measured 0×1 px → every title base point collapsed to (0, 0.18) → permanently black canvas. `_resize()` never re-lays-out existing shapes.
- FPS-culling bug reproduced live: hidden tab → rAF throttled → monitor misreads as low perf → particles spliced 8000 → 6800, **permanently**.
- The Messages API tolerates a history that starts with an assistant message (verified) — no fix required for the greeting-first history.
- Dead code confirmed: `#stateIndicator` is never written; `setInterimShape`/`setThinking` never called; `interimMode` is only ever set to `false`; the legacy `'concepts'` SSE case in `app.js` is never emitted by the server; no `isComposing` check on Enter.

### Added by the re-audit (live-verified 2026-09-05/06 unless noted)

- **Conversations silently die at the 26th message.** The client sends `getHistory().slice(0,-1)` = 2N−1 entries; the server rejects `history.length > 50` with `400 {"error":"Invalid history"}` (reproduced: 50 entries → 200, 51 → 400); the client never checks `response.ok`, the JSON body has no `data:` lines, so the loop exits cleanly — no reply bubble, no error, canvas stuck in `gathering` with the thinking title, input re-enabled. Every later message repeats this.
- **Cross-turn timer race (reproduced).** `_scheduleCarousel`'s `setTimeout(launch, CYCLE_MS)` is never tracked; `_clearConceptCycle` clears only `conceptTimer`. Simulation: new turn began (`gathering`, thinking title), 1.5 s later the OLD turn's `launch` ran `setShapes(oldShapes)` → `settled`, old carousel, thinking title gone, and the new turn's `thinking` event was then rejected by the `setState` guard. Reachable whenever the user sends a follow-up while the previous turn's cycle→carousel countdown (≥ 1.5 s × unshown shapes + 1.5 s) is still pending — which is normal, since `done` arrives well before that.
- **The hurricane ring cuts through every streamed single shape (reproduced).** During streaming `currentShapes = [thinkingTitle, singleShape]`, so the `length === 1 && !isTitle` branch in `_update` is skipped and no shape has `orbitRadius > 0` → `baseRadius` stays 120 px (ring 90–150 px) while the shape spans ~0.7·min(w,h). Same `length` test misplaces the label in `_render`.
- **An empty point array is a valid shape (reproduced).** `rasterizeFromPaths`/`particlesFromGeomElements` return `[]` for empty rasters; `[]` is truthy, so `_resolvePoints` caches it and `setShape([])` calls `clearShape()` → `dissolving`, every particle released including the thinking title (whose reference dangles).
- **Zero-size init also mirrors shapes.** With a 0-width panel, `_buildShape`'s `fullScale = min(width−120, height−120)·0.7` goes **negative** (observed `bboxMax: −84`), so shapes are laid out inverted, not just collapsed.
- **Lottie substring hijack (verified with `matchBundled`).** `key.includes(tag) || tag.includes(key)` and the tier runs FIRST: `car → heart` (tag "cardio"), `light → lightning`, `ship → rocket`, `rock → rocket`, `ear → heart`, `art → atom`, `net → globe`, `wheat → fire`, `theater → fire`, `bio → dna`, `notebook → music-notes`. "car" is in the extractor's own shape vocabulary and in the greeting's suggested prompts.
- **Shape resolution blocks the reply text.** `server.js` runs the whole `streamConceptShapes` loop *inside* the `for await` over the chat stream, so no `text` event is forwarded until all shapes resolve (12 s in the first audit's measurement). Parallelizing resolution (Phase 1.3) shortens but does not remove this — the loop must be detached (Phase 1.7).
- **Emoji tier renders wrong for ~19% of its icons (census over all 2,402 files + visual check).** `isStrokeOnlySvg`'s whole-file 80% rule sends 458 files to the fill path, which reads only `<path d>` and fills every path: 286 lose their `<circle>/<rect>/<line>/<polyline>` geometry, 368 have `fill="none"` outlines filled solid, 20 have no `<path>` and return null. Rendered: `1F600` (grinning face) = two dots + a filled mouth, **no face**. Separately, 124 files carry transforms the stroke sampler ignores (`cloneNode(false)` drops ancestor `<g transform>`; `getPointAtLength` returns local coords): `1F10D` renders at 1/4.3 scale in the corner. (Not every transform case is visibly wrong — `1F338` renders fine — so treat the 124 as "at risk", not "broken".)
- **Rasterization stalls the main thread per shape.** Measured in-browser: emoji (stroke sampler, DOM `getPointAtLength` ×3 per sample) 170–970 ms each; iconify/library fill icons up to 1.4 s. For fill icons the edge-only "too simple" heuristic fires for essentially every filled icon (ratio ≈ perimeter/area < 0.12 whenever a feature is > ~17 px thick) and re-rasterizes at 600 px, discarding the 300 px pass — measured 4–6× cost (e.g. `capacitor` 839 ms vs 134 ms with the recursion suppressed).
- **Both regex SVG sanitizers are bypassable** (`node -e` against the real functions): `<a href="javascript:…">` and `<set attributeName=… to="javascript:…">` pass `iconify-service.sanitizeSvg` **and** `svg-generator.validate`; cached files are served same-origin as `image/svg+xml` with CSP disabled. `validate()` also passes a 3-number viewBox (`vh` = NaN → all area/detail checks silently pass), `style="fill:none;stroke:…"`, `fill="#fff"`/`opacity="0"`, `<defs>/<mask>/<clipPath>/<text>`, and five sparse dots + a hairline (bbox from sampled points, not filled area).
- **Iconify placeholder paths corrupt 7 cached icons.** `hat/rose/remote-control/sunflower` carry a mingcute `fill="none"` placeholder that the fill path renders as an orphan speck and that shifts the icon in its box (rendered: hat + speck); `jeep/capacitor/number-line` carry a full-viewBox `fill="none"` rect-path that becomes a solid square → edge-only → the icon is replaced by a hollow square (rendered: `capacitor` = empty square).
- `package-lock.json` is gitignored (`git ls-files` empty) → no `npm ci`, every Render build resolves transitive versions fresh.
- Contrast (WCAG, computed): `--text-muted` 2.55:1, `--accent-dim` (thinking summary) 3.75:1, canvas label 1.29:1 — all fail AA; the Phase 4 replacements pass (4.99:1, 6.91:1, 4.64:1).
- `icon-matcher.init()` caches a rejected `initPromise` with no reset (emoji-service does reset), and `shape-service` calls `hasExactMatch` outside any try → one bad init makes every chat turn fail until restart.
- Refuted / overstated during verification: the `conceptToShape` RegExp-metacharacter crash is unreachable (every server name passes `toKebab` or a verified-clean catalog); a never-firing Lottie `DOMLoaded` cannot happen with the vendored lib (timeout is defensive only); `setShapes(n===1)` dropping the animation is real but unreachable (`_onConceptsDone` returns early for <2 shapes).

---

## Phase 0 — Baseline

1. `git status` must be clean (untracked cache files under `public/shapes/generated-v3/`, `iconify-cache/` are fine — they're gitignored). Create branch `fix/audit-2026-08`.
2. Start the dev server, send one chat message, confirm the baseline failure: server log shows `404 ... claude-sonnet-4-20250514` and the UI shows "Sorry, something went wrong."

## Phase 1 — Revive and harden the AI calls

### 1.1 `services/chat-service.js`

- Model: `claude-sonnet-5`. Add `const FALLBACK_MODEL = 'claude-haiku-4-5'`.
- Thinking: `thinking: { type: 'adaptive', display: 'summarized' }`. Delete `budget_tokens`.
- `max_tokens: 8192` (thinking output counts toward it; 16000 was cost exposure).
- **Fallback logic rewrite:** on stream-creation error, branch on the error type/status:
  - `err instanceof Anthropic.APIConnectionError` (note: **`.status` is `undefined` on connection errors** — check the instance, not the status) or `err.status === 429` or `err.status >= 500` → retry the primary model once;
  - otherwise (404/400/any other status) → fall back to `FALLBACK_MODEL` with **no `thinking` param** (Haiku 4.5 uses the old thinking API; omitting it means no thinking, which is fine for a degraded mode) and `max_tokens: 1024`.
  - Use the SDK's typed error classes — no string matching.
- **Stream thinking deltas:** replace the buffered single `thinking_text` yield with:
  - `{ type: 'thinking_delta', text }` yielded per `thinking_delta` chunk (accumulate into `thinkingBuffer` too — the regex fallback at the bottom still uses it);
  - `{ type: 'thinking_done' }` at `content_block_stop` of a thinking block.
- **Extractor context:** build a compact context string from the last 4 history entries (each truncated to 200 chars, formatted `user: …` / `assistant: …`) and pass it as the second arg to `extractVisualConcepts(message, contextText)` (Phase 1.2 makes the extractor use it).
- System prompt: append `"Use plain conversational text — no markdown formatting."` (the client renders with textContent; this kills raw `**asterisks**` without a markdown renderer).
- **Abort support:** `createStream(message, history, signal)` — pass `{ signal }` as the second argument (request options) to both `anthropic.messages.create` calls; if the signal aborts mid-stream, return cleanly (catch `AbortError`, stop yielding).

### 1.2 `services/visual-extractor.js`

- Model: `claude-haiku-4-5` (drop the dated suffix).
- **Structured outputs** (verified shape — copy exactly):
  ```js
  output_config: {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          visuals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                iconic: { type: 'string' },
                shape: { type: 'string', enum: [/* the 28 shape names already listed in the prompt: car, truck, bicycle, airplane, boat, dog, cat, bird, fish, horse, house, building, tree, mountain, sun, cloud, flower, phone, computer, book, cup, guitar, key, person, money, heart, star, food */] },
              },
              required: ['iconic', 'shape'],
              additionalProperties: false,
            },
          },
        },
        required: ['visuals'],
        additionalProperties: false,
      },
    },
  }
  ```
  The `enum` on `shape` replaces the free-text fallback field — `normalizeBuiltin` in shape-service stays as defense-in-depth.
- Delete the markdown-fence stripping and the plain-array handling; keep a defensive try/catch around `JSON.parse` (return null on failure). Read the response via `response.content.find(b => b.type === 'text')?.text` rather than `content[0]` (same robustness rule as Phase 1.6 — cheap insurance even though Haiku without a thinking param shouldn't emit thinking blocks).
- **Prompt additions:** (a) "If the topic is vague or refers to earlier conversation ('tell me more', 'what about that'), use the Context to infer the actual subject." (b) "Always return your best guess as JSON. Never ask for clarification. Never output prose."
- Use the `contextText` param (now populated): `Topic: ${userMessage}\n\nContext (recent conversation):\n${contextText}` when context is non-empty.

### 1.3 `services/shape-service.js` — parallel resolution

Rewrite `streamConceptShapes(visuals, max = 3)`:

1. Kick off resolution for **all** visuals concurrently (empty exclude set — the common case has no collisions). **[reviewed]** Attach a rejection handler at kickoff so no promise can ever settle unhandled while the loop is awaiting an earlier one (Node's default `--unhandled-rejections=throw` would otherwise kill the process — e.g. `iconMatcher.init()` rejects on a corrupt data file and both `hasExactMatch` and `findBestMatch` await it unguarded):
   ```js
   const pending = visuals.map(v => resolveVisual(v, new Set()).catch(err => {
     console.warn('[shape-service] resolveVisual failed:', err.message);
     const fallback = normalizeBuiltin(v && v.shape);
     return { name: fallback, concept: (v && v.iconic ? String(v.iconic).trim() : '') || fallback, dynamic: null, source: 'builtin' };
   }));
   ```
   The collision re-run in step 3 (`resolveVisual(visual, seen)`) must get the same `.catch` wrapper. **This parallelism also depends on the svg-generator change in Phase 1.6** (serialize instead of instant-fail on `inFlight`) — without it, only the first concept per turn to reach the generation tier can generate.
2. Yield results **in input order** as their promises settle (await them in order; later promises are already running, so a slow one no longer delays earlier ones, and the measured 11.5 s tier only affects its own slot).
3. Dedupe at yield time against a `seen` set. **On collision** (resolved name already seen — e.g. "chromosome" and "dna double helix" both hitting the bundled `dna` Lottie), re-run `resolveVisual(visual, seen)` for just that item so the exclusion-based tier fallthrough still works, then yield if the second result is novel.
4. Wrap each resolution in a 20 s timeout (`Promise.race`) → on timeout, fall through to the builtin fallback shape for that visual.
5. `mapConceptsToShapes` stays a thin wrapper — verify it still works.

### 1.4 `services/lottie-service.js`

- **[re-audit] Kill the substring tag match and demote the tier.** Replace `matchBundled`'s `key.includes(tag) || tag.includes(key)` loop with whole-token matching only: split both the kebab key and each tag on `-`; accept when the full key equals a tag, or every word of the key is a tag word (so `dna double helix` still hits `double-helix`, but `car` never hits `cardio`). In `shape-service.resolveVisual`, move the Lottie lookup to run **after** the curated (0.5) and exact-library (0.7) tiers — an exact icon must beat a fuzzy animation. Verify with `node -e` on `matchBundled`: `car`, `ship`, `art`, `light`, `ear`, `net` → null; `heart`, `atom`, `dna`, `double helix`, `rocket` → hits.
- **[re-audit] Recommended: drop the LottieFiles API tier entirely** rather than just circuit-breaking it — it 403s, carries no license data (Phase 8), fetches attacker-influenced URLs with no host allowlist, and `validateLottieJson` admits image assets/layers (which make every visitor's browser fetch third-party image URLs via lottie-web's unconditional `preloadImages`). If you keep it: allowlist `https://assets*.lottiefiles.com`, reject `assets[]` entries with `p`/`u` (unless `e:1` data URIs) and layers with `ty === 2`, count nested `assets[].layers` toward `MAX_LAYERS`, and enforce the byte cap on a streamed body (see 1.8).
- **Circuit breaker** on the API tier (only if kept): after 3 consecutive failures (non-OK status, timeout, or network error), set a module-level flag that disables `searchAPI` for the process lifetime; log once (`[lottie-service] API disabled after repeated failures`). A success resets the counter. Bundled tier (tier A) unaffected.
- In-memory negative cache for API misses: `Map<kebab, timestamp>`, TTL 1 h.

### 1.5 `services/iconify-service.js`

- In-memory negative cache for search misses and all-candidates-filtered cases: `Map<kebab, timestamp>`, TTL 1 h — skips the 200–500 ms re-search for repeat concepts.

### 1.6 `services/svg-generator.js`

- `PRIMARY_MODEL = 'claude-opus-5'`, `FALLBACK_MODEL = 'claude-sonnet-5'`.
- Add `output_config: { effort: 'low' }` to the request params (both models). Do **not** add a `thinking` param (omitting it = adaptive on both; effort low keeps it brief).
- **[reviewed] Read the text block, not `content[0]`:** with adaptive thinking the response's first content block can be a `thinking` block, so the existing `const raw = resp.content[0]?.text` (~line 310) comes back `undefined` → "empty response" → the concept lands in `failedCache` **permanently poisoning the negative cache for every novel concept**. Replace with `const raw = resp.content.find(b => b.type === 'text')?.text;`.
- **[reviewed] Serialize instead of instant-fail on `inFlight`** (required by Phase 1.3's parallel resolution): today `generate()` returns `{ ok:false, reason:'another generation in progress' }` the moment another generation is running (~line 291) — under concurrent `resolveVisual` calls, every novel concept after the first would silently degrade to the builtin fallback. Replace the guard with a wait loop: `while (inFlight) { await inFlight.catch(() => {}); }`, then **re-run the disk-cache and negative-cache checks** before claiming the slot (a generation that just completed for the same kebab is now served from cache). Note: a caller whose Phase-1.3 20 s race times out yields the builtin fallback, but its underlying `generate()` keeps running, still holds `inFlight` until it settles, and on success still populates the disk cache for future turns — this is expected, not an error; later callers queue behind it instead of instant-failing.
- **[re-audit] Harden `validate()` — it is bypassable and has NaN blind spots** (each verified with `node -e`):
  - Parse `viewBox` as **exactly four finite numbers** with `w, h > 0` (a 3-number viewBox currently makes `vh` NaN and every area/detail check silently passes).
  - Strip XML comments before any regex gate, then **switch the element check to an allowlist on the parsed DOM**: only `svg` and `path` may exist (kills `<a>`, `<set>`, `<use>`, `<defs>`, `<clipPath>`, `<mask>`, `<text>` — none are in today's deny-list — and the false-positive on comments containing `<g`).
  - Reject any `style=` attribute; require each path's `fill` to be absent or ∈ {`currentColor`, `#000`, `black`}; reject `opacity`/`fill-opacity` (white/transparent "cut-out" layers currently become solid blobs because the rasterizer fills every `d`).
  - Add a filled-area proxy: sum |shoelace area| over sampled subpaths and require ≥ 5% of the viewBox (today five corner dots + a hairline pass the 10% *bbox* rule).
  - Apply the "single-path single-subpath blob" gate to single-word concepts too.
  - Add API/FS failures to `failedCache` (today only validation failures are negative-cached, so e.g. an `ENAMETOOLONG` write error after a paid Opus call re-spends every turn), and cap the kebab to ~100 chars.
- Bump `PROMPT_VERSION` to `'v4'` **only if you change the prompt text**; a model-only change can keep `v3` (cache stays valid — the cached SVGs are fine).

### 1.7 `server.js`

- **Rate limiting** (hand-rolled, no new dependency): in-memory sliding window, keyed by `req.ip`, max 20 requests / 5 min across both `/api/chat` routes. Over limit → `429 { error: 'Too many requests, slow down.' }`. Add `app.set('trust proxy', 1)` (Render sits behind a proxy). Prune stale entries opportunistically.
- **History validation:** in addition to the existing checks, reject any history entry that isn't `{ role: string, content: string }` or whose content exceeds 4000 chars → 400.
- **Abort on disconnect [reviewed]:** per request, `const ac = new AbortController();` then detect disconnect on the **response**, not the request: `res.on('close', () => { if (!res.writableEnded) ac.abort(); });`. Do **NOT** use `req.on('close', ...)`: since Node 16, `IncomingMessage` emits `'close'` when the request message *completes* — and because `express.json()` consumes the POST body before the handler runs, that fires immediately and would abort every stream at the start (empirically reproduced on this machine's Node 25). `res` `'close'` after a normal `res.end()` is harmless because `writableEnded` is `true` by then; on a real mid-stream client disconnect it fires with `writableEnded` `false` and the abort proceeds. Pass `ac.signal` to `chatService.createStream(...)`; also `break` the shape-resolution `for await` loop when `ac.signal.aborted`.
- **SSE event changes:**
  - Forward `thinking_delta` / `thinking_done` events as `{ type: 'thinking_delta', text }` / `{ type: 'thinking_done' }`.
  - On stream error, emit `{ type: 'error', message: 'Something went wrong.' }` instead of a fake `text` event (keep the detailed error in the server log only).
  - **Always** emit `concepts_done` before `done`, even when no `visual_concepts` event arrived or the visuals list was empty (`{ type: 'concepts_done', concepts: [] }`) — the client needs it to settle the canvas (Phase 4.4). Track with a boolean whether it was already sent.
- Default port `3000` (matches README; `.claude/launch.json` handled in Phase 6).
- **[re-audit] Decouple shape resolution from the chat stream.** Today the `visual_concepts` case runs the entire `streamConceptShapes` loop inside the `for await` over `chatService.createStream`, so the reply text cannot stream until every shape has resolved. Restructure: on `visual_concepts`, start `const shapesDone = (async () => { for await (const shape of streamConceptShapes(...)) { if (ac.signal.aborted || res.writableEnded) break; res.write(...concept_resolved...); } })()` **without awaiting it**, keep consuming chat events (thinking/text) as they arrive, and `await shapesDone` right before writing `concepts_done` + `done`. `res.write` calls are atomic, so interleaving is safe. Guard against the `shapesDone` promise rejecting (catch → log).
- **[re-audit] Enable a real CSP and sandbox the cached SVGs.** Replace `helmet({ contentSecurityPolicy: false })` with directives the page actually needs: `default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'` (there is no inline script; `chat.js`'s `innerHTML` is a static template). Serve `/shapes` via `express.static(..., { setHeaders: res => res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox") })` so a cached SVG that slipped past the sanitizers can never execute in the app origin.

### 1.8 Service robustness **[re-audit]**

- `services/icon-matcher.js`: append `.catch(err => { state.initPromise = null; throw err; })` to the init IIFE (mirror emoji-service), and in `shape-service.js` wrap every `iconMatcher.*` call (incl. `hasExactMatch`) in try/catch that falls through to the next tier. Today one corrupt data file makes every chat turn fail until restart.
- `services/iconify-service.js` + `lottie-service.js` `fetchWithTimeout`: reject when `content-length` exceeds the cap, and read the body as a stream, aborting once accumulated bytes exceed `MAX_*_BYTES` (today `res.text()` runs before any size check). In `sanitizeSvg`: extend the transform reject to any element (`/<\w+\b[^>]*\btransform\s*=/i`), require a `viewBox`, and reject `<a>`/`<set>`/`<use>` (allowlist `svg`, `g`, `path`, `defs`-free). Also **drop `<path>` elements whose effective fill is `none`** (own attr or nearest ancestor) before caching — this is the mingcute placeholder bug — and purge/re-fetch the 7 affected cached files (`hat, rose, remote-control, sunflower, jeep, capacitor, number-line`).
- `services/visual-extractor.js`: sanitize each `iconic` — strip control characters/newlines, cap at 60 chars (log-injection + oversized filenames).
- `services/chat-service.js` `buildMessages`: skip history entries whose `content` is not a non-empty string (defense in depth behind the server validation).
- `services/shape-service.js`: replace `curatedKey` with `utils.toKebab` (byte-identical); collapse the source-label logic into one `labelSource(match)` helper (the `'exact'` arm is unreachable and the substring-fallback path emits inconsistent raw labels).

**Phase 1 verification** (all from `thinking-canvas/`, with `.env` exported):
```bash
curl -sN -X POST localhost:3000/api/chat/stream -H 'Content-Type: application/json' \
  -d '{"message":"Tell me about ancient Rome","history":[]}' \
  | grep -E '"type":"(thinking_delta|concept_resolved|concepts_done|done|error)"'
```
Expect: possibly many `thinking_delta` lines (or none — adaptive may skip), 3 × `concept_resolved`, one `concepts_done`, one `done`, no `error`. **[reviewed]** Do NOT pipe this stream through `head`: after 1.1 the stream is hundreds of per-chunk delta events, so the terminal events lie far past any small head window — and head's exit closes the connection, which via 1.7's disconnect-abort kills the stream server-side so `concepts_done`/`done` would never be emitted at all. The grep consumes the stream to completion. Then a follow-up with history:
```bash
curl -sN -X POST localhost:3000/api/chat/stream -H 'Content-Type: application/json' \
  -d '{"message":"tell me more about that","history":[{"role":"user","content":"Tell me about ancient Rome"},{"role":"assistant","content":"Rome was a vast empire centered on the Mediterranean."}]}' | grep -E 'concept_resolved|concepts_done'
```
Expect: Rome-related `concept_resolved` events (context fix working — before the fix this yielded nothing). Also run a quick loop of 25 curls to confirm 429s kick in, then wait out or restart to clear the limiter.

## Phase 2 — Canvas correctness (`public/js/canvas.js`, `public/js/app.js`)

### 2.1 Layout re-computation

Today `setTitle`/`setThinkingTitle`/`setShape`/`setShapes` bake absolute pixel coords from `this.width/height` at call time; `_resize()` never re-lays-out. Fix:

- Store the **layout inputs** on the canvas: `this._layout = { kind, args }` where kind ∈ `title | thinkingTitle | shape | shapes` and args are the original normalized points/labels/animation descriptors exactly as passed in. Every `set*` method records this before doing its work. **[reviewed]** `clearShape` and `setState('gathering')` clear it; `clearThinkingTitle()` also clears it **when the recorded `kind` is `'thinkingTitle'`** (otherwise it leaves `_layout` alone — a cleared thinking title must not wipe the replay record for shapes already on screen). This matters for Phase 4.4's empty-turn settle and the error path: both end a turn via `clearThinkingTitle()` + `setState('idle')`, and without this rule the next resize would replay `setThinkingTitle` via `_relayoutAll()` and resurrect the "I'm thinking about…" title on an idle canvas.
- Add `_relayoutAll()`: re-invokes the recorded `set*` method with the stored args against current `width/height`. Full particle reassignment on relayout is acceptable (it's a rare event).
- Replace the window `resize` listener with a **`ResizeObserver`** on `canvas.parentElement` (keep a window-resize fallback if RO is unavailable). Debounce ~150 ms. Handler: `_resize()` (bitmap dims — keep immediate, undebounced) then debounced `_relayoutAll()`.
- **Zero-size guard:** if `width < 50 || height < 50` when a `set*` method runs, record `this._layout` but skip the geometry work; the first ResizeObserver tick with a real size triggers `_relayoutAll()` which replays it. Same guard in the constructor path. **[re-audit]** Also clamp `_buildShape`/`_attachAnimation`'s `fullScale` to `≥ 1` — with a tiny panel `min(width−120, height−120)·0.7` goes negative and shapes render mirrored (observed `bboxMax: −84`).
- `writeReveal` on replay: re-lay-out with the reveal considered complete (don't re-animate the handwriting on a window resize).

### 2.2 FPS governor rewrite

- Replace the destructive `splice` with an `activeParticleCount` (init = `PARTICLE_COUNT`). `_update` and `_render` iterate `particles[0 .. activeParticleCount)` only.
- **Gate on visibility:** skip the fps check entirely when `document.visibilityState !== 'visible'`; on `visibilitychange` back to visible, reset `_frameCount`/`_fpsCheckTime`/`_lowFpsCount` so a stale window doesn't trigger a cull.
- Downscale: sustained fps < 24 (3 checks) → `activeParticleCount *= 0.85`. **Upscale (recovery):** sustained fps > 50 (3 checks) → `activeParticleCount = min(activeParticleCount * 1.1, PARTICLE_COUNT)`.
- **[reviewed]** After any change to `activeParticleCount`, re-run `_assignShapeToParticles(this.currentShapes)` with **NO `reservedIndices`** — `currentShapes` already contains the thinkingTitle shape when one exists (see `setThinkingTitle`/`setShape`), so the title is re-assigned along with the other shapes in the same call. Do NOT pass the title's old `particleIndices` as a reservation: reserved indices are excluded from the pool and never reach the free-particle cleanup loop, which would leave the old title particles frozen on screen as a ghost. (Title state such as `writeReveal`/seep lives on the shape object and its basePoints, not on particles, so a clean re-assignment is safe.)
- **[reviewed]** Inside `_assignShapeToParticles`, change `const particleCount = this.particles.length` (~line 550) to `const particleCount = this.activeParticleCount` so the SHAPE_PARTICLE_RATIO budget, the shuffled index pool, **and** the free-particle loop all derive from the same active count. Do NOT restrict only the pool-build loop: if the budget still derives from `particles.length` (permanently 8000), `totalShapeSlots` (up to 6800 — external shapes are uniform-sampled upstream to `getShapeParticleBudget()`) exceeds the pool after two downscales (8000·0.85² ≈ 5780), `indices[cursor++]` goes `undefined`, and `this.particles[undefined].isShapeParticle` throws inside `_animate` **before** the trailing `requestAnimationFrame` — permanently killing the animation loop, exactly on the low-fps machines the governor targets. `getShapeParticleBudget()` itself stays based on `PARTICLE_COUNT` (it governs upstream point sampling); that is precisely why the runtime clamp must track `activeParticleCount`.

### 2.4 Turn-lifecycle races and state bugs **[re-audit]** (`canvas.js`, `app.js`)

- **Track every timer and gate callbacks on a turn id.** Add `this.turnId` in `App`, incremented at the top of `handleUserMessage`; capture it in `_scheduleCarousel`'s `launch` and in both `setInterval` callbacks and bail if `this.turnId !== captured`. Store the `setTimeout(launch, …)` id in `this.carouselTimer` and clear it in `_clearConceptCycle`. In `canvas.js`, store the crossfade `setTimeout(doAssign, 130)` id and clear it in `setState('gathering')` and `setShapes`. (Reproduced today: a follow-up sent during the ≥1.5 s cycle→carousel countdown gets the previous turn's carousel painted over it and its `thinking` events rejected.)
- **Ring radius and label placement must ignore the thinking title.** In `_update`'s `baseRadius` selection and in `_render`'s label branch, compute `const shapes = this.currentShapes.filter(s => !s.isTitle)` and branch on `shapes.length` — today the single-shape branch never runs while streaming, so the ring (120±30 px) cuts through every ~400 px shape.
- **Empty point clouds are failures, not shapes.** In `app.js` `_resolvePoints`, treat `points.length === 0` as a miss (don't cache; fall through to `conceptToShape`); in `_onConceptResolved` require `points.length > 0` before pushing. Today `[]` is truthy and `setShape([])` triggers `clearShape()` mid-turn, wiping the title.
- `HURRICANE_TARGETS`: add `'transitioning': 0.35` and treat `transitioning` like `forming` in the `baseRadius` branch (small intensity dip on every crossfade otherwise).
- Seep ellipsis after a governor downscale: derive the particle for basePoint `k` with the same stride mapping the target loop uses (today the seep loop uses `k % particleIndices.length`, so after a cull it teleports the wrong particles).
- FPS governor: initialise `_fpsCheckTime` on the first frame (today it is 0, so the first window divides by time-since-navigation).

### 2.3 Font race (`public/js/app.js`)

- Before rasterizing either title: `await document.fonts.load("400 140px 'Love Light'").catch(() => {})` (plus `document.fonts.ready` fallback). Make `_showTitle` async and call it from an async `_init()`; `_showThinkingTitle` likewise (fonts are cached after first load, so this is a no-op cost on later calls).

**Phase 2 verification** (browser pane, JS probes — remember rAF is ~1 fps when the pane is hidden):
```js
// After reload, even if the pane initialized at 0 size:
const s = window.app.canvas.currentShapes[0];
// expect a real bbox spanning a few hundred px, NOT all points at one coordinate
```
Then emulate a resize (`resize_window` tablet → desktop) and re-probe: the bbox must scale with the new panel size. For the governor: with the pane hidden for 60+ s, `window.app.canvas.particles.length` must stay 8000 and `activeParticleCount` unchanged.

## Phase 3 — dt-correct physics + rendering performance (`public/js/canvas.js`)

### 3.1 Delta-time scaling

All animation/physics currently assumes 60 fps (wrong speed at 120 Hz, slow-mo under throttling). In `_animate`, compute once per frame:
```js
const dtF = Math.min(dt / (1 / 60), 3);        // dt is already clamped to 0.05s
this._dtF = dtF;
this._frictionF = Math.pow(FRICTION, dtF);      // precompute per frame, per-particle pow is too hot
this._springDampF = Math.pow(SPRING_DAMPING, dtF);
this._hurricaneLerpF = 1 - Math.pow(1 - HURRICANE_LERP, dtF);
```
Then apply:
- every force/impulse addition (`p.vx += …`) × `dtF` (brownian included — pragmatically scaled by dtF, not √dtF; tuned baseline is 60 fps where dtF = 1 so nothing changes there);
- position integration `p.x += p.vx * dtF`;
- damping/friction multiply by the precomputed pow factors;
- `wr.time += dt` and `shape.animationTime += dt` (real seconds, not 1/60);
- `this.carouselAngle += SHAPE_ROTATION_SPEED * dtF`;
- `this.transitionProgress += 0.008 * dtF`;
- hurricane intensity lerp uses `_hurricaneLerpF`.
**[reviewed] Placement + first frame:** the dtF/pow computations go **inside** the existing `if (this.lastTimestamp !== null)` block in `_animate` (that is where `dt` is in scope). Because `_update()` and `_render()` still run on the very first frame (where `lastTimestamp` is null and that block is skipped), initialize the factors to their dtF=1 values in the constructor: `this._dtF = 1; this._frictionF = FRICTION; this._springDampF = SPRING_DAMPING; this._hurricaneLerpF = HURRICANE_LERP;`. Without this, every particle multiplies by `undefined` on frame 1, positions go NaN, and NaN never recovers (the boundary clamps are comparison-based and false for NaN) — permanent black canvas.

**[reviewed]** Also add to the "Then apply" list — the motion-blur trail clear in `_render`: replace the constant `ctx.globalAlpha = 0.35` with a per-frame factor `this._trailClearF = 1 - Math.pow(1 - 0.35, dtF)` (precompute alongside the other pow factors; equals 0.35 at dtF = 1). Without it, trails halve at 120 Hz and triple under throttling. This won't show in a 60 fps screenshot compare — verify via probe (`window.app.canvas._trailClearF ≈ 0.35`).

At exactly 60 fps every factor is 1 → the tuned feel is preserved by construction.

### 3.2 Sprite-based rendering

- Pre-render one small offscreen canvas per palette color for (a) the core disc and (b) the glow disc, at device-pixel resolution ×3 headroom; cache in a `Map<color, sprite>` built lazily.
- `_render` replaces `beginPath/arc/fill` with `drawImage(sprite, x - r, y - r, d, d)` (size scaling via draw dims). Per-particle `globalAlpha` stays. Free particles keep the existing `fillRect` path.
- Visual output must match the current look — compare before/after screenshots of the settled state.

### 3.3 Minor fixes

- Boundary clamp symmetry: right edge `p.x = this.width - 1` to match the bottom edge treatment.
- `_showCurrentConcept` overlap guard: a monotonically increasing `this._conceptGen` token; async resolutions check the token after `await` and bail if stale.

### 3.4 Rasterization cost **[re-audit]** (`public/js/shapes.js`, `public/js/lottie-rasterizer.js`, `canvas.js`)

Measured per-shape main-thread stalls: emoji 170–970 ms, fill icons up to 1.4 s. Every arriving shape freezes the animation for that long.

- **Fill path:** decide edge-only with a cheap count over the `filled` mask *before* allocating any point objects, and rasterize **once** at the chosen resolution (today the 300 px pass is thrown away and everything — closing, flood-fill, point allocation — runs again at 600 px for essentially every filled icon). Scale `countLargeComponents`' `minSize` by `(resolution/300)²`. Emit edge points directly from the mask when edge-only. Read each path's `fill-rule` attribute and pass it to `ctx.fill(path, rule)` (default `nonzero`), forcing `evenodd` only for `shapeSource === 'generated'` — ~1% of library icons (slash-overlay "-off" icons) currently get unintended holes.
- **Stroke sampler:** use consecutive samples for the tangent (one `getPointAtLength` per sample instead of three) and append all clones to the hidden host before measuring (one layout flush, not one per element). Stretch goal: replace DOM `getPointAtLength` with `svg-path-properties` (already a server dependency; pure JS, worker-safe) and move both rasterizers into a Web Worker with `OffscreenCanvas` so the animation never blocks.
- **Lottie capture:** pass `dpr: 1` in `rendererSettings` (today it captures at devicePixelRatio → 600×600×24 frames on Retina); store pixels as packed `Int32` keys / `Uint8Array` masks instead of `{x,y}` objects and per-frame `Set`s; `await` a frame between keyframe captures; wrap the capture loop in `try/finally` that always destroys the animation and removes the container; add a 3 s `Promise.race` timeout on `DOMLoaded` (defensive). In `canvas.js`, cache the canvas-space frame arrays per (descriptor, center, scale) so each 1.5 s crossfade tick doesn't re-map 24 frames of points.
- **Lottie correctness:** use the **union** of all frames' pixel sets (not `staticKeys`) as the neighbour lookup when edge-classifying static pixels (today the whole resting outline of the pulsing heart is tripled into a bright inner ring); normalise every frame's dynamic tail to a fixed length (pad or truncate) so frame swaps never leave stale tail particles; keep empty frames as zero-dynamic frames instead of dropping them, lower the alpha threshold, and drive the frame index from the authored `duration` rather than a 5 fps clamp (today the lightning's "off" phase is deleted and every animation plays at 24/5 s).
- `rasterizeText`: size the bitmap from `actualBoundingBoxLeft + actualBoundingBoxRight` and draw at `x = padding + actualBoundingBoxLeft` so Love Light's swashes aren't clipped.

**Phase 3 verification:** at 60 fps nothing should look different (screenshot compare). For 3.4, time `loadExternalShape` in-page on `/shapes/emoji/1F436.svg` and `/shapes/iconify-cache/capacitor.svg` before/after (baseline 968 ms and 839 ms). Probe: `window.app.canvas._dtF` exists and ≈1 when pane is fronted. No NaNs: run 10 s, probe a few particles for finite x/y/vx/vy.

## Phase 4 — Visual design + UX

### 4.1 Canvas labels (`canvas.js` `_render`)

- Label alpha: replace `(transitionProgress - 0.5) * 0.3` (caps at 0.15 — nearly invisible) with a curve capping at **0.65**. Font `13px monospace` minimum.

### 4.2 Contrast tokens (`public/style.css`)

- `--text-muted: #5a5650` → `#8a8478` (≈4.9:1 on `#12121f`).
- `--text-secondary: #8a8478` → `#a59d90`.
- Check every usage still looks intentional (subtitle, placeholder, thinking content).

### 4.3 State indicator (dead element → wire it)

- **[reviewed]** `ThinkingCanvas` gets an `onStateChange(state)` callback fired from `setState` **and from every direct `this.state =` assignment** — grep for them: `setTitle`, `setShape` (both the `'forming'` assignment in `doAssign` and the `'transitioning'` assignment in the crossfade branch), `setShapes`, and `clearShape` (the `'dissolving'` assignment and the timeout's `'idle'`). Simplest: route them all through a tiny private `_setStateDirect(s)` helper that assigns and fires the callback.
- `app.js` maps states to `#stateIndicator` text: `title-idle` → `"move your cursor through the sand"` (doubles as the interaction-discoverability hint), `gathering` → `"gathering…"`, `thinking` → `"thinking…"`, `forming`/`transitioning`/`settled` → `""` (labels take over), `dissolving`/`idle` → `""`.

### 4.4 Turn lifecycle fixes (`app.js`, `chat.js`)

- **`thinking_delta` handling:** on first delta, create a streaming thinking block (rework `addThinkingMessage` into `addStreamingThinking()` returning `{ append, finish }`); append deltas; `thinking_done` finishes it. Auto-scroll as it grows, `max-height` CSS already caps it.
- **'thinking' canvas state trigger:** enter `setState('thinking')` on the **first** of `thinking_delta` | `concept_resolved` | `text` — adaptive thinking may produce no thinking at all (verified), and the canvas must still leave `gathering`. (The existing guard in `setState` already protects `forming`/`settled` from late thinking events.)
- **Error events:** handle `{ type: 'error' }` → render a distinct error bubble (new `.chat-error` style — muted red-ish border, plain background) with a **Retry** button that re-sends the last user message. Error bubbles are excluded from `getHistory()` (store with role `'error'`, filter in `getHistory`).
- **Empty-turn settle:** on `concepts_done` with zero collected shapes (and on `done` if no shapes ever arrived): `clearThinkingTitle()` + `setState('idle')` — no more eternal "I'm thinking about…" hurricane.
- **Input:** keep the textarea **enabled** during a turn (user can compose); only the send button disables. Guard `_handleSend` against sending while a turn is in flight.
- Enter handler: ignore when `e.isComposing` (IME safety).
- Add a `touchstart` listener mirroring `touchmove` (position registers on first touch, not first move).
- **[re-audit] Kill the 26-message cliff:** send only the last 10 history entries (`getHistory().slice(0,-1).slice(-10)` — the server only uses 10 anyway) and add `if (!response.ok) throw new Error(...)` before reading the body, so a 4xx renders the error bubble instead of a silent no-op.
- **[re-audit] Always finish the stream:** hoist `reader`/`stream` above the `try` and, in a `finally`, call `stream?.finish()` and `reader?.cancel().catch(() => {})` — today a mid-stream error leaves the blinking cursor forever and drops the partial reply from history.
- Accessibility/mobile: `aria-live="polite"` on `#chatMessages`, a visually-hidden `<label>` for the textarea, and `100dvh` instead of `100vh` in `#app` (mobile Safari URL bar hides the input).

### 4.5 Dead code removal

- `app.js`: delete the legacy `case 'concepts'` branch, **and the leftover `this.canvas.interimMode = false;` line in `_onConceptResolved` (~line 191)** — it references the property canvas.js no longer has.
- `canvas.js`: delete `setInterimShape`, `setThinking`, and every `interimMode` branch (it is never set to `true`; the `interimMode` softening constants go too).
- Keep `services/concept-service.js` and the `/api/chat` non-streaming route (working server-side fallbacks).

**Phase 4 verification:** browser turn end-to-end: thinking streams into the collapsible (when present), state indicator updates through the lifecycle, labels legible in a screenshot, an induced error (temporarily set a bogus model, restart, send) shows the error bubble + Retry works, restore model afterward.

## Phase 5 — Generated-SVG vision QA (optional; skip cleanly if install fails)

Background: validation is structural only — a generated "roman laurel wreath" passed validation but renders as a gear. Gate semantics with a cheap vision check.

- `npm install @resvg/resvg-js` (prebuilt binaries exist for macOS arm64 and Render's linux-x64-gnu). Guard with a lazy `try { require } catch` — if unavailable, **skip QA entirely** (behavior identical to today). Env kill-switch: `SVG_QA=0` disables.
- In `svg-generator.js` after `validate()` passes: replace `currentColor` → `#000000`, render to a 256 px PNG on white; send to `claude-haiku-4-5` (vision, `max_tokens: 50`): *"What object does this image depict? Answer with 1–3 lowercase words only."*
- Compare answer to the concept via the existing `embedding-service`: `cosine(embed(answer), embed(iconic)) >= 0.45` → accept; else reject (add to `failedCache`, log the answer + score so the threshold can be tuned).
- Cost/latency: one Haiku vision call per *novel* generated concept (rare, then cached). Keep it out of the other tiers.

**Phase 5 verification:** delete one cached generated SVG, request its concept, confirm the QA log line (accept or reject) and that a rejection falls through to the builtin shape without crashing. Also confirm the app still works with `SVG_QA=0` and with resvg absent (temporarily rename node_modules dir for the check).

## Phase 6 — Hygiene

- `package.json`: remove `dotenv` (unused — `.env` parsing is hand-rolled).
- `.claude/launch.json`: `port` → 3000 (server default also 3000 from Phase 1.7; README already says 3000).
- Comment drift: `CYCLE_MS` comments in `app.js` claim "2s" — it's 1.5 s; `services/emoji-service.js` header claims emoji runs AFTER Iconify — it actually runs **before** (tier 1 vs tier 2 in `shape-service.js`). Fix both comments to match reality.
- **[re-audit] More drift to fix:** `concept-service.js` `star` regex matches `great`/`amazing` (a thank-you maps to a star in the fallback) — remove those words; the extractor prompt promises curated routing for Eiffel Tower / Statue of Liberty but `curated-icons.json` has neither (either add them or trim the examples), and its `eiffel tower → paris` example violates its own physical-object rule; `emoji-service.js` and `icon-matcher.js` cite a 0.55 threshold while the effective library threshold is 0.60; `shape-service.js`'s header lists 3 tiers (there are 8) and numbers two tiers "3."; `visual-extractor.js` / `server.js` / README still say extraction is triggered by the thinking block (it fires at t=0). Delete `/api/chat` (unused by the client, and its fallback runs `search`/`question` through the external tiers) or make it a thin wrapper over the streaming path.
- **Write `CLAUDE.md`** (repo has none; this is a day-one default for Ben's projects). Include: what the app is (1 para), real commands (`npm start`, `npm run setup-icons`, `npm run setup-emoji`, `npm run generate-lottie`), file map (server.js / services/ / public/js/ / public/shapes/ / scripts/), model IDs in use and where they live, and a **Verify** section: (1) `npm start`, (2) the Phase-1 curl expecting `concept_resolved` ×N + `concepts_done` + `done`, (3) browser check that the particle title forms, (4) note that a hidden browser pane throttles rAF so canvas verification uses JS probes.

## Phase 7 — Emoji-tier rasterization correctness **[re-audit]** (`public/js/shapes.js`, `scripts/fetch-emoji.js`)

Census over all 2,402 OpenMoji files: the whole-file 80% stroke/fill rule sends 458 to the fill path, where 286 lose their basic-shape geometry and 368 get outlines filled solid; 124 carry transforms the sampler discards. This is the most-used non-curated tier, so it matters more than any single icon bug.

- **Dispatch per element, not per file.** In `loadExternalShape`, iterate every geometry element (`path, rect, circle, ellipse, line, polyline, polygon`) and route each by its *resolved* fill/stroke: `fill="none"` + stroke → the stroke sampler; filled → the fill rasterizer, converting basic shapes to `Path2D` (`rect/circle/ellipse/line/poly*` are one-liners). Merge the two point clouds and re-normalise with a shared denominator. Skip elements whose resolved fill is `none` and that have no stroke. Route anything under `/shapes/emoji/` this way unconditionally.
- **Honour transforms.** Adopt the whole parsed `<svg>` into the hidden host (`document.importNode(svg, true)`) instead of `cloneNode(false)` per element, sample each geometry element in place, and map every sample through `el.getCTM()` composed with the root's inverse CTM before normalising. For the fill path, apply the element's composed transform via `ctx.setTransform`/`ctx.transform` before `ctx.fill`. Widen the loader's warning selector from `g[transform]` to `[transform]`.
- **Build-time metadata.** In `fetch-emoji.js` parse each SVG (xmldom is already a dependency) and record `{ hasTransform, geomCount, strokeOnlyRatio }` in `data/emoji-catalog.json`; fix the header comment claiming the files are stroke-only paths (28% contain filled geometry, 73% use basic shapes).

**Phase 7 verification:** render `/shapes/emoji/1F600.svg` (must show the face circle), `/shapes/emoji/1F10D.svg` (content centred at full size), `/shapes/iconify-cache/hat.svg` (no orphan speck, hat centred) through `loadExternalShape` onto an overlay canvas and screenshot — the re-audit did exactly this to demonstrate the bugs.

## Phase 8 — Licensing and attribution **[re-audit]**

The Iconify tier excludes CC-BY-SA sets on share-alike grounds, while the emoji tier ships 2,402 OpenMoji files (CC-BY-SA 4.0) tracked in git; README/LICENSE declare MIT only, with no attribution for OpenMoji, Font Awesome Free icons (CC BY 4.0 — attribution required), Material Symbols (Apache-2.0), or the CC-BY Iconify sets; `data/emoji-catalog.json` (where attribution "lives") is gitignored and not served; the Iconify cache-hit path returns `license: null`, so per-icon attribution is unrecoverable after the first fetch.

- Decide one policy — recommended: **allow CC-BY / CC-BY-SA assets with attribution** (OpenMoji is the best-looking tier), which means adding `CC-BY-SA-4.0` to the Iconify whitelist and dropping its share-alike rationale.
- Add `THIRD-PARTY-LICENSES.md` (OpenMoji CC-BY-SA 4.0, Font Awesome Free CC BY 4.0, Material Symbols Apache-2.0, Iconify sets by prefix) plus a README "Licenses" section stating the code is MIT while `public/shapes/{emoji,library,iconify-cache}` carry their own licenses, and an attribution line in `index.html`'s footer.
- Persist a sidecar `{ prefix, iconName, license.spdx, license.title }` JSON next to each cached Iconify SVG (write it on cache miss, read it on hit).
- The Lottie API tier checks no license at all — one more reason to remove it (Phase 1.4).

## Phase 9 — Build and deploy reproducibility **[re-audit]** (`scripts/*`, `.gitignore`, `render.yaml`)

- Remove `package-lock.json` from `.gitignore`, commit it, and use `npm ci --include=dev` in `render.yaml`'s `buildCommand`.
- `fetch-emoji.js`: move the up-to-date check *before* the GitHub API call (today a cold Render build always hits `api.github.com` unauthenticated at 60 req/h/IP); send `Authorization: Bearer ${GITHUB_TOKEN}` when the env var is set; replace the `execFileSync('unzip', …)` shell-out with a JS unzip dependency (or vendor the zip); fetch `openmoji.json` from the pinned release tag, not `master`.
- `build-embeddings.js` / `build-emoji-embeddings.js`: write the `.f32` + index to temp files and rename them last, and write the JSON only after the binaries succeed (today JSON is written first, so a crash leaves a fresh JSON + stale binaries the up-to-date check accepts forever); assert every vector's length `=== EMBED_DIM` (`writeFloatLE(undefined)` silently writes NaN); make the up-to-date check compare the index's own checksum and `count`.
- Render's free-plan disk is ephemeral: the generated/iconify/lottie caches and the in-memory negative cache vanish on every restart, so Opus spend repeats. Either commit the generated SVG cache (it is small) or attach a persistent disk.

## Phase 10 — Embedding-matcher quality **[re-audit]** (`scripts/fetch-icons.js`, `scripts/build-embeddings.js`, `services/icon-matcher.js`)

- The library embeddings are built from the humanised filename only. For FA icons, read `node_modules/@fortawesome/fontawesome-free/metadata/icons.yml` (`label` + `search.terms` for 1,970 icons) into a `searchText` field in the manifest and embed `${displayName} ${searchText}`; Material has no bundled metadata — keep displayName there.
- Port emoji-service's top-K + head-noun-overlap gate into `icon-matcher.findBestMatch` (single argmax with no gate is why "bumpy head map → tools-flat-head" happens).
- Persist generated icons' embeddings (sidecar `data/generated-embeddings.json` written by `registerGenerated`) and load them in `scanGeneratedDir`, so "future variants can find it" survives a restart.

## Final verification (whole-app)

1. Fresh server start; browser reload. Title forms in the Love Light font (probe bbox if pane is throttled).
2. Turn 1 "Tell me about volcanoes": thinking (if any) streams, 3 shapes crossfade → carousel, labels readable, state indicator tracked the lifecycle.
3. Turn 2 "tell me more about that": still produces on-topic shapes (context fix).
4. Resize the window mid-carousel: shapes re-lay-out to the new size.
4b. **[re-audit]** Send a follow-up *while* the previous turn's carousel countdown is still pending: the old carousel must not reappear. Send 30 messages in a row: no silent failure at message 26. Watch the ring during a single streamed shape: it must encompass the shape, not cut through it. Ask "tell me about cars": no pulsing heart.
5. `git diff --stat` review; confirm no changes under `data/` or `public/shapes/` **other than** the 7 purged/re-fetched iconify-cache files (1.8) and the `.gitignore`/lockfile change (Phase 9).
6. Commits: one per phase on `fix/audit-2026-08`. **Do not merge or push** — leave the branch for Ben to review.

## Explicitly out of scope

- Font-family redesign of the chat panel (aesthetic call — Ben's).
- Raising `PARTICLE_COUNT` back to 12,000 (revisit after Phase 3 sprites prove out on real hardware).
- A markdown renderer (handled via system-prompt instruction).
- Deleting `/api/chat` or `concept-service.js`.
- Vision-QA for the embedding-matcher tier (only the generator tier gets QA).
- SDK upgrade; Render deploy config changes beyond none.
