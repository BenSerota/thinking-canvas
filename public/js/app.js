/**
 * Orchestrator — ties together the Thinking Canvas, Chat Panel, and AI backend
 *
 * Lifecycle per turn:
 * 1. Page load: particle-typography title shows ("Thinking Canvas"), ambient
 *    hurricane drifts underneath.
 * 2. User sends: title dissolves into gathering → thinking → hurricane ramps up.
 * 3. Shapes stream in one-by-one (crossfade): viewer sees Claude's "current
 *    thought" as each concept arrives.
 * 4. concepts_done: all streamed shapes arrange side-by-side and rotate slowly
 *    in place. Free particles orbit each shape as its own mini-hurricane.
 * 5. Next user message: everything dissolves back to the hurricane. Repeat.
 */

import { ThinkingCanvas, getShapeParticleBudget } from './canvas.js';
import { ChatPanel } from './chat.js';
import { rasterizeShape, loadExternalShape, rasterizeText, conceptToShape, getAvailableShapes } from './shapes.js';
import { loadLottieShape } from './lottie-rasterizer.js';

// How long each shape stays on screen during the crossfade cycle (ms).
// Also the pause before/after the carousel swap. 2s is the sweet spot —
// long enough to register the silhouette and label, short enough that 3
// shapes cycle in ~6s before the group view.
const CYCLE_MS = 2000;

class App {
  constructor() {
    this.canvas = new ThinkingCanvas(document.getElementById('thinkingCanvas'));
    this.chat = new ChatPanel(document.getElementById('chatPanel'), (msg) => this.handleUserMessage(msg));
    this.shapeCache = {};
    // Shapes accumulated during the current turn — used for the side-by-side
    // view once concepts_done arrives.
    this.turnShapes = [];
    this.currentConcepts = [];
    this.conceptIndex = 0;
    this.conceptTimer = null;

    this._precacheShapes();
    this._showTitle();

    setTimeout(() => {
      this.chat.addMessage('assistant',
        'Hello! I\'m your AI assistant with visual thinking. As we talk, watch the canvas — you\'ll see my thoughts taking shape. Try asking me about cars, pets, travel, or anything else!'
      );
    }, 500);
  }

  _precacheShapes() {
    const shapes = getAvailableShapes();
    const budget = getShapeParticleBudget();
    for (const name of shapes) {
      this.shapeCache[name] = rasterizeShape(name, 300, budget);
    }
  }

  /**
   * Rasterize the "Thinking Canvas" title into particle targets and hand it
   * to the canvas. Runs on page load and sets the canvas initial state to
   * 'title-idle' with ambient hurricane drifting underneath.
   */
  _showTitle() {
    const titleBudget = Math.floor(getShapeParticleBudget() * 0.25);
    const points = rasterizeText('Thinking Canvas', {
      font: "400 140px 'Love Light', cursive",
      maxPoints: titleBudget,
      alphaThreshold: 128,
    });
    if (points) {
      this.canvas.setTitle(points, 'Thinking Canvas');
    } else {
      console.warn('[app] Title rasterization failed — falling back to idle state');
    }
  }

  async handleUserMessage(text) {
    this.chat.setInputEnabled(false);

    // Release all particles (including title) into the gathering → hurricane.
    this.canvas.setState('gathering');
    this._clearConceptCycle();
    this.turnShapes = [];  // fresh for this turn

    // Show "I'm thinking about..." immediately as the hurricane forms.
    this._showThinkingTitle();

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: this.chat.getHistory().slice(0, -1),
        }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let stream = null;
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
            case 'thinking':
              this.chat.addThinkingMessage(data.text);
              this.canvas.setState('thinking');
              break;

            case 'concept_resolved':
              // Per-shape streaming: render the FIRST arrival immediately so
              // the canvas starts forming while shapes 2-3 are still resolving
              // on the server.
              if (data.shape) await this._onConceptResolved(data.shape);
              break;

            case 'concepts_done':
              // Terminal marker — all shapes have arrived. If we collected
              // 2+ shapes, switch from single-shape crossfade to side-by-side
              // multi-shape view.
              await this._onConceptsDone();
              break;

            case 'concepts':
              // Legacy batched payload — retained for any non-streaming path.
              this.canvas.interimMode = false;
              this._startConceptCycle(data.concepts || []);
              break;

            case 'text':
              if (!stream) {
                stream = this.chat.addStreamingMessage('assistant');
              }
              stream.append(data.text);
              break;

            case 'done':
              if (stream) stream.finish();
              break;
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      this.canvas.setState('idle');
      this.chat.addMessage('assistant', 'Sorry, something went wrong. Please try again.');
    }

    this.chat.setInputEnabled(true);
  }

  /**
   * Handle a single concept_resolved SSE event. During streaming, shapes
   * still crossfade one-by-one (that's the dramatic beat — viewer sees each
   * thought take shape in turn). We also collect them into turnShapes so
   * concepts_done can flip into side-by-side.
   */
  async _onConceptResolved(shape) {
    // Resolve the shape's points ONCE — we'll need them again for the
    // side-by-side switch. Cache on the shape object.
    const resolved = await this._resolvePoints(shape);
    if (!resolved) return;

    // Animated shapes return a descriptor { isAnimated, frames, fps, points }.
    // Static shapes return a plain point array. Normalize both into _points
    // (first frame for display) and _animated (full animation data if present).
    if (resolved.isAnimated) {
      shape._points = resolved.points;
      shape._animated = { frames: resolved.frames, fps: resolved.fps, staticCount: resolved.staticCount || 0 };
    } else {
      shape._points = resolved;
      shape._animated = null;
    }
    const points = shape._points;
    if (!points) return;
    this.turnShapes.push(shape);

    // Crossfade behavior during streaming, same as before.
    if (this.currentConcepts.length === 0) {
      this.canvas.interimMode = false;
      this._clearConceptCycle();
      this.currentConcepts = [shape];
      this.conceptIndex = 0;
      this._showCurrentConcept('instant');
      return;
    }

    this.currentConcepts.push(shape);

    // Rotate through shapes while we wait for concepts_done. 2s per shape
    // is snappy enough to feel responsive without flicker.
    if (this.currentConcepts.length === 2 && !this.conceptTimer) {
      this.conceptTimer = setInterval(() => {
        this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
        this._showCurrentConcept('crossfade');
      }, CYCLE_MS);
    }
  }

  /**
   * All shapes for this turn have arrived. Every turn follows the same
   * two-phase arc: (1) cycle through each remaining unshown shape at 2s
   * intervals so the viewer sees every concept individually, (2) then
   * arrange all shapes on the circular carousel together.
   *
   * If the server resolves shapes quickly, most still haven't been shown
   * by the time this fires — so we step through them here before the
   * carousel, rather than immediately swapping to the group view.
   */
  async _onConceptsDone() {
    const allShapes = this.turnShapes.filter(s => s._points && s._points.length > 0);

    if (allShapes.length < 2) {
      // Nothing to arrange — single (or zero) shape, just stop cycling.
      this._clearConceptCycle();
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
    const launch = () => {
      this._clearConceptCycle();
      this.canvas.setShapes(shapesForCarousel);
    };

    if (stepsLeft <= 0) {
      // Everything already shown — brief pause on the last shape, then
      // fan them out onto the ring.
      setTimeout(launch, CYCLE_MS);
      return;
    }

    let remaining = stepsLeft;
    this.conceptTimer = setInterval(() => {
      this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
      this._showCurrentConcept('crossfade');
      remaining--;
      if (remaining <= 0) {
        clearInterval(this.conceptTimer);
        this.conceptTimer = null;
        // Show the final shape for a moment, then carousel.
        setTimeout(launch, CYCLE_MS);
      }
    }, CYCLE_MS);
  }

  /**
   * Resolve a shape info object to its particle point cloud.
   * Factored out of _showCurrentConcept so _onConceptResolved can
   * pre-resolve for later reuse in setShapes.
   */
  async _resolvePoints(info) {
    let points = null;

    // Lottie animated shapes return a multi-frame descriptor instead of a
    // flat point array. The descriptor has { isAnimated, frames, fps, points }.
    if (info.type === 'lottie' && info.dynamic) {
      const cacheKey = `lottie:${info.dynamic}`;
      if (this.shapeCache[cacheKey]) return this.shapeCache[cacheKey];

      const result = await loadLottieShape(info.dynamic, 300, getShapeParticleBudget(), 24);
      if (result && result.frames.length > 0) {
        const descriptor = {
          isAnimated: true,
          frames: result.frames,
          fps: result.fps,
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
        points = await loadExternalShape(info.dynamic, 300, getShapeParticleBudget());
        if (points) this.shapeCache[cacheKey] = points;
      }
    }

    if (!points) {
      const shapeName = conceptToShape(info.name);
      points = this.shapeCache[shapeName];
      if (!points) {
        points = rasterizeShape(shapeName, 300, getShapeParticleBudget());
        if (points) this.shapeCache[shapeName] = points;
      }
    }

    return points;
  }

  /**
   * Start cycling through shapes from a batched concepts payload.
   * Legacy path — the streaming path uses _onConceptResolved instead.
   */
  _startConceptCycle(shapeInfos) {
    this._clearConceptCycle();
    this.currentConcepts = shapeInfos;
    this.conceptIndex = 0;
    this._showCurrentConcept();

    if (this.currentConcepts.length > 1) {
      this.conceptTimer = setInterval(() => {
        this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
        this._showCurrentConcept('crossfade');
      }, CYCLE_MS);
    }
  }

  async _showCurrentConcept(transition = 'instant') {
    const info = this.currentConcepts[this.conceptIndex];
    if (!info) return;

    let points = info._points;
    let animated = info._animated;
    if (!points) {
      const resolved = await this._resolvePoints(info);
      if (!resolved) return;
      if (resolved.isAnimated) {
        points = resolved.points;
        animated = { frames: resolved.frames, fps: resolved.fps };
      } else {
        points = resolved;
      }
    }
    if (!points) return;

    const label = info.concept || info.name;
    this.canvas.setShape(points, label, transition, animated || null);
  }

  _showThinkingTitle() {
    const budget = Math.floor(getShapeParticleBudget() * 0.15);
    const points = rasterizeText('I\'m thinking about...', {
      font: "400 100px 'Love Light', cursive",
      maxPoints: budget,
      alphaThreshold: 128,
    });
    if (points) {
      this.canvas.setThinkingTitle(points);
    }
  }

  _clearConceptCycle() {
    if (this.conceptTimer) {
      clearInterval(this.conceptTimer);
      this.conceptTimer = null;
    }
    this.currentConcepts = [];
    this.conceptIndex = 0;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
