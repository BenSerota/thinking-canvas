/**
 * Lottie Rasterizer
 *
 * Converts a Lottie animation JSON into an array of particle point-cloud
 * frames. Each frame is an array of {x, y, edge, hidden?} points in [0, 1]
 * space (same contract as shapes.js rasterizeFromPaths).
 *
 * Static/dynamic split: pixels present in ALL non-empty frames (nucleus,
 * orbit rings) are placed first in every frame array and are identical
 * across frames. Pixels that move (electrons) are placed after. canvas.js
 * uses the returned `staticCount` to skip retargeting the stable portion on
 * frame swap — only the dynamic tail gets new particle targets.
 *
 * Every frame has the same length: the dynamic tail is padded with
 * `hidden` sentinels, which release their particle to the hurricane. An
 * empty keyframe (an "off" phase of a blinking animation) therefore hides
 * the dynamic part instead of being dropped from the sequence.
 *
 * Capture runs at 1 CSS px per pixel (dpr 1) with typed-array masks, and
 * yields to the event loop between keyframes so the animation loop is not
 * blocked for the whole capture.
 */

// Pixels above this alpha count as ink. The canvas is cleared each frame,
// so faint opacity phases still register.
const ALPHA_MIN = 25;
const LOAD_TIMEOUT_MS = 3000;

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

/**
 * Turn the set pixels of `mask` (optionally restricted to those where
 * `only` is set / `except` is unset) into normalized points, tripling edge
 * pixels. Edges are detected against `neighbours` — the union of all
 * frames for static pixels, the frame itself for dynamic ones.
 */
function maskToPoints(mask, neighbours, W, bbox, only, except) {
  const { minX, maxX, minY, maxY, denom } = bbox;
  const points = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (only && !only[i]) continue;
      if (except && except[i]) continue;
      const nx = (x - minX) / denom;
      const ny = (y - minY) / denom;
      const isEdge =
        y === 0 || !neighbours[i - W] ||
        !neighbours[i + W] ||
        x === 0 || !neighbours[i - 1] ||
        !neighbours[i + 1];
      points.push({ x: nx, y: ny, edge: isEdge });
      if (isEdge) {
        points.push({ x: nx, y: ny, edge: true });
        points.push({ x: nx, y: ny, edge: true });
      }
    }
  }
  return points;
}

/**
 * @returns {Promise<{frames: Array, fps: number, duration: number, staticCount: number}|null>}
 */
export async function loadLottieShape(url, resolution = 300, maxPointsPerFrame = 6800, numKeyframes = 24) {
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

  let anim = null;
  try {
    anim = lottieLib.loadAnimation({
      container,
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: animData,
      rendererSettings: { clearCanvas: true, preserveAspectRatio: 'xMidYMid meet', dpr: 1 },
    });

    await new Promise((resolve, reject) => {
      if (anim.isLoaded) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('DOMLoaded timeout')), LOAD_TIMEOUT_MS);
      anim.addEventListener('DOMLoaded', () => { clearTimeout(timer); resolve(); });
    });

    const totalFrames = anim.totalFrames;
    const fps = animData.fr || 30;
    const duration = totalFrames / fps;

    const canvasEl = container.querySelector('canvas');
    if (!canvasEl) return null;
    const ctx = canvasEl.getContext('2d');
    const W = canvasEl.width;
    const H = canvasEl.height;
    const N = W * H;

    // Pass 1: capture each keyframe as a bitmask; count per-pixel presence.
    const masks = [];
    const presence = new Uint16Array(N);
    let nonEmptyFrames = 0;
    let minX = W, maxX = -1, minY = H, maxY = -1;
    for (let k = 0; k < numKeyframes; k++) {
      anim.goToAndStop(Math.floor((k / numKeyframes) * totalFrames), true);
      const data = ctx.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(N);
      let count = 0;
      for (let i = 0; i < N; i++) {
        if (data[i * 4 + 3] > ALPHA_MIN) {
          mask[i] = 1;
          presence[i]++;
          count++;
          const x = i % W;
          const y = (i - x) / W;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      masks.push({ mask, count });
      if (count > 0) nonEmptyFrames++;
      // Let the animation loop breathe between captures.
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (nonEmptyFrames === 0 || maxX < minX || maxY < minY) {
      console.warn('[lottie-rasterizer] empty frames');
      return null;
    }

    // Pass 2: static = present in every non-empty frame; union = any frame.
    const staticMask = new Uint8Array(N);
    const unionMask = new Uint8Array(N);
    let staticCountPx = 0;
    for (let i = 0; i < N; i++) {
      if (presence[i] > 0) unionMask[i] = 1;
      if (presence[i] === nonEmptyFrames) { staticMask[i] = 1; staticCountPx++; }
    }

    const bbox = { minX, maxX, minY, maxY, denom: Math.max(maxX - minX + 1, maxY - minY + 1) };

    // Pass 3: static points once, edge-classified against the union so the
    // resting outline of a pulsing shape isn't tripled into a bright ring.
    let staticPoints = maskToPoints(staticMask, unionMask, W, bbox, null, null);
    const maxFramePx = Math.max(...masks.map(m => m.count));
    const staticRatio = maxFramePx > 0 ? staticCountPx / maxFramePx : 0.5;
    const staticBudget = Math.min(Math.floor(maxPointsPerFrame * staticRatio), staticPoints.length);
    const dynamicBudget = Math.max(0, maxPointsPerFrame - staticBudget);
    staticPoints = fisherYatesDownsample(staticPoints, staticBudget, 12345);
    const staticCount = staticPoints.length;

    // Pass 4: per-frame dynamic points, normalised to dynamicBudget entries.
    const frames = [];
    for (const { mask } of masks) {
      let dynamicPoints = maskToPoints(mask, mask, W, bbox, null, staticMask);
      dynamicPoints = fisherYatesDownsample(dynamicPoints, dynamicBudget, 12345);

      const combined = new Array(staticCount + dynamicBudget);
      for (let i = 0; i < staticCount; i++) {
        const p = staticPoints[i];
        combined[i] = { x: p.x, y: p.y, edge: p.edge };
      }
      for (let i = 0; i < dynamicBudget; i++) {
        const p = dynamicPoints[i];
        combined[staticCount + i] = p
          ? { x: p.x, y: p.y, edge: p.edge }
          : { x: 0, y: 0, edge: false, hidden: true };
      }
      frames.push(combined);
    }

    return { frames, fps, duration, staticCount };
  } catch (err) {
    console.warn('[lottie-rasterizer] capture failed:', err.message);
    return null;
  } finally {
    if (anim) {
      try { anim.destroy(); } catch (_) { /* already gone */ }
    }
    if (container.parentNode) container.parentNode.removeChild(container);
  }
}
