const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic();

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
 * Build messages array from conversation history for the Anthropic API.
 */
function buildMessages(message, history) {
  const messages = [];

  if (history && history.length > 0) {
    const recent = history.slice(-10);
    for (const msg of recent) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content || msg.text,
      });
    }
  }

  messages.push({ role: 'user', content: message });
  return messages;
}

const SYSTEM_PROMPT = `You are a friendly, conversational AI assistant called Thinking Canvas. You're embedded in a visual interface where particles on a canvas form shapes related to the conversation topic. Keep your responses concise but helpful (2-4 sentences typically). Be warm and engaging.`;

/**
 * POST /api/chat/stream
 * Streams responses via the Anthropic SDK.
 */
app.post('/api/chat/stream', async (req, res) => {
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

  try {
    const messages = buildMessages(message, history);

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('error', (err) => {
      if (err.name === 'APIUserAbortError') {
        // Client disconnected, nothing to do
        return;
      }
      console.error('Anthropic stream error:', err.message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'text', text: 'Error communicating with Claude API.' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      }
    });

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      stream.abort();
    });
  } catch (err) {
    console.error('Failed to create stream:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'text', text: 'Error: Could not connect to Claude API. Check your ANTHROPIC_API_KEY.' })}\n\n`);
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

  const concepts = extractConcepts(message);

  try {
    const messages = buildMessages(message, history);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    res.json({ text, concepts });
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    res.status(500).json({
      text: 'Error: Could not get response from Claude API. Check your ANTHROPIC_API_KEY.',
      concepts: ['question'],
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Thinking Canvas is running!\n`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
