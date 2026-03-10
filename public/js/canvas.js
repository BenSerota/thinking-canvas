/**
 * Thinking Canvas — Particle Simulation Engine
 *
 * Renders thousands of sand-grain particles on a 2D canvas.
 * Particles can drift ambient, swirl (thinking), or coalesce into target shapes.
 */

const PARTICLE_COUNT = 6000;
const SAND_COLORS = ['#D4A574', '#C4956A', '#E8C9A0', '#B8845A', '#DEB887', '#C9A882'];
const BG_COLOR = '#0d0d1a';
const PARTICLE_SIZE = 2.5;

// Physics constants
const GRAVITY = 0.02;
const FRICTION = 0.97;
const BROWNIAN = 0.3;
const SPRING_K = 0.015;
const SPRING_DAMPING = 0.92;
const SWIRL_SPEED = 0.03;

export class ThinkingCanvas {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.particles = [];
    this.state = 'idle'; // idle | thinking | forming | dissolving
    this.targetShape = null;
    this.shapeOpacity = 0;
    this.time = 0;
    this.transitionProgress = 0;
    this.pendingShape = null;

    this._resize();
    this._initParticles();
    this._boundAnimate = this._animate.bind(this);
    this._boundResize = this._resize.bind(this);
    window.addEventListener('resize', this._boundResize);
    requestAnimationFrame(this._boundAnimate);
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * window.devicePixelRatio;
    this.canvas.height = this.height * window.devicePixelRatio;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
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
        size: PARTICLE_SIZE + (Math.random() - 0.5) * 1,
        phase: Math.random() * Math.PI * 2, // for organic motion
      });
    }
  }

  /**
   * Set a target shape for particles to form.
   * @param {Array<{x: number, y: number}>} shapePoints - normalized 0-1 coords
   * @param {string} label - concept name for display
   */
  setShape(shapePoints, label) {
    if (!shapePoints || shapePoints.length === 0) {
      this.clearShape();
      return;
    }

    this.state = 'forming';
    this.targetShape = label;
    this.transitionProgress = 0;

    // Scale shape points to canvas, centered
    const margin = 60;
    const shapeW = this.width - margin * 2;
    const shapeH = this.height - margin * 2;
    const scale = Math.min(shapeW, shapeH) * 0.7;
    const offsetX = (this.width - scale) / 2;
    const offsetY = (this.height - scale) / 2;

    const scaledPoints = shapePoints.map(p => ({
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY
    }));

    // Assign target positions to particles
    // Some particles get shape targets, others drift nearby
    const shapeParticleCount = Math.min(scaledPoints.length, Math.floor(PARTICLE_COUNT * 0.7));

    // Shuffle particles for random assignment
    const indices = [...Array(PARTICLE_COUNT).keys()];
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const pi = indices[i];
      if (i < shapeParticleCount) {
        const sp = scaledPoints[i % scaledPoints.length];
        // Add slight jitter for organic feel
        this.particles[pi].targetX = sp.x + (Math.random() - 0.5) * 4;
        this.particles[pi].targetY = sp.y + (Math.random() - 0.5) * 4;
      } else {
        // Ambient particles: drift around the shape
        this.particles[pi].targetX = null;
        this.particles[pi].targetY = null;
      }
    }
  }

  clearShape() {
    this.state = 'dissolving';
    this.targetShape = null;
    for (const p of this.particles) {
      p.targetX = null;
      p.targetY = null;
      // Give a little push outward
      p.vx += (Math.random() - 0.5) * 2;
      p.vy += (Math.random() - 0.5) * 2;
    }
    setTimeout(() => {
      if (this.state === 'dissolving') this.state = 'idle';
    }, 2000);
  }

  setThinking(isThinking) {
    if (isThinking && this.state !== 'forming') {
      this.state = 'thinking';
    } else if (!isThinking && this.state === 'thinking') {
      this.state = 'idle';
    }
  }

  _animate() {
    this.time += 0.016; // ~60fps
    this._update();
    this._render();
    requestAnimationFrame(this._boundAnimate);
  }

  _update() {
    const cx = this.width / 2;
    const cy = this.height / 2;

    for (const p of this.particles) {
      // Brownian motion (always present, subtle)
      p.vx += (Math.random() - 0.5) * BROWNIAN * 0.3;
      p.vy += (Math.random() - 0.5) * BROWNIAN * 0.3;

      if (this.state === 'thinking') {
        // Swirl around center
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        // Tangential force (swirl)
        p.vx += Math.cos(angle + Math.PI / 2) * SWIRL_SPEED * (1 + Math.sin(this.time * 2 + p.phase));
        p.vy += Math.sin(angle + Math.PI / 2) * SWIRL_SPEED * (1 + Math.sin(this.time * 2 + p.phase));

        // Slight inward pull
        if (dist > 100) {
          p.vx -= dx * 0.0003;
          p.vy -= dy * 0.0003;
        }

        // More brownian in thinking mode
        p.vx += (Math.random() - 0.5) * BROWNIAN;
        p.vy += (Math.random() - 0.5) * BROWNIAN;

      } else if (p.targetX !== null && p.targetY !== null) {
        // Spring force toward target
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        p.vx += dx * SPRING_K;
        p.vy += dy * SPRING_K;
        p.vx *= SPRING_DAMPING;
        p.vy *= SPRING_DAMPING;

      } else {
        // Ambient: gentle gravity + drift
        p.vy += GRAVITY * 0.3;

        // Gentle sine wave drift
        p.vx += Math.sin(this.time * 0.5 + p.phase) * 0.02;
        p.vy += Math.cos(this.time * 0.3 + p.phase) * 0.01;
      }

      // Apply velocity with friction
      p.vx *= FRICTION;
      p.vy *= FRICTION;
      p.x += p.vx;
      p.y += p.vy;

      // Boundary wrapping with soft bounce
      if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx) * 0.5; }
      if (p.x > this.width) { p.x = this.width; p.vx = -Math.abs(p.vx) * 0.5; }
      if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy) * 0.5; }
      if (p.y > this.height) { p.y = this.height - 1; p.vy = -Math.abs(p.vy) * 0.3; }
    }
  }

  _render() {
    const ctx = this.ctx;

    // Clear with slight trail effect for motion blur
    ctx.fillStyle = BG_COLOR;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;

    // Draw particles
    for (const p of this.particles) {
      ctx.fillStyle = p.color;

      // Particles near their target glow slightly brighter
      if (p.targetX !== null) {
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 10) {
          ctx.globalAlpha = 0.9;
        } else {
          ctx.globalAlpha = 0.5 + Math.min(0.3, 10 / dist);
        }
      } else {
        ctx.globalAlpha = 0.4 + Math.sin(this.time + p.phase) * 0.15;
      }

      ctx.fillRect(
        Math.round(p.x),
        Math.round(p.y),
        p.size,
        p.size
      );
    }

    ctx.globalAlpha = 1;

    // Draw subtle label if shape is active
    if (this.targetShape && this.state === 'forming') {
      this.transitionProgress = Math.min(1, this.transitionProgress + 0.005);
      if (this.transitionProgress > 0.5) {
        ctx.fillStyle = `rgba(200, 180, 160, ${(this.transitionProgress - 0.5) * 0.3})`;
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(this.targetShape, this.width / 2, this.height - 30);
      }
    }
  }

  destroy() {
    window.removeEventListener('resize', this._boundResize);
  }
}
