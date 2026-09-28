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
  star: /\b(stars?|space|universe|galax(?:y|ies))\b/i,
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

module.exports = {
  CONCEPT_KEYWORDS,
  extractConceptsFromText,
};
