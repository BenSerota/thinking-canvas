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
      // Body + head with clearer ears, snout, tail, all 4 legs
      'M18,32 Q15,28 12,20 L16,18 Q19,26 22,30 L30,27 Q33,22 36,16 L40,18 Q38,24 37,28 L48,26 Q55,25 62,28 L72,32 Q80,36 84,44 Q86,50 85,56 L84,62 Q83,66 82,70 L82,82 L76,82 L76,70 Q75,66 74,64 L66,62 Q58,63 52,64 L46,65 Q40,66 36,68 L36,82 L30,82 L30,70 Q28,64 26,60 Q22,54 20,48 Q18,42 18,36 Z',
      // Tail (curved up)
      'M84,44 Q88,38 92,32 Q90,30 86,34 Q84,38 84,44',
      // Eye
      'M30,36 A3,3 0 1,0 30,30 A3,3 0 1,0 30,36',
      // Nose
      'M20,40 Q18,42 20,44 Q22,42 20,40',
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
      // Body with wide wingspan, visible tail, head profile
      'M50,42 Q45,38 38,36 L28,34 Q18,32 8,26 Q5,24 4,28 Q6,34 14,38 L26,40 Q34,42 40,44 L42,46 Q44,52 44,58 L40,64 Q36,68 30,70 L28,72 Q34,70 40,66 L46,60 Q48,56 50,52 Q52,56 54,60 L60,66 Q66,70 72,72 L70,70 Q64,68 60,64 L56,58 Q56,52 58,46 L60,44 Q66,42 74,40 L86,38 Q94,34 96,28 Q95,24 92,26 Q82,32 72,34 L62,36 Q55,38 50,42 Z',
      // Head
      'M50,42 Q50,36 48,32 Q46,28 42,28 Q40,30 40,34 Q42,36 46,38 Q48,40 50,42',
      // Eye
      'M44,33 A2,2 0 1,0 44,29 A2,2 0 1,0 44,33',
      // Beak
      'M40,34 L34,36 L40,38 Z',
      // Tail feathers
      'M46,60 L42,72 L46,68 L50,74 L54,68 L58,72 L54,60',
    ]
  },
  fish: {
    viewBox: '0 0 100 100',
    paths: [
      // Fuller body with dorsal fin, pectoral fin, clear tail fork
      'M12,50 Q8,38 16,28 Q24,20 36,18 Q48,16 58,20 Q66,24 72,32 L74,30 Q76,26 78,22 L80,24 Q78,30 76,34 L78,38 Q82,44 84,50 Q82,56 78,62 L76,66 Q78,70 80,76 L78,78 Q76,74 74,70 L72,68 Q66,76 58,80 Q48,84 36,82 Q24,80 16,72 Q8,62 12,50 Z',
      // Tail (forked)
      'M84,50 L96,34 L92,50 L96,66 Z',
      // Dorsal fin
      'M40,18 Q44,8 52,10 Q56,12 58,20',
      // Pectoral fin
      'M36,54 Q30,60 26,66 Q28,64 34,58 Q38,56 36,54',
      // Eye
      'M26,42 A4,4 0 1,0 26,34 A4,4 0 1,0 26,42',
      'M27,40 A2,2 0 1,0 27,36 A2,2 0 1,0 27,40',
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
      // Layered peaks with ridgeline detail
      'M0,88 L18,52 L24,60 L32,38 L38,48 L42,42 L50,20 L58,42 L62,36 L68,48 L76,28 L82,45 L88,38 L100,88 Z',
      // Snow cap on main peak
      'M42,42 L50,20 L58,42 L54,38 Q50,28 46,38 Z',
      // Snow cap on secondary peak
      'M68,48 L76,28 L82,45 L79,40 Q76,34 73,42 Z',
      // Foothills
      'M0,88 Q10,80 20,82 Q30,78 40,80 Q50,76 60,80 Q70,78 80,82 Q90,80 100,88 Z',
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
      // Large 5-petal flower
      'M50,28 Q56,14 50,6 Q44,14 50,28',   // top petal
      'M50,28 Q64,18 72,24 Q62,32 50,28',   // top-right petal
      'M50,28 Q64,38 66,48 Q56,42 50,28',   // bottom-right petal
      'M50,28 Q36,38 34,48 Q44,42 50,28',   // bottom-left petal
      'M50,28 Q36,18 28,24 Q38,32 50,28',   // top-left petal
      // Center
      'M50,36 A8,8 0 1,0 50,20 A8,8 0 1,0 50,36',
      // Stem
      'M47,36 L47,90 L53,90 L53,36 Z',
      // Leaves
      'M53,52 Q62,44 72,46 Q68,50 62,52 Q56,54 53,56',
      'M47,62 Q38,54 28,56 Q32,60 38,62 Q44,64 47,66',
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
      'M49,20 L51,20 L51,85 L49,85 Z',
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
      // Head (rounder)
      'M50,22 A12,12 0 1,0 50,-2 A12,12 0 1,0 50,22',
      // Torso with shoulders
      'M34,26 Q30,26 28,30 L26,34 Q24,38 26,40 L30,42 L32,48 Q34,54 36,56 L36,58 L38,58 L38,54 Q40,52 42,52 L58,52 Q60,52 62,54 L62,58 L64,58 L64,56 Q66,54 68,48 L70,42 L74,40 Q76,38 74,34 L72,30 Q70,26 66,26 Z',
      // Left arm
      'M26,34 Q22,40 20,48 Q18,54 22,58 Q24,56 24,52 Q26,46 28,42',
      // Right arm
      'M74,34 Q78,40 80,48 Q82,54 78,58 Q76,56 76,52 Q74,46 72,42',
      // Left leg
      'M38,58 L36,72 Q34,80 36,88 L40,88 L42,80 Q42,72 42,64 L42,58',
      // Right leg
      'M62,58 L64,72 Q66,80 64,88 L60,88 L58,80 Q58,72 58,64 L58,58',
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
      // Plate (wide oval)
      'M15,58 Q15,44 50,44 Q85,44 85,58 Q85,72 50,72 Q15,72 15,58 Z',
      // Plate rim
      'M20,58 Q20,48 50,48 Q80,48 80,58 Q80,68 50,68 Q20,68 20,58 Z',
      // Food on plate (dome shape — like a serving)
      'M30,48 Q30,32 50,30 Q70,32 70,48',
      // Fork (left)
      'M8,28 L10,28 L10,38 L8,38 Z M12,28 L14,28 L14,38 L12,38 Z M16,28 L18,28 L18,38 L16,38 Z M8,38 L18,38 L18,40 L16,42 L16,68 L10,68 L10,42 L8,40 Z',
      // Knife (right)
      'M84,26 Q88,26 90,30 L90,40 Q90,42 88,42 L86,42 L86,68 L82,68 L82,42 L80,42 Q80,40 80,38 L80,30 Q82,26 84,26 Z',
    ]
  },
};

/**
 * Rasterize an SVG path set into an array of {x, y} points (normalized 0-1).
 * Uses an offscreen canvas with edge-weighting for sharper shape outlines.
 */
export function rasterizeShape(shapeName, resolution = 300, maxPoints = 30000) {
  const shape = SHAPE_PATHS[shapeName];
  if (!shape) return null;

  return rasterizeFromPaths(shape.paths, shape.viewBox, resolution, 'library', maxPoints);
}

/**
 * Morphological dilation: each output pixel is set if ANY input pixel within
 * a radius-r disk is set. Out-of-bounds is treated as unset.
 */
// Separable O(W·H·R) dilation with a Chebyshev (square) kernel. The disk
// kernel was O(W·H·R²) which, at the sizes we actually use (W=H≈400, R≈20),
// locked the main thread for ~10-20s on first shape render. A square kernel
// closes gaps equally well for the downstream point-cloud; the silhouette
// difference after dilate→erode closing is imperceptible after sampling.
function dilateMask(mask, W, H, r) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  // Horizontal pass: tmp[y,x] = 1 iff any mask[y, x-r..x+r] is set.
  for (let y = 0; y < H; y++) {
    const off = y * W;
    let dist = r + 1;
    for (let x = 0; x < W; x++) {
      dist = mask[off + x] ? 0 : dist + 1;
      if (dist <= r) tmp[off + x] = 1;
    }
    dist = r + 1;
    for (let x = W - 1; x >= 0; x--) {
      dist = mask[off + x] ? 0 : dist + 1;
      if (dist <= r) tmp[off + x] = 1;
    }
  }
  // Vertical pass: out[y,x] = 1 iff any tmp[y-r..y+r, x] is set.
  for (let x = 0; x < W; x++) {
    let dist = r + 1;
    for (let y = 0; y < H; y++) {
      dist = tmp[y * W + x] ? 0 : dist + 1;
      if (dist <= r) out[y * W + x] = 1;
    }
    dist = r + 1;
    for (let y = H - 1; y >= 0; y--) {
      dist = tmp[y * W + x] ? 0 : dist + 1;
      if (dist <= r) out[y * W + x] = 1;
    }
  }
  return out;
}

/**
 * Morphological erosion with a Chebyshev (square) kernel, separable O(W·H·R).
 * Out-of-bounds treated as SET so the shape isn't eroded at the canvas
 * boundary (important for icons that span the full bitmap).
 */
function erodeMask(mask, W, H, r) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const distBuf = new Int16Array(Math.max(W, H));
  // Horizontal pass: pixel survives iff no unset pixel within r in its row.
  for (let y = 0; y < H; y++) {
    const off = y * W;
    let dist = r + 1;
    for (let x = 0; x < W; x++) {
      dist = mask[off + x] ? dist + 1 : 0;
      distBuf[x] = dist;
    }
    dist = r + 1;
    for (let x = W - 1; x >= 0; x--) {
      dist = mask[off + x] ? dist + 1 : 0;
      const d = distBuf[x] < dist ? distBuf[x] : dist;
      if (d > r) tmp[off + x] = 1;
    }
  }
  // Vertical pass on tmp.
  for (let x = 0; x < W; x++) {
    let dist = r + 1;
    for (let y = 0; y < H; y++) {
      dist = tmp[y * W + x] ? dist + 1 : 0;
      distBuf[y] = dist;
    }
    dist = r + 1;
    for (let y = H - 1; y >= 0; y--) {
      dist = tmp[y * W + x] ? dist + 1 : 0;
      const d = distBuf[y] < dist ? distBuf[y] : dist;
      if (d > r) out[y * W + x] = 1;
    }
  }
  return out;
}

/**
 * Count connected components in a binary mask, ignoring specks under
 * `minSize`. Uses iterative 4-connectivity flood fill. Used to detect
 * whether a rasterized SVG needs aggressive closing — if the shape
 * came out as multiple large islands (basketball's 8 wedges, brain's
 * two hemispheres), we boost the morphological closing radius to
 * bridge them into one silhouette.
 */
function countLargeComponents(mask, W, H, minSize = 500) {
  const visited = new Uint8Array(mask.length);
  const stack = [];
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i]) continue;
    stack.length = 0;
    stack.push(i);
    let size = 0;
    while (stack.length) {
      const idx = stack.pop();
      if (visited[idx] || !mask[idx]) continue;
      visited[idx] = 1;
      size++;
      const x = idx % W;
      const y = (idx - x) / W;
      if (x > 0) stack.push(idx - 1);
      if (x < W - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - W);
      if (y < H - 1) stack.push(idx + W);
    }
    if (size >= minSize) count++;
  }
  return count;
}

/**
 * Core rasterization: SVG paths → particle point cloud.
 *
 * Many library icons (Font Awesome basketball, skull eye sockets, car wheels,
 * brain midline) encode decorative detail as intentional gaps between subpaths.
 * At our 300px resolution those gaps scale to 10-30px voids and the canvas
 * reads as floating fragments instead of a coherent silhouette. We apply a
 * morphological closing (dilate→erode) with an adaptive radius:
 *
 *   - Default R ≈ 2.5% of min(bboxW, bboxH) (closes ~14px gaps on a 280px
 *     icon — enough for skull eye sockets, tooth cusp, car window line).
 *   - Boosted R ≈ 5% when the raw mask has ≥ 2 large connected components
 *     (basketball's 8 wedges, brain's hemispheres) — closes ~30px seams.
 *
 * This keeps single-component icons untouched while aggressively merging
 * inherently multi-part icons into coherent silhouettes.
 *
 * `shapeSource` gates the closing step:
 *   - 'library' (default): full closing as described above — needed because
 *     FA/MS icons and some built-ins (basketball seams, envelope flap)
 *     express decorative detail as separate subpaths that need bridging.
 *   - 'generated': skip closing entirely. The SVG generator's v2 prompt uses
 *     fill-rule="evenodd" for intentional holes (arch openings, brain sulci);
 *     morphological closing would seal them back into blobs. Generated SVGs
 *     already come out as coherent single-component silhouettes.
 *
 * Path fills use fill-rule="evenodd" so holes carved by reversed subpaths
 * render as holes (nonzero would fill them solid). This is essential for
 * v2-generated SVGs.
 *
 * Edge pixels are duplicated 3x so more particles cluster on outlines.
 */
function rasterizeFromPaths(paths, viewBox, resolution = 300, shapeSource = 'library', maxPoints = 30000) {
  // Render into a canvas that extends past the declared viewBox. Some SVGs
  // have path points outside their viewBox (LLM-generated ones most often);
  // a rigid viewBox-sized canvas clips that content. The pad captures
  // overflow; actual-content normalization below makes the final coords
  // honest. `generated` gets a larger buffer because the LLM occasionally
  // emits viewBox-overflowing strokes; library/emoji/iconify SVGs are
  // well-formed, so a small safety pad is enough and keeps the raster
  // bitmap ≈ (1.3×resolution)² — the pad was previously 3× which made
  // the bitmap 9× larger and pushed the morphological closing pass into
  // a multi-second main-thread block on first shape render.
  const OVERFLOW_PAD = shapeSource === 'generated' ? 0.5 : 0.15;
  const padPx = Math.round(resolution * OVERFLOW_PAD);
  const W = resolution + padPx * 2;
  const H = resolution + padPx * 2;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const [vx, vy, vw, vh] = viewBox.split(' ').map(Number);
  const scaleX = resolution / vw;
  const scaleY = resolution / vh;

  ctx.fillStyle = 'white';
  ctx.translate(padPx, padPx);
  ctx.scale(scaleX, scaleY);
  ctx.translate(-vx, -vy);

  for (const pathStr of paths) {
    const path = new Path2D(pathStr);
    ctx.fill(path, 'evenodd');
  }

  // Extract filled pixel positions at 1px resolution
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;
  const points = [];

  // First pass: build raw mask + compute bounding box
  const raw = new Uint8Array(W * H);
  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] > 128) {
        raw[y * W + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Morphological closing to fill decorative gaps between subpaths.
  // Use connected-components count to decide the closing radius:
  //   1 large island → light closing (2.5% of bbDim) — just smooth small seams
  //   2+ large islands → aggressive closing (5% of bbDim) — bridge the islands
  // The CC count is cheap (single 4-connectivity flood-fill pass) and lets us
  // avoid over-closing icons like `envelope` (flap is a separate island but
  // it's intentional visual detail).
  //
  // SKIPPED for generated and builtin sources — their SVGs are authored as
  // coherent single-component silhouettes with intentional holes (evenodd).
  // Closing would seal those holes (Colosseum arches, brain sulcus) into blobs.
  let filled = raw;
  if (shapeSource === 'library' && maxX >= minX && maxY >= minY) {
    const bbDim = Math.max(1, Math.min(maxX - minX, maxY - minY));
    const components = countLargeComponents(raw, W, H);
    const fraction = components >= 2 ? 0.05 : 0.025;
    const R = Math.max(0, Math.round(bbDim * fraction));
    if (R >= 2) {
      filled = erodeMask(dilateMask(raw, W, H, R), W, H, R);
    }
  }

  // Normalize against the actual filled bbox, but use the SAME denominator for
  // both axes so aspect ratio is preserved in the point cloud. Downstream
  // _buildShape recomputes bbox from points and applies a single uniform scale,
  // so the shorter axis naturally ends up with a smaller [0, <1] range. This
  // matches the pre-fix behavior for in-viewBox shapes (where normalization
  // was `/resolution`) while correctly handling shapes that overflow their
  // declared viewBox.
  if (maxX < minX || maxY < minY) return points;  // empty shape
  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const denom = Math.max(bboxW, bboxH);

  // Second pass: collect edge and interior points separately so we can
  // detect "too simple" filled icons (solid blocks with no internal detail).
  const edgePoints = [];
  const interiorPoints = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!filled[y * W + x]) continue;

      const nx = (x - minX) / denom;
      const ny = (y - minY) / denom;

      const isEdge =
        x === 0 || x === W - 1 || y === 0 || y === H - 1 ||
        !filled[(y - 1) * W + x] ||
        !filled[(y + 1) * W + x] ||
        !filled[y * W + (x - 1)] ||
        !filled[y * W + (x + 1)];

      if (isEdge) {
        edgePoints.push({ x: nx, y: ny });
      } else {
        interiorPoints.push({ x: nx, y: ny });
      }
    }
  }

  // Detect "too simple" filled shapes: if edges are < 12% of total pixels,
  // the shape is a solid blob with little internal structure. Drop interior
  // points entirely and render edge-only so the silhouette outline is visible.
  const totalPixels = edgePoints.length + interiorPoints.length;
  const edgeRatio = totalPixels > 0 ? edgePoints.length / totalPixels : 1;
  const edgeOnly = edgeRatio < 0.12;

  if (edgeOnly && resolution <= 300) {
    return rasterizeFromPaths(paths, viewBox, resolution * 2, shapeSource, maxPoints);
  }

  const pixelSize = 1 / denom;
  if (edgeOnly) {
    for (const p of edgePoints) {
      points.push({ x: p.x, y: p.y, edge: true });
      points.push({ x: p.x + (Math.random() - 0.5) * pixelSize, y: p.y + (Math.random() - 0.5) * pixelSize, edge: true });
      points.push({ x: p.x + (Math.random() - 0.5) * pixelSize, y: p.y + (Math.random() - 0.5) * pixelSize, edge: true });
    }
  } else {
    for (const p of edgePoints) {
      points.push({ x: p.x, y: p.y, edge: true });
      points.push({ x: p.x, y: p.y, edge: true });
      points.push({ x: p.x, y: p.y, edge: true });
    }
    for (const p of interiorPoints) {
      points.push({ x: p.x, y: p.y, edge: false });
    }
  }

  // Shuffle unconditionally so ANY prefix of the array is a uniform spatial
  // sample. This is critical for the ferris wheel: each shape gets only
  // budget/N particles, and _applyShapeRotation walks basePoints[0..slots].
  // Without shuffling, those slots cover only the first scanlines (top of
  // the shape) and the bottom half vanishes.
  //
  // When points.length > maxPoints, the shuffle doubles as a partial
  // Fisher-Yates that selects a uniform K-sample and truncates.
  {
    const n = points.length;
    const K = Math.min(n, maxPoints);
    for (let i = 0; i < K; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      if (j !== i) {
        const tmp = points[i];
        points[i] = points[j];
        points[j] = tmp;
      }
    }
    points.length = K;
  }

  points.aspectRatio = bboxW / bboxH;
  return points;
}

/**
 * Stroke-following rasterizer: SVG geometry → particle point cloud sampled
 * ALONG the paths (instead of inside their fills).
 *
 * Designed for line-art silhouettes (OpenMoji black, Iconify line sets,
 * stroke-only icons) where `rasterizeFromPaths` would produce nothing
 * because the paths have `fill="none"`. Uses the browser's native
 * SVGGeometryElement.getTotalLength / getPointAtLength — no dependencies.
 *
 * Visual feel: particles behave like bristles on a brush following the
 * stroke. Perpendicular jitter gives the stroke "weight"; along-tangent
 * jitter breaks up the regularity of fixed-interval sampling.
 *
 * Same output contract as rasterizeFromPaths: points are {x, y} in
 * [0, 1] × [0, <=1] (aspect-preserving, longest axis = 1), with
 * `points.aspectRatio = bboxW / bboxH` attached.
 *
 * @param {SVGElement[]} geomEls — DOM nodes that implement SVGGeometryElement
 *   (path, line, polyline, polygon, circle, ellipse, rect). Any other tags
 *   are ignored.
 * @param {string} viewBox — SVG viewBox string "minX minY width height".
 * @param {number} resolution — target canvas-space size (longest axis).
 * @param {number} maxPoints — hard cap on returned particles.
 */
export function particlesFromGeomElements(geomEls, viewBox, resolution = 300, maxPoints = 30000) {
  const [vx, vy, vw, vh] = viewBox.split(' ').map(Number);
  // Uniform scale so the longest viewBox axis fills `resolution` — preserves
  // aspect ratio. Offsets center the content inside the square measurement box.
  const scale = resolution / Math.max(vw, vh);
  const offsetX = (resolution - vw * scale) / 2;
  const offsetY = (resolution - vh * scale) / 2;

  // Brush knobs. Tuned for 300px resolution & ~10K particle budget.
  const SAMPLE_STEP_PX = 1.3;    // canvas-px between samples along the stroke
  const BRISTLE_COUNT = 3;       // particles per sample
  const BRISTLE_SPREAD_PX = 1.8; // max perpendicular jitter, canvas-px
  const ALONG_JITTER_PX = 0.5;   // max along-tangent jitter, canvas-px
  const CORNER_BONUS = 2;        // multiplier for bristles at sharp turns

  // Hidden SVG to host clones — getTotalLength/getPointAtLength require the
  // element to be in the DOM and laid out.
  const ns = 'http://www.w3.org/2000/svg';
  const host = document.createElementNS(ns, 'svg');
  host.setAttribute('viewBox', viewBox);
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);

  const points = [];
  const sampleStepSvg = SAMPLE_STEP_PX / scale;       // svg-units between samples
  const bristleSpreadSvg = BRISTLE_SPREAD_PX / scale;
  const alongJitterSvg = ALONG_JITTER_PX / scale;

  try {
    for (const el of geomEls) {
      // Only sample elements that implement SVGGeometryElement.
      if (typeof el.getTotalLength !== 'function') continue;

      // Clone without children — we only need the element's geometry.
      const clone = el.cloneNode(false);
      host.appendChild(clone);

      let totalLen = 0;
      try {
        totalLen = clone.getTotalLength();
      } catch (_) { /* some browsers throw on degenerate geometry */ }
      if (!Number.isFinite(totalLen) || totalLen <= 0) { host.removeChild(clone); continue; }

      const numSamples = Math.max(2, Math.ceil(totalLen / sampleStepSvg));
      let prevNtx = 0, prevNty = 0;

      for (let i = 0; i < numSamples; i++) {
        const t = (i / (numSamples - 1)) * totalLen;
        const p = clone.getPointAtLength(t);

        // Tangent via symmetric finite difference, clamped at ends.
        const dt = Math.max(0.05, Math.min(sampleStepSvg * 0.5, totalLen * 0.5));
        const tA = Math.max(0, t - dt);
        const tB = Math.min(totalLen, t + dt);
        const pA = clone.getPointAtLength(tA);
        const pB = clone.getPointAtLength(tB);
        const tx = pB.x - pA.x, ty = pB.y - pA.y;
        const tLen = Math.hypot(tx, ty) || 1;
        const ntx = tx / tLen, nty = ty / tLen;
        const perpx = -nty, perpy = ntx;

        // Corner detection: sharp tangent change → emit more bristles so
        // joins stay crisp instead of getting thinned out.
        let bristles = BRISTLE_COUNT;
        if (i > 0) {
          const dot = ntx * prevNtx + nty * prevNty;
          if (dot < 0.7) bristles *= CORNER_BONUS;  // > ~45° turn
        }
        prevNtx = ntx; prevNty = nty;

        for (let b = 0; b < bristles; b++) {
          const perpOffset = (Math.random() - 0.5) * 2 * bristleSpreadSvg;
          const alongOffset = (Math.random() - 0.5) * 2 * alongJitterSvg;
          const rx = p.x + perpx * perpOffset + ntx * alongOffset;
          const ry = p.y + perpy * perpOffset + nty * alongOffset;
          // Map viewBox-units → measurement canvas pixel-units, store as unit square
          const cx = offsetX + (rx - vx) * scale;
          const cy = offsetY + (ry - vy) * scale;
          points.push({ x: cx / resolution, y: cy / resolution, edge: true });
        }
      }
      host.removeChild(clone);
    }
  } finally {
    document.body.removeChild(host);
  }

  if (points.length === 0) return points;

  // Re-normalize to the actual point bbox with a shared denominator
  // (aspect-preserving), matching rasterizeFromPaths's output contract.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const denom = Math.max(bboxW, bboxH) || 1;
  for (const p of points) {
    p.x = (p.x - minX) / denom;
    p.y = (p.y - minY) / denom;
  }

  // Shuffle unconditionally so any prefix is a uniform spatial sample
  // (same rationale as rasterizeFromPaths — ferris wheel uses a prefix).
  {
    const K = Math.min(points.length, maxPoints), n = points.length;
    for (let i = 0; i < K; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      if (j !== i) { const tmp = points[i]; points[i] = points[j]; points[j] = tmp; }
    }
    points.length = K;
  }

  points.aspectRatio = bboxW / (bboxH || 1);
  return points;
}

/**
 * Decide whether an SVG should be rendered stroke-following (line art) or
 * fill-rasterized (silhouette). A line-art SVG is characterized by every
 * geometry element declaring or inheriting `fill="none"` together with a
 * non-none `stroke`. OpenMoji black/line set fits this pattern; Iconify
 * fill sets do not.
 *
 * Returns true if a clear majority of geometry elements are stroke-only.
 */
function isStrokeOnlySvg(doc) {
  const geomEls = doc.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect');
  if (geomEls.length === 0) return false;

  const resolveAttr = (el, name) => {
    // Walk up ancestors to find the nearest declared attribute (SVG
    // inheritance). Stops at the <svg> element.
    let node = el;
    while (node && node.nodeType === 1) {
      const v = node.getAttribute && node.getAttribute(name);
      if (v != null && v !== '') return v;
      node = node.parentNode;
      if (node && node.tagName && node.tagName.toLowerCase() === 'svg') {
        const v2 = node.getAttribute && node.getAttribute(name);
        return v2 != null && v2 !== '' ? v2 : null;
      }
    }
    return null;
  };

  let strokeOnly = 0;
  for (const el of geomEls) {
    const fill = resolveAttr(el, 'fill');
    const stroke = resolveAttr(el, 'stroke');
    const isFillNone = fill === 'none';
    const hasStroke = stroke && stroke !== 'none';
    if (isFillNone && hasStroke) strokeOnly++;
  }
  // Threshold at 80% — generous to catch mixed sets like "filled fill + stroked outline".
  return strokeOnly / geomEls.length >= 0.8;
}

/**
 * Infer the shape source from its URL. Used to gate morphological closing —
 * library icons need seam-bridging (basketball seams, envelope flap gaps);
 * generated (v2+) and curated (hand-drawn) icons have intentional holes
 * (Pisa tier bands, Colosseum arches) and must not be closed.
 * Iconify-cached icons come from clean icon sets (Material Symbols, Tabler,
 * Phosphor, etc.) — they're library-quality with no intentional holes to
 * preserve, so they get the same seam-bridging treatment as FA/Material.
 */
function inferShapeSource(url) {
  if (!url) return 'library';
  if (url.includes('/shapes/generated')) return 'generated';
  if (url.includes('/shapes/curated')) return 'generated';
  if (url.includes('/shapes/iconify-cache')) return 'library';
  if (url.includes('/shapes/library')) return 'library';
  return 'library';
}

/**
 * Load an external SVG file and rasterize it into particle points.
 * Returns a promise that resolves to an array of {x, y} points.
 *
 * `maxPoints` is the hard cap; callers pass the particle-budget so the
 * output is ALREADY a uniform sample sized to fit. This is the primary
 * defense against the slicing class of bug — downstream consumers can
 * safely walk the prefix knowing it's uniform.
 */
export async function loadExternalShape(url, resolution = 300, maxPoints = 30000) {
  try {
    const response = await fetch(url);
    const svgText = await response.text();

    // Parse SVG to extract paths and viewBox
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return null;

    const viewBox = svg.getAttribute('viewBox') || '0 0 100 100';

    // Defensive check: our rasterizer ignores group transforms. Library SVGs
    // are pre-filtered, but cached/generated ones may slip through. Warn
    // so regressions are visible rather than silently producing skewed shapes.
    const transformedGroups = doc.querySelectorAll('g[transform]');
    if (transformedGroups.length > 0) {
      console.warn(`[shapes] SVG has ${transformedGroups.length} <g transform> — paths may render incorrectly: ${url}`);
    }

    // Auto-dispatch between stroke-following and fill-rasterization based on
    // what the SVG actually contains. Line-art SVGs (OpenMoji black, Iconify
    // line sets) produce NOTHING under rasterizeFromPaths because every path
    // has fill="none"; they need particlesFromGeomElements. Fill-based SVGs
    // (FA solid, Material filled, LLM-generated) keep the existing path.
    if (isStrokeOnlySvg(doc)) {
      const geomEls = Array.from(doc.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect'));
      if (geomEls.length === 0) return null;
      // Inject a clone of the source SVG into the DOM so getPointAtLength
      // can measure real on-page geometry (SVGGeometryElement methods require
      // an in-document, laid-out element). particlesFromGeomElements handles
      // its own hidden host — we just need to pass it live elements.
      return particlesFromGeomElements(geomEls, viewBox, resolution, maxPoints);
    }

    const pathEls = doc.querySelectorAll('path');
    const paths = Array.from(pathEls).map(p => p.getAttribute('d')).filter(Boolean);

    if (paths.length === 0) return null;

    const shapeSource = inferShapeSource(url);
    return rasterizeFromPaths(paths, viewBox, resolution, shapeSource, maxPoints);
  } catch (e) {
    console.warn('Failed to load external shape:', url, e);
    return null;
  }
}

/**
 * Rasterize a text string into particle points using the Canvas text API.
 * Returns points normalized to [0, 1] × [0, 1] — same format as
 * rasterizeFromPaths — so it plugs into the same downstream machinery
 * (spring physics, target-based rendering, contract asserts).
 *
 * Used to build the "Thinking Canvas" particle title. The title is
 * rasterized once at canvas size, then scaled to the visible area just
 * like any shape.
 *
 * @param {string} text - The text to rasterize.
 * @param {object} opts
 * @param {number} opts.resolution - Width (in px) of the offscreen scratch
 *   bitmap. Taller content is auto-scaled to fit. 600 is a good default
 *   for titles.
 * @param {string} opts.font - CSS font shorthand (e.g. `"bold 72px 'Inter', -apple-system, sans-serif"`).
 * @param {number} opts.maxPoints - Hard cap on returned points. Caller should
 *   pass the particle budget for the title to stay within.
 * @returns {Array<{x:number,y:number}>|null} Normalized point cloud, or null
 *   on empty string / font-measure failure.
 */
export function rasterizeText(text, opts = {}) {
  const resolution = opts.resolution || 600;
  const font = opts.font || "bold 72px 'Inter', -apple-system, 'SF Pro Display', sans-serif";
  const maxPoints = opts.maxPoints || 30000;
  // Minimum pixel alpha to count as filled. Default 128 captures anti-aliased
  // edges — makes titles look bold/padded. Callers wanting a thin, clean
  // letterform can raise this (e.g. 200) to pick only stroke cores.
  const alphaThreshold = opts.alphaThreshold ?? 128;

  if (!text || typeof text !== 'string') return null;

  // Extra pixel spacing between glyphs. Script faces (Love Light) have
  // connecting strokes that run letters into one another under the bokeh
  // particle render — small positive spacing breaks the letters apart so
  // each one reads as distinct, at the cost of losing the "handwriting
  // flow" feel.
  const letterSpacing = opts.letterSpacing || 0;
  const letterSpacingCss = letterSpacing ? `${letterSpacing}px` : '0px';

  // First pass: measure text at the requested font so we can size the
  // bitmap tightly. Browser measureText() returns width; we approximate
  // height from the font-size token.
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = font;
  if ('letterSpacing' in measureCtx) measureCtx.letterSpacing = letterSpacingCss;
  const metrics = measureCtx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  // Most browsers expose actualBoundingBox* in modern versions. Fall back
  // to a heuristic if missing.
  const ascent = metrics.actualBoundingBoxAscent || 56;
  const descent = metrics.actualBoundingBoxDescent || 16;
  const textHeight = Math.ceil(ascent + descent);

  if (textWidth <= 0 || textHeight <= 0) return null;

  // Pad so anti-aliased edges aren't clipped.
  const padding = 8;
  const bitmapW = textWidth + padding * 2;
  const bitmapH = textHeight + padding * 2;

  const canvas = document.createElement('canvas');
  canvas.width = bitmapW;
  canvas.height = bitmapH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = 'white';
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = letterSpacingCss;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, padding, padding + ascent);

  // Scan pixels, collect filled positions, and normalize to [0,1] × [0,1].
  const imageData = ctx.getImageData(0, 0, bitmapW, bitmapH);
  const data = imageData.data;

  // Build a set of filled pixel coordinates for erosion.
  let filled = new Set();
  for (let y = 0; y < bitmapH; y++) {
    for (let x = 0; x < bitmapW; x++) {
      const i = (y * bitmapW + x) * 4;
      if (data[i + 3] > alphaThreshold) {
        filled.add(y * bitmapW + x);
      }
    }
  }

  // Morphological erosion: peel boundary pixels to thin strokes uniformly.
  const erode = opts.erode || 0;
  for (let pass = 0; pass < erode; pass++) {
    const interior = new Set();
    for (const key of filled) {
      const x = key % bitmapW;
      const y = (key - x) / bitmapW;
      if (
        filled.has((y - 1) * bitmapW + x) &&
        filled.has((y + 1) * bitmapW + x) &&
        filled.has(y * bitmapW + (x - 1)) &&
        filled.has(y * bitmapW + (x + 1))
      ) {
        interior.add(key);
      }
    }
    filled = interior;
  }

  // Edge-only mode: for titles, interior glyph fill is what crushes
  // counters (loops in a/o/g) and bleeds adjacent strokes together under
  // the soft bokeh particle render. Keeping only the outline gives the
  // letterforms room to breathe.
  const edgeOnly = opts.edgeOnly === true;
  const points = [];
  for (const key of filled) {
    const x = key % bitmapW;
    const y = (key - x) / bitmapW;
    const isEdge =
      !filled.has((y - 1) * bitmapW + x) ||
      !filled.has((y + 1) * bitmapW + x) ||
      !filled.has(y * bitmapW + (x - 1)) ||
      !filled.has(y * bitmapW + (x + 1));
    if (edgeOnly && !isEdge) continue;
    points.push({ x: x / bitmapW, y: y / bitmapH, edge: isEdge });
  }

  if (points.length === 0) return null;

  // Shuffle unconditionally (same rationale as rasterizeFromPaths).
  {
    const n = points.length;
    const K = Math.min(n, maxPoints);
    for (let i = 0; i < K; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      if (j !== i) {
        const tmp = points[i];
        points[i] = points[j];
        points[j] = tmp;
      }
    }
    points.length = K;
  }

  // Expose the aspect ratio so callers can lay the title out without
  // distorting letterforms.
  points.aspectRatio = bitmapW / bitmapH;
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

  // Partial match — word-boundary aware to avoid false positives
  // (e.g. "glove" should NOT match "love")
  for (const [synonym, shape] of Object.entries(synonyms)) {
    const re = new RegExp(`\\b${synonym}\\b`);
    if (re.test(c) || new RegExp(`\\b${c}\\b`).test(synonym)) return shape;
  }

  // Default to question mark for unknown concepts
  return 'question';
}
