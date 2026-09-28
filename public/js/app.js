/**
 * Orchestrator — ties together the Thinking Canvas, Chat Panel, and AI backend
 *
 * Lifecycle per turn:
 * 1. Page load: particle-typography title shows ("Thinking Canvas"), ambient
 *    hurricane drifts underneath.
 * 2. User sends: title dissolves into gathering → thinking → hurricane ramps up.
 * 3. Shapes stream in one-by-one (crossfade): viewer sees Claude's "current
 *    thought" as each concept arrives.
 * 4. concepts_done: any shapes not yet shown get their turn, then all of them
 *    arrange on the carousel. A turn with one shape keeps it; a turn with
 *    none settles back to idle.
 * 5. Next user message: everything dissolves back to the hurricane. Repeat.
 *
 * Every timer captures the turn id it was started in and bails if a newer
 * turn has begun, so a follow-up sent mid-countdown can never have the
 * previous turn's carousel painted over it.
 */

import { ThinkingCanvas, getShapeParticleBudget } from './canvas.js';
import { ChatPanel } from './chat.js';
import { rasterizeShape, loadExternalShape, rasterizeText, conceptToShape } from './shapes.js';
import { loadLottieShape } from './lottie-rasterizer.js';

// How long each shape stays on screen during the crossfade cycle (ms).
// Also the pause before/after the carousel swap. 1.5 s keeps the cadence
// snappy — shapes read clearly but the turn moves along without dragging.
const CYCLE_MS = 1500;

const TITLE_FONT = "400 140px 'Love Light', cursive";
const THINKING_FONT = "400 150px 'Love Light', cursive";
// Never hold the canvas hostage to a font CDN.
const FONT_WAIT_MS = 2000;

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

class App {
  constructor() {
    this.canvas = new ThinkingCanvas(document.getElementById('thinkingCanvas'));
    this.chat = new ChatPanel(document.getElementById('chatPanel'), (msg) => this.handleUserMessage(msg));
    this.shapeCache = {};
    // Shapes accumulated during the current turn — used for the carousel
    // once concepts_done arrives.
    this.turnShapes = [];
    this.currentConcepts = [];
    this.conceptIndex = 0;
    this.conceptTimer = null;
    this.carouselTimer = null;
    // Monotonic turn id — see the file header.
    this.turnId = 0;
    this.inFlight = false;

    // State readout in the canvas corner. On the idle title it doubles as
    // the hint for the cursor interaction.
    this.stateEl = document.getElementById('stateIndicator');
    this.canvas.onStateChange = (state) => this._renderState(state);
    this._renderState(this.canvas.state);

    this._init();

    setTimeout(() => {
      this.chat.addMessage('assistant',
        'Hello! I\'m your AI assistant with visual thinking. As we talk, watch the canvas — you\'ll see my thoughts taking shape. Try asking me about cars, pets, travel, or anything else!'
      );
    }, 500);
  }

  async _init() {
    await this._fontsReady();
    this._showTitle();
  }

  /**
   * Resolve once the script face is usable (or after FONT_WAIT_MS). Titles
   * are rasterized from canvas text, so drawing before the web font arrives
   * would bake the fallback face into the particles for the whole session.
   */
  async _fontsReady() {
    if (!document.fonts || typeof document.fonts.load !== 'function') return;
    const timeout = new Promise(resolve => setTimeout(resolve, FONT_WAIT_MS));
    try {
      await Promise.race([document.fonts.load(TITLE_FONT), timeout]);
    } catch (_) {
      // Font failed to load — fall back to whatever the browser has.
    }
  }

  // Shapes are rasterized lazily (on first request via _resolvePoints).
  // Upfront precache blocked the main thread for tens of seconds on
  // low-powered machines and in Safari — page stayed dark until done.

  /**
   * Rasterize the "Thinking Canvas" title into particle targets and hand it
   * to the canvas. Runs on page load and sets the canvas initial state to
   * 'title-idle' with ambient hurricane drifting underneath.
   */
  _showTitle() {
    const titleBudget = Math.floor(getShapeParticleBudget() * 0.25);
    const points = rasterizeText('Thinking Canvas', {
      font: TITLE_FONT,
      maxPoints: titleBudget,
      alphaThreshold: 128,
      edgeOnly: true,
      letterSpacing: 8,
    });
    if (points) {
      this.canvas.setTitle(points, 'Thinking Canvas');
    } else {
      console.warn('[app] Title rasterization failed — falling back to idle state');
    }
  }

  _renderState(state) {
    if (!this.stateEl) return;
    const labels = {
      'title-idle': 'move your cursor through the sand',
      'gathering': 'gathering…',
      'thinking': 'thinking…',
    };
    this.stateEl.textContent = labels[state] || '';
  }

  /**
   * History to send with `text`: everything the user and assistant said,
   * minus the trailing user entry when it is the message being sent (so a
   * retry doesn't duplicate it), capped to what the server reads.
   */
  _historyFor(text) {
    const all = this.chat.getHistory();
    let last = all.length - 1;
    while (last >= 0 && all[last].role !== 'user') last--;
    const base = last >= 0 && all[last].content === text ? all.slice(0, last) : all;
    return base.slice(-10);
  }

  async handleUserMessage(text) {
    if (this.inFlight) return;
    this.inFlight = true;
    this.turnId++;
    this.chat.setInputEnabled(false);

    // Release all particles (including title) into the gathering → hurricane.
    this.canvas.setState('gathering');
    this._clearConceptCycle();
    this.turnShapes = [];  // fresh for this turn

    // Show "I'm thinking about..." immediately as the hurricane forms.
    this._showThinkingTitle();

    let reader = null;
    let stream = null;
    let thinking = null;

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: this._historyFor(text),
        }),
      });
      if (!response.ok) {
        throw new Error(`Chat request failed (${response.status})`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try {
            data = JSON.parse(line.slice(6));
          } catch (e) {
            continue;
          }

          switch (data.type) {
            case 'thinking_delta':
              if (!thinking) thinking = this.chat.addStreamingThinking();
              thinking.append(data.text);
              this.canvas.setState('thinking');
              break;

            case 'thinking_done':
              if (thinking) thinking.finish();
              break;

            case 'concept_resolved':
              // Adaptive thinking may skip thinking entirely on simple turns,
              // so any first sign of life moves the canvas out of 'gathering'.
              this.canvas.setState('thinking');
              if (data.shape) {
                await this._onConceptResolved(data.shape);
                await nextFrame();
              }
              break;

            case 'concepts_done':
              await this._onConceptsDone();
              break;

            case 'text':
              this.canvas.setState('thinking');
              if (!stream) {
                stream = this.chat.addStreamingMessage('assistant');
              }
              stream.append(data.text);
              break;

            case 'error':
              this.chat.addErrorMessage(
                data.message || 'Something went wrong.',
                () => this.handleUserMessage(text)
              );
              break;

            case 'done':
              break;
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      this._settleEmptyTurn();
      this.chat.addErrorMessage("Couldn't reach the server.", () => this.handleUserMessage(text));
    } finally {
      // Whatever happened, the reply bubble must stop blinking and land in
      // the history, and the connection must not linger.
      if (stream) stream.finish();
      if (thinking) thinking.finish();
      if (reader) reader.cancel().catch(() => {});
    }

    if (this.turnShapes.length === 0) this._settleEmptyTurn();
    this.inFlight = false;
    this.chat.setInputEnabled(true);
  }

  /**
   * Handle a single concept_resolved SSE event. During streaming, shapes
   * still crossfade one-by-one (that's the dramatic beat — viewer sees each
   * thought take shape in turn). We also collect them into turnShapes so
   * concepts_done can flip into the carousel.
   */
  async _onConceptResolved(shape) {
    const turn = this.turnId;

    // Resolve the shape's points ONCE — we'll need them again for the
    // carousel. Cache on the shape object.
    const resolved = await this._resolvePoints(shape);
    if (!resolved || turn !== this.turnId) return;

    // Animated shapes return a descriptor { isAnimated, frames, fps, points }.
    // Static shapes return a plain point array. Normalize both into _points
    // (first frame for display) and _animated (full animation data if present).
    if (resolved.isAnimated) {
      shape._points = resolved.points;
      shape._animated = { frames: resolved.frames, fps: resolved.fps, duration: resolved.duration, staticCount: resolved.staticCount || 0 };
    } else {
      shape._points = resolved;
      shape._animated = null;
    }
    const points = shape._points;
    if (!points || points.length === 0) return;
    this.turnShapes.push(shape);

    // First shape of the turn: show it right away.
    if (this.currentConcepts.length === 0) {
      this._clearConceptCycle();
      this.currentConcepts = [shape];
      this.conceptIndex = 0;
      this._showCurrentConcept('instant');
      return;
    }

    this.currentConcepts.push(shape);

    // Rotate through shapes while we wait for concepts_done.
    if (this.currentConcepts.length === 2 && !this.conceptTimer) {
      this.conceptTimer = setInterval(() => {
        if (turn !== this.turnId) return;
        this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
        this._showCurrentConcept('crossfade');
      }, CYCLE_MS);
    }
  }

  /**
   * All shapes for this turn have arrived. Every turn follows the same
   * two-phase arc: (1) cycle through each remaining unshown shape at
   * CYCLE_MS intervals so the viewer sees every concept individually,
   * (2) then arrange all shapes on the circular carousel together.
   */
  async _onConceptsDone() {
    const allShapes = this.turnShapes.filter(s => s._points && s._points.length > 0);

    if (allShapes.length === 0) {
      // Nothing visual came of this turn — don't leave the hurricane and
      // "I'm thinking about…" running forever.
      this._settleEmptyTurn();
      return;
    }
    if (allShapes.length === 1) {
      // Single shape: keep it, but the thinking title has done its job.
      this._clearConceptCycle();
      this.canvas.clearThinkingTitle();
      return;
    }

    // Make sure currentConcepts has the full set (shapes added after the
    // timer started would already be here, but guard against races).
    for (const s of allShapes) {
      if (!this.currentConcepts.includes(s)) this.currentConcepts.push(s);
    }

    // Stop the current timer — we're about to replace it with a finite
    // stepper that knows how many shapes remain.
    if (this.conceptTimer) {
      clearInterval(this.conceptTimer);
      this.conceptTimer = null;
    }

    const shapesForCarousel = allShapes.map(s => ({
      points: s._points,
      label: s.concept || s.name,
      animation: s._animated || null,
    }));

    // How many shapes are still unshown? Cycle through them, then carousel.
    const stepsLeft = allShapes.length - this.conceptIndex - 1;
    this._scheduleCarousel(shapesForCarousel, stepsLeft);
  }

  /**
   * Step through any unshown shapes at CYCLE_MS intervals, then call
   * `setShapes` to arrange them all on the circular carousel.
   */
  _scheduleCarousel(shapesForCarousel, stepsLeft) {
    const turn = this.turnId;
    const launch = () => {
      this.carouselTimer = null;
      if (turn !== this.turnId) return;
      this._clearConceptCycle();
      this.canvas.setShapes(shapesForCarousel);
    };

    if (stepsLeft <= 0) {
      // Everything already shown — brief pause on the last shape, then
      // fan them out onto the ring.
      this.carouselTimer = setTimeout(launch, CYCLE_MS);
      return;
    }

    let remaining = stepsLeft;
    this.conceptTimer = setInterval(() => {
      if (turn !== this.turnId) return;
      this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
      this._showCurrentConcept('crossfade');
      remaining--;
      if (remaining <= 0) {
        clearInterval(this.conceptTimer);
        this.conceptTimer = null;
        // Show the final shape for a moment, then carousel.
        this.carouselTimer = setTimeout(launch, CYCLE_MS);
      }
    }, CYCLE_MS);
  }

  /**
   * Resolve a shape info object to its particle point cloud. An empty
   * point cloud is a miss (falls through to the next source), never a
   * shape — `setShape([])` would dissolve the whole canvas.
   */
  async _resolvePoints(info) {
    let points = null;

    // Lottie animated shapes return a multi-frame descriptor instead of a
    // flat point array. The descriptor has { isAnimated, frames, fps, points }.
    if (info.type === 'lottie' && info.dynamic) {
      const cacheKey = `lottie:${info.dynamic}`;
      if (this.shapeCache[cacheKey]) return this.shapeCache[cacheKey];

      const result = await loadLottieShape(info.dynamic, 300, getShapeParticleBudget(), 24);
      if (result && result.frames.length > 0 && result.frames[0].length > 0) {
        const descriptor = {
          isAnimated: true,
          frames: result.frames,
          fps: result.fps,
          duration: result.duration,
          points: result.frames[0],
          staticCount: result.staticCount || 0,
        };
        this.shapeCache[cacheKey] = descriptor;
        return descriptor;
      }
      // Lottie rasterization failed — fall through to static pipeline
    }

    if (info.dynamic && !info.dynamic.endsWith('.json')) {
      const cacheKey = info.dynamic;
      if (this.shapeCache[cacheKey]) {
        points = this.shapeCache[cacheKey];
      } else {
        const loaded = await loadExternalShape(info.dynamic, 300, getShapeParticleBudget());
        if (loaded && loaded.length > 0) {
          points = loaded;
          this.shapeCache[cacheKey] = points;
        }
      }
    }

    if (!points) {
      const shapeName = conceptToShape(info.name);
      points = this.shapeCache[shapeName];
      if (!points) {
        const built = rasterizeShape(shapeName, 300, getShapeParticleBudget());
        if (built && built.length > 0) {
          points = built;
          this.shapeCache[shapeName] = points;
        }
      }
    }

    return points || null;
  }

  _showCurrentConcept(transition = 'instant') {
    const info = this.currentConcepts[this.conceptIndex];
    if (!info || !info._points) return;
    const label = info.concept || info.name;
    this.canvas.setShape(info._points, label, transition, info._animated || null);
  }

  _showThinkingTitle() {
    // Budget slightly boosted over the old 0.15 — we're allocating ~20% of
    // it to the trailing ellipsis that seeps into the hurricane.
    const budget = Math.floor(getShapeParticleBudget() * 0.18);
    const points = rasterizeText('I\'m thinking about', {
      font: THINKING_FONT,
      maxPoints: Math.floor(budget * 0.80),
      alphaThreshold: 128,
      edgeOnly: true,
      letterSpacing: 10,
    });
    if (!points) return;

    // Discrete trail of dots extending from the end of "about". Each dot
    // is a small round cluster; the dots are stationary (no rightward drift
    // in the animation). Particles at each dot cycle through a per-particle
    // phase — most of the cycle they sit at the dot; near the end of the
    // cycle they're released into the hurricane (dissipating in place at
    // the dot's position); at wrap the particle is teleported back to the
    // dot. Net visual: discrete, recognizable "..." trail where each dot
    // subtly shimmers with particles coming and going.
    const textMaxY = points.reduce((m, p) => p.y > m ? p.y : m, 0);
    const textMinY = points.reduce((m, p) => p.y < m ? p.y : m, 1);
    const centerY = (textMinY + textMaxY) / 2;
    const glyphHeight = textMaxY - textMinY;
    const numDots = 3;
    const dotParticles = 10;  // tight dots — a handful of particles each
    const dotRadius = glyphHeight * 0.022;
    // Three small dots forming a plain ellipsis right after "about".
    const trailStart = 1.02;
    const trailEnd = 1.12;
    const dotY = centerY + glyphHeight * 0.12;
    const trail = [];
    for (let i = 0; i < numDots; i++) {
      const t = numDots === 1 ? 0 : i / (numDots - 1);
      const xCenter = trailStart + t * (trailEnd - trailStart);
      for (let k = 0; k < dotParticles; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * dotRadius;
        trail.push({
          x: xCenter + Math.cos(a) * r * 0.6,
          y: dotY + Math.sin(a) * r,
          edge: true,
          seep: true,
          // Constrain initial phase to the "tethered" portion of the cycle
          // (0..0.6) so a freshly-activated dot doesn't have half its
          // particles immediately in the release window — they all get a
          // full moment of visibility before any start streaming off.
          seepPhaseInit: Math.random() * 0.6,
          // Left-to-right activation order: dot 0 lights up first, the last
          // dot last — gives the "typing the ellipsis in" feel instead of
          // all dots appearing simultaneously.
          seepDotIndex: i,
        });
      }
    }
    const combined = points.concat(trail);
    combined.aspectRatio = points.aspectRatio;
    this.canvas.setThinkingTitle(combined);
  }

  /** End a turn that produced no shapes: drop the thinking title, calm down. */
  _settleEmptyTurn() {
    this._clearConceptCycle();
    this.canvas.clearThinkingTitle();
    this.canvas.setState('idle');
  }

  _clearConceptCycle() {
    if (this.conceptTimer) {
      clearInterval(this.conceptTimer);
      this.conceptTimer = null;
    }
    if (this.carouselTimer) {
      clearTimeout(this.carouselTimer);
      this.carouselTimer = null;
    }
    this.currentConcepts = [];
    this.conceptIndex = 0;
  }
}

try {
  window.app = new App();
  console.log('[app] App created successfully');
} catch (err) {
  console.error('[app] App constructor CRASHED:', err.message, err.stack);
}
