/**
 * Chat Service
 *
 * Wraps the Anthropic SDK for streaming with adaptive thinking.
 * Concept extraction is handled by the visual-extractor (Haiku) service,
 * kicked off at request start — BEFORE the main stream call — so Haiku and
 * the chat model run in parallel from t=0. The extractor also receives a
 * compact slice of the recent conversation so follow-ups ("tell me more")
 * resolve to the actual subject instead of the literal follow-up text.
 *
 * Yields typed events:
 *   { type: 'thinking_delta', text }        — chunk of the thinking block
 *   { type: 'thinking_done' }               — thinking block finished
 *   { type: 'visual_concepts', visuals }    — from Haiku extraction
 *   { type: 'text', text }                  — response text chunk
 *   { type: 'done' }
 */

const Anthropic = require('@anthropic-ai/sdk');
const visualExtractor = require('./visual-extractor');
const conceptService = require('./concept-service'); // fallback only

const anthropic = new Anthropic();

const PRIMARY_MODEL = 'claude-sonnet-5';
// Degraded mode if the primary model is unavailable. Haiku 4.5 uses the
// older thinking API, so the fallback request carries no `thinking` param.
const FALLBACK_MODEL = 'claude-haiku-4-5';
// Adaptive thinking output counts toward max_tokens; the system prompt asks
// for 2-4 sentences, so this is headroom for thinking, not for long replies.
const MAX_TOKENS = 8192;
const FALLBACK_MAX_TOKENS = 1024;
const HISTORY_TURNS = 10;
const EXTRACTOR_CONTEXT_TURNS = 4;
const EXTRACTOR_CONTEXT_CHARS = 200;

const SYSTEM_PROMPT = `You are a friendly, conversational AI assistant called Thinking Canvas. You're embedded in a visual interface where particles on a canvas form shapes related to the conversation topic. Keep your responses concise but helpful (2-4 sentences typically). Be warm and engaging. Use plain conversational text — no markdown formatting.`;

/** Text of a history entry, or null if the entry is malformed. */
function entryText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const text = typeof msg.content === 'string' ? msg.content : msg.text;
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

/**
 * Build the messages array from conversation history + current message.
 * Malformed entries are skipped rather than forwarded (an entry without a
 * string content would 400 the whole turn).
 */
function buildMessages(message, history) {
  const messages = [];
  if (Array.isArray(history) && history.length > 0) {
    for (const msg of history.slice(-HISTORY_TURNS)) {
      const text = entryText(msg);
      if (text === null) continue;
      messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: text });
    }
  }
  messages.push({ role: 'user', content: message });
  return messages;
}

/** Last few turns, clipped, as "role: text" lines for the extractor prompt. */
function buildExtractorContext(history) {
  if (!Array.isArray(history)) return '';
  const lines = [];
  for (const msg of history.slice(-EXTRACTOR_CONTEXT_TURNS)) {
    const text = entryText(msg);
    if (text === null) continue;
    const role = msg.role === 'user' ? 'user' : 'assistant';
    const flat = text.replace(/\s+/g, ' ').trim();
    const clipped = flat.length > EXTRACTOR_CONTEXT_CHARS ? flat.slice(0, EXTRACTOR_CONTEXT_CHARS) + '…' : flat;
    lines.push(`${role}: ${clipped}`);
  }
  return lines.join('\n');
}

// 429 / 5xx / connection failures deserve one retry on the primary model;
// anything else (retired model 404, bad params 400) goes straight to the
// fallback model. Connection errors carry no `.status`, so test the class.
function isRetryable(err) {
  if (err instanceof Anthropic.APIConnectionError) return true;
  const status = err && err.status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

function isAbort(err, signal) {
  if (signal && signal.aborted) return true;
  if (err instanceof Anthropic.APIUserAbortError) return true;
  return Boolean(err && err.name === 'AbortError');
}

function openStream(params, signal) {
  return anthropic.messages.create(params, signal ? { signal } : undefined);
}

/**
 * Create a streaming chat session.
 * Returns an async generator that yields typed events. `signal` (optional)
 * aborts the upstream request when the client disconnects.
 */
async function* createStream(message, history, signal) {
  const messages = buildMessages(message, history);

  const primaryParams = {
    model: PRIMARY_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive', display: 'summarized' },
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
  };
  const fallbackParams = {
    model: FALLBACK_MODEL,
    max_tokens: FALLBACK_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
  };

  let thinkingBuffer = '';
  let currentBlockType = null;
  let haikuResolved = false;
  let haikuYielded = false;
  let haikuResult = null;

  // Kick off Haiku concept extraction BEFORE opening the chat stream so the
  // two calls run truly in parallel. A `.then` handler flips `haikuResolved`;
  // the event loop below polls the flag and yields `visual_concepts` the
  // first time it sees it set.
  const haikuPromise = visualExtractor
    .extractVisualConcepts(message, buildExtractorContext(history))
    .then(r => { haikuResult = r; haikuResolved = true; return r; })
    .catch(err => { console.warn('[chat] Haiku extraction failed:', err.message); haikuResolved = true; return null; });

  let stream;
  try {
    stream = await openStream(primaryParams, signal);
  } catch (err) {
    if (isAbort(err, signal)) return;
    if (isRetryable(err)) {
      console.warn(`[chat] ${PRIMARY_MODEL} transient failure (${err.status || err.name}) — retrying once`);
      try {
        stream = await openStream(primaryParams, signal);
      } catch (err2) {
        if (isAbort(err2, signal)) return;
        console.warn(`[chat] retry failed (${err2.status || err2.name}) — falling back to ${FALLBACK_MODEL}`);
        stream = await openStream(fallbackParams, signal);
      }
    } else {
      console.warn(`[chat] ${PRIMARY_MODEL} failed (${err.status || err.name}: ${err.message}) — falling back to ${FALLBACK_MODEL}`);
      stream = await openStream(fallbackParams, signal);
    }
  }

  try {
    for await (const event of stream) {
      if (haikuResolved && !haikuYielded) {
        haikuYielded = true;
        if (haikuResult && haikuResult.length > 0) {
          yield { type: 'visual_concepts', visuals: haikuResult };
        }
      }

      if (event.type === 'content_block_start') {
        currentBlockType = event.content_block?.type || null;
        if (currentBlockType === 'thinking') thinkingBuffer = '';
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const text = event.delta.thinking;
        if (text) {
          thinkingBuffer += text;
          yield { type: 'thinking_delta', text };
        }
        continue;
      }

      if (event.type === 'content_block_stop') {
        if (currentBlockType === 'thinking') yield { type: 'thinking_done' };
        currentBlockType = null;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
  } catch (err) {
    if (isAbort(err, signal)) return;
    throw err;
  }

  if (signal && signal.aborted) return;

  // If the mid-stream poll never caught Haiku (chat finished first), wait.
  if (!haikuYielded) {
    await haikuPromise;
    haikuYielded = true;
    if (haikuResult && haikuResult.length > 0) {
      yield { type: 'visual_concepts', visuals: haikuResult };
    }
  }

  // Fallback: if Haiku returned nothing, use the regex keyword map.
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
  buildExtractorContext,
  SYSTEM_PROMPT,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
};
