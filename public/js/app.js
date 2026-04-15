/**
 * Orchestrator — ties together the Thinking Canvas, Chat Panel, and AI backend
 *
 * Three visual states:
 * 1. Idle — particles drift ambient
 * 2. Thinking — hurricane vortex while LLM reasons
 * 3. Forming — shapes materialize from Haiku-extracted concepts
 */

import { ThinkingCanvas } from './canvas.js';
import { ChatPanel } from './chat.js';
import { rasterizeShape, loadExternalShape, conceptToShape, getAvailableShapes } from './shapes.js';

class App {
  constructor() {
    this.canvas = new ThinkingCanvas(document.getElementById('thinkingCanvas'));
    this.chat = new ChatPanel(document.getElementById('chatPanel'), (msg) => this.handleUserMessage(msg));
    this.shapeCache = {};
    this.currentConcepts = [];
    this.conceptIndex = 0;
    this.conceptTimer = null;

    this._precacheShapes();

    setTimeout(() => {
      this.chat.addMessage('assistant',
        'Hello! I\'m your AI assistant with visual thinking. As we talk, watch the canvas — you\'ll see my thoughts taking shape. Try asking me about cars, pets, travel, or anything else!'
      );
    }, 500);
  }

  _precacheShapes() {
    const shapes = getAvailableShapes();
    for (const name of shapes) {
      this.shapeCache[name] = rasterizeShape(name);
    }
  }

  async handleUserMessage(text) {
    this.chat.setInputEnabled(false);

    // State 1 → 2: Gathering, then thinking when LLM starts reasoning
    this.canvas.setState('gathering');
    this._clearConceptCycle();

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
              // Show thinking text in collapsible UI + enter hurricane state
              this.chat.addThinkingMessage(data.text);
              this.canvas.setState('thinking');
              break;

            case 'concept_resolved':
              // Per-shape streaming: render the FIRST arrival immediately so
              // the canvas starts forming while shapes 2-3 are still resolving
              // on the server (potentially including slow svg-generator calls).
              if (data.shape) this._onConceptResolved(data.shape);
              break;

            case 'concepts_done':
              // Terminal marker — all shapes have arrived. The rotation timer
              // was started on the second arrival; nothing to do here.
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
   * Handle a single concept_resolved SSE event. Renders the first shape
   * immediately, then appends later shapes and starts the 4-s rotation timer
   * on the second arrival.
   */
  _onConceptResolved(shape) {
    if (this.currentConcepts.length === 0) {
      // First arrival — drop thinking state, render this shape now
      this.canvas.interimMode = false;
      this._clearConceptCycle();
      this.currentConcepts = [shape];
      this.conceptIndex = 0;
      this._showCurrentConcept('instant');
      return;
    }

    this.currentConcepts.push(shape);

    // Start rotation timer the moment we have 2 shapes to cycle between
    if (this.currentConcepts.length === 2 && !this.conceptTimer) {
      this.conceptTimer = setInterval(() => {
        this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
        this._showCurrentConcept('crossfade');
      }, 4000);
    }
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

    let points = null;

    // Try dynamic SVG first — use cached rasterization if we've seen this URL before
    if (info.dynamic) {
      const cacheKey = info.dynamic;
      if (this.shapeCache[cacheKey]) {
        points = this.shapeCache[cacheKey];
      } else {
        points = await loadExternalShape(info.dynamic);
        if (points) this.shapeCache[cacheKey] = points;
      }
    }

    // Fall back to built-in shape
    if (!points) {
      const shapeName = conceptToShape(info.name);
      points = this.shapeCache[shapeName];
      if (!points) {
        points = rasterizeShape(shapeName);
        if (points) this.shapeCache[shapeName] = points;
      }
    }

    if (points) {
      // Label = Haiku's original iconic phrase (e.g. "basketball hoop") when
      // available, falling back to the matched filename. This is what
      // surfaces on the canvas as the small label at the bottom.
      const label = info.concept || info.name;
      this.canvas.setShape(points, label, transition);
    }
  }

  _clearConceptCycle() {
    if (this.conceptTimer) {
      clearInterval(this.conceptTimer);
      this.conceptTimer = null;
    }
    // Reset collected concepts so the first concept_resolved of the next
    // message triggers the "first arrival" render path.
    this.currentConcepts = [];
    this.conceptIndex = 0;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
