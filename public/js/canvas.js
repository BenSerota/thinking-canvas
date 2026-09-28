/**
 * Thinking Canvas — Particle Simulation Engine
 *
 * Renders thousands of sand-grain particles on a 2D canvas. Particles can:
 *   - drift ambient (title particles held in place, free particles breeze)
 *   - form the title "Thinking Canvas" on page load
 *   - gather into a hurricane vortex while the LLM is reasoning
 *   - coalesce into one or more target shapes and ride a carousel
 *   - dissolve back into the hurricane on a new turn
 *
 * Hurricane is continuous, not a state. Its intensity is a lerped [0,1]
 * float that ramps up on user activity and dims (but never fully stops)
 * when shapes are settled. This gives the canvas a living feel at all
 * times — the ring never blinks on/off.
 *
 * Layout is recomputed from the recorded inputs whenever the panel
 * changes size (ResizeObserver), so shapes never keep stale pixel
 * coordinates, and a panel that measured 0×0 at startup lays out as soon
 * as it has a real size.
 *
 * States: title-idle → gathering → thinking → forming → transitioning →
 *         settled → dissolving → idle
 */

const PARTICLE_COUNT = 8000;
// The adaptive governor never trims below this many active particles.
const MIN_ACTIVE_PARTICLES = 2000;
const SAND_COLORS = ['#D4A574', '#C4956A', '#E8C9A0', '#B8845A', '#DEB887', '#C9A882'];
const EDGE_COLORS = ['#F0D8B0', '#EED5A8', '#F5E0BE', '#E8D0A0'];
const INTERIOR_COLORS = ['#A07050', '#8C6545', '#977055', '#B08060'];
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
  'title-idle':    0.15,  // gentle breeze, title particles locked
  'gathering':     0.6,
  'thinking':      1.0,   // full hurricane
  'forming':       0.35,  // orbiting around the shape(s)
  'transitioning': 0.35,  // 130 ms crossfade scatter between streamed shapes
  'settled':       0.35,  // same — shape(s) ride the carousel, free particles orbit
  'dissolving':    0.5,   // bit of chaos as shapes come apart
  'idle':          0.15,
};
// Exponential-lerp rate per frame. ~0.04 → 25 frames to settle (~0.4s at 60fps).
const HURRICANE_LERP = 0.04;

// Shape rotation speed, radians per frame. 0.005 rad/frame × 60fps = 0.3 rad/s
// → ~21s per full revolution. Slow enough to read the silhouette clearly.
const SHAPE_ROTATION_SPEED = 0.005;

// Motion-blur trail: fraction of the previous frame cleared per 60 fps frame.
const TRAIL_CLEAR = 0.35;
// Offscreen disc sprite (one per palette color) drawn scaled per particle —
// far cheaper than a beginPath/arc/fill per particle.
const SPRITE_SIZE = 32;
const SPRITE_DISC_RADIUS = SPRITE_SIZE / 2 - 1;

// Cursor interaction constants
const CURSOR_RADIUS = 80;
const CURSOR_REPEL_FORCE = 3.0;
const CURSOR_ATTRACT_FORCE = 2.0;

// Below this the panel hasn't been laid out yet (flex not settled, hidden
// tab). Layout requests are recorded and replayed once it has a real size.
const MIN_LAYOUT_SIZE = 50;
const RELAYOUT_DEBOUNCE_MS = 150;
const CROSSFADE_SCATTER_MS = 130;

/**
 * Particle budget for shape points. Exported so shapes.js /
 * loadExternalShape can pass it as `maxPoints` and uniform-sample the
 * rasterizer output to fit. Fixed at the full particle count on purpose —
 * the runtime clamp in _assignShapeToParticles tracks activeParticleCount.
 */
export function getShapeParticleBudget() {
  return Math.floor(PARTICLE_COUNT * SHAPE_PARTICLE_RATIO);
}

export class ThinkingCanvas {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.particles = [];
    // Particles beyond this index are parked: not simulated, not drawn.
    this.activeParticleCount = PARTICLE_COUNT;
    this.state = 'title-idle';
    /** Optional callback fired on every state change: (state) => void */
    this.onStateChange = null;

    /** @type {Array<{label, centerX, centerY, basePoints, particleIndices, bboxMax, isTitle, orbitRadius, orbitPhase}>} */
    this.currentShapes = [];
    this.thinkingTitle = null;
    // Single shared angle for the multi-shape carousel. All shapes ride
    // the same virtual ring and share this angle (plus their orbitPhase).
    // Shapes stay upright — they don't spin on their own centroids, they
    // travel around the canvas center like seats on a carousel.
    this.carouselAngle = 0;
    this.transitionProgress = 0;

    // Hurricane intensity in [0, 1]. Drives swirl strength. Lerps toward
    // the target for the current state.
    this.hurricaneIntensity = HURRICANE_TARGETS['title-idle'];

    this.time = 0;
    this.lastTimestamp = null;

    // Per-frame timing factors. Every force, impulse and per-frame rate is
    // tuned for 60 fps; dtF scales them so 120 Hz displays and throttled
    // tabs play at the same real-time speed. Initialised to their dtF = 1
    // values because _update/_render already run on the very first frame,
    // before any dt exists.
    this._dt = 1 / 60;
    this._dtF = 1;
    this._frictionF = FRICTION;
    this._springDampF = SPRING_DAMPING;
    this._hurricaneLerpF = HURRICANE_LERP;
    this._trailClearF = TRAIL_CLEAR;

    this._sprites = new Map();

    // Layout replay. `_layout` records the main content ({kind, args});
    // the thinking title is an overlay recorded separately because it
    // coexists with a streamed shape.
    this._layout = null;
    this._thinkingTitleArgs = null;
    this._layoutSize = null;
    this._layoutApplied = false;
    this._replaying = false;
    this._sizeReady = false;
    this._crossfadeTimer = null;
    this._relayoutTimer = null;

    // Cursor tracking
    this.mouseX = null;
    this.mouseY = null;
    this.mouseDown = false;

    // FPS governor
    this._frameCount = 0;
    this._fpsCheckTime = null;
    this._lowFpsCount = 0;
    this._highFpsCount = 0;

    this._resize();
    this._initParticles();
    this._boundAnimate = this._animate.bind(this);
    this._observeSize();

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

    // A hidden tab throttles rAF to ~1 fps; that must never read as a slow
    // machine. Restart the measurement window whenever visibility changes.
    this._boundVisibility = () => this._resetFpsWindow();
    document.addEventListener('visibilitychange', this._boundVisibility);

    this._rafId = requestAnimationFrame(this._boundAnimate);
  }

  // ─── Sizing and layout replay ───

  _observeSize() {
    const onChange = () => {
      this._resize();
      clearTimeout(this._relayoutTimer);
      this._relayoutTimer = setTimeout(() => this._relayoutAll(), RELAYOUT_DEBOUNCE_MS);
    };
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(onChange);
      this._resizeObserver.observe(this.canvas.parentElement);
    } else {
      this._boundResize = onChange;
      window.addEventListener('resize', onChange);
    }
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this._sizeReady = this.width >= MIN_LAYOUT_SIZE && this.height >= MIN_LAYOUT_SIZE;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * dpr));
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Remember the size the current layout was computed for. */
  _recordLayoutSize() {
    this._layoutSize = { w: this.width, h: this.height };
    this._layoutApplied = this._sizeReady;
  }

  /**
   * Re-run the recorded layout against the current panel size. The thinking
   * title (overlay) replays first because a streamed shape reserves its
   * particles. A layout that was actually shown replays with its handwriting
   * reveal already complete; one that was skipped at zero size plays fresh.
   */
  _relayoutAll() {
    if (!this._sizeReady) return;
    if (this._layoutSize && this._layoutSize.w === this.width && this._layoutSize.h === this.height) return;
    const main = this._layout;
    const titleArgs = this._thinkingTitleArgs;
    if (!main && !titleArgs) {
      this._recordLayoutSize();
      return;
    }
    this._replaying = this._layoutApplied ? 'complete' : 'fresh';
    try {
      if (titleArgs) this.setThinkingTitle(titleArgs);
      if (main) {
        const a = main.args;
        if (main.kind === 'title') this.setTitle(a[0], a[1]);
        else if (main.kind === 'shape') this.setShape(a[0], a[1], 'instant', a[2]);
        else if (main.kind === 'shapes') this.setShapes(a[0]);
      }
    } finally {
      this._replaying = false;
    }
  }

  _clearCrossfade() {
    if (this._crossfadeTimer) {
      clearTimeout(this._crossfadeTimer);
      this._crossfadeTimer = null;
    }
  }

  _initParticles() {
    this.particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const c = SAND_COLORS[Math.floor(Math.random() * SAND_COLORS.length)];
      this.particles.push({
        x: Math.random() * (this.width || 800),
        y: Math.random() * (this.height || 600),
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        targetX: null,
        targetY: null,
        color: c,
        baseColor: c,
        size: PARTICLE_SIZE + (Math.random() - 0.5) * 0.8,
        phase: Math.random() * Math.PI * 2,
        isShapeParticle: false,
      });
    }
  }

  // ─── State ───

  _setStateDirect(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (typeof this.onStateChange === 'function') this.onStateChange(newState);
  }

  setState(newState) {
    if (this.state === newState) return;
    // 'thinking' is a refinement of 'gathering' only. Text and concept events
    // keep arriving after shapes have landed (forming/transitioning/settled)
    // and must not tear them down or re-target particles mid-crossfade.
    if (newState === 'thinking' && this.state !== 'gathering') {
      return;
    }
    this._setStateDirect(newState);
    if (newState === 'gathering') {
      // New turn: release every particle (including title particles) into
      // the hurricane and forget the previous layout.
      this._clearCrossfade();
      for (const p of this.particles) {
        p.targetX = null;
        p.targetY = null;
        p.isShapeParticle = false;
        p.color = p.baseColor;
      }
      this.currentShapes = [];
      this.thinkingTitle = null;
      this._thinkingTitleArgs = null;
      this._layout = null;
    }
  }

  // ─── Titles ───

  /**
   * Show "I'm thinking about..." as particle text above the hurricane.
   * Displayed during thinking/streaming; cleared when the carousel forms or
   * the turn settles without shapes.
   */
  setThinkingTitle(textPoints) {
    if (!textPoints || textPoints.length === 0) return;
    this._thinkingTitleArgs = textPoints;
    this._layout = null;
    this._recordLayoutSize();
    if (!this._sizeReady) return;

    const aspectRatio = textPoints.aspectRatio || 6;
    const titleWidth = Math.min(this.width * 0.80, this.height * aspectRatio * 0.17);
    const titleHeight = titleWidth / aspectRatio;
    const centerX = this.width / 2;
    const centerY = this.height * 0.14;
    const offsetX = centerX - titleWidth / 2;
    const offsetY = centerY - titleHeight / 2;

    const basePoints = textPoints.map(p => {
      const bx = offsetX + p.x * titleWidth;
      const by = offsetY + p.y * titleHeight;
      const bp = { x: bx, y: by, edge: p.edge ?? false };
      if (p.seep) {
        // Seep metadata: the ellipsis trail is static dots; particles
        // cycle through a per-particle phase (see `_applyShapeRotation`).
        // `seepDotIndex` drives the left-to-right activation stagger.
        bp.seep = true;
        bp.seepHomeX = bx;
        bp.seepHomeY = by;
        bp.seepPhaseInit = p.seepPhaseInit ?? Math.random();
        bp.seepDotIndex = p.seepDotIndex ?? 0;
      }
      return bp;
    });

    // Exclude seep basepoints from the reveal range — the ellipsis should
    // only start appearing *after* the main phrase is fully written, not
    // sweep in alongside it.
    let bpMinX = Infinity, bpMaxX = -Infinity;
    for (const bp of basePoints) {
      if (bp.seep) continue;
      if (bp.x < bpMinX) bpMinX = bp.x;
      if (bp.x > bpMaxX) bpMaxX = bp.x;
    }

    const shape = {
      label: '',
      centerX,
      centerY,
      isTitle: true,
      bboxMax: titleWidth,
      orbitRadius: 0,
      orbitPhase: 0,
      basePoints,
      hasSeep: basePoints.some(bp => bp.seep),
      particleIndices: [],
      writeReveal: {
        time: 0,
        duration: 2.0,
        minX: bpMinX,
        maxX: bpMaxX,
      },
    };
    if (this._replaying === 'complete') shape.writeReveal.time = shape.writeReveal.duration;

    this._assignShapeToParticles([shape]);
    this.currentShapes = [shape];
    this.thinkingTitle = shape;
  }

  clearThinkingTitle() {
    this._thinkingTitleArgs = null;
    if (!this.thinkingTitle) return;
    const shape = this.thinkingTitle;
    for (const pi of shape.particleIndices) {
      const p = this.particles[pi];
      if (!p) continue;
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
      p.color = p.baseColor;
    }
    this.currentShapes = this.currentShapes.filter(s => s !== shape);
    this.thinkingTitle = null;
  }

  /**
   * Set the page-load title particles. Single-shape, centered near the top,
   * static (not rotating). Called once by app.js on init.
   */
  setTitle(textPoints, label = 'Thinking Canvas') {
    if (!textPoints || textPoints.length === 0) return;
    this._layout = { kind: 'title', args: [textPoints, label] };
    this._thinkingTitleArgs = null;
    this._recordLayoutSize();
    this._setStateDirect('title-idle');
    this.transitionProgress = 0;
    if (!this._sizeReady) {
      this.currentShapes = [];
      return;
    }

    const aspectRatio = textPoints.aspectRatio || 4;
    const titleWidth = Math.min(this.width * 0.82, this.height * aspectRatio * 0.22);
    const titleHeight = titleWidth / aspectRatio;
    const centerX = this.width / 2;
    const centerY = this.height * 0.18;
    const offsetX = centerX - titleWidth / 2;
    const offsetY = centerY - titleHeight / 2;

    const basePoints = textPoints.map(p => ({
      x: offsetX + p.x * titleWidth,
      y: offsetY + p.y * titleHeight,
      edge: p.edge ?? false,
    }));

    let bpMinX = Infinity, bpMaxX = -Infinity;
    for (const bp of basePoints) {
      if (bp.x < bpMinX) bpMinX = bp.x;
      if (bp.x > bpMaxX) bpMaxX = bp.x;
    }

    const shape = {
      label,
      centerX,
      centerY,
      isTitle: true,
      bboxMax: titleWidth,
      orbitRadius: 0,
      orbitPhase: 0,
      basePoints,
      hasSeep: false,
      particleIndices: [],
      writeReveal: {
        time: 0,
        duration: 2.5,
        minX: bpMinX,
        maxX: bpMaxX,
      },
    };
    if (this._replaying === 'complete') shape.writeReveal.time = shape.writeReveal.duration;

    this._assignShapeToParticles([shape]);
    this.currentShapes = [shape];
  }

  // ─── Shapes ───

  /**
   * Set a single shape centered on the canvas. Used during streaming
   * (crossfade behavior) before all shapes for a turn have arrived.
   */
  setShape(shapePoints, label, transition = 'instant', animationOpts = null) {
    if (!shapePoints || shapePoints.length === 0) {
      this.clearShape();
      return;
    }
    this._layout = { kind: 'shape', args: [shapePoints, label, animationOpts] };
    this._recordLayoutSize();
    this._clearCrossfade();
    if (!this._sizeReady) return;

    const doAssign = () => {
      const singleShape = this._buildShape(shapePoints, label, this.width / 2, this.height / 2, 1.0);
      if (animationOpts) {
        this._attachAnimation(singleShape, animationOpts, this.width / 2, this.height / 2, 1.0);
      }
      if (this.thinkingTitle) {
        const reserved = new Set(this.thinkingTitle.particleIndices);
        this._assignShapeToParticles([singleShape], reserved);
        this.currentShapes = [this.thinkingTitle, singleShape];
      } else {
        this._assignShapeToParticles([singleShape]);
        this.currentShapes = [singleShape];
      }
      this._setStateDirect('forming');
      this.transitionProgress = 1;
    };

    if (transition === 'crossfade' && this.state === 'forming') {
      this._setStateDirect('transitioning');
      // Collect thinking title particle indices so we don't scatter them.
      const titlePIs = this.thinkingTitle
        ? new Set(this.thinkingTitle.particleIndices)
        : null;
      for (let i = 0; i < this.activeParticleCount; i++) {
        const p = this.particles[i];
        if (p.targetX !== null && (!titlePIs || !titlePIs.has(i))) {
          p.vx += (Math.random() - 0.5) * 4;
          p.vy += (Math.random() - 0.5) * 4;
          p.targetX = null;
          p.targetY = null;
          p.isShapeParticle = false;
          p.color = p.baseColor;
        }
      }
      this._crossfadeTimer = setTimeout(() => {
        this._crossfadeTimer = null;
        doAssign();
      }, CROSSFADE_SCATTER_MS);
    } else {
      doAssign();
    }
  }

  /**
   * Arrange N shapes on a circular carousel around the canvas center and
   * rotate them all together (each shape stays upright, doesn't spin on
   * its own centroid). One hurricane ring encompasses the whole group.
   * Used once all shapes for a turn have arrived.
   */
  setShapes(shapesPointsAndLabels) {
    this.thinkingTitle = null;
    this._thinkingTitleArgs = null;
    const n = shapesPointsAndLabels.length;
    if (n === 0) return this.clearShape();
    if (n === 1) {
      const only = shapesPointsAndLabels[0];
      return this.setShape(only.points, only.label, 'instant', only.animation || null);
    }
    this._layout = { kind: 'shapes', args: [shapesPointsAndLabels] };
    this._recordLayoutSize();
    this._clearCrossfade();
    if (!this._sizeReady) return;

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
      const { points, label, animation } = shapesPointsAndLabels[i];
      // centerX/centerY will be updated every frame in _applyShapeRotation;
      // seed them at the t=0 position so the very first frame doesn't see
      // stale values.
      const cx = this.width / 2 + orbitRadius * Math.cos(phases[i]);
      const cy = this.height / 2 + orbitRadius * Math.sin(phases[i]);
      const shape = this._buildShape(points, label, cx, cy, perShapeScale);
      if (animation) {
        this._attachAnimation(shape, animation, cx, cy, perShapeScale);
      }
      shape.orbitRadius = orbitRadius;
      shape.orbitPhase = phases[i];
      shapes.push(shape);
    }

    this._assignShapeToParticles(shapes);
    this.currentShapes = shapes;
    this._setStateDirect('settled');  // skip 'forming' — multi-shape view is the settled state
    // Jump transitionProgress past the 0.5 gate so labels appear
    // immediately (no streaming fade-in for the carousel transition —
    // viewer has already seen each shape in the preceding crossfade).
    this.transitionProgress = 0.9;
  }

  /** Full-canvas scale for a shape; clamped so a tiny panel never goes negative. */
  _fullScale() {
    const margin = 60;
    return Math.max(1, Math.min(this.width - margin * 2, this.height - margin * 2) * 0.7);
  }

  /**
   * Build a shape-descriptor with its centroid, per-shape scale, and base
   * (unrotated) particle positions. Doesn't touch particles yet — that's
   * _assignShapeToParticles's job.
   */
  _buildShape(shapePoints, label, centerX, centerY, scaleFactor) {
    const scale = this._fullScale() * scaleFactor;

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
      edge: p.edge ?? false,
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
      hasSeep: false,
      particleIndices: [],
      // Animation fields (null = static shape)
      animationFrames: null,
      animationDuration: 0,
      animationTime: 0,
      currentFrameIdx: 0,
    };
  }

  /**
   * Pre-compute all animation frames in canvas-space and attach them to a
   * shape descriptor. Each frame is transformed identically to how _buildShape
   * transforms basePoints, so frame-swaps are spatially consistent.
   */
  _attachAnimation(shape, animOpts, centerX, centerY, scaleFactor) {
    if (!animOpts || !animOpts.frames || animOpts.frames.length < 2) return;

    const scale = this._fullScale() * scaleFactor;

    // Compute a global bbox across ALL frames for consistent centering
    let gMinX = 1, gMaxX = 0, gMinY = 1, gMaxY = 0;
    for (const frame of animOpts.frames) {
      for (const p of frame) {
        if (p.x < gMinX) gMinX = p.x;
        if (p.x > gMaxX) gMaxX = p.x;
        if (p.y < gMinY) gMinY = p.y;
        if (p.y > gMaxY) gMaxY = p.y;
      }
    }
    const gcx = (gMinX + gMaxX) / 2;
    const gcy = (gMinY + gMaxY) / 2;

    // Canvas-space frames are cached on the descriptor per placement, so a
    // crossfade tick that re-sets the same shape doesn't re-map 24 frames.
    const cacheKey = `${centerX}|${centerY}|${scale}`;
    if (!animOpts._frameCache || animOpts._frameCache.key !== cacheKey) {
      animOpts._frameCache = {
        key: cacheKey,
        frames: animOpts.frames.map(frame =>
          frame.map(p => ({
            x: centerX + (p.x - gcx) * scale,
            y: centerY + (p.y - gcy) * scale,
            edge: p.edge ?? false,
            hidden: p.hidden === true,
          }))
        ),
      };
    }
    shape.animationFrames = animOpts._frameCache.frames;
    const frameCount = animOpts.frames.length;
    shape.animationDuration = animOpts.duration > 0
      ? animOpts.duration
      : frameCount / Math.min(animOpts.fps || 5, 5);
    shape.animationTime = 0;
    shape.currentFrameIdx = 0;
    shape.animationOriginX = centerX;
    shape.animationOriginY = centerY;
    shape.staticPointCount = animOpts.staticCount || 0;

    // Sync initial basePoints with animation frame 0 so both use the same
    // global-bbox transform. _buildShape uses frame-0-only bbox centering,
    // which differs when dynamic elements (electrons) extend the global bbox
    // in other frames. Without this, static particles sit at _buildShape
    // positions while dynamic particles jump to _attachAnimation positions.
    shape.basePoints = shape.animationFrames[0].map(p => ({ x: p.x, y: p.y, edge: p.edge ?? false, hidden: p.hidden === true }));
  }

  /**
   * Partition the particle budget across the given shapes and assign each
   * shape a contiguous slice of particle indices. Free particles (those
   * not claimed by any shape) go back to the hurricane, which always
   * orbits the live canvas center.
   *
   * Everything derives from activeParticleCount — the budget, the index
   * pool and the free-particle loop — so a governor downscale can never
   * hand out more slots than there are active particles.
   *
   * Runtime contract check: verify the output Y-range covers the input
   * Y-range. If not, a downstream slicing bug has regressed.
   */
  _assignShapeToParticles(shapes, reservedIndices = null) {
    const particleCount = this.activeParticleCount;

    const budget = Math.min(
      shapes.reduce((sum, s) => sum + s.basePoints.length, 0),
      Math.floor(particleCount * SHAPE_PARTICLE_RATIO)
    );

    const perShapeBudget = shapes.map(s => {
      const idealShare = Math.floor(budget / shapes.length);
      return Math.min(s.basePoints.length, idealShare);
    });

    // Build pool of available indices, excluding any reserved by a
    // persistent shape (e.g. the thinking title during streaming).
    const indices = [];
    for (let i = 0; i < particleCount; i++) {
      if (reservedIndices && reservedIndices.has(i)) continue;
      indices.push(i);
    }
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    // First totalShapeSlots indices become shape particles.
    let cursor = 0;
    for (let s = 0; s < shapes.length; s++) {
      const shape = shapes[s];
      shape.particleIndices = [];
      const slots = Math.min(perShapeBudget[s], indices.length - cursor);
      for (let k = 0; k < slots; k++) {
        const pi = indices[cursor++];
        shape.particleIndices.push(pi);
        // Note: we DON'T set targetX/targetY here — that happens per-frame
        // in _applyShapeRotation so rotation is smooth.
        this.particles[pi].isShapeParticle = true;
      }
    }

    // Remaining particles are free — they form the single encompassing
    // hurricane around the whole group.
    for (; cursor < indices.length; cursor++) {
      const p = this.particles[indices[cursor]];
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
      p.color = p.baseColor;
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

      // Mirror the stride mapping _applyShapeRotation uses so the assert
      // reflects the actual sampled indices.
      let outMinY = Infinity, outMaxY = -Infinity;
      const slots = shape.particleIndices.length;
      const strideAssert = slots > 0 && slots < bp.length ? (bp.length / slots) : 0;
      for (let k = 0; k < slots; k++) {
        const idx = strideAssert > 0 ? Math.floor(k * strideAssert) : (k % bp.length);
        const by = bp[idx].y;
        if (by < outMinY) outMinY = by;
        if (by > outMaxY) outMaxY = by;
      }
      const outRange = outMaxY - outMinY;
      if (slots > 0 && outRange < inRange * 0.8) {
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

  clearShape() {
    this._clearCrossfade();
    this._setStateDirect('dissolving');
    this.currentShapes = [];
    this.thinkingTitle = null;
    this._thinkingTitleArgs = null;
    this._layout = null;
    for (const p of this.particles) {
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
      p.color = p.baseColor;
      p.vx += (Math.random() - 0.5) * 2;
      p.vy += (Math.random() - 0.5) * 2;
    }
    setTimeout(() => {
      if (this.state === 'dissolving') this._setStateDirect('idle');
    }, 2000);
  }

  // ─── Frame loop ───

  _animate(timestamp) {
    this._rafId = requestAnimationFrame(this._boundAnimate);

    if (this.lastTimestamp !== null) {
      const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
      this.time += dt;
      const dtF = Math.min(dt * 60, 3);
      this._dt = dt;
      this._dtF = dtF;
      this._frictionF = Math.pow(FRICTION, dtF);
      this._springDampF = Math.pow(SPRING_DAMPING, dtF);
      this._hurricaneLerpF = 1 - Math.pow(1 - HURRICANE_LERP, dtF);
      this._trailClearF = 1 - Math.pow(1 - TRAIL_CLEAR, dtF);
    }
    this.lastTimestamp = timestamp;

    this._sampleFps(timestamp);
    this._update();
    this._render();
  }

  /**
   * Adaptive particle count. Sustained < 24 fps trims the active count by
   * 15 %; sustained > 50 fps grows it back by 10 % up to PARTICLE_COUNT.
   * Nothing is ever destroyed, and frames from a hidden tab are ignored
   * (rAF throttles there — it says nothing about the machine).
   */
  _sampleFps(timestamp) {
    if (document.visibilityState !== 'visible') {
      this._resetFpsWindow();
      return;
    }
    if (this._fpsCheckTime === null) {
      this._fpsCheckTime = timestamp;
      this._frameCount = 0;
      return;
    }
    this._frameCount++;
    const elapsed = timestamp - this._fpsCheckTime;
    if (elapsed < 2000) return;

    const fps = this._frameCount / (elapsed / 1000);
    if (fps < 24) {
      this._lowFpsCount++;
      this._highFpsCount = 0;
      if (this._lowFpsCount >= 3) {
        this._setActiveParticleCount(Math.floor(this.activeParticleCount * 0.85));
        this._lowFpsCount = 0;
      }
    } else if (fps > 50 && this.activeParticleCount < PARTICLE_COUNT) {
      this._highFpsCount++;
      this._lowFpsCount = 0;
      if (this._highFpsCount >= 3) {
        this._setActiveParticleCount(Math.ceil(this.activeParticleCount * 1.1));
        this._highFpsCount = 0;
      }
    } else {
      this._lowFpsCount = 0;
      this._highFpsCount = 0;
    }
    this._frameCount = 0;
    this._fpsCheckTime = timestamp;
  }

  _resetFpsWindow() {
    this._frameCount = 0;
    this._fpsCheckTime = null;
    this._lowFpsCount = 0;
    this._highFpsCount = 0;
  }

  _setActiveParticleCount(count) {
    const next = Math.max(MIN_ACTIVE_PARTICLES, Math.min(PARTICLE_COUNT, count));
    if (next === this.activeParticleCount) return;
    console.log(`[canvas] active particles ${this.activeParticleCount} → ${next}`);
    this.activeParticleCount = next;
    for (let i = next; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
      p.color = p.baseColor;
    }
    // Re-slice every shape (the thinking title included — it lives in
    // currentShapes) across the new active range. No reservations: reserved
    // indices never reach the free-particle cleanup and would linger as a
    // frozen ghost of the old title.
    if (this.currentShapes.length > 0) this._assignShapeToParticles(this.currentShapes);
  }

  _update() {
    // Lerp hurricane intensity toward target for current state.
    const target = HURRICANE_TARGETS[this.state] != null
      ? HURRICANE_TARGETS[this.state]
      : HURRICANE_TARGETS['idle'];
    this.hurricaneIntensity += (target - this.hurricaneIntensity) * this._hurricaneLerpF;

    // Rotate each shape's target positions. Done per-frame so shape
    // particles smoothly track the rotating silhouette via spring physics.
    this._applyShapeRotation();

    const cx = this.width / 2;
    const cy = this.height / 2;
    const dtF = this._dtF;
    const springK = SPRING_K * dtF;
    const springDamp = this._springDampF;
    const frictionF = this._frictionF;
    const intensity = this.hurricaneIntensity;

    // Target hurricane radius. The ring must ENCOMPASS whatever shapes
    // are on screen — it should never overlap or cut through them. The
    // thinking title is an overlay and doesn't count as a shape here.
    let baseRadius = 120;
    if (this.state === 'forming' || this.state === 'settled' || this.state === 'transitioning') {
      const shapes = this.currentShapes.filter(s => !s.isTitle);
      if (shapes.length === 1) {
        // Single shape: push the ring outside the shape's bounding box
        baseRadius = shapes[0].bboxMax * 0.6 + 50;
      } else if (shapes.length > 1) {
        const firstOrbiting = shapes.find(s => s.orbitRadius > 0);
        if (firstOrbiting) {
          baseRadius = firstOrbiting.orbitRadius + firstOrbiting.bboxMax * 0.8;
        }
      }
    }
    const targetRadius = baseRadius + Math.sin(this.time * 1.5) * 30;

    for (let i = 0; i < this.activeParticleCount; i++) {
      const p = this.particles[i];
      // Subtle ambient brownian
      p.vx += (Math.random() - 0.5) * BROWNIAN * 0.2 * dtF;
      p.vy += (Math.random() - 0.5) * BROWNIAN * 0.2 * dtF;

      // ─── Cursor interaction (all states) ───
      if (this.mouseX !== null) {
        const mdx = p.x - this.mouseX;
        const mdy = p.y - this.mouseY;
        const mDist = Math.sqrt(mdx * mdx + mdy * mdy);

        if (mDist < CURSOR_RADIUS && mDist > 1) {
          const force = (CURSOR_RADIUS - mDist) / CURSOR_RADIUS * dtF;
          if (this.mouseDown) {
            p.vx += (mdx / mDist) * force * force * CURSOR_REPEL_FORCE;
            p.vy += (mdy / mDist) * force * force * CURSOR_REPEL_FORCE;
          } else {
            p.vx -= (mdx / mDist) * force * CURSOR_ATTRACT_FORCE;
            p.vy -= (mdy / mDist) * force * CURSOR_ATTRACT_FORCE;
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
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        // Tangential force — inner particles orbit faster (hurricane eye)
        const speedMult = dist < 60 ? 2.0 : (dist < 150 ? 1.5 : 1.0);
        const swirlStrength = SWIRL_SPEED * intensity * speedMult * dtF;
        const modulation = 1 + Math.sin(this.time * 3 + p.phase) * 0.5;
        p.vx += Math.cos(angle + Math.PI / 2) * swirlStrength * modulation;
        p.vy += Math.sin(angle + Math.PI / 2) * swirlStrength * modulation;

        // Radial force — always pull toward target radius. Scaled by
        // intensity so idle breeze is loose, thinking vortex is tight.
        const radialError = dist - targetRadius;
        const radialForce = radialError * 0.002 * (0.3 + intensity * 0.7) * dtF;
        p.vx -= (dx / (dist + 1)) * radialForce;
        p.vy -= (dy / (dist + 1)) * radialForce;

        // Extra gathering pull during gather state (distinct behavior
        // from the swirl — particles rush in before organizing).
        if (this.state === 'gathering') {
          const pulse = (1 + Math.sin(this.time * 3) * 0.3) * dtF;
          p.vx -= dx * GATHER_PULL * pulse;
          p.vy -= dy * GATHER_PULL * pulse;
        }

        // Light brownian so the swirl stays coherent at high intensity.
        const browScale = (0.15 + (1 - intensity) * 0.3) * dtF;
        p.vx += (Math.random() - 0.5) * BROWNIAN * browScale;
        p.vy += (Math.random() - 0.5) * BROWNIAN * browScale;

        // Tiny gravity so low-intensity breeze particles don't fly off.
        if (intensity < 0.3) {
          p.vy += GRAVITY * 0.1 * (1 - intensity / 0.3) * dtF;
        }
      }

      // Apply velocity with friction
      p.vx *= frictionF;
      p.vy *= frictionF;
      p.x += p.vx * dtF;
      p.y += p.vy * dtF;

      // Boundary soft bounce
      if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx) * 0.5; }
      if (p.x > this.width) { p.x = this.width - 1; p.vx = -Math.abs(p.vx) * 0.5; }
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
      this.carouselAngle += SHAPE_ROTATION_SPEED * this._dtF;
    }

    // During the crossfade scatter window, do NOT write targets.
    // setShape kicked all particles with a small velocity impulse so they
    // scatter; if we keep overwriting targetX/Y to the old shape's
    // basePoints here, the spring drags them straight back and the old
    // shape never actually disappears.
    if (this.state === 'transitioning') return;

    const canvasCx = this.width / 2;
    const canvasCy = this.height / 2;

    for (const shape of this.currentShapes) {
      // Non-title shapes: orbit movement + animation frame cycling.
      // Titles skip this block but share the writeReveal + target-setting
      // code below.
      if (!shape.isTitle) {
        let newCx = shape.centerX;
        let newCy = shape.centerY;

        if (inCarousel && shape.orbitRadius > 0) {
          newCx = canvasCx + shape.orbitRadius * Math.cos(this.carouselAngle + shape.orbitPhase);
          newCy = canvasCy + shape.orbitRadius * Math.sin(this.carouselAngle + shape.orbitPhase);
        }

        const dx = newCx - shape.centerX;
        const dy = newCy - shape.centerY;
        shape.centerX = newCx;
        shape.centerY = newCy;

        if (dx !== 0 || dy !== 0) {
          for (const bp of shape.basePoints) {
            bp.x += dx;
            bp.y += dy;
          }
        }

        if (shape.animationFrames && shape.animationFrames.length > 1) {
          // Frame index follows the authored duration in real time, so a
          // 2 s heartbeat and a 3 s helix each play at their own pace.
          shape.animationTime += this._dt;
          const dur = shape.animationDuration;
          const newIdx = Math.floor(((shape.animationTime % dur) / dur) * shape.animationFrames.length);
          if (newIdx !== shape.currentFrameIdx) {
            shape.currentFrameIdx = newIdx;
            const ox = shape.centerX - (shape.animationOriginX || shape.centerX);
            const oy = shape.centerY - (shape.animationOriginY || shape.centerY);
            const newFrame = shape.animationFrames[newIdx];
            const sc = shape.staticPointCount || 0;
            for (let i = sc; i < shape.basePoints.length && i < newFrame.length; i++) {
              shape.basePoints[i].x = newFrame[i].x + ox;
              shape.basePoints[i].y = newFrame[i].y + oy;
              shape.basePoints[i].edge = newFrame[i].edge ?? false;
              shape.basePoints[i].hidden = newFrame[i].hidden === true;
            }
          }
        }
      }

      // Handwriting reveal: sweep a threshold left-to-right so particles
      // "write" the text. Unrevealed particles stay in the hurricane.
      let revealX = Infinity;
      if (shape.writeReveal) {
        const wr = shape.writeReveal;
        wr.time += this._dt;
        const t = Math.min(wr.time / wr.duration, 1);
        const ease = t * (2 - t);
        revealX = wr.minX + (wr.maxX - wr.minX) * ease;
      }

      // Ellipsis seep animation: each seep base point is STATIC at its
      // home position (dots of "..." don't move). Each assigned particle
      // cycles through a per-particle phase:
      //   [0.0 - 0.85] tethered at the dot  → visible as a crisp dot
      //   (0.85 - 1.0] released               → particle dissipates into
      //                                          the hurricane starting
      //                                          from the dot's position
      //   wrap                               → particle is teleported
      //                                          back to the dot
      // Gate: the animation only runs once writeReveal has finished, so
      // the ellipsis only appears after the rest of the phrase. Dots
      // activate left-to-right, DOT_STAGGER seconds apart.
      const SEEP_CYCLE_SEC = 5.0;
      const DOT_STAGGER = 0.28;
      const seepNow = performance.now() / 1000;
      const postRevealSec = shape.hasSeep ? shape.writeReveal.time - shape.writeReveal.duration : 0;

      // Write targets: each particle tracks its assigned basePoint.
      // When we have fewer slots than basePoints (carousel divides the
      // budget across N shapes, or the governor trimmed the active count),
      // stride through basePoints so coverage is uniform. Without this,
      // animated Lottie shapes (which store static points first, dynamic
      // after) would only assign particles to the static nucleus.
      const bpLen = shape.basePoints.length;
      const pLen = shape.particleIndices.length;
      const useStride = pLen > 0 && pLen < bpLen;
      const stride = useStride ? bpLen / pLen : 1;
      for (let k = 0; k < pLen; k++) {
        const pi = shape.particleIndices[k];
        const bpIdx = useStride ? Math.floor(k * stride) : (k % bpLen);
        const bp = shape.basePoints[bpIdx];
        const p = this.particles[pi];

        if (bp.hidden) {
          // Padding entry of a shorter animation frame — nothing to show.
          p.targetX = null;
          p.targetY = null;
          continue;
        }

        if (bp.seep) {
          // The seep cycle is evaluated for the particle that actually
          // tracks this dot — the same mapping as the target write below.
          const activationAt = (bp.seepDotIndex || 0) * DOT_STAGGER;
          if (postRevealSec < activationAt) {
            bp._seepPhase = -1;
          } else {
            const phase = (seepNow / SEEP_CYCLE_SEC + bp.seepPhaseInit) % 1;
            const prev = bp._seepPhase;
            if (prev === undefined || prev < 0) {
              // First activation: snap home so the dot materializes cleanly.
              p.x = bp.seepHomeX;
              p.y = bp.seepHomeY;
              p.vx = 0;
              p.vy = 0;
            } else if (prev > 0.5 && phase < prev - 0.3) {
              // Cycle wrap: respawn at home after a lap in the hurricane.
              p.x = bp.seepHomeX;
              p.y = bp.seepHomeY;
              p.vx = 0;
              p.vy = 0;
            } else if (prev <= 0.85 && phase > 0.85) {
              // Release: tangential kick around the canvas-center hurricane
              // so the particle swirls into the vortex instead of
              // plummeting to center.
              const rx = p.x - canvasCx;
              const ry = p.y - canvasCy;
              const rLen = Math.sqrt(rx * rx + ry * ry) || 1;
              const tx = -ry / rLen;
              const ty = rx / rLen;
              const kick = 2.4;
              p.vx += tx * kick + 0.6;  // + slight outward bias (rightward)
              p.vy += ty * kick;
            }
            bp._seepPhase = phase;
          }
          if (bp._seepPhase === undefined || bp._seepPhase < 0 || bp._seepPhase > 0.85) {
            p.targetX = null;
            p.targetY = null;
            continue;
          }
        } else if (bp.x > revealX) {
          p.targetX = null;
          p.targetY = null;
          continue;
        }

        if (p.targetX == null) {
          p.targetX = bp.x + (Math.random() - 0.5) * 3;
          p.targetY = bp.y + (Math.random() - 0.5) * 3;
          const palette = bp.edge ? EDGE_COLORS : INTERIOR_COLORS;
          p.color = palette[Math.floor(Math.random() * palette.length)];
        } else {
          p.targetX = bp.x;
          p.targetY = bp.y;
        }
      }
    }
  }

  _render() {
    const ctx = this.ctx;

    // Clear with motion blur trail (frame-rate independent)
    ctx.fillStyle = BG_COLOR;
    ctx.globalAlpha = this._trailClearF;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;

    // The sprite's disc is slightly smaller than its box; scale the box so
    // the drawn disc has exactly the requested radius.
    const k = SPRITE_SIZE / SPRITE_DISC_RADIUS;

    for (let i = 0; i < this.activeParticleCount; i++) {
      const p = this.particles[i];

      if (p.targetX !== null && p.isShapeParticle) {
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const sprite = this._getSprite(p.color);

        if (dist < 5) {
          // Glow
          const rg = GLOW_SIZE * k;
          ctx.globalAlpha = 0.15;
          ctx.drawImage(sprite, p.x - rg / 2, p.y - rg / 2, rg, rg);
          // Main
          const rc = p.size * 0.8 * k;
          ctx.globalAlpha = 0.9;
          ctx.drawImage(sprite, p.x - rc / 2, p.y - rc / 2, rc, rc);
        } else {
          const rm = p.size * 0.7 * k;
          ctx.globalAlpha = 0.5 + Math.min(0.3, 10 / dist);
          ctx.drawImage(sprite, p.x - rm / 2, p.y - rm / 2, rm, rm);
        }
      } else {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.3 + Math.sin(this.time + p.phase) * 0.12;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
    }

    ctx.globalAlpha = 1;

    // Per-shape labels. The thinking title is not a shape (its text IS the
    // particles); early-forming shapes wait until they've settled visually.
    if (this.state === 'forming' || this.state === 'settled') {
      const shapes = this.currentShapes.filter(s => !s.isTitle);
      if (shapes.length > 0) {
        this.transitionProgress = Math.min(1, this.transitionProgress + 0.008 * this._dtF);
        if (this.transitionProgress > 0.5) {
          const alpha = (this.transitionProgress - 0.5) * 0.3;
          ctx.fillStyle = `rgba(200, 180, 160, ${alpha})`;
          ctx.font = '14px monospace';
          ctx.textAlign = 'center';

          if (shapes.length === 1) {
            // Single shape: label at the bottom of canvas.
            ctx.fillText(shapes[0].label, this.width / 2, this.height - 30);
          } else {
            // Multi-shape carousel: label under each shape's centroid.
            // centerX/centerY update every frame in _applyShapeRotation, so
            // the label travels with the shape around the orbit.
            for (const shape of shapes) {
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
  }

  /** Lazily build the disc sprite for a palette color. */
  _getSprite(color) {
    let sprite = this._sprites.get(color);
    if (!sprite) {
      sprite = document.createElement('canvas');
      sprite.width = SPRITE_SIZE;
      sprite.height = SPRITE_SIZE;
      const g = sprite.getContext('2d');
      g.fillStyle = color;
      g.beginPath();
      g.arc(SPRITE_SIZE / 2, SPRITE_SIZE / 2, SPRITE_DISC_RADIUS, 0, Math.PI * 2);
      g.fill();
      this._sprites.set(color, sprite);
    }
    return sprite;
  }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._boundResize) window.removeEventListener('resize', this._boundResize);
    document.removeEventListener('visibilitychange', this._boundVisibility);
    clearTimeout(this._relayoutTimer);
    this._clearCrossfade();
  }
}
