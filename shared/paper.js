// Hand-drawn "marker on graph paper" drawing helpers for canvas.
// Every wobble is driven by a seed, so a shape looks the same every frame
// instead of jittering.

export const INK = {
  paper: '#fbf8ee',
  gridMinor: 'rgba(90, 140, 200, 0.16)',
  gridMajor: 'rgba(90, 140, 200, 0.34)',
  pencil: '#55534e',
  marker: '#24221f',
  red: '#d9412b',
  green: '#2e9e4f',
  greenLight: '#9ee0a4',
  yellow: '#f4c430',
  blue: '#2f6fc0',
  cardboard: '#c9a26b',
};

export const HAND_FONT =
  '"Marker Felt", "Chalkboard SE", "Comic Sans MS", "Comic Neue", "Segoe Print", cursive';

// Small deterministic RNG (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(...nums) {
  let h = 2166136261;
  for (const n of nums) {
    h ^= Math.floor(n * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A slightly bowed line, drawn twice like a quick marker stroke.
export function sketchLine(ctx, x1, y1, x2, y2, seed = 1, { wobble = 1.6, passes = 2 } = {}) {
  const r = rng(seed);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const w = Math.min(wobble, len * 0.05 + 0.4);
  for (let p = 0; p < passes; p++) {
    const bow = (r() - 0.5) * w * 2;
    const sx = x1 + (r() - 0.5) * w;
    const sy = y1 + (r() - 0.5) * w;
    const ex = x2 + (r() - 0.5) * w;
    const ey = y2 + (r() - 0.5) * w;
    const mx = (sx + ex) / 2 + nx * bow;
    const my = (sy + ey) / 2 + ny * bow;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }
}

export function sketchRect(ctx, x, y, w, h, seed = 1, opts) {
  sketchLine(ctx, x, y, x + w, y, seed, opts);
  sketchLine(ctx, x + w, y, x + w, y + h, seed + 1, opts);
  sketchLine(ctx, x + w, y + h, x, y + h, seed + 2, opts);
  sketchLine(ctx, x, y + h, x, y, seed + 3, opts);
}

// A circle drawn as a loop that slightly overshoots its start, like a pen.
export function sketchCircle(ctx, cx, cy, radius, seed = 1, { wobble = 1.2, passes = 2 } = {}) {
  const r = rng(seed);
  for (let p = 0; p < passes; p++) {
    const start = r() * Math.PI * 2;
    const sweep = Math.PI * 2 + 0.25 + r() * 0.3;
    const steps = 18;
    const offs = Array.from({ length: 4 }, () => (r() - 0.5) * wobble * 2);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = start + sweep * t;
      const o = offs[Math.floor(t * 3.999)] * (1 - Math.abs(t - 0.5));
      const rr = radius + o;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

// Diagonal marker hatching clipped to the current path region.
export function hatch(ctx, x, y, w, h, { gap = 7, angle = -Math.PI / 4, seed = 1 } = {}) {
  const r = rng(seed);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const reach = Math.hypot(w, h) / 2 + gap;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  ctx.beginPath();
  for (let o = -reach; o <= reach; o += gap) {
    const jitter = (r() - 0.5) * gap * 0.35;
    const px = cx - dy * (o + jitter);
    const py = cy + dx * (o + jitter);
    ctx.moveTo(px - dx * reach, py - dy * reach);
    ctx.lineTo(px + dx * reach, py + dy * reach);
  }
  ctx.stroke();
}

// Graph paper covering the given world-space rectangle.
export function graphPaper(ctx, x, y, w, h, minor = 10, majorEvery = 4) {
  ctx.fillStyle = INK.paper;
  ctx.fillRect(x, y, w, h);
  const x0 = Math.floor(x / minor) * minor;
  const y0 = Math.floor(y / minor) * minor;
  ctx.lineWidth = 1;
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? INK.gridMajor : INK.gridMinor;
    ctx.beginPath();
    for (let gx = x0; gx <= x + w; gx += minor) {
      if ((Math.round(gx / minor) % majorEvery === 0) !== major) continue;
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
    }
    for (let gy = y0; gy <= y + h; gy += minor) {
      if ((Math.round(gy / minor) % majorEvery === 0) !== major) continue;
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
    }
    ctx.stroke();
  }
}

// Size a canvas to its CSS box at device pixel ratio. Returns the CSS size.
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}
