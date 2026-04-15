/**
 * Chat Service
 *
 * Wraps the Anthropic SDK for streaming with extended thinking.
 * Concept extraction is handled by the visual-extractor (Haiku) service,
 * which we kick off at request start — BEFORE the Sonnet stream call — so
 * Haiku and Sonnet run truly in parallel from t=0. Previously Haiku waited
 * on Sonnet's thinking block to complete, adding 1-3 s to "first shape"
 * latency. Haiku's prompt handles an empty context string, and the tiny
 * quality loss from skipping the thinking buffer is dwarfed by the timing win.
 *
 * Yields typed events:
 *   { type: 'thinking_text', text }            — raw thinking block content
 *   { type: 'visual_concepts', visuals }       — from Haiku extraction
 *   { type: 'text', text }                     — response text
 *   { type: 'done' }
 */

const Anthropic = require('@anthropic-ai/sdk');
const visualExtractor = require('./visual-extractor');
const conceptService = require('./concept-service'); // fallback only

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a friendly, conversational AI assistant called Thinking Canvas. You're embedded in a visual interface where particles on a canvas form shapes related to the conversation topic. Keep your responses concise but helpful (2-4 sentences typically). Be warm and engaging.`;

/**
 * Build the messages array from conversation history + current message.
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

/**
 * Create a streaming chat session.
 * Returns an async generator that yields typed events.
 */
async function* createStream(message, history) {
  const messages = buildMessages(message, history);

  const streamParams = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
  };

  let thinkingBuffer = '';
  let currentBlockType = null;
  let haikuResolved = false;
  let haikuYielded = false;
  let haikuResult = null;

  // Kick off Haiku concept extraction BEFORE opening the Sonnet stream so the
  // two calls run truly in parallel. Haiku typically returns in 500-1500 ms;
  // by starting it at t=0 rather than post-thinking we shave 1-3 s off "first
  // shape appears on canvas."
  //
  // A `.then` handler flips `haikuResolved` when the call completes. The
  // Sonnet event loop below polls this flag on each iteration and yields
  // `visual_concepts` the first time it sees `resolved && !yielded`. Using a
  // flag instead of `Promise.race([p.then(...), Promise.resolve(false)])` —
  // the old pattern silently lost every race because `Promise.resolve` is
  // already-settled and always won the microtask queue.
  const haikuPromise = visualExtractor
    .extractVisualConcepts(message, '')
    .then(r => { haikuResult = r; haikuResolved = true; return r; })
    .catch(err => { console.warn('Haiku failed:', err.message); haikuResolved = true; return null; });

  let stream;
  try {
    stream = await anthropic.messages.create(streamParams);
  } catch (err) {
    // Fall back to non-thinking streaming. Haiku is already in flight —
    // nothing else to do here.
    console.warn('Extended thinking failed, falling back:', err.message);
    const fallbackParams = { ...streamParams, max_tokens: 1024 };
    delete fallbackParams.thinking;
    stream = await anthropic.messages.create(fallbackParams);
  }

  for await (const event of stream) {
    // --- Non-blocking check: has Haiku resolved? Yield concepts mid-stream. ---
    if (haikuResolved && !haikuYielded) {
      haikuYielded = true;
      if (haikuResult && haikuResult.length > 0) {
        yield { type: 'visual_concepts', visuals: haikuResult };
      }
    }

    // --- Track block types ---
    if (event.type === 'content_block_start') {
      currentBlockType = event.content_block?.type || null;
      if (currentBlockType === 'thinking') thinkingBuffer = '';
      continue;
    }

    // --- Accumulate thinking ---
    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      thinkingBuffer += event.delta.thinking;
      continue;
    }

    // --- Block ends ---
    if (event.type === 'content_block_stop') {
      if (currentBlockType === 'thinking' && thinkingBuffer.length > 0) {
        // Yield thinking text for the collapsible UI. Haiku extraction was
        // already kicked off at request start; by the time thinking ends,
        // Haiku concepts are usually already yielded by the flag-poll check
        // at the top of the loop.
        yield { type: 'thinking_text', text: thinkingBuffer };
      }
      currentBlockType = null;
      continue;
    }

    // --- Stream response text ---
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield { type: 'text', text: event.delta.text };
    }
  }

  // --- After stream ends: ensure Haiku concepts arrive ---
  // If the mid-stream poll never caught Haiku (Sonnet finished before Haiku
  // did), await it here. The .then handler has already populated haikuResult
  // and flipped haikuResolved — we just need to wait for the promise chain
  // to settle before yielding.
  if (!haikuYielded) {
    await haikuPromise;
    haikuYielded = true;
    if (haikuResult && haikuResult.length > 0) {
      yield { type: 'visual_concepts', visuals: haikuResult };
    }
  }

  // --- Fallback: if Haiku returned nothing, use regex ---
  if (!haikuResult || haikuResult.length === 0) {
    const fallbackText = (thinkingBuffer + ' ' + message).trim();
    const concepts = conceptService.extractConceptsFromText(fallbackText, 3);
    const filtered = concepts.filter(c => c !== 'search' && c !== 'question');
    if (filtered.length > 0) {
      yield {
        type: 'visual_concepts',
        visuals: filtered.map(c => ({ iconic: c, shape: c })),
      };
    }
  }

  yield { type: 'done' };
}

module.exports = {
  createStream,
  buildMessages,
  SYSTEM_PROMPT,
};
