#!/usr/bin/env node
/**
 * Generate bundled Lottie animations for the starter set.
 * Creates simple, single-color, looping animations optimized for
 * particle rasterization (clear silhouettes, high contrast).
 *
 * Run: node scripts/generate-lottie-assets.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'shapes', 'lottie');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 200, H = 200;
const BLACK = [0, 0, 0, 1];

function static_(v) { return { a: 0, k: v }; }
function animated(keyframes) {
  const result = [];
  for (let idx = 0; idx < keyframes.length; idx++) {
    const curr = keyframes[idx];
    if (idx < keyframes.length - 1) {
      const next = keyframes[idx + 1];
      const dims = curr.s.length;
      result.push({
        t: curr.t,
        s: curr.s,
        e: next.s,
        i: { x: Array(dims).fill(1), y: Array(dims).fill(1) },
        o: { x: Array(dims).fill(0), y: Array(dims).fill(0) },
      });
    } else {
      result.push({ t: curr.t, s: curr.s });
    }
  }
  return { a: 1, k: result };
}
function kf(t, s) { return { t, s: Array.isArray(s) ? s : [s] }; }

function baseTransform(overrides = {}) {
  return {
    o: static_(overrides.o ?? 100),
    r: overrides.r ?? static_(0),
    p: overrides.p ?? static_([W / 2, H / 2]),
    a: overrides.a ?? static_([0, 0]),
    s: overrides.s ?? static_([100, 100]),
  };
}

function shapeLayer(name, shapes, ks, ip = 0, op = 90) {
  return { ty: 4, nm: name, ip, op, st: 0, ks, shapes };
}

function group(items, tr = {}) {
  return {
    ty: 'gr',
    it: [
      ...items,
      {
        ty: 'tr',
        p: tr.p ?? static_([0, 0]),
        a: tr.a ?? static_([0, 0]),
        s: tr.s ?? static_([100, 100]),
        r: tr.r ?? static_(0),
        o: static_(100),
      },
    ],
  };
}

function ellipse(cx, cy, w, h) {
  return { ty: 'el', p: static_([cx, cy]), s: static_([w, h]) };
}

function fill(color = BLACK) {
  return { ty: 'fl', c: static_(color), o: static_(100) };
}

function stroke(color = BLACK, width = 2) {
  return { ty: 'st', c: static_(color), o: static_(100), w: static_(width), lc: 2, lj: 2 };
}

function shapePath(vertices, closed = true) {
  return {
    ty: 'sh',
    ks: static_({
      c: closed,
      v: vertices.map(v => [v[0], v[1]]),
      i: vertices.map(v => v.length > 2 ? [v[2], v[3]] : [0, 0]),
      o: vertices.map(v => v.length > 4 ? [v[4], v[5]] : [0, 0]),
    }),
  };
}

function lottie(layers, fr = 30, op = 90) {
  return { v: '5.7.0', fr, ip: 0, op, w: W, h: H, nm: 'animation', layers };
}

// ── Atom: nucleus + 3 orbiting electrons ──
// Orbit rings are static layers (tilted). Electrons are separate layers
// with animated LAYER rotation (not group rotation — lottie-web light
// canvas doesn't reliably support animated group transforms).
function generateAtom() {
  const FPS = 30, DUR = 90;

  // Static orbit ring (tilted ellipse, thick stroke)
  function orbitRingLayer(name, ellipseW, ellipseH, tilt) {
    return shapeLayer(name, [
      group([ellipse(0, 0, ellipseW, ellipseH), stroke(BLACK, 8)]),
    ], baseTransform({ r: static_(tilt) }), 0, DUR);
  }

  // Animated electron — layer rotation carries the electron around.
  // Rotation goes from tilt → tilt+360*speed so it starts aligned
  // with its orbit and completes `speed` full orbits over DUR frames.
  function electronLayer(name, orbitRadius, tilt, speed) {
    return shapeLayer(name, [
      group([ellipse(orbitRadius, 0, 32, 32), fill()]),
    ], baseTransform({
      r: animated([kf(0, tilt), kf(DUR, tilt + 360 * speed)]),
    }), 0, DUR);
  }

  const layers = [
    orbitRingLayer('orbit1', 150, 55, 0),
    electronLayer('e1', 75, 0, 1),
    orbitRingLayer('orbit2', 150, 55, 60),
    electronLayer('e2', 75, 60, 1.3),
    orbitRingLayer('orbit3', 150, 55, -60),
    electronLayer('e3', 75, -60, 0.8),
    shapeLayer('nucleus', [
      group([ellipse(0, 0, 40, 40), fill()]),
    ], baseTransform(), 0, DUR),
  ];

  return lottie(layers, FPS, DUR);
}

// ── Heart: pulsing beat ──
// Large filled heart that pulses. The double-beat (lub-dub) pattern
// makes it feel organic.
function generateHeart() {
  const FPS = 30, DUR = 60;
  const heartPath = shapePath([
    [0, -25, 0, 0, -35, -15],
    [-55, -65, 25, 35, 0, 0],
    [-85, -15, 0, 0, 0, -35],
    [-55, 30, -25, -15, 0, 0],
    [0, 75, 0, 0, -25, 15],
    [55, 30, 0, 0, 25, 15],
    [85, -15, 0, 35, 0, 0],
    [55, -65, 0, 0, -25, 35],
  ]);

  const pulseScale = animated([
    kf(0, [100, 100]),
    kf(8, [115, 115]),
    kf(16, [100, 100]),
    kf(22, [108, 108]),
    kf(30, [100, 100]),
    kf(DUR, [100, 100]),
  ]);

  return lottie([
    shapeLayer('heart', [
      group([heartPath, fill()]),
    ], baseTransform({ s: pulseScale })),
  ], FPS, DUR);
}

// ── Fire: flickering flame ──
// Large filled flame shape that wobbles and scales.
function generateFire() {
  const FPS = 30, DUR = 60;

  function flameShape(scale, yOff, opacity, phase) {
    const flame = shapePath([
      [0, -80 + yOff, 0, 0, -20, -8],
      [-45, -20 + yOff, 15, -30, 0, 0],
      [-35, 50 + yOff, 0, 0, -12, -18],
      [0, 40 + yOff, 8, 12, -8, 12],
      [35, 50 + yOff, 12, -18, 0, 0],
      [45, -20 + yOff, 0, 0, -15, -30],
    ]);

    return shapeLayer(`flame${phase}`, [
      group([flame, fill()]),
    ], baseTransform({
      s: animated([
        kf(0, [scale, scale]),
        kf(15, [scale * 1.06, scale * 0.96]),
        kf(30, [scale * 0.96, scale * 1.05]),
        kf(45, [scale * 1.03, scale * 0.97]),
        kf(DUR, [scale, scale]),
      ]),
      o: static_(opacity),
      p: animated([
        kf(0, [W / 2, H / 2 + 10]),
        kf(20, [W / 2 - 4, H / 2 + 7]),
        kf(40, [W / 2 + 4, H / 2 + 13]),
        kf(DUR, [W / 2, H / 2 + 10]),
      ]),
    }), 0, DUR);
  }

  return lottie([
    flameShape(85, 12, 70, 10),
    flameShape(100, 0, 100, 0),
  ], FPS, DUR);
}

// ── Globe: spinning with meridians ──
function generateGlobe() {
  const FPS = 30, DUR = 120;
  const R = 75;

  // Outer circle
  const outerCircle = shapeLayer('outline', [
    group([ellipse(0, 0, R * 2, R * 2), stroke(BLACK, 3)]),
  ], baseTransform(), 0, DUR);

  // Equator
  const equator = shapeLayer('equator', [
    group([ellipse(0, 0, R * 2, R * 0.5), stroke(BLACK, 2)]),
  ], baseTransform(), 0, DUR);

  // Animated meridian — ellipse that changes width to simulate rotation
  function meridian(name, phaseOffset) {
    const half = DUR / 2;
    const quarterDur = DUR / 4;
    return shapeLayer(name, [
      group([ellipse(0, 0, 40, R * 2), stroke(BLACK, 2)]),
    ], baseTransform({
      s: animated([
        kf(0, [100, 100]),
        kf(quarterDur, [20, 100]),
        kf(half, [-100, 100]),
        kf(half + quarterDur, [-20, 100]),
        kf(DUR, [100, 100]),
      ]),
    }), 0, DUR);
  }

  return lottie([
    outerCircle,
    equator,
    meridian('meridian1', 0),
    meridian('meridian2', 30),
  ], FPS, DUR);
}

// ── Rocket: launch with exhaust ──
function generateRocket() {
  const FPS = 30, DUR = 60;

  const body = shapePath([
    [0, -70, 0, 0, -15, -5],
    [-20, -30, 5, -15, 0, 0],
    [-20, 30, 0, 0, 0, -10],
    [-35, 50, 0, 0, -5, -5],
    [-20, 40, 3, 5, 0, 0],
    [0, 55, 0, 0, -5, 0],
    [20, 40, 0, 0, -3, 5],
    [35, 50, 5, -5, 0, 0],
    [20, 30, 0, -10, 0, 0],
    [20, -30, 0, 0, -5, -15],
  ]);

  const window = ellipse(0, -20, 14, 14);

  const exhaust = shapePath([
    [-15, 55],
    [0, 85],
    [15, 55],
  ]);

  return lottie([
    shapeLayer('exhaust', [
      group([exhaust, fill()]),
    ], baseTransform({
      s: animated([
        kf(0, [100, 80]),
        kf(8, [90, 120]),
        kf(15, [110, 90]),
        kf(22, [85, 115]),
        kf(30, [100, 80]),
        kf(DUR, [100, 80]),
      ]),
      o: animated([
        kf(0, 80),
        kf(10, 100),
        kf(20, 70),
        kf(30, 90),
        kf(DUR, 80),
      ]),
    }), 0, DUR),
    shapeLayer('body', [
      group([body, fill()]),
      group([window, stroke(BLACK, 2)]),
    ], baseTransform({
      p: animated([
        kf(0, [W / 2, H / 2 + 5]),
        kf(15, [W / 2, H / 2 - 3]),
        kf(30, [W / 2, H / 2 + 5]),
        kf(DUR, [W / 2, H / 2 + 5]),
      ]),
    }), 0, DUR),
  ], FPS, DUR);
}

// ── Lightning: bolt flash ──
function generateLightning() {
  const FPS = 30, DUR = 60;

  const bolt = shapePath([
    [15, -80],
    [-5, -15],
    [15, -15],
    [-15, 80],
    [5, 10],
    [-15, 10],
  ]);

  return lottie([
    shapeLayer('bolt', [
      group([bolt, fill()]),
    ], baseTransform({
      o: animated([
        kf(0, 0),
        kf(5, 100),
        kf(10, 30),
        kf(13, 100),
        kf(25, 100),
        kf(35, 0),
        kf(DUR, 0),
      ]),
      s: animated([
        kf(0, [95, 95]),
        kf(5, [105, 105]),
        kf(13, [100, 100]),
        kf(DUR, [95, 95]),
      ]),
    }), 0, DUR),
  ], FPS, DUR);
}

// ── DNA: double helix rotation ──
function generateDNA() {
  const FPS = 30, DUR = 90;
  const RUNGS = 8;
  const layers = [];

  for (let i = 0; i < RUNGS; i++) {
    const yPos = -70 + (i * 140 / (RUNGS - 1));
    const phaseOff = i * (360 / RUNGS);

    // Left dot
    layers.push(shapeLayer(`dot-l-${i}`, [
      group([ellipse(0, 0, 10, 10), fill()]),
    ], baseTransform({
      p: animated([
        kf(0, [W / 2 + 30 * Math.cos((phaseOff) * Math.PI / 180), H / 2 + yPos]),
        kf(DUR / 4, [W / 2 + 30 * Math.cos((phaseOff + 90) * Math.PI / 180), H / 2 + yPos]),
        kf(DUR / 2, [W / 2 + 30 * Math.cos((phaseOff + 180) * Math.PI / 180), H / 2 + yPos]),
        kf(3 * DUR / 4, [W / 2 + 30 * Math.cos((phaseOff + 270) * Math.PI / 180), H / 2 + yPos]),
        kf(DUR, [W / 2 + 30 * Math.cos((phaseOff + 360) * Math.PI / 180), H / 2 + yPos]),
      ]),
    }), 0, DUR));

    // Right dot (opposite phase)
    layers.push(shapeLayer(`dot-r-${i}`, [
      group([ellipse(0, 0, 10, 10), fill()]),
    ], baseTransform({
      p: animated([
        kf(0, [W / 2 + 30 * Math.cos((phaseOff + 180) * Math.PI / 180), H / 2 + yPos]),
        kf(DUR / 4, [W / 2 + 30 * Math.cos((phaseOff + 270) * Math.PI / 180), H / 2 + yPos]),
        kf(DUR / 2, [W / 2 + 30 * Math.cos((phaseOff + 360) * Math.PI / 180), H / 2 + yPos]),
        kf(3 * DUR / 4, [W / 2 + 30 * Math.cos((phaseOff + 450) * Math.PI / 180), H / 2 + yPos]),
        kf(DUR, [W / 2 + 30 * Math.cos((phaseOff + 540) * Math.PI / 180), H / 2 + yPos]),
      ]),
    }), 0, DUR));
  }

  // Backbone strands (vertical lines on each side)
  layers.push(shapeLayer('backbone-l', [
    group([
      shapePath([[-30, -70], [-30, 70]], false),
      stroke(BLACK, 3),
    ]),
  ], baseTransform(), 0, DUR));

  layers.push(shapeLayer('backbone-r', [
    group([
      shapePath([[30, -70], [30, 70]], false),
      stroke(BLACK, 3),
    ]),
  ], baseTransform(), 0, DUR));

  return lottie(layers, FPS, DUR);
}

// ── Music Notes: floating upward ──
function generateMusicNotes() {
  const FPS = 30, DUR = 90;

  function noteLayer(name, startX, delay) {
    const note = [
      group([
        ellipse(0, 0, 16, 12),
        fill(),
      ], { p: static_([0, 0]) }),
      group([
        shapePath([[7, 0], [7, -35]], false),
        stroke(BLACK, 3),
      ]),
      group([
        shapePath([[7, -35], [14, -32]], false),
        stroke(BLACK, 3),
      ]),
    ];

    return shapeLayer(name, note, baseTransform({
      p: animated([
        kf(delay, [W / 2 + startX, H / 2 + 40]),
        kf(delay + 60, [W / 2 + startX + (Math.random() - 0.5) * 30, H / 2 - 60]),
        kf(delay + 75, [W / 2 + startX + (Math.random() - 0.5) * 30, H / 2 - 80]),
      ]),
      o: animated([
        kf(delay, 0),
        kf(delay + 10, 100),
        kf(delay + 55, 100),
        kf(delay + 75, 0),
      ]),
      s: animated([
        kf(delay, [80, 80]),
        kf(delay + 30, [100, 100]),
        kf(delay + 75, [90, 90]),
      ]),
    }), 0, DUR);
  }

  return lottie([
    noteLayer('note1', -25, 0),
    noteLayer('note2', 10, 15),
    noteLayer('note3', -5, 30),
  ], FPS, DUR);
}

// ── Generate all ──
const animations = {
  atom: generateAtom(),
  heart: generateHeart(),
  fire: generateFire(),
  globe: generateGlobe(),
  rocket: generateRocket(),
  lightning: generateLightning(),
  dna: generateDNA(),
  'music-notes': generateMusicNotes(),
};

const manifest = {};
for (const [slug, anim] of Object.entries(animations)) {
  const filePath = path.join(OUT_DIR, `${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(anim), 'utf-8');
  const size = fs.statSync(filePath).size;
  console.log(`  ${slug}.json — ${(size / 1024).toFixed(1)}KB, ${anim.fr}fps, ${anim.op} frames`);

  const tags = {
    atom: ['atom', 'atomic', 'nucleus', 'electron', 'orbit', 'particle', 'physics'],
    heart: ['heart', 'love', 'beat', 'pulse', 'valentine', 'cardio'],
    fire: ['fire', 'flame', 'burning', 'blaze', 'inferno', 'heat'],
    globe: ['globe', 'earth', 'world', 'planet', 'geography', 'sphere'],
    rocket: ['rocket', 'launch', 'space', 'spaceship', 'shuttle', 'takeoff'],
    lightning: ['lightning', 'thunder', 'electricity', 'bolt', 'storm', 'shock', 'energy'],
    dna: ['dna', 'helix', 'genetics', 'chromosome', 'gene', 'biology', 'double-helix'],
    'music-notes': ['music', 'melody', 'song', 'note', 'notes', 'tune', 'musical'],
  };

  manifest[slug] = {
    file: `${slug}.json`,
    fps: anim.fr,
    frames: anim.op,
    tags: tags[slug] || [],
  };
}

const manifestPath = path.join(OUT_DIR, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`\nWrote manifest.json with ${Object.keys(manifest).length} entries`);
