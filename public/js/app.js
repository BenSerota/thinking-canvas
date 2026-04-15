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

            case 'concepts':
              // State 2 → 3: Haiku concepts arrived — form shapes
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
   * Start cycling through shapes from concept events.
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
      this.canvas.setShape(points, info.name, transition);
    }
  }

  _clearConceptCycle() {
    if (this.conceptTimer) {
      clearInterval(this.conceptTimer);
      this.conceptTimer = null;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
