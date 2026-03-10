/**
 * Orchestrator — ties together the Thinking Canvas, Chat Panel, and AI backend
 */

import { ThinkingCanvas } from './canvas.js';
import { ChatPanel } from './chat.js';
import { rasterizeShape, conceptToShape, getAvailableShapes } from './shapes.js';

class App {
  constructor() {
    this.canvas = new ThinkingCanvas(document.getElementById('thinkingCanvas'));
    this.chat = new ChatPanel(document.getElementById('chatPanel'), (msg) => this.handleUserMessage(msg));
    this.shapeCache = {};
    this.currentConcepts = [];
    this.conceptIndex = 0;
    this.conceptTimer = null;

    // Pre-cache some common shapes
    this._precacheShapes();

    // Show welcome state
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

    // Show thinking state on canvas
    this.canvas.setThinking(true);
    this._clearConceptCycle();

    try {
      // Use streaming endpoint
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: this.chat.getHistory()
        })
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
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));

          switch (data.type) {
            case 'concepts':
              this.canvas.setThinking(false);
              this._startConceptCycle(data.concepts);
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
      this.canvas.setThinking(false);
      this.chat.addMessage('assistant', 'Sorry, something went wrong. Please try again.');
    }

    this.chat.setInputEnabled(true);
  }

  /**
   * Cycle through concepts, showing each shape for a few seconds.
   */
  _startConceptCycle(concepts) {
    this._clearConceptCycle();

    // Map concept names to shape names
    this.currentConcepts = concepts.map(c => conceptToShape(c));
    this.conceptIndex = 0;

    this._showCurrentConcept();

    // Cycle through concepts if there are multiple
    if (this.currentConcepts.length > 1) {
      this.conceptTimer = setInterval(() => {
        this.conceptIndex = (this.conceptIndex + 1) % this.currentConcepts.length;
        this._showCurrentConcept();
      }, 4000); // Switch every 4 seconds
    }
  }

  _showCurrentConcept() {
    const shapeName = this.currentConcepts[this.conceptIndex];
    let points = this.shapeCache[shapeName];

    if (!points) {
      points = rasterizeShape(shapeName);
      if (points) this.shapeCache[shapeName] = points;
    }

    if (points) {
      this.canvas.setShape(points, shapeName);
    }
  }

  _clearConceptCycle() {
    if (this.conceptTimer) {
      clearInterval(this.conceptTimer);
      this.conceptTimer = null;
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
