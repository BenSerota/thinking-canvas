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

When the topic is a famous landmark, monument, or proper-noun structure with a distinctive silhouette, INCLUDE the proper noun itself as one of the iconics (it routes to a hand-curated icon). Examples:
- "Leaning Tower of Pisa" → leaning tower of pisa, bell, marble
- "Colosseum" → colosseum, gladiator, arch
- "Eiffel Tower" → eiffel tower, paris, beacon
- "Statue of Liberty" → statue of liberty, torch, crown

For each concept, provide:
- "iconic": the specific visual object people would picture. Be creative and specific — 1-3 words, lowercase, no punctuation (e.g., "top hat", "log cabin", "stethoscope", "atom", "violin", "lightbulb"). There is no constrained vocabulary for this field.
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
