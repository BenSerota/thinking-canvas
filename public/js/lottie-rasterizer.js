/**
 * Lottie Rasterizer
 *
 * Converts a Lottie animation JSON into an array of particle point-cloud
 * frames. Each frame is an array of {x, y} points in [0, 1] space
 * (same contract as shapes.js rasterizeFromPaths).
 *
 * Static/dynamic split: pixels present in ALL frames (nucleus, orbit rings)
 * are placed first in every frame array and are identical across frames.
 * Pixels that move (electrons) are placed after. canvas.js uses the returned
 * `staticCount` to skip retargeting the stable portion on frame swap —
 * only the dynamic tail gets new particle targets.
 */

function fisherYatesDownsample(points, budget, seed) {
  if (points.length <= budget) return points;
  const nextSeed = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < budget; i++) {
    const j = i + (nextSeed() % (points.length - i));
    if (j !== i) {
      const tmp = points[i];
      points[i] = points[j];
      points[j] = tmp;
    }
  }
  points.length = budget;
  return points;
}

function edgeWeightAndNormalize(pixels, edgeLookup, globalMinX, globalMinY, denom, W) {
  const points = [];
  for (const p of pixels) {
    const nx = (p.x - globalMinX) / denom;
    const ny = (p.y - globalMinY) / denom;
    const isEdge =
      !edgeLookup.has((p.y - 1) * W + p.x) ||
      !edgeLookup.has((p.y + 1) * W + p.x) ||
      !edgeLookup.has(p.y * W + (p.x - 1)) ||
      !edgeLookup.has(p.y * W + (p.x + 1));
    points.push({ x: nx, y: ny, edge: isEdge });
    if (isEdge) {
      points.push({ x: nx, y: ny, edge: true });
      points.push({ x: nx, y: ny, edge: true });
    }
  }
  return points;
}

/**
 * @returns {Promise<{frames: Array, fps: number, duration: number, staticCount: number}|null>}
 */
export async function loadLottieShape(url, resolution = 300, maxPointsPerFrame = 10200, numKeyframes = 20) {
  const lottieLib = typeof lottie !== 'undefined' ? lottie : (typeof bodymovin !== 'undefined' ? bodymovin : null);
  if (!lottieLib) {
    console.warn('[lottie-rasterizer] lottie-web not loaded');
    return null;
  }

  let animData;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    animData = await resp.json();
  } catch (err) {
    console.warn('[lottie-rasterizer] fetch failed:', err.message);
    return null;
  }

  if (!animData || !animData.layers || !Array.isArray(animData.layers)) {
    console.warn('[lottie-rasterizer] invalid animation data');
    return null;
  }

  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:' + resolution + 'px;height:' + resolution + 'px;overflow:hidden;';
  document.body.appendChild(container);

  let anim;
  try {
    anim = lottieLib.loadAnimation({
      container,
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: animData,
      rendererSettings: { clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' },
    });
  } catch (err) {
    console.warn('[lottie-rasterizer] lottie init failed:', err.message);
    document.body.removeChild(container);
    return null;
  }

  await new Promise((resolve) => {
    if (anim.isLoaded) resolve();
    else anim.addEventListener('DOMLoaded', resolve);
  });

  const totalFrames = anim.totalFrames;
  const fps = animData.fr || 30;
  const duration = totalFrames / fps;

  const canvasEl = container.querySelector('canvas');
  if (!canvasEl) {
    anim.destroy();
    document.body.removeChild(container);
    return null;
  }

  const ctx = canvasEl.getContext('2d');
  const W = canvasEl.width;
  const H = canvasEl.height;

  const frameIndices = [];
  for (let i = 0; i < numKeyframes; i++) {
    frameIndices.push(Math.floor((i / numKeyframes) * totalFrames));
  }

  // Pass 1: render each frame and collect raw pixel positions
  const rawFrames = [];
  let globalMinX = W, globalMaxX = 0, globalMinY = H, globalMaxY = 0;

  for (const frameIdx of frameIndices) {
    anim.goToAndStop(frameIdx, true);
    const imageData = ctx.getImageData(0, 0, W, H);
    const data = imageData.data;
    const pixels = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (data[i + 3] > 100) {
          pixels.push({ x, y });
          if (x < globalMinX) globalMinX = x;
          if (x > globalMaxX) globalMaxX = x;
          if (y < globalMinY) globalMinY = y;
          if (y > globalMaxY) globalMaxY = y;
        }
      }
    }
    rawFrames.push(pixels);
  }

  anim.destroy();
  document.body.removeChild(container);

  if (globalMaxX <= globalMinX || globalMaxY <= globalMinY) {
    console.warn('[lottie-rasterizer] empty frames');
    return null;
  }

  // Pass 2: identify static pixels (present in ALL non-empty frames)
  const nonEmptyIdx = [];
  const pixelSets = [];
  for (let f = 0; f < rawFrames.length; f++) {
    if (rawFrames[f].length === 0) continue;
    nonEmptyIdx.push(f);
    const set = new Set();
    for (const p of rawFrames[f]) set.add(p.y * W + p.x);
    pixelSets.push(set);
  }

  if (nonEmptyIdx.length === 0) return null;

  const staticKeys = new Set(pixelSets[0]);
  for (let i = 1; i < pixelSets.length; i++) {
    for (const key of staticKeys) {
      if (!pixelSets[i].has(key)) staticKeys.delete(key);
    }
  }

  // Pass 3: process static pixels ONCE from the first non-empty frame
  const denom = Math.max(globalMaxX - globalMinX + 1, globalMaxY - globalMinY + 1);
  const refFrame = rawFrames[nonEmptyIdx[0]];
  const staticRawPixels = refFrame.filter(p => staticKeys.has(p.y * W + p.x));

  const staticEdgeLookup = staticKeys;
  let staticPoints = edgeWeightAndNormalize(staticRawPixels, staticEdgeLookup, globalMinX, globalMinY, denom, W);

  // Budget: proportional to static vs dynamic pixel counts
  const dynamicRawCount = refFrame.length - staticRawPixels.length;
  const totalRaw = refFrame.length;
  const staticRatio = totalRaw > 0 ? staticRawPixels.length / totalRaw : 0.5;
  const staticBudget = Math.min(Math.floor(maxPointsPerFrame * staticRatio), staticPoints.length);
  const dynamicBudget = maxPointsPerFrame - staticBudget;

  staticPoints = fisherYatesDownsample(staticPoints, staticBudget, 12345);
  const staticCount = staticPoints.length;


  // Pass 4: process dynamic pixels per frame, prepend static
  const frames = [];
  for (let fi = 0; fi < rawFrames.length; fi++) {
    if (rawFrames[fi].length === 0) {
      frames.push([]);
      continue;
    }

    const dynamicRaw = rawFrames[fi].filter(p => !staticKeys.has(p.y * W + p.x));
    const framePixelSet = pixelSets[nonEmptyIdx.indexOf(fi)] || new Set();
    let dynamicPoints = edgeWeightAndNormalize(dynamicRaw, framePixelSet, globalMinX, globalMinY, denom, W);
    dynamicPoints = fisherYatesDownsample(dynamicPoints, dynamicBudget, 12345);

    // Static points first (identical every frame), dynamic points after
    const combined = [];
    for (const p of staticPoints) combined.push({ x: p.x, y: p.y, edge: p.edge ?? false });
    for (const p of dynamicPoints) combined.push({ x: p.x, y: p.y, edge: p.edge ?? false });
    frames.push(combined);
  }

  const nonEmpty = frames.filter(f => f.length > 0);
  if (nonEmpty.length === 0) return null;

  return { frames: nonEmpty, fps, duration, staticCount };
}
