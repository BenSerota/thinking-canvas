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

    // Turn counter — turn 1 is pure crossfade (the dramatic intro to the
    // shape metaphor). Turn 2+ gets crossfade during streaming, then the
    // carousel arrangement at concepts_done.
    this.turnsCompleted = 0;

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
    // Budget the title at ~35% of shape particles so the hurricane underneath
    // has ample free particles to swirl with.
    const titleBudget = Math.floor(getShapeParticleBudget() * 0.35);
    // Thin serif reads as elegant rather than blocky when rasterized to
    // particles (the particle pass thickens strokes further because every
    // AA pixel above alpha 128 becomes a cluster). Weight 300, Garamond-
    // family fallback stack ends at Georgia for ubiquitous availability.
    const points = rasterizeText('Thinking Canvas', {
      font: "300 56px 'Cormorant Garamond', 'EB Garamond', 'Didot', 'Didot LT STD', Georgia, serif",
      maxPoints: titleBudget,
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
    const points = await this._resolvePoints(shape);
    if (!points) return;

    shape._points = points;  // attach for _onConceptsDone to reuse
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

    // Rotate through shapes while we wait for concepts_done.
    if (this.currentConcepts.length === 2 && !this.conceptTimer) {
      this.conceptTimer = setInterval(() => {
        this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
        this._showCurrentConcept('crossfade');
      }, 4000);
    }
  }

  /**
   * All shapes for this turn have arrived. Stop the crossfade rotation and
   * switch to side-by-side multi-shape view (if 2+ shapes).
   */
  async _onConceptsDone() {
    this._clearConceptCycle();

    // Turn 1 is pure crossfade — keep the shapes cycling through the center
    // via the existing conceptTimer. Turn 2+ switches to the carousel so
    // the viewer can see all three together once they've seen each one
    // individually in the first exchange.
    if (this.turnShapes.length >= 2 && this.turnsCompleted >= 1) {
      const shapesForCanvas = this.turnShapes
        .filter(s => s._points && s._points.length > 0)
        .map(s => ({
          points: s._points,
          label: s.concept || s.name,
        }));
      if (shapesForCanvas.length >= 2) {
        // Carousel replaces the crossfade — stop the cycle timer so the
        // canvas isn't also trying to swap shapes under us.
        this._clearConceptCycle();
        this.canvas.setShapes(shapesForCanvas);
      }
    }

    this.turnsCompleted++;
  }

  /**
   * Resolve a shape info object to its particle point cloud.
   * Factored out of _showCurrentConcept so _onConceptResolved can
   * pre-resolve for later reuse in setShapes.
   */
  async _resolvePoints(info) {
    let points = null;

    if (info.dynamic) {
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
      }, 4000);
    }
  }

  async _showCurrentConcept(transition = 'instant') {
    const info = this.currentConcepts[this.conceptIndex];
    if (!info) return;

    const points = info._points || await this._resolvePoints(info);
    if (!points) return;

    const label = info.concept || info.name;
    this.canvas.setShape(points, label, transition);
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
