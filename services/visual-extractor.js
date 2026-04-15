/**
 * Visual Extractor Service
 *
 * Uses Haiku (fast, cheap) to extract iconic visual concepts from text.
 * Runs concurrently with the main Sonnet stream — fires after the thinking
 * block completes and returns while response text is still streaming.
 *
 * Returns both the "iconic" concept (creative, for future SVG expansion)
 * and the nearest "shape" from the available built-in library.
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

const EXTRACTION_PROMPT = `You identify iconic visual imagery for topics. Given a topic and context, return 1-3 concrete objects that people would immediately picture when thinking about this topic.

Think associatively and iconically — what would appear in a simple illustration?
- "Abraham Lincoln" → top hat, log cabin, book
- "ocean travel" → boat, sun, fish
- "programming" → computer, cup, book
- "wedding" → heart, flower, person
- "quantum physics" → atom, electron, wave
- "phrenology" → skull, brain, measurement

For each concept, provide:
- "iconic": the specific visual object people would picture. Be creative and specific — 1-3 words, lowercase, no punctuation (e.g., "top hat", "log cabin", "stethoscope", "electron orbit", "lincoln memorial", "phrenology skull"). There is no constrained vocabulary for this field.
- "shape": a safety-net fallback — the closest match from this list: car, truck, bicycle, airplane, boat, dog, cat, bird, fish, horse, house, building, tree, mountain, sun, cloud, flower, phone, computer, book, cup, guitar, key, person, money, heart, star, food

Return JSON only. No explanation.
{"visuals":[{"iconic":"top hat","shape":"person"},{"iconic":"log cabin","shape":"house"}]}`;

/**
 * Extract iconic visual concepts using Haiku.
 *
 * @param {string} userMessage - The user's original message
 * @param {string} thinkingText - The Sonnet thinking block content (optional)
 * @returns {Promise<Array<{iconic: string, shape: string}>|null>} - Visuals array or null on failure
 */
async function extractVisualConcepts(userMessage, thinkingText = '') {
  const contextSnippet = thinkingText.slice(0, 500);
  const userContent = contextSnippet
    ? `Topic: ${userMessage}\n\nContext: ${contextSnippet}`
    : `Topic: ${userMessage}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    let text = response.content[0]?.text?.trim();
    if (!text) return null;

    // Strip markdown code fences if Haiku wraps the JSON
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();

    const parsed = JSON.parse(text);
    if (parsed.visuals && Array.isArray(parsed.visuals)) {
      return parsed.visuals.slice(0, 3).map(v => ({
        iconic: String(v.iconic || '').toLowerCase().trim(),
        shape: String(v.shape || 'question').toLowerCase().trim(),
      }));
    }

    // Handle case where Haiku returns a plain array
    if (Array.isArray(parsed)) {
      return parsed.slice(0, 3).map(v => {
        if (typeof v === 'string') return { iconic: v, shape: v };
        return {
          iconic: String(v.iconic || '').toLowerCase().trim(),
          shape: String(v.shape || 'question').toLowerCase().trim(),
        };
      });
    }
  } catch (err) {
    console.warn('[visual-extractor] Haiku extraction failed:', err.message);
  }
  return null;
}

module.exports = { extractVisualConcepts };
