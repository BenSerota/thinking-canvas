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
const helmet = require('helmet');
const path = require('path');

// Services
const chatService = require('./services/chat-service');
const shapeService = require('./services/shape-service');
const iconMatcher = require('./services/icon-matcher');
const emojiService = require('./services/emoji-service');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Request limits. The API is unauthenticated on the public deploy, so every
// bound here is a cost bound on Ben's API key.
const MAX_MESSAGE_CHARS = 10000;
const MAX_HISTORY_ENTRIES = 50;
const MAX_HISTORY_ENTRY_CHARS = 4000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_REQUESTS = 20;
const SSE_PING_MS = 15000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

// Render terminates TLS at a proxy; req.ip must come from X-Forwarded-For.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'connect-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '1mb' }));

// Cached and generated SVGs are third-party or model-authored content. The
// client only ever fetches them as text and parses them with DOMParser, but
// serve them under a no-script sandbox so navigating to one directly can
// never execute in the app origin even if a sanitizer slips.
app.use('/shapes', express.static(path.join(PUBLIC_DIR, 'shapes'), {
  setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"),
}));
app.use(express.static(PUBLIC_DIR));

// ─── Rate limiting: in-memory sliding window per IP ───
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const stamps = (rateBuckets.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (stamps.length >= RATE_MAX_REQUESTS) {
    res.status(429).json({ error: 'Too many requests, slow down.' });
    return;
  }
  stamps.push(now);
  rateBuckets.set(key, stamps);
  if (rateBuckets.size > 1000) {
    for (const [ip, times] of rateBuckets) {
      if (!times.some(t => now - t < RATE_WINDOW_MS)) rateBuckets.delete(ip);
    }
  }
  next();
}
app.use('/api/', rateLimit);

/** Returns an error string for a bad chat body, or null if it is acceptable. */
function validateChatBody(body) {
  const { message, history } = body || {};
  if (!message || typeof message !== 'string') return 'No message provided';
  if (message.length > MAX_MESSAGE_CHARS) return 'Message too long';
  if (history !== undefined) {
    if (!Array.isArray(history) || history.length > MAX_HISTORY_ENTRIES) return 'Invalid history';
    for (const entry of history) {
      if (!entry || typeof entry !== 'object' || typeof entry.role !== 'string' || typeof entry.content !== 'string') {
        return 'Invalid history entry';
      }
      if (entry.content.length > MAX_HISTORY_ENTRY_CHARS) return 'History entry too long';
    }
  }
  return null;
}

/**
 * POST /api/chat/stream
 *
 * Pipeline:
 * 1. Chat Service → Sonnet 5 adaptive thinking + streaming response, with
 *    the Haiku visual extractor started in parallel at t=0
 * 2. Shape Service → resolves the extracted concepts concurrently, in a
 *    detached task so reply text keeps streaming while shapes resolve
 * 3. SSE → typed events to the client:
 *    thinking_delta, thinking_done, concept_resolved, text, error,
 *    concepts_done (always, possibly empty), done
 */
app.post('/api/chat/stream', async (req, res) => {
  const problem = validateChatBody(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const { message, history } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Detect a client disconnect on the RESPONSE: `res` emits 'close' when the
  // socket goes away, and writableEnded is still false at that point. (The
  // request's own 'close' fires as soon as its body is consumed, i.e. before
  // this handler even runs — never abort on that.)
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const alive = () => !res.writableEnded && !res.destroyed && !ac.signal.aborted;
  const send = (payload) => { if (alive()) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
  // Keep proxies from idling out the connection during a long resolution.
  const ping = setInterval(() => { if (alive()) res.write(': ping\n\n'); }, SSE_PING_MS);

  const collected = [];
  let shapesDone = null;

  const resolveShapes = async (visuals) => {
    const iconics = visuals.map(v => v.iconic).filter(Boolean);
    if (iconics.length > 0) console.log('[visuals] Iconic concepts:', iconics.join(', '));
    try {
      for await (const shape of shapeService.streamConceptShapes(visuals)) {
        if (!alive()) break;
        collected.push(shape);
        const scoreStr = typeof shape.score === 'number' ? `, ${shape.score.toFixed(2)}` : '';
        console.log(`[icons] "${shape.concept}" → ${shape.dynamic || shape.name} (${shape.source}${scoreStr})`);
        send({ type: 'concept_resolved', shape });
      }
    } catch (err) {
      console.error('[shapes] resolution failed:', err.message);
    }
  };

  try {
    for await (const event of chatService.createStream(message, history, ac.signal)) {
      if (!alive()) break;
      switch (event.type) {
        case 'thinking_delta':
          send({ type: 'thinking_delta', text: event.text });
          break;
        case 'thinking_done':
          send({ type: 'thinking_done' });
          break;
        case 'visual_concepts':
          // Run in the background — the chat stream keeps flowing meanwhile.
          if (!shapesDone) shapesDone = resolveShapes(event.visuals);
          break;
        case 'text':
          send({ type: 'text', text: event.text });
          break;
        case 'done':
          break;
      }
    }
  } catch (err) {
    console.error('Stream error:', err.name, err.message);
    send({ type: 'error', message: 'Something went wrong. Please try again.' });
  }

  if (shapesDone) await shapesDone;
  send({ type: 'concepts_done', concepts: collected });
  send({ type: 'done' });
  clearInterval(ping);
  if (!res.writableEnded) res.end();
});

/**
 * POST /api/chat (non-streaming fallback — same pipeline, one JSON reply)
 */
app.post('/api/chat', async (req, res) => {
  const problem = validateChatBody(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const { message, history } = req.body;

  try {
    let fullText = '';
    let visuals = [];
    for await (const event of chatService.createStream(message, history)) {
      if (event.type === 'text') fullText += event.text;
      if (event.type === 'visual_concepts') visuals = event.visuals;
    }
    const shapes = await shapeService.mapConceptsToShapes(visuals);
    res.json({ text: fullText, concepts: shapes });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({
      text: 'Sorry, something went wrong. Please try again.',
      concepts: [{ name: 'question', concept: 'question', dynamic: null, source: 'builtin' }],
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Thinking Canvas is running!\n`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);

  setImmediate(async () => {
    try {
      await iconMatcher.init();
    } catch (err) {
      console.warn('[server] iconMatcher init failed:', err.message);
    }
    await new Promise(resolve => setImmediate(resolve));
    try {
      await emojiService.init();
    } catch (err) {
      console.warn('[server] emojiService init failed:', err.message);
    }
  });
});
