/**
 * Concept Extraction Service
 *
 * Extracts visual concepts from text using three strategies:
 * 1. JSON prefix parsing (from LLM structured output)
 * 2. Keyword regex scanning (on any text)
 * 3. Thinking block analysis (from extended thinking)
 */

// Keyword-to-concept regex map — matches singular and plural forms
const CONCEPT_KEYWORDS = {
  car: /\b(cars?|vehicles?|autos?|sedans?|suvs?|driv(?:e|ing)|trucks?|vans?)\b/i,
  dog: /\b(dogs?|pupp(?:y|ies)|canines?|labradors?|retrievers?|dalmatians?)\b/i,
  cat: /\b(cats?|kittens?|felines?)\b/i,
  horse: /\b(horses?|pon(?:y|ies)|stallions?|mares?)\b/i,
  bird: /\b(birds?|parrots?|eagles?|sparrows?|penguins?)\b/i,
  fish: /\b(fish|salmon|trout|aquariums?|ocean creatures?)\b/i,
  airplane: /\b(fly|flights?|airplanes?|planes?|airports?|travel(?:ing)?|trips?|vacations?)\b/i,
  boat: /\b(boats?|ships?|sail(?:ing)?|cruises?|ocean|sea)\b/i,
  house: /\b(homes?|houses?|apartments?|rent|real estate|rooms?|living)\b/i,
  building: /\b(buildings?|offices?|skyscrapers?|cit(?:y|ies)|urban)\b/i,
  tree: /\b(trees?|forests?|woods?|nature|gardens?|plants?)\b/i,
  mountain: /\b(mountains?|hills?|climb(?:ing)?|hik(?:e|ing)|trails?)\b/i,
  sun: /\b(sun|sunny|weather|warm|summer|beach(?:es)?)\b/i,
  cloud: /\b(clouds?|rain|storms?|weather|sky)\b/i,
  flower: /\b(flowers?|roses?|gardens?|bloom(?:ing)?|blossoms?)\b/i,
  computer: /\b(computers?|laptops?|software|cod(?:e|ing)|programs?|tech|ai|algorithms?)\b/i,
  phone: /\b(phones?|mobile|call(?:ing)?|text(?:ing)?|smartphones?)\b/i,
  book: /\b(books?|read(?:ing)?|novels?|stor(?:y|ies)|authors?|librar(?:y|ies)|writ(?:e|ing))\b/i,
  guitar: /\b(music|songs?|instruments?|guitars?|pianos?|bands?|concerts?|sing(?:ing)?)\b/i,
  food: /\b(foods?|cook(?:ing)?|recipes?|restaurants?|eat(?:ing)?|dinners?|lunch(?:es)?|meals?|breakfast)\b/i,
  cup: /\b(coffee|tea|drinks?|cups?|beverages?)\b/i,
  person: /\b(person|people|friends?|famil(?:y|ies)|humans?|someone)\b/i,
  star: /\b(stars?|space|universe|galax(?:y|ies)|night|amazing|great)\b/i,
  heart: /\b(hearts?|love|loving|romantic|romance)\b/i,
  money: /\b(money|cash|dollars?|budget|financ(?:e|ial)|pay(?:ment)?|cost|price)\b/i,
  key: /\b(keys?|lock|unlock|password|secur(?:e|ity))\b/i,
};

/**
 * Extract concepts from text using keyword regex matching.
 * Returns up to `max` matching concept names.
 */
function extractConceptsFromText(text, max = 3) {
  const matches = [];
  for (const [concept, pattern] of Object.entries(CONCEPT_KEYWORDS)) {
    if (pattern.test(text)) {
      matches.push(concept);
    }
  }
  if (matches.length === 0) return ['search', 'question'];
  return matches.slice(0, max);
}

/**
 * Parse a JSON concept prefix from the start of an LLM response.
 *
 * Expected format: {"concepts":["dog","park","sun"]}\n<response text>
 *
 * Returns { concepts: string[], remainingText: string } if found,
 * or null if the prefix hasn't arrived yet or isn't present.
 */
function parseConceptPrefix(textSoFar) {
  // Look for a JSON object at the very start
  const trimmed = textSoFar.trimStart();

  if (!trimmed.startsWith('{')) {
    // No JSON prefix — the LLM is responding directly
    return { concepts: null, remainingText: textSoFar };
  }

  // Try to find the closing brace
  const closingIdx = trimmed.indexOf('}');
  if (closingIdx === -1) {
    // JSON hasn't fully arrived yet — keep buffering
    return null;
  }

  const jsonStr = trimmed.slice(0, closingIdx + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.concepts && Array.isArray(parsed.concepts)) {
      // Strip the JSON line (and any trailing newline) from the text
      let remaining = trimmed.slice(closingIdx + 1);
      if (remaining.startsWith('\n')) remaining = remaining.slice(1);
      return {
        concepts: parsed.concepts.slice(0, 3),
        remainingText: remaining,
      };
    }
  } catch (e) {
    // Malformed JSON — treat as no prefix
  }

  return { concepts: null, remainingText: textSoFar };
}

/**
 * Extract concepts from an extended thinking block.
 * Uses the same keyword regex but tuned for longer, more abstract text.
 */
function extractConceptsFromThinking(thinkingText) {
  return extractConceptsFromText(thinkingText, 2);
}

/**
 * Scan accumulated response text for NEW concepts not already found.
 * Returns only newly discovered concepts.
 */
function scanForNewConcepts(accumulatedText, alreadyFound = []) {
  const allConcepts = extractConceptsFromText(accumulatedText, 5);
  const newConcepts = allConcepts.filter(c => !alreadyFound.includes(c));
  return newConcepts.slice(0, 2);
}

module.exports = {
  CONCEPT_KEYWORDS,
  extractConceptsFromText,
  parseConceptPrefix,
  extractConceptsFromThinking,
  scanForNewConcepts,
};
