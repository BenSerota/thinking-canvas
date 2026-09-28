/**
 * Visual Extractor Service
 *
 * Uses Haiku (fast, cheap) to extract iconic visual concepts from the user's
 * message. Runs concurrently with the main chat stream from t=0 and receives
 * a compact slice of recent conversation so follow-ups resolve to the real
 * subject.
 *
 * Output is constrained with a JSON schema (structured outputs), so the
 * response is guaranteed to be valid JSON — no fence stripping, no prose.
 *
 * Returns both the "iconic" concept (free text, for the shape ladder) and
 * the nearest "shape" from the built-in client library (safety net).
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

const MODEL = 'claude-haiku-4-5';
// Iconic phrases become log lines, cache keys and file names downstream —
// keep them short and free of control characters.
const MAX_ICONIC_CHARS = 60;

// Must stay in sync with SHAPE_PATHS in public/js/shapes.js (minus the
// 'question'/'search' placeholders, which are never a good fallback).
const BUILTIN_SHAPES = [
  'car', 'truck', 'bicycle', 'airplane', 'boat', 'dog', 'cat', 'bird', 'fish', 'horse',
  'house', 'building', 'tree', 'mountain', 'sun', 'cloud', 'flower', 'phone', 'computer',
  'book', 'cup', 'guitar', 'key', 'person', 'money', 'heart', 'star', 'food',
];

const EXTRACTION_PROMPT = `You identify iconic visual imagery for topics. Given a topic and context, return exactly 3 concrete PHYSICAL OBJECTS that people would immediately picture when thinking about this topic.

Think associatively and iconically — what would appear in a simple illustration?
- "Abraham Lincoln" → top hat, log cabin, book
- "ocean travel" → boat, sun, fish
- "programming" → computer, cup, book
- "wedding" → heart, flower, person
- "quantum physics" → atom, microscope, chalkboard
- "phrenology" → skull, brain, caliper
- "Albert Einstein" → atom, lightbulb, violin
- "volcanoes" → volcano, lava, mountain

CRITICAL RULES:
- Every iconic MUST be a concrete physical object with a recognizable silhouette.
- NEVER return text, equations, formulas, or written words (e.g., "equation e=mc2", "moo text", "resignation speech"). These cannot be drawn as icons.
- NEVER return abstract visual descriptions (e.g., "glowing red stream", "color changing skin", "labeled regions"). These have no recognizable shape.
- NEVER return actions or states (e.g., "person trembling", "two people embracing"). Return the object, not the scene.
- Prefer common single objects: "lightbulb" not "light bulb moment", "violin" not "violin playing".

When the topic is a famous landmark, monument, or proper-noun structure with a distinctive silhouette, INCLUDE the proper noun itself as one of the iconics (it routes to a curated or hand-drawn icon when one exists). Examples:
- "Leaning Tower of Pisa" → leaning tower of pisa, bell, marble
- "Colosseum" → colosseum, gladiator, arch
- "Eiffel Tower" → eiffel tower, beret, croissant
- "Statue of Liberty" → statue of liberty, torch, crown

If the topic is vague or refers to earlier conversation ("tell me more", "what about that", "why did it fall?"), use the Context to infer the actual subject and extract objects for THAT subject.

For each concept, provide:
- "iconic": the specific visual object people would picture. Be creative and specific — 1-3 words, lowercase, no punctuation (e.g., "top hat", "log cabin", "stethoscope", "atom", "violin", "lightbulb"). There is no constrained vocabulary for this field.
- "shape": a safety-net fallback — the closest match from this list: ${BUILTIN_SHAPES.join(', ')}

Always return your best guess as JSON matching the schema. Never ask for clarification. Never output prose.`;

const OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      visuals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            iconic: { type: 'string' },
            shape: { type: 'string', enum: BUILTIN_SHAPES },
          },
          required: ['iconic', 'shape'],
          additionalProperties: false,
        },
      },
    },
    required: ['visuals'],
    additionalProperties: false,
  },
};

/** Normalize an iconic phrase: no control chars, single spaces, capped length. */
function sanitizeIconic(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_ICONIC_CHARS)
    .trim();
}

/**
 * Extract iconic visual concepts using Haiku.
 *
 * @param {string} userMessage - The user's current message
 * @param {string} contextText - Recent conversation as "role: text" lines (optional)
 * @returns {Promise<Array<{iconic: string, shape: string}>|null>} - Visuals array or null on failure
 */
async function extractVisualConcepts(userMessage, contextText = '') {
  const context = String(contextText || '').trim();
  const userContent = context
    ? `Topic: ${userMessage}\n\nContext (recent conversation):\n${context}`
    : `Topic: ${userMessage}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: OUTPUT_FORMAT },
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    if (!text) return null;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.warn('[visual-extractor] non-JSON response:', err.message);
      return null;
    }
    if (!parsed || !Array.isArray(parsed.visuals)) return null;

    return parsed.visuals
      .slice(0, 3)
      .map(v => ({
        iconic: sanitizeIconic(v && v.iconic),
        shape: String((v && v.shape) || 'question').toLowerCase().trim(),
      }))
      .filter(v => v.iconic);
  } catch (err) {
    console.warn('[visual-extractor] Haiku extraction failed:', err.message);
  }
  return null;
}

module.exports = { extractVisualConcepts, sanitizeIconic, BUILTIN_SHAPES };
