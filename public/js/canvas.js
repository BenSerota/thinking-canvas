/**
 * Thinking Canvas — Particle Simulation Engine
 *
 * Renders thousands of sand-grain particles on a 2D canvas. Particles can:
 *   - drift ambient (title particles held in place, free particles breeze)
 *   - form the title "Thinking Canvas" on page load
 *   - gather into a hurricane vortex while the LLM is reasoning
 *   - coalesce into one or more target shapes and ROTATE around their centroids
 *   - dissolve back into the hurricane on a new turn
 *
 * Hurricane is continuous, not a state. Its intensity is a lerped [0,1]
 * float that ramps up on user activity and dims (but never fully stops)
 * when shapes are settled. This gives the canvas a living feel at all
 * times — the ring never blinks on/off.
 *
 * Multi-shape layout: after all shapes for a turn have streamed in,
 * they arrange side-by-side and spin slowly in place. Each shape gets
 * its own orbiting mini-hurricane of free particles.
 *
 * States: title-idle → gathering → thinking → forming → settled → dissolving
 */

const PARTICLE_COUNT = 12000;
const SAND_COLORS = ['#D4A574', '#C4956A', '#E8C9A0', '#B8845A', '#DEB887', '#C9A882'];
const BG_COLOR = '#0d0d1a';
const PARTICLE_SIZE = 2.0;
const GLOW_SIZE = 5;

// Physics constants
const GRAVITY = 0.02;
const FRICTION = 0.97;
const BROWNIAN = 0.3;
const SPRING_K = 0.035;
const SPRING_DAMPING = 0.88;
const SWIRL_SPEED = 0.06;
const GATHER_PULL = 0.001;
const SHAPE_PARTICLE_RATIO = 0.85;

// Hurricane intensity targets per state. Always > 0 so the ring never
// fully disappears — it's ambient weather, not a status light.
const HURRICANE_TARGETS = {
  'title-idle': 0.15,  // gentle breeze, title particles locked
  'gathering':  0.6,
  'thinking':   1.0,   // full hurricane
  'forming':    0.35,  // orbiting around the shape(s)
  'settled':    0.35,  // same — shape(s) rotate, free particles orbit
  'dissolving': 0.5,   // bit of chaos as shapes come apart
  'idle':       0.15,
};
// Exponential-lerp rate per frame. ~0.04 → 25 frames to settle (~0.4s at 60fps).
const HURRICANE_LERP = 0.04;

// Shape rotation speed, radians per frame. 0.005 rad/frame × 60fps = 0.3 rad/s
// → ~21s per full revolution. Slow enough to read the silhouette clearly.
const SHAPE_ROTATION_SPEED = 0.005;

// Cursor interaction constants
const CURSOR_RADIUS = 80;
const CURSOR_REPEL_FORCE = 3.0;
const CURSOR_ATTRACT_FORCE = 2.0;

/**
 * Particle budget for shape points. Exported so shapes.js /
 * loadExternalShape can pass it as `maxPoints` and uniform-sample the
 * rasterizer output to fit. This is the upstream half of the bug-prevention
 * pair (see ./shapes.js rasterizeFromPaths comments).
 */
export function getShapeParticleBudget() {
  return Math.floor(PARTICLE_COUNT * SHAPE_PARTICLE_RATIO);
}

export class ThinkingCanvas {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.particles = [];
    this.state = 'title-idle';

    /** @type {Array<{label, centerX, centerY, basePoints, particleIndices, bboxMax, isTitle, orbitRadius, orbitPhase}>} */
    this.currentShapes = [];
    // Single shared angle for the multi-shape carousel. All shapes ride
    // the same virtual ring and share this angle (plus their orbitPhase).
    // Shapes stay upright — they don't spin on their own centroids, they
    // travel around the canvas center like seats on a carousel.
    this.carouselAngle = 0;
    this.transitionProgress = 0;
    this.interimMode = false;

    // Hurricane intensity in [0, 1]. Drives swirl strength. Lerps toward
    // the target for the current state.
    this.hurricaneIntensity = HURRICANE_TARGETS['title-idle'];

    this.time = 0;
    this.lastTimestamp = null;

    // Cursor tracking
    this.mouseX = null;
    this.mouseY = null;
    this.mouseDown = false;

    this._resize();
    this._initParticles();
    this._boundAnimate = this._animate.bind(this);
    this._boundResize = this._resize.bind(this);
    window.addEventListener('resize', this._boundResize);

    // Mouse interaction
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouseX = null;
      this.mouseY = null;
      this.mouseDown = false;
    });
    this.canvas.addEventListener('mousedown', () => { this.mouseDown = true; });
    this.canvas.addEventListener('mouseup', () => { this.mouseDown = false; });

    // Touch support
    this.canvas.addEventListener('touchmove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const touch = e.touches[0];
      this.mouseX = touch.clientX - rect.left;
      this.mouseY = touch.clientY - rect.top;
    });
    this.canvas.addEventListener('touchend', () => {
      this.mouseX = null;
      this.mouseY = null;
      this.mouseDown = false;
    });

    requestAnimationFrame(this._boundAnimate);

    // FPS monitoring
    this._frameCount = 0;
    this._fpsCheckTime = 0;
    this._lowFpsCount = 0;
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * window.devicePixelRatio;
    this.canvas.height = this.height * window.devicePixelRatio;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  }

  _initParticles() {
    this.particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.particles.push({
        x: Math.random() * (this.width || 800),
        y: Math.random() * (this.height || 600),
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        targetX: null,
        targetY: null,
        color: SAND_COLORS[Math.floor(Math.random() * SAND_COLORS.length)],
        size: PARTICLE_SIZE + (Math.random() - 0.5) * 0.8,
        phase: Math.random() * Math.PI * 2,
        isShapeParticle: false,
        // For multi-shape hurricane: which shape center this free particle orbits.
        // null = orbit canvas center.
        hurricaneCenterX: null,
        hurricaneCenterY: null,
      });
    }
  }

  setState(newState) {
    if (this.state === newState) return;
    // Protect settled/forming from being overwritten by late 'thinking'
    // SSE events that arrive after the shapes have already landed. Only
    // 'gathering' (new user turn) is allowed to tear down shapes.
    if (newState === 'thinking' && (this.state === 'settled' || this.state === 'forming')) {
      return;
    }
    this.state = newState;
    if (newState === 'gathering') {
      // Release all targets so every particle (including title particles)
      // joins the hurricane.
      for (const p of this.particles) {
        p.targetX = null;
        p.targetY = null;
        p.isShapeParticle = false;
        p.hurricaneCenterX = null;
        p.hurricaneCenterY = null;
      }
      this.currentShapes = [];
    }
  }

  /**
   * Set the page-load title particles. Single-shape, centered near the top,
   * static (not rotating). Called once by app.js on init.
   */
  setTitle(textPoints, label = 'Thinking Canvas') {
    if (!textPoints || textPoints.length === 0) return;

    // Lay the title out near the top of the canvas. Use the aspectRatio
    // that rasterizeText attached, so letters don't squish.
    const aspectRatio = textPoints.aspectRatio || 4;
    const titleWidth = Math.min(this.width * 0.7, this.height * aspectRatio * 0.18);
    const titleHeight = titleWidth / aspectRatio;
    const centerX = this.width / 2;
    const centerY = this.height * 0.18;  // top ~18% of canvas
    const offsetX = centerX - titleWidth / 2;
    const offsetY = centerY - titleHeight / 2;

    const shape = {
      label,
      centerX,
      centerY,
      isTitle: true,
      bboxMax: titleWidth,
      orbitRadius: 0,     // title doesn't orbit
      orbitPhase: 0,
      basePoints: textPoints.map(p => ({
        x: offsetX + p.x * titleWidth,
        y: offsetY + p.y * titleHeight,
      })),
      particleIndices: [],
    };

    this._assignShapeToParticles([shape]);
    this.currentShapes = [shape];
    this.state = 'title-idle';
    this.transitionProgress = 0;
  }

  /**
   * Set a single shape centered on the canvas. Used during streaming
   * (crossfade behavior) before all shapes for a turn have arrived.
   */
  setShape(shapePoints, label, transition = 'instant') {
    if (!shapePoints || shapePoints.length === 0) {
      this.clearShape();
      return;
    }

    const doAssign = () => {
      const singleShape = this._buildShape(shapePoints, label, this.width / 2, this.height / 2, 1.0);
      this._assignShapeToParticles([singleShape]);
      this.currentShapes = [singleShape];
      this.state = 'forming';
      this.transitionProgress = 0;
    };

    if (transition === 'crossfade' && this.state === 'forming') {
      this.state = 'transitioning';
      for (const p of this.particles) {
        if (p.targetX !== null) {
          // Give shape particles an outward scatter kick…
          p.vx += (Math.random() - 0.5) * 4;
          p.vy += (Math.random() - 0.5) * 4;
          // …then release them from the spring entirely so they actually
          // drift. Without nulling targets here, spring physics (SPRING_K)
          // immediately cancels the kick and the shape stays frozen.
          p.targetX = null;
          p.targetY = null;
          p.isShapeParticle = false;
        }
      }
      setTimeout(doAssign, 200);
    } else {
      doAssign();
    }
  }

  /**
   * Arrange N shapes on a circular carousel around the canvas center and
   * rotate them all together (each shape stays upright, doesn't spin on
   * its own centroid). One hurricane ring encompasses the whole group.
   * Used once all shapes for a turn have arrived (turn 2+).
   */
  setShapes(shapesPointsAndLabels) {
    const n = shapesPointsAndLabels.length;
    if (n === 0) return this.clearShape();
    if (n === 1) return this.setShape(shapesPointsAndLabels[0].points, shapesPointsAndLabels[0].label);

    // Orbit radius is the distance from canvas center to each shape's
    // centroid. ~22% of min(w, h) leaves plenty of room for the shapes
    // AND the encompassing hurricane ring.
    const orbitRadius = Math.min(this.width, this.height) * 0.22;

    // Shapes distributed evenly by phase around the ring. Start at the
    // top (-π/2) for visual anchoring — the first shape is always at 12
    // o'clock at t=0.
    const phases = [];
    for (let i = 0; i < n; i++) {
      phases.push(-Math.PI / 2 + (i * 2 * Math.PI) / n);
    }

    // Per-shape scale. At 0.45 each shape is about half the size of the
    // single-shape view — shapes comfortably fit on the orbit without
    // overlap when they're closest to each other (across the ring).
    const perShapeScale = 0.45;

    // Reset the shared carousel angle so each new turn starts at t=0
    // (first shape at 12 o'clock).
    this.carouselAngle = 0;

    const shapes = [];
    for (let i = 0; i < n; i++) {
      const { points, label } = shapesPointsAndLabels[i];
      // centerX/centerY will be updated every frame in _applyShapeRotation;
      // seed them at the t=0 position so the very first frame doesn't see
      // stale values.
      const cx = this.width / 2 + orbitRadius * Math.cos(phases[i]);
      const cy = this.height / 2 + orbitRadius * Math.sin(phases[i]);
      const shape = this._buildShape(points, label, cx, cy, perShapeScale);
      shape.orbitRadius = orbitRadius;
      shape.orbitPhase = phases[i];
      shapes.push(shape);
    }

    this._assignShapeToParticles(shapes);
    this.currentShapes = shapes;
    this.state = 'settled';  // skip 'forming' — multi-shape view is the settled state
    // Jump transitionProgress past the 0.5 gate so labels appear
    // immediately (no streaming fade-in for the carousel transition —
    // viewer has already seen each shape in the preceding crossfade).
    this.transitionProgress = 0.9;
  }

  /**
   * Build a shape-descriptor with its centroid, per-shape scale, and base
   * (unrotated) particle positions. Doesn't touch particles yet — that's
   * _assignShapeToParticles's job.
   */
  _buildShape(shapePoints, label, centerX, centerY, scaleFactor) {
    const margin = 60;
    const shapeW = this.width - margin * 2;
    const shapeH = this.height - margin * 2;
    const fullScale = Math.min(shapeW, shapeH) * 0.7;
    const scale = fullScale * scaleFactor;

    // Find bbox of input points in [0,1] space (they're already normalized)
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const p of shapePoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const inCenterX = (minX + maxX) / 2;
    const inCenterY = (minY + maxY) / 2;

    // Translate so shape is centered on (centerX, centerY), scaled by `scale`.
    const basePoints = shapePoints.map(p => ({
      x: centerX + (p.x - inCenterX) * scale,
      y: centerY + (p.y - inCenterY) * scale,
    }));

    return {
      label,
      centerX,
      centerY,
      isTitle: false,
      bboxMax: Math.max(maxX - minX, maxY - minY) * scale,
      orbitRadius: 0,     // set by setShapes for carousel; 0 = stationary
      orbitPhase: 0,
      basePoints,
      particleIndices: [],
    };
  }

  /**
   * Partition the particle budget across the given shapes and assign each
   * shape a contiguous slice of particle indices. Free particles (those
   * not claimed by any shape) get a nearest-shape home so the multi-
   * hurricane knows where to orbit them.
   *
   * Runtime contract check: verify the output Y-range covers the input
   * Y-range. If not, a downstream slicing bug has regressed.
   */
  _assignShapeToParticles(shapes) {
    const particleCount = this.particles.length;

    // Total shape-particle budget.
    const budget = Math.min(
      shapes.reduce((sum, s) => sum + s.basePoints.length, 0),
      Math.floor(particleCount * SHAPE_PARTICLE_RATIO)
    );

    // Allocate each shape a slice proportional to the particles it needs.
    // Cap per shape at its basePoints.length (can't use more particles
    // than it has target positions).
    const perShapeBudget = shapes.map(s => {
      const idealShare = Math.floor(budget / shapes.length);
      return Math.min(s.basePoints.length, idealShare);
    });
    const totalShapeSlots = perShapeBudget.reduce((a, b) => a + b, 0);

    // Shuffle particle indices so shape assignment is spatially random
    // (no clumps of "particles that happened to be in this corner all
    // end up in shape 0").
    const indices = [...Array(particleCount).keys()];
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    // First totalShapeSlots indices become shape particles.
    let cursor = 0;
    for (let s = 0; s < shapes.length; s++) {
      const shape = shapes[s];
      shape.particleIndices = [];
      const slots = perShapeBudget[s];
      for (let k = 0; k < slots; k++) {
        const pi = indices[cursor++];
        shape.particleIndices.push(pi);
        // Note: we DON'T set targetX/targetY here — that happens per-frame
        // in _applyShapeRotation so rotation is smooth.
        this.particles[pi].isShapeParticle = true;
      }
    }

    // Remaining particles are free — they form the single encompassing
    // hurricane around the whole group. Home them at the canvas center so
    // the swirl physics orbits every free particle around ONE point, not
    // per-shape mini-hurricanes.
    const cx = this.width / 2;
    const cy = this.height / 2;
    for (; cursor < particleCount; cursor++) {
      const pi = indices[cursor];
      const p = this.particles[pi];
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
      p.hurricaneCenterX = cx;
      p.hurricaneCenterY = cy;
    }

    // ─── Runtime contract assert ───
    // Historical: two slicing bugs (f2a317d, f561856) silently dropped the
    // bottom half of shapes when a downstream consumer walked an ordered
    // prefix of scanline-emitted points. Upstream uniform-sampling (in
    // shapes.js rasterizeFromPaths with maxPoints) is the structural fix;
    // this is belt-and-suspenders that shouts if the invariant is violated
    // by any future code change.
    for (const shape of shapes) {
      const bp = shape.basePoints;
      if (bp.length < 100) continue;  // trivial shape, skip
      let inMinY = Infinity, inMaxY = -Infinity;
      for (const p of bp) {
        if (p.y < inMinY) inMinY = p.y;
        if (p.y > inMaxY) inMaxY = p.y;
      }
      const inRange = inMaxY - inMinY;
      if (inRange < 20) continue;  // shape too flat to meaningfully check

      // Check which base-point Y values the assigned particle slots will
      // visit (targets are set per-frame in _applyShapeRotation; we can't
      // read them here, but the slots walk basePoints[k % length] — same
      // shape, just offset in time).
      let outMinY = Infinity, outMaxY = -Infinity;
      const slots = shape.particleIndices.length;
      for (let k = 0; k < slots; k++) {
        const by = bp[k % bp.length].y;
        if (by < outMinY) outMinY = by;
        if (by > outMaxY) outMaxY = by;
      }
      const outRange = outMaxY - outMinY;
      if (outRange < inRange * 0.8) {
        console.warn(
          `[canvas] ⚠️  Shape "${shape.label}" sampling lost coverage:\n` +
          `  input Y-range = ${inRange.toFixed(1)}px, output Y-range = ${outRange.toFixed(1)}px ` +
          `(${(outRange/inRange*100).toFixed(0)}% coverage).\n` +
          `  This is the slicing-bug pattern. shapes.js rasterizeFromPaths must uniform-sample\n` +
          `  down to getShapeParticleBudget() before returning. Check that the SVG loader is\n` +
          `  passing maxPoints correctly. (points ${bp.length}, slots ${slots})`
        );
      }
    }
  }

  setInterimShape(shapePoints, label) {
    this.interimMode = true;
    this.setShape(shapePoints, label);
  }

  clearShape() {
    this.state = 'dissolving';
    this.currentShapes = [];
    this.interimMode = false;
    for (const p of this.particles) {
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
      p.hurricaneCenterX = null;
      p.hurricaneCenterY = null;
      p.vx += (Math.random() - 0.5) * 2;
      p.vy += (Math.random() - 0.5) * 2;
    }
    setTimeout(() => {
      if (this.state === 'dissolving') this.state = 'idle';
    }, 2000);
  }

  setThinking(isThinking) {
    // Kept for backward compat with app.js. Maps to states that drive
    // hurricaneIntensity through HURRICANE_TARGETS.
    if (isThinking && this.state !== 'forming' && this.state !== 'settled') {
      this.state = 'thinking';
    } else if (!isThinking && this.state === 'thinking') {
      this.state = 'idle';
    }
  }

  _animate(timestamp) {
    if (this.lastTimestamp !== null) {
      const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
      this.time += dt;
    }
    this.lastTimestamp = timestamp;

    // FPS monitoring
    this._frameCount++;
    if (timestamp - this._fpsCheckTime > 2000) {
      const fps = (this._frameCount / ((timestamp - this._fpsCheckTime) / 1000));
      if (fps < 24) {
        this._lowFpsCount++;
        if (this._lowFpsCount >= 3) {
          const reduction = Math.floor(this.particles.length * 0.15);
          this.particles.splice(this.particles.length - reduction, reduction);
          this._lowFpsCount = 0;
        }
      } else {
        this._lowFpsCount = 0;
      }
      this._frameCount = 0;
      this._fpsCheckTime = timestamp;
    }

    this._update();
    this._render();
    requestAnimationFrame(this._boundAnimate);
  }

  _update() {
    // Lerp hurricane intensity toward target for current state.
    const target = HURRICANE_TARGETS[this.state] != null
      ? HURRICANE_TARGETS[this.state]
      : HURRICANE_TARGETS['idle'];
    this.hurricaneIntensity += (target - this.hurricaneIntensity) * HURRICANE_LERP;

    // Rotate each shape's target positions. Done per-frame so shape
    // particles smoothly track the rotating silhouette via spring physics.
    this._applyShapeRotation();

    const cx = this.width / 2;
    const cy = this.height / 2;
    const springK = this.interimMode ? SPRING_K * 0.6 : SPRING_K;
    const springDamp = this.interimMode ? 0.92 : SPRING_DAMPING;
    const intensity = this.hurricaneIntensity;

    // Target hurricane radius. In the settled multi-shape carousel, the
    // ring needs to ENCOMPASS all the shapes — so it expands to
    // orbitRadius + shape bbox margin. In every other state, the default
    // tight ring (~120px, pulsing) is what we want.
    let baseRadius = 120;
    if (this.state === 'settled' && this.currentShapes.length > 1) {
      const firstOrbiting = this.currentShapes.find(s => s.orbitRadius > 0);
      if (firstOrbiting) {
        baseRadius = firstOrbiting.orbitRadius + firstOrbiting.bboxMax * 0.8;
      }
    }
    const targetRadius = baseRadius + Math.sin(this.time * 1.5) * 30;

    for (const p of this.particles) {
      // Subtle ambient brownian
      p.vx += (Math.random() - 0.5) * BROWNIAN * 0.2;
      p.vy += (Math.random() - 0.5) * BROWNIAN * 0.2;

      // ─── Cursor interaction (all states) ───
      if (this.mouseX !== null) {
        const mdx = p.x - this.mouseX;
        const mdy = p.y - this.mouseY;
        const mDist = Math.sqrt(mdx * mdx + mdy * mdy);

        if (mDist < CURSOR_RADIUS && mDist > 1) {
          const force = (CURSOR_RADIUS - mDist) / CURSOR_RADIUS;
          if (this.mouseDown) {
            p.vx -= (mdx / mDist) * force * CURSOR_ATTRACT_FORCE;
            p.vy -= (mdy / mDist) * force * CURSOR_ATTRACT_FORCE;
          } else {
            p.vx += (mdx / mDist) * force * force * CURSOR_REPEL_FORCE;
            p.vy += (mdy / mDist) * force * force * CURSOR_REPEL_FORCE;
          }
        }
      }

      // ─── Physics per particle class ───
      if (p.targetX !== null && p.targetY !== null) {
        // Shape particle — spring toward (possibly rotating) target.
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        p.vx += dx * springK;
        p.vy += dy * springK;
        p.vx *= springDamp;
        p.vy *= springDamp;

      } else {
        // Free particle — ambient hurricane. The swirl is always on;
        // intensity scales the force strength so we get everything from
        // gentle breeze (intensity 0.15) to full vortex (intensity 1.0)
        // with the same physics.
        const homeX = p.hurricaneCenterX != null ? p.hurricaneCenterX : cx;
        const homeY = p.hurricaneCenterY != null ? p.hurricaneCenterY : cy;
        const dx = p.x - homeX;
        const dy = p.y - homeY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        // Tangential force — inner particles orbit faster (hurricane eye)
        const speedMult = dist < 60 ? 2.0 : (dist < 150 ? 1.5 : 1.0);
        const swirlStrength = SWIRL_SPEED * intensity * speedMult;
        const modulation = 1 + Math.sin(this.time * 3 + p.phase) * 0.5;
        p.vx += Math.cos(angle + Math.PI / 2) * swirlStrength * modulation;
        p.vy += Math.sin(angle + Math.PI / 2) * swirlStrength * modulation;

        // Radial force — always pull toward target radius. Scaled by
        // intensity so idle breeze is loose, thinking vortex is tight.
        const radialError = dist - targetRadius;
        const radialForce = radialError * 0.002 * (0.3 + intensity * 0.7);
        p.vx -= (dx / (dist + 1)) * radialForce;
        p.vy -= (dy / (dist + 1)) * radialForce;

        // Extra gathering pull during gather state (distinct behavior
        // from the swirl — particles rush in before organizing).
        if (this.state === 'gathering') {
          const gx = p.x - cx;
          const gy = p.y - cy;
          const pulse = 1 + Math.sin(this.time * 3) * 0.3;
          p.vx -= gx * GATHER_PULL * pulse;
          p.vy -= gy * GATHER_PULL * pulse;
        }

        // Light brownian so the swirl stays coherent at high intensity.
        const browScale = 0.15 + (1 - intensity) * 0.3;
        p.vx += (Math.random() - 0.5) * BROWNIAN * browScale;
        p.vy += (Math.random() - 0.5) * BROWNIAN * browScale;

        // Tiny gravity so low-intensity breeze particles don't fly off.
        if (intensity < 0.3) {
          p.vy += GRAVITY * 0.1 * (1 - intensity / 0.3);
        }
      }

      // Apply velocity with friction
      p.vx *= FRICTION;
      p.vy *= FRICTION;
      p.x += p.vx;
      p.y += p.vy;

      // Boundary soft bounce
      if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx) * 0.5; }
      if (p.x > this.width) { p.x = this.width; p.vx = -Math.abs(p.vx) * 0.5; }
      if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy) * 0.5; }
      if (p.y > this.height) { p.y = this.height - 1; p.vy = -Math.abs(p.vy) * 0.3; }
    }
  }

  /**
   * Advance the shared carousel angle and translate each shape's particle
   * targets along its orbit. Shapes don't spin on their own centroids —
   * they travel around the canvas center like seats on a merry-go-round,
   * staying upright. Title particles (isTitle) don't move.
   *
   * Called once per frame.
   */
  _applyShapeRotation() {
    // Advance the carousel only in settled multi-shape state. During
    // 'forming' (streaming single shape) or 'title-idle', the shape
    // stays put.
    const inCarousel = this.state === 'settled' && this.currentShapes.length > 1;
    if (inCarousel) {
      this.carouselAngle += SHAPE_ROTATION_SPEED;
    }

    // During the 200ms crossfade scatter window, do NOT write targets.
    // setShape kicked all particles with a small velocity impulse so they
    // scatter; if we keep overwriting targetX/Y to the old shape's
    // basePoints here, the spring drags them straight back and the old
    // shape never actually disappears.
    if (this.state === 'transitioning') return;

    const canvasCx = this.width / 2;
    const canvasCy = this.height / 2;

    for (const shape of this.currentShapes) {
      if (shape.isTitle) {
        // Title particles: targets set once, never change.
        if (shape.particleIndices.length && this.particles[shape.particleIndices[0]].targetX == null) {
          for (let k = 0; k < shape.particleIndices.length; k++) {
            const pi = shape.particleIndices[k];
            const bp = shape.basePoints[k % shape.basePoints.length];
            this.particles[pi].targetX = bp.x + (Math.random() - 0.5) * 2;
            this.particles[pi].targetY = bp.y + (Math.random() - 0.5) * 2;
          }
        }
        continue;
      }

      let newCx = shape.centerX;
      let newCy = shape.centerY;

      if (inCarousel && shape.orbitRadius > 0) {
        // Travel around the canvas center at (orbitRadius, carouselAngle + orbitPhase).
        newCx = canvasCx + shape.orbitRadius * Math.cos(this.carouselAngle + shape.orbitPhase);
        newCy = canvasCy + shape.orbitRadius * Math.sin(this.carouselAngle + shape.orbitPhase);
      }

      const dx = newCx - shape.centerX;
      const dy = newCy - shape.centerY;
      shape.centerX = newCx;
      shape.centerY = newCy;

      // Translate every basePoint by (dx, dy) so the shape moves with its
      // center. Shapes stay upright — no spin around own centroid.
      if (dx !== 0 || dy !== 0) {
        for (const bp of shape.basePoints) {
          bp.x += dx;
          bp.y += dy;
        }
      }

      // Write targets: each particle tracks its assigned basePoint.
      for (let k = 0; k < shape.particleIndices.length; k++) {
        const pi = shape.particleIndices[k];
        const bp = shape.basePoints[k % shape.basePoints.length];
        // On the very first frame, seed the jitter; subsequent frames
        // just update position.
        if (this.particles[pi].targetX == null) {
          this.particles[pi].targetX = bp.x + (Math.random() - 0.5) * 3;
          this.particles[pi].targetY = bp.y + (Math.random() - 0.5) * 3;
        } else {
          this.particles[pi].targetX = bp.x;
          this.particles[pi].targetY = bp.y;
        }
      }
    }
  }

  _render() {
    const ctx = this.ctx;

    // Clear with motion blur trail
    ctx.fillStyle = BG_COLOR;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;

    for (const p of this.particles) {
      ctx.fillStyle = p.color;

      if (p.targetX !== null && p.isShapeParticle) {
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 5) {
          // Glow
          ctx.globalAlpha = this.interimMode ? 0.1 : 0.15;
          ctx.beginPath();
          ctx.arc(Math.round(p.x), Math.round(p.y), GLOW_SIZE, 0, Math.PI * 2);
          ctx.fill();
          // Main
          ctx.globalAlpha = this.interimMode ? 0.6 : 0.9;
          ctx.beginPath();
          ctx.arc(Math.round(p.x), Math.round(p.y), p.size * 0.8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.globalAlpha = 0.5 + Math.min(0.3, 10 / dist);
          ctx.beginPath();
          ctx.arc(Math.round(p.x), Math.round(p.y), p.size * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.globalAlpha = 0.3 + Math.sin(this.time + p.phase) * 0.12;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
    }

    ctx.globalAlpha = 1;

    // Per-shape labels. Skip title (its text IS the particles) and skip
    // early-forming shapes until they've settled visually (crossfade look).
    if ((this.state === 'forming' || this.state === 'settled') && this.currentShapes.length > 0) {
      this.transitionProgress = Math.min(1, this.transitionProgress + 0.008);
      if (this.transitionProgress > 0.5) {
        const alpha = (this.transitionProgress - 0.5) * 0.3;
        ctx.fillStyle = `rgba(200, 180, 160, ${this.interimMode ? alpha * 0.5 : alpha})`;
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';

        if (this.currentShapes.length === 1 && !this.currentShapes[0].isTitle) {
          // Single shape: label at the bottom of canvas.
          ctx.fillText(this.currentShapes[0].label, this.width / 2, this.height - 30);
        } else if (this.currentShapes.length > 1) {
          // Multi-shape carousel: label under each shape's centroid.
          // centerX/centerY update every frame in _applyShapeRotation, so
          // the label travels with the shape around the orbit.
          for (const shape of this.currentShapes) {
            if (shape.isTitle) continue;
            const labelY = Math.min(
              shape.centerY + shape.bboxMax / 2 + 20,
              this.height - 12
            );
            ctx.fillText(shape.label, shape.centerX, labelY);
          }
        }
      }
    }
  }

  destroy() {
    window.removeEventListener('resize', this._boundResize);
  }
}
