/**
 * Thinking Canvas — Particle Simulation Engine
 *
 * Renders thousands of sand-grain particles on a 2D canvas.
 * Particles can drift ambient, gather, form a hurricane vortex (thinking),
 * or coalesce into target shapes. Cursor interaction lets users scatter particles.
 *
 * States: idle → gathering → thinking → forming → transitioning → settled → dissolving
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
const SPRING_K = 0.035;         // 2x faster snap to target
const SPRING_DAMPING = 0.88;    // less oscillation, faster settle
const SWIRL_SPEED = 0.06;       // faster hurricane vortex
const GATHER_PULL = 0.001;
const SHAPE_PARTICLE_RATIO = 0.85;

// Cursor interaction constants
const CURSOR_RADIUS = 80;       // pixels — repulsion range
const CURSOR_REPEL_FORCE = 3.0; // repulsion strength
const CURSOR_ATTRACT_FORCE = 2.0; // attraction on mousedown

export class ThinkingCanvas {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.particles = [];
    this.state = 'idle';
    this.targetShape = null;
    this.shapeOpacity = 0;
    this.time = 0;
    this.lastTimestamp = null;
    this.transitionProgress = 0;
    this.pendingShape = null;
    this.interimMode = false;

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
      });
    }
  }

  setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (newState === 'gathering') {
      for (const p of this.particles) {
        p.targetX = null;
        p.targetY = null;
        p.isShapeParticle = false;
      }
    }
  }

  setShape(shapePoints, label, transition = 'instant') {
    if (!shapePoints || shapePoints.length === 0) {
      this.clearShape();
      return;
    }
    if (transition === 'crossfade' && this.state === 'forming') {
      this.state = 'transitioning';
      for (const p of this.particles) {
        if (p.targetX !== null) {
          p.vx += (Math.random() - 0.5) * 1.5;
          p.vy += (Math.random() - 0.5) * 1.5;
        }
      }
      setTimeout(() => {
        this._assignShape(shapePoints, label);
        this.state = 'forming';
      }, 200); // faster crossfade
    } else {
      this._assignShape(shapePoints, label);
      this.state = 'forming';
    }
  }

  _assignShape(shapePoints, label) {
    this.targetShape = label;
    this.transitionProgress = 0;
    const margin = 60;
    const shapeW = this.width - margin * 2;
    const shapeH = this.height - margin * 2;
    const scale = Math.min(shapeW, shapeH) * 0.7;
    const offsetX = (this.width - scale) / 2;
    const offsetY = (this.height - scale) / 2;

    const scaledPoints = shapePoints.map(p => ({
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY,
    }));

    const particleCount = this.particles.length;
    const shapeParticleCount = Math.min(scaledPoints.length, Math.floor(particleCount * SHAPE_PARTICLE_RATIO));

    const indices = [...Array(particleCount).keys()];
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    for (let i = 0; i < particleCount; i++) {
      const pi = indices[i];
      if (i < shapeParticleCount) {
        const sp = scaledPoints[i % scaledPoints.length];
        this.particles[pi].targetX = sp.x + (Math.random() - 0.5) * 3;
        this.particles[pi].targetY = sp.y + (Math.random() - 0.5) * 3;
        this.particles[pi].isShapeParticle = true;
      } else {
        this.particles[pi].targetX = null;
        this.particles[pi].targetY = null;
        this.particles[pi].isShapeParticle = false;
      }
    }
  }

  setInterimShape(shapePoints, label) {
    this.interimMode = true;
    this.setShape(shapePoints, label);
  }

  clearShape() {
    this.state = 'dissolving';
    this.targetShape = null;
    this.interimMode = false;
    for (const p of this.particles) {
      p.targetX = null;
      p.targetY = null;
      p.isShapeParticle = false;
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
    const cx = this.width / 2;
    const cy = this.height / 2;
    const springK = this.interimMode ? SPRING_K * 0.6 : SPRING_K;
    const springDamp = this.interimMode ? 0.92 : SPRING_DAMPING;

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
          const force = (CURSOR_RADIUS - mDist) / CURSOR_RADIUS; // 0 at edge, 1 at center
          if (this.mouseDown) {
            // Attract: pull particles toward cursor
            p.vx -= (mdx / mDist) * force * CURSOR_ATTRACT_FORCE;
            p.vy -= (mdy / mDist) * force * CURSOR_ATTRACT_FORCE;
          } else {
            // Repel: push particles away from cursor
            p.vx += (mdx / mDist) * force * force * CURSOR_REPEL_FORCE;
            p.vy += (mdy / mDist) * force * force * CURSOR_REPEL_FORCE;
          }
        }
      }

      // ─── State-specific physics ───
      if (this.state === 'gathering') {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const pulse = 1 + Math.sin(this.time * 3) * 0.3;
        p.vx -= dx * GATHER_PULL * pulse;
        p.vy -= dy * GATHER_PULL * pulse;
        p.vx += (Math.random() - 0.5) * BROWNIAN * 0.4;
        p.vy += (Math.random() - 0.5) * BROWNIAN * 0.4;

      } else if (this.state === 'thinking') {
        // ─── Hurricane vortex ───
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        // Pulsing containment radius
        const targetRadius = 120 + Math.sin(this.time * 1.5) * 30;

        // Tangential force — inner particles orbit faster (hurricane eye)
        const speedMult = dist < 60 ? 2.0 : (dist < 150 ? 1.5 : 1.0);
        p.vx += Math.cos(angle + Math.PI / 2) * SWIRL_SPEED * speedMult * (1 + Math.sin(this.time * 3 + p.phase) * 0.5);
        p.vy += Math.sin(angle + Math.PI / 2) * SWIRL_SPEED * speedMult * (1 + Math.sin(this.time * 3 + p.phase) * 0.5);

        // Radial force — always pull toward target radius (tight containment)
        const radialError = dist - targetRadius;
        const radialForce = radialError * 0.002;
        p.vx -= (dx / (dist + 1)) * radialForce;
        p.vy -= (dy / (dist + 1)) * radialForce;

        // Very light brownian so vortex stays coherent
        p.vx += (Math.random() - 0.5) * BROWNIAN * 0.15;
        p.vy += (Math.random() - 0.5) * BROWNIAN * 0.15;

      } else if (p.targetX !== null && p.targetY !== null) {
        // Spring force toward target
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        p.vx += dx * springK;
        p.vy += dy * springK;
        p.vx *= springDamp;
        p.vy *= springDamp;

      } else {
        // Ambient: gentle gravity + drift
        p.vy += GRAVITY * 0.3;
        p.vx += Math.sin(this.time * 0.5 + p.phase) * 0.02;
        p.vy += Math.cos(this.time * 0.3 + p.phase) * 0.01;
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

    // Shape label
    if (this.targetShape && (this.state === 'forming' || this.state === 'settled')) {
      this.transitionProgress = Math.min(1, this.transitionProgress + 0.008);
      if (this.transitionProgress > 0.5) {
        const alpha = (this.transitionProgress - 0.5) * 0.3;
        ctx.fillStyle = `rgba(200, 180, 160, ${this.interimMode ? alpha * 0.5 : alpha})`;
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
