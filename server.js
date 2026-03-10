const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Available shapes for concept visualization
const AVAILABLE_SHAPES = [
  'car', 'truck', 'bicycle', 'airplane', 'boat',
  'dog', 'cat', 'bird', 'fish', 'horse',
  'house', 'building', 'castle',
  'tree', 'mountain', 'sun', 'cloud', 'flower',
  'phone', 'computer', 'book', 'cup', 'key', 'guitar',
  'person', 'question', 'search', 'star', 'food'
];

// Keyword-to-concept mapping for canvas visuals
const CONCEPT_KEYWORDS = {
  car: /\b(car|vehicle|auto|sedan|suv|drive|driving|truck|van)\b/i,
  dog: /\b(dog|puppy|canine|labrador|retriever|dalmatian)\b/i,
  cat: /\b(cat|kitten|feline)\b/i,
  horse: /\b(horse|pony|stallion|mare)\b/i,
  bird: /\b(bird|parrot|eagle|sparrow|penguin)\b/i,
  fish: /\b(fish|salmon|trout|aquarium|ocean creature)\b/i,
  airplane: /\b(fly|flight|airplane|plane|airport|travel|trip|vacation)\b/i,
  boat: /\b(boat|ship|sail|cruise|ocean|sea)\b/i,
  house: /\b(home|house|apartment|rent|real estate|room|living)\b/i,
  building: /\b(building|office|skyscraper|city|urban)\b/i,
  tree: /\b(tree|forest|wood|nature|garden|plant)\b/i,
  mountain: /\b(mountain|hill|climb|hike|hiking|trail)\b/i,
  sun: /\b(sun|sunny|weather|warm|summer|beach)\b/i,
  cloud: /\b(cloud|rain|storm|weather|sky)\b/i,
  flower: /\b(flower|rose|garden|bloom|blossom)\b/i,
  computer: /\b(computer|laptop|software|code|program|tech|ai|algorithm)\b/i,
  phone: /\b(phone|mobile|call|text|smartphone)\b/i,
  book: /\b(book|read|novel|story|author|library|write|writing)\b/i,
  guitar: /\b(music|song|instrument|guitar|piano|band|concert|sing)\b/i,
  food: /\b(food|cook|recipe|restaurant|eat|dinner|lunch|meal|breakfast)\b/i,
  cup: /\b(coffee|tea|drink|cup|beverage)\b/i,
  person: /\b(person|people|friend|family|human|someone)\b/i,
  star: /\b(star|space|universe|galaxy|night|amazing|great)\b/i,
};

/**
 * Extract visual concepts from a message using keyword matching.
 * Returns 1-2 shape names for the canvas to display.
 */
function extractConcepts(message) {
  const matches = [];
  for (const [concept, pattern] of Object.entries(CONCEPT_KEYWORDS)) {
    if (pattern.test(message)) {
      matches.push(concept);
    }
  }
  if (matches.length === 0) return ['search', 'question'];
  return matches.slice(0, 2);
}

/**
 * Build a prompt string that includes conversation history.
 */
function buildPrompt(message, history) {
  if (!history || history.length === 0) {
    return message;
  }

  // Include recent history for context (last 10 messages max)
  const recent = history.slice(-10);
  const lines = recent.map(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.text}`;
  });

  lines.push(`User: ${message}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are a friendly, conversational AI assistant called Thinking Canvas. You're embedded in a visual interface where particles on a canvas form shapes related to the conversation topic. Keep your responses concise but helpful (2-4 sentences typically). Be warm and engaging.`;

/**
 * POST /api/chat/stream
 * Streams real Claude responses via the claude CLI subprocess.
 */
app.post('/api/chat/stream', (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send concepts immediately based on the user's message
  const concepts = extractConcepts(message);
  res.write(`data: ${JSON.stringify({ type: 'concepts', concepts })}\n\n`);

  const prompt = buildPrompt(message, history);

  // Build env without CLAUDECODE to allow nested invocation
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;

  const child = spawn('claude', [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--system-prompt', SYSTEM_PROMPT,
    '--verbose',
  ], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Close stdin immediately since we passed the prompt via -p
  child.stdin.end();

  let buffer = '';
  let hasStreamedText = false;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);

        // stream-json format wraps events in { type: "stream_event", event: {...} }
        if (data.type === 'stream_event' && data.event) {
          const evt = data.event;
          if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
            hasStreamedText = true;
            res.write(`data: ${JSON.stringify({ type: 'text', text: evt.delta.text })}\n\n`);
          }
        }
        // Also handle "assistant" message type (complete message, non-streaming fallback)
        else if (data.type === 'assistant' && data.message) {
          // data.message is an object with content array
          const content = data.message.content || [];
          for (const block of content) {
            if (block.type === 'text' && block.text && !hasStreamedText) {
              res.write(`data: ${JSON.stringify({ type: 'text', text: block.text })}\n\n`);
              hasStreamedText = true;
            }
          }
        }
        // Handle "result" type as final fallback
        else if (data.type === 'result' && data.result && !hasStreamedText) {
          res.write(`data: ${JSON.stringify({ type: 'text', text: data.result })}\n\n`);
          hasStreamedText = true;
        }
      } catch (e) {
        // Not valid JSON, skip
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    console.error('Claude CLI stderr:', chunk.toString());
  });

  child.on('close', (code) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        if (data.type === 'stream_event' && data.event) {
          const evt = data.event;
          if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ type: 'text', text: evt.delta.text })}\n\n`);
          }
        } else if (data.type === 'result' && data.result && !hasStreamedText) {
          res.write(`data: ${JSON.stringify({ type: 'text', text: data.result })}\n\n`);
        }
      } catch (e) {
        // ignore
      }
    }

    if (code !== 0 && !hasStreamedText) {
      res.write(`data: ${JSON.stringify({ type: 'text', text: 'Error: Claude CLI exited with code ' + code + '. Make sure "claude" is installed and authenticated. Run "claude" in your terminal to set up.' })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  });

  child.on('error', (err) => {
    console.error('Failed to start Claude CLI:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'text', text: 'Error: Could not start the "claude" CLI. Make sure Claude Code is installed. Visit https://docs.anthropic.com/en/docs/claude-code to install it.' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    child.kill();
  });
});

/**
 * POST /api/chat (non-streaming fallback)
 */
app.post('/api/chat', (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  const concepts = extractConcepts(message);
  const prompt = buildPrompt(message, history);

  const childEnv2 = { ...process.env };
  delete childEnv2.CLAUDECODE;

  const child = spawn('claude', [
    '-p', prompt,
    '--output-format', 'json',
    '--system-prompt', SYSTEM_PROMPT,
  ], {
    env: childEnv2,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdin.end();

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({
        text: 'Error: Claude CLI failed. Make sure "claude" is installed and authenticated.',
        concepts: ['question']
      });
    }
    try {
      const data = JSON.parse(stdout);
      res.json({ text: data.result || stdout, concepts });
    } catch {
      res.json({ text: stdout.trim(), concepts });
    }
  });

  child.on('error', () => {
    res.status(500).json({
      text: 'Error: Could not start "claude" CLI. Install Claude Code first.',
      concepts: ['question']
    });
  });
});

app.listen(PORT, () => {
  console.log(`\n  Thinking Canvas is running!\n`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
