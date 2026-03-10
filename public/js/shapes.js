/**
 * Shape Library — SVG silhouettes converted to particle target points
 *
 * Each shape is defined as an SVG path. We rasterize it to an offscreen canvas
 * and extract filled pixel positions as particle targets.
 */

// Simple SVG path silhouettes for common concepts
// All paths are designed for a 100x100 viewbox
const SHAPE_PATHS = {
  car: {
    viewBox: '0 0 100 100',
    paths: [
      'M15,65 L15,55 Q15,45 25,42 L35,38 Q40,30 50,28 L70,28 Q80,30 85,40 L90,45 Q95,48 95,55 L95,65 Z',
      'M25,68 A8,8 0 1,0 25,52 A8,8 0 1,0 25,68',
      'M75,68 A8,8 0 1,0 75,52 A8,8 0 1,0 75,68',
    ]
  },
  truck: {
    viewBox: '0 0 100 100',
    paths: [
      'M5,60 L5,40 L55,40 L55,30 L90,30 L95,45 L95,60 Z',
      'M15,65 A7,7 0 1,0 15,51 A7,7 0 1,0 15,65',
      'M80,65 A7,7 0 1,0 80,51 A7,7 0 1,0 80,65',
    ]
  },
  bicycle: {
    viewBox: '0 0 100 100',
    paths: [
      'M25,55 A12,12 0 1,0 25,31 A12,12 0 1,0 25,55',
      'M75,55 A12,12 0 1,0 75,31 A12,12 0 1,0 75,55',
      'M25,43 L50,25 L75,43 L60,43 L55,30 L45,30 L50,43 Z',
    ]
  },
  airplane: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,15 L55,25 L55,35 L85,50 L85,55 L55,45 L55,70 L65,78 L65,82 L50,75 L35,82 L35,78 L45,70 L45,45 L15,55 L15,50 L45,35 L45,25 Z',
    ]
  },
  boat: {
    viewBox: '0 0 100 100',
    paths: [
      'M15,65 L25,75 L75,75 L85,65 Z',
      'M48,25 L52,25 L52,62 L48,62 Z',
      'M52,28 L80,58 L52,58 Z',
    ]
  },
  dog: {
    viewBox: '0 0 100 100',
    paths: [
      'M20,35 L15,20 L25,30 L40,28 L45,18 L50,28 L60,30 L70,32 L80,40 L82,55 L80,65 L75,70 L75,80 L70,80 L70,68 L55,70 L40,70 L35,80 L30,80 L30,68 L25,60 L20,50 Z',
      'M28,38 A2,2 0 1,0 28,34 A2,2 0 1,0 28,38',
    ]
  },
  cat: {
    viewBox: '0 0 100 100',
    paths: [
      'M30,30 L25,12 L35,25 L50,22 L65,25 L75,12 L70,30 L72,40 L70,55 L68,65 L68,78 L63,78 L63,65 L55,60 L45,60 L37,65 L37,78 L32,78 L32,65 L30,55 L28,40 Z',
      'M40,38 A3,3 0 1,0 40,32 A3,3 0 1,0 40,38',
      'M60,38 A3,3 0 1,0 60,32 A3,3 0 1,0 60,38',
    ]
  },
  bird: {
    viewBox: '0 0 100 100',
    paths: [
      'M20,50 Q15,45 20,40 L35,38 L50,30 Q55,28 58,30 L55,35 L58,38 L85,25 Q75,38 60,42 L45,45 L40,50 Q35,55 28,55 Z',
      'M22,44 A2,2 0 1,0 22,40 A2,2 0 1,0 22,44',
    ]
  },
  fish: {
    viewBox: '0 0 100 100',
    paths: [
      'M15,50 Q10,35 20,30 Q35,20 55,25 Q70,28 80,40 L95,30 L90,50 L95,70 L80,60 Q70,72 55,75 Q35,80 20,70 Q10,65 15,50 Z',
      'M30,45 A3,3 0 1,0 30,39 A3,3 0 1,0 30,45',
    ]
  },
  horse: {
    viewBox: '0 0 100 100',
    paths: [
      'M25,25 L20,15 L30,22 L40,18 L42,28 L55,32 L70,35 L78,42 L80,55 L78,65 L78,80 L73,80 L73,62 L65,58 L55,60 L45,62 L42,80 L37,80 L38,60 L30,50 L25,45 Z',
    ]
  },
  house: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,15 L90,45 L85,45 L85,85 L15,85 L15,45 L10,45 Z',
      'M40,85 L40,60 L60,60 L60,85 Z',
      'M25,40 L25,55 L38,55 L38,40 Z',
    ]
  },
  building: {
    viewBox: '0 0 100 100',
    paths: [
      'M25,85 L25,15 L75,15 L75,85 Z',
      'M32,25 L42,25 L42,35 L32,35 Z',
      'M58,25 L68,25 L68,35 L58,35 Z',
      'M32,45 L42,45 L42,55 L32,55 Z',
      'M58,45 L68,45 L68,55 L58,55 Z',
      'M42,70 L58,70 L58,85 L42,85 Z',
    ]
  },
  tree: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,10 Q25,20 30,35 Q20,38 28,50 Q18,55 30,65 L45,75 L45,90 L55,90 L55,75 L70,65 Q82,55 72,50 Q80,38 70,35 Q75,20 50,10 Z',
    ]
  },
  mountain: {
    viewBox: '0 0 100 100',
    paths: [
      'M5,85 L35,25 L45,45 L55,30 L95,85 Z',
    ]
  },
  sun: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,30 A20,20 0 1,0 50,70 A20,20 0 1,0 50,30',
      'M48,8 L52,8 L52,22 L48,22 Z',
      'M48,78 L52,78 L52,92 L48,92 Z',
      'M8,48 L22,48 L22,52 L8,52 Z',
      'M78,48 L92,48 L92,52 L78,52 Z',
      'M22,22 L26,18 L32,24 L28,28 Z',
      'M72,22 L76,18 L82,24 L78,28 Z',
      'M22,72 L26,76 L20,82 L16,78 Z',
      'M72,72 L78,76 L82,82 L76,78 Z',
    ]
  },
  cloud: {
    viewBox: '0 0 100 100',
    paths: [
      'M25,60 Q10,60 12,48 Q5,40 18,35 Q20,22 35,25 Q42,15 55,20 Q65,12 75,22 Q90,20 88,35 Q98,42 90,52 Q95,62 82,62 Z',
    ]
  },
  flower: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,35 Q60,20 50,15 Q40,20 50,35',
      'M50,35 Q65,30 70,20 Q60,25 50,35',
      'M50,35 Q35,30 30,20 Q40,25 50,35',
      'M50,35 Q65,45 72,40 Q62,38 50,35',
      'M50,35 Q35,45 28,40 Q38,38 50,35',
      'M50,40 A8,8 0 1,0 50,24 A8,8 0 1,0 50,40',
      'M47,40 L47,85 L53,85 L53,40 Z',
      'M53,55 Q65,48 70,52 Q60,52 53,55',
      'M47,62 Q35,55 30,60 Q40,58 47,62',
    ]
  },
  phone: {
    viewBox: '0 0 100 100',
    paths: [
      'M30,10 Q30,5 35,5 L65,5 Q70,5 70,10 L70,90 Q70,95 65,95 L35,95 Q30,95 30,90 Z',
      'M35,15 L65,15 L65,75 L35,75 Z',
      'M45,82 L55,82 L55,88 L45,88 Z',
    ]
  },
  computer: {
    viewBox: '0 0 100 100',
    paths: [
      'M10,20 L90,20 L90,65 L10,65 Z',
      'M15,25 L85,25 L85,60 L15,60 Z',
      'M35,65 L65,65 L70,80 L30,80 Z',
      'M25,80 L75,80 L75,85 L25,85 Z',
    ]
  },
  book: {
    viewBox: '0 0 100 100',
    paths: [
      'M20,15 L50,20 L80,15 L80,80 L50,85 L20,80 Z',
      'M50,20 L50,85',
      'M25,25 L45,28 L45,35 L25,32 Z',
      'M55,28 L75,25 L75,32 L55,35 Z',
    ]
  },
  cup: {
    viewBox: '0 0 100 100',
    paths: [
      'M25,25 L75,25 L70,85 L30,85 Z',
      'M75,35 Q92,35 90,52 Q88,65 75,60',
    ]
  },
  key: {
    viewBox: '0 0 100 100',
    paths: [
      'M30,40 A15,15 0 1,0 30,70 A15,15 0 1,0 30,40',
      'M30,48 A7,7 0 1,0 30,62 A7,7 0 1,0 30,48',
      'M42,52 L85,52 L85,58 L80,58 L80,65 L75,65 L75,58 L70,58 L70,65 L65,65 L65,58 L42,58 Z',
    ]
  },
  guitar: {
    viewBox: '0 0 100 100',
    paths: [
      'M60,8 L65,8 L65,35 L60,35 Z',
      'M55,35 L70,35 L70,40 L55,40 Z',
      'M58,40 L67,40 L70,55 Q75,65 70,75 Q65,88 55,88 Q40,88 35,75 Q30,65 35,55 L40,45 Z',
      'M52,65 A6,6 0 1,0 52,53 A6,6 0 1,0 52,65',
    ]
  },
  person: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,25 A10,10 0 1,0 50,5 A10,10 0 1,0 50,25',
      'M35,30 L65,30 Q70,30 70,35 L70,55 L62,55 L62,85 L55,85 L55,55 L45,55 L45,85 L38,85 L38,55 L30,55 L30,35 Q30,30 35,30 Z',
    ]
  },
  question: {
    viewBox: '0 0 100 100',
    paths: [
      'M35,30 Q35,10 50,10 Q65,10 65,25 Q65,38 52,42 L52,55 L48,55 L48,40 Q60,36 60,25 Q60,15 50,15 Q40,15 40,30 Z',
      'M47,62 L53,62 L53,70 L47,70 Z',
    ]
  },
  search: {
    viewBox: '0 0 100 100',
    paths: [
      'M42,20 A22,22 0 1,0 42,64 A22,22 0 1,0 42,20',
      'M42,28 A14,14 0 1,0 42,56 A14,14 0 1,0 42,28',
      'M58,58 L62,54 L85,77 L80,82 Z',
    ]
  },
  money: {
    viewBox: '0 0 100 100',
    paths: [
      'M10,25 L90,25 L90,75 L10,75 Z',
      'M15,30 L85,30 L85,70 L15,70 Z',
      'M50,38 A12,12 0 1,0 50,62 A12,12 0 1,0 50,38',
    ]
  },
  heart: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,85 Q15,60 15,35 Q15,15 32,15 Q45,15 50,30 Q55,15 68,15 Q85,15 85,35 Q85,60 50,85 Z',
    ]
  },
  star: {
    viewBox: '0 0 100 100',
    paths: [
      'M50,5 L61,35 L95,38 L70,58 L78,92 L50,72 L22,92 L30,58 L5,38 L39,35 Z',
    ]
  },
  food: {
    viewBox: '0 0 100 100',
    paths: [
      // plate + fork/knife
      'M20,50 A30,20 0 1,0 80,50 A30,20 0 1,0 20,50',
      'M12,45 L12,25 L15,25 L15,32 L18,32 L18,25 L21,25 L21,45',
      'M82,25 L88,25 L86,45 L84,45 Z',
    ]
  },
};

/**
 * Rasterize an SVG path set into an array of {x, y} points (normalized 0-1).
 * Uses an offscreen canvas.
 */
export function rasterizeShape(shapeName, resolution = 150) {
  const shape = SHAPE_PATHS[shapeName];
  if (!shape) return null;

  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');

  // Parse viewBox
  const [vx, vy, vw, vh] = shape.viewBox.split(' ').map(Number);
  const scaleX = resolution / vw;
  const scaleY = resolution / vh;

  ctx.fillStyle = 'white';
  ctx.scale(scaleX, scaleY);
  ctx.translate(-vx, -vy);

  for (const pathStr of shape.paths) {
    const path = new Path2D(pathStr);
    ctx.fill(path);
  }

  // Extract filled pixel positions
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const imageData = ctx.getImageData(0, 0, resolution, resolution);
  const points = [];

  // Sample pixels — skip some for performance
  const step = 2;
  for (let y = 0; y < resolution; y += step) {
    for (let x = 0; x < resolution; x += step) {
      const i = (y * resolution + x) * 4;
      if (imageData.data[i + 3] > 128) {
        points.push({
          x: x / resolution,
          y: y / resolution
        });
      }
    }
  }

  return points;
}

/**
 * Get available shape names.
 */
export function getAvailableShapes() {
  return Object.keys(SHAPE_PATHS);
}

/**
 * Map a concept keyword to the best matching shape.
 */
export function conceptToShape(concept) {
  const c = concept.toLowerCase().trim();

  // Direct match
  if (SHAPE_PATHS[c]) return c;

  // Synonym mapping
  const synonyms = {
    automobile: 'car', vehicle: 'car', sedan: 'car', suv: 'car',
    pickup: 'truck', van: 'truck', lorry: 'truck',
    bike: 'bicycle', cycle: 'bicycle',
    plane: 'airplane', flight: 'airplane', jet: 'airplane',
    ship: 'boat', yacht: 'boat', sail: 'boat',
    puppy: 'dog', canine: 'dog', pup: 'dog',
    kitten: 'cat', feline: 'cat', kitty: 'cat',
    parrot: 'bird', eagle: 'bird', sparrow: 'bird', owl: 'bird',
    goldfish: 'fish', salmon: 'fish', whale: 'fish', shark: 'fish',
    pony: 'horse', stallion: 'horse', mare: 'horse',
    home: 'house', cottage: 'house', apartment: 'house', residence: 'house',
    office: 'building', skyscraper: 'building', tower: 'building',
    forest: 'tree', wood: 'tree', plant: 'tree',
    hill: 'mountain', peak: 'mountain', cliff: 'mountain',
    sunny: 'sun', sunshine: 'sun', sunrise: 'sun', sunset: 'sun',
    sky: 'cloud', weather: 'cloud', rain: 'cloud',
    rose: 'flower', garden: 'flower', bloom: 'flower',
    mobile: 'phone', smartphone: 'phone', cellphone: 'phone', telephone: 'phone', call: 'phone',
    laptop: 'computer', pc: 'computer', desktop: 'computer', screen: 'computer', monitor: 'computer',
    read: 'book', reading: 'book', novel: 'book', library: 'book', story: 'book',
    coffee: 'cup', tea: 'cup', mug: 'cup', drink: 'cup',
    lock: 'key', unlock: 'key', password: 'key', security: 'key',
    music: 'guitar', song: 'guitar', instrument: 'guitar', band: 'guitar',
    human: 'person', people: 'person', man: 'person', woman: 'person', user: 'person', someone: 'person',
    help: 'question', ask: 'question', confused: 'question', wonder: 'question', curious: 'question',
    find: 'search', look: 'search', discover: 'search', explore: 'search', research: 'search',
    cash: 'money', price: 'money', cost: 'money', dollar: 'money', budget: 'money', pay: 'money', purchase: 'money', buy: 'money', expensive: 'money', cheap: 'money',
    love: 'heart', like: 'heart', favorite: 'heart', romantic: 'heart',
    excellent: 'star', rating: 'star', review: 'star', best: 'star',
    eat: 'food', meal: 'food', restaurant: 'food', dinner: 'food', lunch: 'food', breakfast: 'food', cooking: 'food',
    castle: 'building',
  };

  if (synonyms[c]) return synonyms[c];

  // Partial match
  for (const [synonym, shape] of Object.entries(synonyms)) {
    if (c.includes(synonym) || synonym.includes(c)) return shape;
  }

  // Default to question mark for unknown concepts
  return 'question';
}
