// Load .env manually (dotenvx intercepts dotenv and breaks it)
const fs = require('fs');
const envPath = require('path').join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const express = require('express');
const path = require('path');

// Services
const chatService = require('./services/chat-service');
const shapeService = require('./services/shape-service');
const conceptService = require('./services/concept-service'); // fallback only
const iconMatcher = require('./services/icon-matcher');

const app = express();
const PORT = process.env.PORT || 3000;

// Warm up icon matcher at boot so first request doesn't pay the init cost
iconMatcher.init().catch(err => console.warn('[server] iconMatcher init failed:', err.message));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/chat/stream
 *
 * Pipeline:
 * 1. Chat Service → Sonnet extended thinking + streaming response
 * 2. Visual Extractor (Haiku) → fires concurrently after thinking block
 * 3. Shape Service → maps Haiku concepts to renderable shapes
 * 4. SSE → typed events to client
 */
app.post('/api/chat/stream', async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // No immediate concepts — let canvas stay in gathering/thinking state
  // Haiku will provide concepts when ready

  try {
    for await (const event of chatService.createStream(message, history)) {
      if (res.writableEnded) break;

      switch (event.type) {
        case 'thinking_text': {
          // Raw thinking text for collapsible UI
          res.write(`data: ${JSON.stringify({ type: 'thinking', text: event.text })}\n\n`);
          break;
        }

        case 'visual_concepts': {
          // Haiku-extracted iconic concepts → map through iconMatcher/generator → send to client
          const iconics = event.visuals.map(v => v.iconic).filter(Boolean);
          if (iconics.length > 0) {
            console.log('[visuals] Iconic concepts:', iconics.join(', '));
          }

          const shapes = await shapeService.mapConceptsToShapes(event.visuals);

          // Log how each iconic resolved — source + score
          for (let i = 0; i < event.visuals.length && i < shapes.length; i++) {
            const iconic = event.visuals[i].iconic;
            const s = shapes[i];
            const scoreStr = typeof s.score === 'number' ? `, ${s.score.toFixed(2)}` : '';
            console.log(`[icons] "${iconic}" → ${s.name}${s.dynamic ? '.svg' : ''} (${s.source}${scoreStr})`);
          }

          res.write(`data: ${JSON.stringify({ type: 'concepts', concepts: shapes, source: 'haiku' })}\n\n`);
          break;
        }

        case 'text': {
          res.write(`data: ${JSON.stringify({ type: 'text', text: event.text })}\n\n`);
          break;
        }

        case 'done': {
          break;
        }
      }
    }
  } catch (err) {
    if (res.writableEnded) return;
    console.error('Stream error:', err.name, err.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'text', text: `API error: ${err.message}` })}\n\n`);
    }
  }

  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
});

/**
 * POST /api/chat (non-streaming fallback)
 */
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  try {
    let fullText = '';
    let visuals = [];

    for await (const event of chatService.createStream(message, history)) {
      if (event.type === 'text') fullText += event.text;
      if (event.type === 'visual_concepts') visuals = event.visuals;
    }

    let shapes;
    if (visuals.length > 0) {
      shapes = await shapeService.mapConceptsToShapes(visuals);
    } else {
      // Fallback: build pseudo-visuals from regex-extracted concepts
      const words = conceptService.extractConceptsFromText(message);
      const pseudoVisuals = words.map(w => ({ iconic: w, shape: w }));
      shapes = await shapeService.mapConceptsToShapes(pseudoVisuals);
    }
    res.json({ text: fullText, concepts: shapes });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({
      text: 'Error: Could not get response from Claude API. Check your ANTHROPIC_API_KEY.',
      concepts: [{ name: 'question', dynamic: null }],
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Thinking Canvas is running!\n`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
