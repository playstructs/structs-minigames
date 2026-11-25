import { INK, HAND_FONT, rng, sketchLine, sketchRect, sketchCircle, hatch, graphPaper, fitCanvas } from '../shared/paper.js';
import { audio, noteFreq } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'reconnet';
const STAR_WIRES = [3, 6, 9]; // wires reconnected for 1, 2 and 3 stars
const TIME_LIMIT = 90; // seconds
const CLEAR_BONUS = 10; // seconds added for clearing a board

// Boards get busier as you clear them.
const boardPlan = (n) => ({
  wires: Math.min(5, 2 + n), // 3, 4, 5, 5...
  tears: Math.min(6, 1 + n),
  holes: Math.min(4, n),
  crates: Math.min(6, 3 + Math.floor(n / 2)),
});

// Wires: chains of stiff, fixed-length segments.
const SEG = 8; // segment length
const MAX_BEND = 0.6; // radians a wire can bend per segment (~34°)
const WIRE_R = 2.5; // wire thickness (radius) for collisions
const SLACK = 1.25; // wire length = anchor-to-socket distance × this + EXTRA
const EXTRA = 50;
const SNAP = 12; // plug snaps into its socket within this distance
const ITERATIONS = 12;
const MAX_DRAG = 220; // units/s: fastest any part of a wire can move

// The bot.
const BOT_SPEED = 150; // units/s
const REACH = 16; // claw grabs the nearest wire point within this
// A tall, narrow arm with the claw at the bottom (0, 0). It never rotates.
const PARTS = [
  { x: -7, y: -38, w: 14, h: 34 }, // arm
  { x: -6, y: -6, w: 12, h: 8 }, // claw
];

// ---- World ---------------------------------------------------------------

const W = 400;
const H = 560;
const WALL = 12; // wall thickness drawn inside the board edge
const TOP_PAD = 60;
const BOTTOM_PAD = 84; // room for the Grab button (screen px)
const COLORS = [
  { ink: '#d9412b', light: '#f6c3b9', sym: 'circle' },
  { ink: '#2f6fc0', light: '#c3d8f3', sym: 'square' },
  { ink: '#2e9e4f', light: '#c2e8cc', sym: 'triangle' },
  { ink: '#e08a12', light: '#f8ddb2', sym: 'diamond' },
  { ink: '#8a3fc4', light: '#e0c9f2', sym: 'star' },
];

const shell = document.getElementById('shell');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;
const formatTime = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = '<span class="hud-time" aria-label="Time left">1:30</span><span class="hud-score" aria-label="Wires reconnected">0</span><span class="hud-stars"></span>';
mountTopBar(shell, { extra: hud });
const hudTime = hud.querySelector('.hud-time');
const hudScore = hud.querySelector('.hud-score');
const hudStars = hud.querySelector('.hud-stars');

let view = { scale: 1, ox: 0, oy: 0, cw: 0, ch: 0, dpr: 1 };

function layout() {
  const { w, h, dpr } = fitCanvas(canvas);
  const availH = Math.max(200, h - TOP_PAD - BOTTOM_PAD);
  const scale = Math.min((w - 12) / W, availH / H);
  view = { scale, ox: (w - W * scale) / 2, oy: TOP_PAD + (availH - H * scale) / 2, cw: w, ch: h, dpr };
}

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angDiff = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
// Distance from a point to a rectangle (0 inside).
const rectDist = (px, py, r) => Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.w)), Math.max(r.y - py, 0, py - (r.y + r.h)));
// Distance from a point to a segment.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
const botRects = (x, y) => PARTS.map((p) => ({ x: x + p.x, y: y + p.y, w: p.w, h: p.h }));
const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

// ---- State ---------------------------------------------------------------

let state;
let silent = false; // true while the balance sim runs
let autoAct = null; // debug: a bot driving the live game
let autoAcc = 0;

function newState() {
  return {
    phase: 'ready',
    countdown: 3.5,
    goT: 1,
    timeLeft: TIME_LIMIT,
    played: 0,
    score: 0,
    board: 0,
    clearT: 0, // > 0 while showing "board clear"
    bot: { x: 0, y: 0, grab: null, taut: 0, tx: 0, ty: 0, moving: false },
    input: { x: 0, y: 0, grab: false }, // set by the bot in the sim
    wires: [],
    crates: [],
    tears: [],
    holes: [],
    particles: [],
    texts: [],
    shake: 0,
    overT: 0,
    cause: null,
    tickT: 0,
    seed: Math.floor(Math.random() * 1e6),
  };
}

// ---- Board generation ----------------------------------------------------

// A spot on one of the four walls, with the inward direction.
function wallSpot(side) {
  const m = WALL + 30;
  switch (side) {
    case 0: return { x: rand(m, W - m), y: WALL, nx: 0, ny: 1, side };
    case 1: return { x: W - WALL, y: rand(m, H - m), nx: -1, ny: 0, side };
    case 2: return { x: rand(m, W - m), y: H - WALL, nx: 0, ny: -1, side };
    default: return { x: WALL, y: rand(m, H - m), nx: 1, ny: 0, side };
  }
}

// Sockets are plates on the floor. The claw is at the bottom of the bot's
// arm, so keep them a little further from the top wall.
const floorSpot = () => ({ x: rand(WALL + 34, W - WALL - 34), y: rand(WALL + 48, H - WALL - 34), nx: 0, ny: -1 });

const BOT_START = { x: W / 2 + 20, y: H / 2 + 30 };

function buildBoard(n) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const b = tryBoard(n);
    if (b) return b;
  }
  return tryBoard(1, true);
}

function tryBoard(n, easy = false) {
  const plan = easy ? { wires: 3, tears: 1, holes: 0, crates: 2 } : boardPlan(n);
  const spots = []; // every anchor and socket, kept apart
  const far = (p, d) => spots.every((s) => Math.hypot(s.x - p.x, s.y - p.y) > d);
  const wires = [];
  const colors = [...COLORS.keys()].sort(() => Math.random() - 0.5);
  for (let i = 0; i < plan.wires; i++) {
    let ok = false;
    for (let t = 0; t < 80 && !ok; t++) {
      const a = wallSpot(Math.floor(Math.random() * 4));
      const s = floorSpot();
      const d = Math.hypot(a.x - s.x, a.y - s.y);
      if (d < 170 || d > 400 || !far(a, 70) || !far(s, 55) || Math.hypot(a.x - s.x, a.y - s.y) < 70) continue;
      const w = makeWire(a, s, COLORS[colors[i]], d);
      const m = WALL + 8;
      if (w.pts.some((p, k) => k > 0 && (p.x < m || p.x > W - m || p.y < m || p.y > H - m))) continue;
      spots.push(a, s);
      wires.push(w);
      ok = true;
    }
    if (!ok) return null;
  }
  const start = botRects(BOT_START.x, BOT_START.y);
  const crates = [];
  for (let i = 0; i < plan.crates; i++) {
    for (let t = 0; t < 60; t++) {
      const w = rand(34, 66);
      const h = rand(30, 60);
      const c = { x: rand(WALL + 24, W - WALL - 24 - w), y: rand(WALL + 24, H - WALL - 24 - h), w, h, seed: Math.floor(Math.random() * 1e5) };
      if (wires.some((w) => rectDist(w.ax, w.ay, c) < 60 || rectDist(w.sx, w.sy, c) < 60 || w.pts.some((p) => rectDist(p.x, p.y, c) < 22))) continue;
      if (start.some((r) => overlaps(r, c, 22))) continue;
      if (crates.some((o) => overlaps(o, c, 26))) continue;
      crates.push(c);
      break;
    }
  }
  const hazards = [];
  const clear = (x, y, r) => {
    if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < r + 60)) return false;
    if (start.some((q) => rectDist(x, y, q) < r + 40)) return false;
    if (crates.some((c) => rectDist(x, y, c) < r + 10)) return false;
    if (hazards.some((h) => Math.hypot(h.x - x, h.y - y) < r + h.r + 24)) return false;
    // Leave a lane along the straight line from each anchor to its socket.
    if (wires.some((w) => segDist(x, y, w.ax, w.ay, w.sx, w.sy) < r + 16)) return false;
    // And room around each coil to pull it out.
    if (wires.some((w) => w.pts.some((p) => Math.hypot(p.x - x, p.y - y) < r + 34))) return false;
    return x > WALL + r + 6 && x < W - WALL - r - 6 && y > WALL + r + 6 && y < H - WALL - r - 6;
  };
  const place = (count, kind, rmin, rmax) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      for (let t = 0; t < 120; t++) {
        const r = rand(rmin, rmax);
        const x = rand(WALL + r, W - WALL - r);
        const y = rand(WALL + r, H - WALL - r);
        if (!clear(x, y, r)) continue;
        const h = { x, y, r, kind, seed: Math.floor(Math.random() * 1e5), phase: Math.random() * 6 };
        hazards.push(h);
        out.push(h);
        break;
      }
    }
    return out;
  };
  const tears = place(plan.tears, 'tear', 11, 16);
  const holes = place(plan.holes, 'hole', 16, 24);
  // Coils must start clear of everything deadly.
  for (const w of wires) {
    for (const p of w.pts) {
      if (hazards.some((h) => Math.hypot(h.x - p.x, h.y - p.y) < h.r + WIRE_R + 4)) return null;
    }
  }
  return { wires, crates, tears, holes };
}

// A wire bunched up a little way out from its anchor (far enough for the
// claw to reach): a loose coil, then some slack in a small S out to the
// plug. All within the bend limit.
const LEAD = 7; // straight segments before the coil starts
const COIL_TURN = 0.4; // radians per segment in the coil (a loose ~20-unit radius)
const S_TAIL = 16; // segments of S-shaped slack between the coil and the plug
const S_TURN = 0.3; // radians per segment in each half of the S
function makeWire(a, s, color, dist) {
  const len = dist * SLACK + EXTRA;
  const n = Math.ceil(len / SEG) + 1;
  const tail = Math.min(S_TAIL, Math.floor((n - LEAD) / 3));
  const pts = [{ x: a.x, y: a.y }];
  let ang = Math.atan2(a.ny, a.nx);
  const spin = Math.random() < 0.5 ? 1 : -1;
  for (let i = 1; i < n; i++) {
    const fromEnd = n - 1 - i; // segments left after this one
    if (fromEnd < tail) {
      // The S: first bend back against the coil, then the other way.
      ang += (fromEnd >= tail / 2 ? -spin : spin) * S_TURN;
    } else if (i > LEAD) ang += spin * rand(COIL_TURN - 0.02, COIL_TURN + 0.02);
    const p = pts[i - 1];
    pts.push({ x: p.x + Math.cos(ang) * SEG, y: p.y + Math.sin(ang) * SEG });
  }
  return { pts, color, ax: a.x, ay: a.y, anx: a.nx, any: a.ny, sx: s.x, sy: s.y, done: false, doneT: 0, tension: 0 };
}

function startBoard() {
  state.board++;
  const b = buildBoard(state.board);
  state.wires = b.wires;
  state.crates = b.crates;
  state.tears = b.tears;
  state.holes = b.holes;
  state.bot.x = BOT_START.x;
  state.bot.y = BOT_START.y;
  state.bot.tx = BOT_START.x;
  state.bot.ty = BOT_START.y;
  state.bot.grab = null;
  state.bot.taut = 0;
  state.clearT = 0;
}

// ---- Wire physics --------------------------------------------------------

// Push a point out of crates and keep it inside the walls.
function collidePoint(p) {
  const r = WIRE_R;
  for (const c of state.crates) {
    if (p.x > c.x - r && p.x < c.x + c.w + r && p.y > c.y - r && p.y < c.y + c.h + r) {
      const dl = p.x - (c.x - r);
      const dr = c.x + c.w + r - p.x;
      const dt = p.y - (c.y - r);
      const db = c.y + c.h + r - p.y;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) p.x = c.x - r;
      else if (m === dr) p.x = c.x + c.w + r;
      else if (m === dt) p.y = c.y - r;
      else p.y = c.y + c.h + r;
    }
  }
  p.x = clamp(p.x, WALL - 1, W - WALL + 1);
  p.y = clamp(p.y, WALL - 1, H - WALL + 1);
}

// Place `p` SEG away from `from`, in its current direction but bent no more
// than MAX_BEND from the direction `prev` -> `from` (when there is a prev).
function follow(p, from, prev, pull = null, k = 0) {
  let a = Math.atan2(p.y - from.y, p.x - from.x);
  // Under tension, segments swing toward the point pulling them: coils unwind.
  if (pull && k > 0) a += angDiff(a, Math.atan2(pull.y - from.y, pull.x - from.x)) * k;
  if (prev) {
    const base = Math.atan2(from.y - prev.y, from.x - prev.x);
    const d = angDiff(base, a);
    if (Math.abs(d) > MAX_BEND) a = base + Math.sign(d) * MAX_BEND;
  }
  p.x = from.x + Math.cos(a) * SEG;
  p.y = from.y + Math.sin(a) * SEG;
}

// Held wire: a chain solver (FABRIK). The held point goes to the claw, the
// first point stays on its anchor, every segment keeps its length and bends
// no more than MAX_BEND, and the wire snags on crates. The free tail trails
// behind. Returns how far the held point ended up from the claw: > 0 means
// the wire is pulled tight.
function solveWire(w, g, tx, ty, dt) {
  const pts = w.pts;
  const n = pts.length;
  const claw = { x: tx, y: ty };
  const old = pts.map((p) => ({ x: p.x, y: p.y }));
  for (let it = 0; it < ITERATIONS; it++) {
    const k = it === 0 ? (w.tension > 0.5 ? 0.12 : 0.03) : 0;
    // From the claw back to the anchor...
    pts[g].x = tx;
    pts[g].y = ty;
    for (let i = g - 1; i >= 0; i--) follow(pts[i], pts[i + 1], i + 2 <= g ? pts[i + 2] : null);
    // ...then from the anchor out to the claw.
    pts[0].x = w.ax;
    pts[0].y = w.ay;
    for (let i = 1; i <= g; i++) {
      follow(pts[i], pts[i - 1], i >= 2 ? pts[i - 2] : null, claw, k);
      collidePoint(pts[i]);
    }
  }
  // The tail beyond the held point trails along.
  for (let i = g + 1; i < n; i++) {
    follow(pts[i], pts[i - 1], pts[i - 2]);
    collidePoint(pts[i]);
  }
  w.tension = Math.hypot(pts[g].x - tx, pts[g].y - ty);
  // No point moves faster than a wire can be dragged: no whipping.
  const max = MAX_DRAG * dt;
  for (let i = 1; i < n; i++) {
    const dx = pts[i].x - old[i].x;
    const dy = pts[i].y - old[i].y;
    const d = Math.hypot(dx, dy);
    if (d > max && i !== g) {
      pts[i].x = old[i].x + (dx / d) * max;
      pts[i].y = old[i].y + (dy / d) * max;
    }
  }
  return w.tension;
}

// ---- Bot -----------------------------------------------------------------

// Move the bot by (dx, dy), sliding along crates and walls.
function moveBot(dx, dy) {
  const b = state.bot;
  const blocked = (x, y) =>
    botRects(x, y).some((r) => r.x < WALL || r.y < WALL || r.x + r.w > W - WALL || r.y + r.h > H - WALL || state.crates.some((c) => overlaps(r, c)));
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
  let hit = false;
  for (let s = 0; s < steps; s++) {
    const sx = dx / steps;
    const sy = dy / steps;
    if (!blocked(b.x + sx, b.y)) b.x += sx;
    else hit = true;
    if (!blocked(b.x, b.y + sy)) b.y += sy;
    else hit = true;
  }
  return hit;
}

// The wire point the claw would grab: the nearest one in reach, except that
// where loops of a coil overlap it takes the one closest to the plug end.
function nearestGrab() {
  const b = state.bot;
  const cands = [];
  for (const w of state.wires) {
    if (w.done) continue;
    for (let i = 1; i < w.pts.length; i++) {
      const d = Math.hypot(w.pts[i].x - b.x, w.pts[i].y - b.y);
      if (d < REACH) cands.push({ w, i, d });
    }
  }
  if (!cands.length) return null;
  const near = Math.min(...cands.map((c) => c.d));
  const close = cands.filter((c) => c.d <= near + 5);
  const w = close.find((c) => c.d === near).w;
  return close.filter((c) => c.w === w).reduce((a, c) => (c.i > a.i ? c : a));
}

function toggleGrab() {
  if (state.phase !== 'playing' || state.clearT > 0) return;
  const b = state.bot;
  if (b.grab) {
    b.grab = null;
    play(() => sfx('release'));
    return;
  }
  const g = nearestGrab();
  if (!g) {
    play(() => sfx('miss'));
    if (!silent) text(b.x, b.y - 54, 'Nothing in reach', INK.pencil, 10);
    return;
  }
  b.grab = { w: g.w, i: g.i };
  play(() => sfx('grab'));
}

// ---- Update --------------------------------------------------------------

function play(fn) {
  if (!silent) fn();
}

function update(dt) {
  state.shake = Math.max(0, state.shake - dt * 2.5);
  updateEffects(dt);
  for (const w of state.wires) if (w.done) w.doneT += dt;
  for (const h of [...state.tears, ...state.holes]) h.phase += dt;

  if (state.phase === 'countdown') {
    const before = Math.ceil(state.countdown - 0.5);
    state.countdown -= dt;
    const after = Math.ceil(state.countdown - 0.5);
    if (after !== before) {
      if (after > 0) play(() => audio.sfx('count'));
      else if (after === 0) {
        play(() => audio.sfx('go'));
        state.phase = 'playing';
        state.goT = 0;
        play(() => audio.playSong(SONG));
      }
    }
  }

  if (state.phase === 'playing') {
    state.goT += dt;
    if (state.clearT > 0) {
      state.clearT -= dt;
      if (state.clearT <= 0) startBoard();
      return;
    }
    state.played += dt;
    state.timeLeft -= dt;
    if (state.timeLeft <= 5 && Math.ceil(state.timeLeft) !== state.tickT) {
      state.tickT = Math.ceil(state.timeLeft);
      if (state.tickT > 0) play(() => audio.sfx('tick'));
    }
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      end('time');
      return;
    }
    updateBot(dt);
    if (state.phase !== 'playing') return;
    checkHazards();
  } else if (state.phase === 'over') {
    state.overT += dt;
    if (state.overT > 1.3 && !silent) finish();
  }
}

function updateBot(dt) {
  const b = state.bot;
  let vx = 0;
  let vy = 0;
  if (autoAct) {
    autoAcc += dt;
    if (autoAcc >= 0.1) {
      autoAcc = 0;
      autoAct(state);
    }
  }
  if (silent || autoAct) {
    vx = state.input.x;
    vy = state.input.y;
    if (state.input.grab) {
      state.input.grab = false;
      toggleGrab();
    }
  } else {
    const k = keyMove();
    if (k.x || k.y) {
      vx = k.x;
      vy = k.y;
      b.tx = b.x;
      b.ty = b.y;
    } else if (drag) {
      // Drag is relative: the bot heads for where the drag says, at its own pace.
      const dx = drag.bx + (drag.x - drag.sx) - b.x;
      const dy = drag.by + (drag.y - drag.sy) - b.y;
      const d = Math.hypot(dx, dy);
      if (d > 1) {
        vx = dx / Math.max(d, 12);
        vy = dy / Math.max(d, 12);
      }
    }
  }
  const m = Math.hypot(vx, vy);
  if (m > 1) {
    vx /= m;
    vy /= m;
  }
  b.moving = m > 0.05;
  const sx = b.x;
  const sy = b.y;
  moveBot(vx * BOT_SPEED * dt, vy * BOT_SPEED * dt);
  const mx = b.x - sx;
  const my = b.y - sy;

  // Wires.
  b.taut = Math.max(0, b.taut - dt * 3);
  for (const w of state.wires) {
    if (w.done) continue;
    // Wires lie still on the floor unless held.
    if (!b.grab || b.grab.w !== w) continue;
    const g = b.grab.i;
    const before = w.pts.map((p) => ({ x: p.x, y: p.y }));
    let off = solveWire(w, g, b.x, b.y, dt);
    if (off > 1 && (mx || my)) {
      // At full stretch the wire won't give, so the bot simply can't go that
      // way. It never gets dragged: try sliding along one axis, else stay put.
      const tries = [[mx, 0], [0, my], [0, 0]];
      for (const [tx, ty] of tries) {
        w.pts.forEach((p, k) => {
          p.x = before[k].x;
          p.y = before[k].y;
        });
        b.x = sx;
        b.y = sy;
        if (tx || ty) moveBot(tx, ty);
        off = solveWire(w, g, b.x, b.y, dt);
        if (off <= 1) break;
      }
      b.taut = 1;
    }
    // Plugged in?
    const end = w.pts[w.pts.length - 1];
    if (Math.hypot(end.x - w.sx, end.y - w.sy) < SNAP) connect(w);
  }
}

function connect(w) {
  w.done = true;
  w.doneT = 0;
  const end = w.pts[w.pts.length - 1];
  end.x = w.sx;
  end.y = w.sy;
  if (state.bot.grab && state.bot.grab.w === w) state.bot.grab = null;
  state.score++;
  play(() => sfx('connect'));
  if (!silent) {
    burst(w.sx, w.sy, 10, w.color.ink);
    text(w.sx, w.sy - 24, 'Connected!', w.color.ink, 13);
    hudScore.classList.remove('bump');
    void hudScore.offsetWidth;
    hudScore.classList.add('bump');
  }
  if (state.wires.every((o) => o.done)) {
    state.timeLeft += CLEAR_BONUS;
    state.clearT = 1.6;
    play(() => sfx('clear'));
    if (!silent) text(W / 2, H / 2, `Board clear! +${CLEAR_BONUS}s`, INK.green, 22);
  }
}

// Losing: the bot or any loose wire touching a tear or a hole.
function checkHazards() {
  const b = state.bot;
  const rects = botRects(b.x, b.y);
  for (const h of [...state.tears, ...state.holes]) {
    const r = h.kind === 'hole' ? h.r * 0.85 : h.r;
    if (rects.some((q) => rectDist(h.x, h.y, q) < r)) return end(h.kind, h, b.x, b.y);
    for (const w of state.wires) {
      if (w.done) continue;
      for (const p of w.pts) {
        if (Math.hypot(p.x - h.x, p.y - h.y) < r + WIRE_R * 0.5) return end(h.kind, h, p.x, p.y, w);
      }
    }
  }
}

function end(cause, h, x, y, w) {
  state.phase = 'over';
  state.overT = 0;
  state.cause = { kind: cause, wire: !!w };
  play(() => audio.stopSong());
  if (cause === 'time') {
    play(() => sfx('timeUp'));
    return;
  }
  state.shake = 1;
  play(() => sfx(cause === 'tear' ? 'zap' : 'fall'));
  if (!silent) {
    burst(x, y, 16, cause === 'tear' ? '#8a3fc4' : INK.marker);
    text(x, y - 20, cause === 'tear' ? 'ZAP!' : 'Whoops!', cause === 'tear' ? '#8a3fc4' : INK.red, 16);
  }
}

// ---- Effects -------------------------------------------------------------

function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(20, 80);
    state.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.4, 0.8), size: rand(2.5, 5), rot: Math.random() * 6, vr: rand(-8, 8), color });
  }
}

function text(x, y, str, color, size = 12) {
  state.texts.push({ x, y, text: str, color, size, t: 0 });
}

function updateEffects(dt) {
  for (const p of state.particles) {
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - dt * 2;
    p.vy *= 1 - dt * 2;
    p.rot += p.vr * dt;
  }
  state.particles = state.particles.filter((p) => p.t < p.life);
  for (const t of state.texts) t.t += dt;
  state.texts = state.texts.filter((t) => t.t < 1.4);
}

// ---- Input ---------------------------------------------------------------

// Drag anywhere to move the bot (relative, like a trackpad). Grabbing is
// only on the Grab button (or Space), so a drag never grabs by accident.
let drag = null;

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale };
}

canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  if (drag) return; // one finger steers
  const p = toWorld(e);
  drag = { id: e.pointerId, sx: p.x, sy: p.y, x: p.x, y: p.y, bx: state.bot.x, by: state.bot.y };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* fine without capture */
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const p = toWorld(e);
  drag.x = p.x;
  drag.y = p.y;
});
const release = (e) => {
  if (drag && e.pointerId === drag.id) drag = null;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);

// The Grab / Release button under the board. It reacts on press, so it can
// be hit with a second finger while the first one steers.
const grabBtn = document.createElement('button');
grabBtn.type = 'button';
grabBtn.className = 'paper-btn grab-btn';
grabBtn.textContent = 'Grab';
grabBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  toggleGrab();
});
grabBtn.addEventListener('click', (e) => {
  // Keyboard activation (Enter/Space on the focused button); pointer presses
  // already toggled on pointerdown.
  if (e.detail === 0) toggleGrab();
});
shell.appendChild(grabBtn);

let grabLook = '';
function updateGrabButton() {
  const playing = state.phase === 'playing' || state.phase === 'countdown';
  const holding = !!state.bot.grab;
  const ready = !holding && state.phase === 'playing' && !!nearestGrab();
  const look = `${playing}|${holding}|${ready}`;
  if (look === grabLook) return;
  grabLook = look;
  grabBtn.hidden = !playing;
  grabBtn.textContent = holding ? 'Release' : 'Grab';
  grabBtn.classList.toggle('holding', holding);
  grabBtn.classList.toggle('ready', ready);
}

const keys = new Set();
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k) && state.phase === 'playing') e.preventDefault();
  if ((k === ' ' || k === 'e') && !e.repeat && state.phase === 'playing') toggleGrab();
  keys.add(k);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => {
  keys.clear();
  drag = null;
});

function keyMove() {
  const k = (...ks) => ks.some((x) => keys.has(x));
  return {
    x: (k('arrowright', 'd') ? 1 : 0) - (k('arrowleft', 'a') ? 1 : 0),
    y: (k('arrowdown', 's') ? 1 : 0) - (k('arrowup', 'w') ? 1 : 0),
  };
}

// ---- Sound ---------------------------------------------------------------

function sfx(name) {
  const n = noteFreq;
  switch (name) {
    case 'grab':
      audio.tone({ wave: 'pulse25', freq: n('C5'), freqEnd: n('G5'), dur: 0.06, vol: 0.15 });
      audio.noise({ dur: 0.04, vol: 0.08, rate: 1.2 });
      break;
    case 'release':
      audio.tone({ wave: 'pulse25', freq: n('G5'), freqEnd: n('C5'), dur: 0.06, vol: 0.12 });
      break;
    case 'miss':
      audio.tone({ wave: 'pulse12', freq: n('C3'), dur: 0.06, vol: 0.1 });
      break;
    case 'connect':
      ['C5', 'E5', 'G5', 'C6'].forEach((note, i) => audio.tone({ wave: 'pulse25', freq: n(note), dur: 0.06, vol: 0.16, at: i * 0.05 }));
      audio.noise({ dur: 0.05, vol: 0.1, rate: 2 });
      break;
    case 'clear':
      ['G4', 'C5', 'E5', 'G5', 'C6'].forEach((note, i) => audio.tone({ wave: 'pulse50', freq: n(note), dur: i === 4 ? 0.3 : 0.08, vol: 0.16, at: 0.25 + i * 0.08 }));
      break;
    case 'zap':
      audio.tone({ wave: 'pulse12', freq: n('C7'), freqEnd: n('C2'), dur: 0.6, vol: 0.2, vibrato: 0.2 });
      audio.noise({ dur: 0.8, vol: 0.3, rate: 2, rateEnd: 0.1 });
      break;
    case 'fall':
      audio.tone({ wave: 'pulse50', freq: n('C6'), freqEnd: n('C3'), dur: 0.8, vol: 0.18 });
      audio.noise({ dur: 0.3, vol: 0.25, rate: 0.3, at: 0.75 });
      break;
    case 'timeUp':
      audio.tone({ wave: 'pulse50', freq: n('A4'), dur: 0.5, vol: 0.2 });
      break;
    default:
      break;
  }
}

// A busy little workshop loop.
const SONG = {
  bpm: 132,
  stepsPerBeat: 4,
  wave1: 'pulse25',
  wave2: 'pulse12',
  vol1: 0.07,
  vol2: 0.05,
  tracks: {
    p1: 'E5 . G5 . A5 . G5 E5 . . D5 . E5 . . . C5 . E5 . G5 . E5 C5 . . D5 . C5 . A4 .',
    p2: 'A4 C5 E5 C5 A4 C5 E5 C5 G4 B4 D5 B4 G4 B4 D5 B4 F4 A4 C5 A4 F4 A4 C5 A4 G4 B4 D5 B4 G4 B4 D5 B4',
    tri: 'A2 . A2 . A3 . A2 . G2 . G2 . G3 . G2 . F2 . F2 . F3 . F2 . G2 . G2 . G3 . B2 .',
    noise: 'k . h . s . h h k . h k s . h h',
  },
};

// ---- Render --------------------------------------------------------------

function render() {
  layout();
  const { scale, ox, oy, cw, ch, dpr } = view;
  let sx = 0;
  let sy = 0;
  if (state.shake > 0) {
    sx = (Math.random() - 0.5) * state.shake * 6;
    sy = (Math.random() - 0.5) * state.shake * 6;
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
  graphPaper(ctx, -ox / scale - 10, -oy / scale - 10, cw / scale + 20, ch / scale + 20, 10, 4);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawBoard();
  for (const h of state.holes) drawHole(h);
  for (const c of state.crates) drawCrate(c);
  for (const w of state.wires) drawSocket(w);
  for (const w of state.wires) if (w.done) drawWire(w);
  for (const w of state.wires) if (!w.done) drawWire(w);
  for (const w of state.wires) drawAnchor(w);
  for (const h of state.tears) drawTear(h);
  drawBot();
  drawParticles();
  drawTexts();
  if (state.phase === 'countdown' || (state.phase === 'playing' && state.goT < 0.6)) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCountdown(cw, ch);
  }
  updateHud();
  updateGrabButton();
}

function drawBoard() {
  // Walls: a hatched border around the floor.
  ctx.fillStyle = '#efe9d8';
  ctx.fillRect(0, 0, W, WALL);
  ctx.fillRect(0, H - WALL, W, WALL);
  ctx.fillRect(0, 0, WALL, H);
  ctx.fillRect(W - WALL, 0, WALL, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(WALL, WALL, W - WALL * 2, H - WALL * 2);
  ctx.clip('evenodd');
  ctx.strokeStyle = 'rgba(85, 83, 78, 0.35)';
  ctx.lineWidth = 1;
  hatch(ctx, 0, 0, W, H, { gap: 6, seed: 3 });
  ctx.restore();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4;
  sketchRect(ctx, 0, 0, W, H, 11, { wobble: 1.2 });
  ctx.lineWidth = 1.6;
  sketchRect(ctx, WALL, WALL, W - WALL * 2, H - WALL * 2, 12, { wobble: 1 });
}

function drawCrate(c) {
  ctx.fillStyle = '#e2c08e';
  ctx.fillRect(c.x, c.y, c.w, c.h);
  ctx.strokeStyle = 'rgba(120, 80, 30, 0.35)';
  ctx.lineWidth = 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(c.x, c.y, c.w, c.h);
  ctx.clip();
  hatch(ctx, c.x, c.y, c.w, c.h, { gap: 7, angle: 0, seed: c.seed });
  ctx.restore();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  sketchRect(ctx, c.x, c.y, c.w, c.h, c.seed, { wobble: 1 });
  ctx.lineWidth = 1.4;
  sketchLine(ctx, c.x + 4, c.y + 4, c.x + c.w - 4, c.y + c.h - 4, c.seed + 1, { wobble: 1, passes: 1 });
  sketchLine(ctx, c.x + c.w - 4, c.y + 4, c.x + 4, c.y + c.h - 4, c.seed + 2, { wobble: 1, passes: 1 });
}

function blobPath(h, scale) {
  const r = rng(h.seed);
  const n = 12;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = h.r * scale * (0.88 + (i === n ? 0 : 0) + r() * 0.24);
    const px = h.x + Math.cos(a) * rr;
    const py = h.y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// A hole in the floor: a jagged dark pit with a cracked rim.
function drawHole(h) {
  blobPath(h, 1.15);
  ctx.fillStyle = 'rgba(85, 83, 78, 0.25)';
  ctx.fill();
  blobPath(h, 1);
  const g = ctx.createRadialGradient(h.x, h.y, 1, h.x, h.y, h.r);
  g.addColorStop(0, '#0d0c0b');
  g.addColorStop(0.7, '#24221f');
  g.addColorStop(1, '#55534e');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Cracks.
  const r = rng(h.seed + 5);
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 4; i++) {
    const a = r() * Math.PI * 2;
    const x0 = h.x + Math.cos(a) * h.r * 1.05;
    const y0 = h.y + Math.sin(a) * h.r * 1.05;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.cos(a + 0.4) * 6, y0 + Math.sin(a + 0.4) * 6);
    ctx.lineTo(x0 + Math.cos(a - 0.2) * 11, y0 + Math.sin(a - 0.2) * 11);
    ctx.stroke();
  }
}

// A space-time tear: a black orb with a glowing purple aura.
function drawTear(h) {
  const pulse = 0.5 + 0.5 * Math.sin(h.phase * 3);
  const aura = h.r * (2.1 + pulse * 0.35);
  const g = ctx.createRadialGradient(h.x, h.y, h.r * 0.6, h.x, h.y, aura);
  g.addColorStop(0, 'rgba(176, 90, 255, 0.85)');
  g.addColorStop(0.45, 'rgba(150, 70, 230, 0.35)');
  g.addColorStop(1, 'rgba(150, 70, 230, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(h.x, h.y, aura, 0, Math.PI * 2);
  ctx.fill();
  // Swirling sparks.
  ctx.fillStyle = '#d9b3ff';
  for (let i = 0; i < 5; i++) {
    const a = h.phase * (1.4 + i * 0.13) + i * 1.3;
    const rr = h.r * (1.25 + 0.35 * Math.sin(h.phase * 2 + i));
    ctx.beginPath();
    ctx.arc(h.x + Math.cos(a) * rr, h.y + Math.sin(a) * rr, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
  ctx.fillStyle = '#060509';
  ctx.fill();
  ctx.strokeStyle = '#8a3fc4';
  ctx.lineWidth = 2;
  sketchCircle(ctx, h.x, h.y, h.r, h.seed, { wobble: 0.6, passes: 1 });
  // A faint crack of light through the middle.
  ctx.strokeStyle = `rgba(200, 150, 255, ${0.4 + pulse * 0.4})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const r = rng(h.seed);
  const a = r() * Math.PI;
  ctx.moveTo(h.x - Math.cos(a) * h.r * 0.7, h.y - Math.sin(a) * h.r * 0.7);
  ctx.lineTo(h.x + Math.cos(a + 0.5) * h.r * 0.15, h.y + Math.sin(a + 0.5) * h.r * 0.15);
  ctx.lineTo(h.x + Math.cos(a) * h.r * 0.7, h.y + Math.sin(a) * h.r * 0.7);
  ctx.stroke();
}

function drawSymbol(sym, x, y, s, fill, stroke) {
  ctx.beginPath();
  if (sym === 'circle') ctx.arc(x, y, s, 0, Math.PI * 2);
  else if (sym === 'square') ctx.rect(x - s * 0.85, y - s * 0.85, s * 1.7, s * 1.7);
  else if (sym === 'triangle') {
    ctx.moveTo(x, y - s * 1.05);
    ctx.lineTo(x + s, y + s * 0.75);
    ctx.lineTo(x - s, y + s * 0.75);
    ctx.closePath();
  } else if (sym === 'diamond') {
    ctx.moveTo(x, y - s * 1.15);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s * 1.15);
    ctx.lineTo(x - s, y);
    ctx.closePath();
  } else {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? s * 0.5 : s * 1.15;
      if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

// A socket plate on the floor.
function drawSocket(w) {
  const now = performance.now() / 1000;
  const held = state.bot.grab && state.bot.grab.w === w;
  ctx.fillStyle = '#fff';
  ctx.fillRect(w.sx - 12, w.sy - 12, 24, 24);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.8;
  sketchRect(ctx, w.sx - 12, w.sy - 12, 24, 24, Math.floor(w.sx * 7 + w.sy), { wobble: 0.6, passes: 1 });
  ctx.fillStyle = INK.marker;
  for (const [dx, dy] of [[-9, -9], [9, -9], [-9, 9], [9, 9]]) {
    ctx.beginPath();
    ctx.arc(w.sx + dx, w.sy + dy, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!w.done && held) {
    ctx.globalAlpha = 0.4 + 0.4 * Math.abs(Math.sin(now * 5));
    ctx.strokeStyle = w.color.ink;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(w.sx, w.sy, SNAP + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  drawSymbol(w.color.sym, w.sx, w.sy, 7, w.done ? w.color.ink : w.color.light, w.color.ink);
}

function drawAnchor(w) {
  ctx.save();
  ctx.translate(w.ax, w.ay);
  ctx.rotate(Math.atan2(w.any, w.anx) - Math.PI / 2);
  ctx.fillStyle = '#d8d4c8';
  ctx.fillRect(-9, -6, 18, 12);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.8;
  ctx.strokeRect(-9, -6, 18, 12);
  ctx.fillStyle = w.color.ink;
  ctx.fillRect(-9, 2, 18, 4);
  ctx.restore();
}

function drawWire(w) {
  const pts = w.pts;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const e = pts[pts.length - 1];
    ctx.lineTo(e.x, e.y);
  };
  ctx.globalAlpha = w.done ? 0.55 : 1;
  path();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = WIRE_R * 2 + 2;
  ctx.stroke();
  path();
  ctx.strokeStyle = w.color.ink;
  ctx.lineWidth = WIRE_R * 2 - 0.5;
  ctx.stroke();
  // The plug: a small block on the free end, pointing along the wire.
  const e = pts[pts.length - 1];
  const p = pts[pts.length - 2];
  const a = Math.atan2(e.y - p.y, e.x - p.x);
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.rotate(a);
  ctx.fillStyle = '#fff';
  ctx.fillRect(-9, -5, 11, 10);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-9, -5, 11, 10);
  ctx.beginPath();
  ctx.moveTo(2, -2.5);
  ctx.lineTo(6, -2.5);
  ctx.moveTo(2, 2.5);
  ctx.lineTo(6, 2.5);
  ctx.stroke();
  ctx.restore();
  drawSymbol(w.color.sym, e.x - Math.cos(a) * 3.5, e.y - Math.sin(a) * 3.5, 3, w.color.ink, null);
  ctx.globalAlpha = 1;
}

function drawBot() {
  const b = state.bot;
  const now = performance.now() / 1000;
  // Reach circle and the point it would grab.
  if (state.phase === 'playing' && !b.grab) {
    const g = nearestGrab();
    ctx.strokeStyle = g ? 'rgba(46, 158, 79, 0.8)' : 'rgba(85, 83, 78, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, REACH, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (g) {
      const p = g.w.pts[g.i];
      ctx.strokeStyle = INK.green;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 + Math.sin(now * 8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const jig = b.taut > 0 ? Math.sin(now * 60) * b.taut * 0.8 : 0;
  ctx.save();
  ctx.translate(b.x + jig, b.y);
  // Wheels on either side of the arm.
  ctx.fillStyle = INK.marker;
  for (const [wx, wy] of [[-8, -32], [8, -32], [-8, -12], [8, -12]]) {
    ctx.beginPath();
    ctx.ellipse(wx, wy, 2.4, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // The arm.
  const arm = PARTS[0];
  ctx.fillStyle = '#c9d6e3';
  ctx.fillRect(arm.x, arm.y, arm.w, arm.h);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  sketchRect(ctx, arm.x, arm.y, arm.w, arm.h, 40, { wobble: 0.7, passes: 1 });
  // Face at the top, and a light that turns red when a wire is pulled tight.
  ctx.fillStyle = INK.marker;
  ctx.beginPath();
  ctx.arc(-3, -32, 1.6, 0, Math.PI * 2);
  ctx.arc(3, -32, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = b.taut > 0.2 ? INK.red : INK.green;
  ctx.fillRect(-2.5, -24, 5, 5);
  // Claw: open when empty, closed when holding.
  const open = b.grab ? 1 : 4;
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.2;
  ctx.fillStyle = '#9aa7b5';
  ctx.fillRect(-6, -6, 12, 5);
  ctx.strokeRect(-6, -6, 12, 5);
  ctx.beginPath();
  ctx.moveTo(-4, -1);
  ctx.lineTo(-open - 1, 4);
  ctx.moveTo(4, -1);
  ctx.lineTo(open + 1, 4);
  ctx.stroke();
  ctx.restore();
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 0.8;
    ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
    ctx.restore();
  }
}

function drawTexts() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of state.texts) {
    ctx.globalAlpha = Math.max(0, 1 - t.t / 1.4);
    ctx.font = `bold ${t.size}px ${HAND_FONT}`;
    const y = t.y - t.t * 16;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(t.text, t.x, y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawCountdown(w, h) {
  const n = state.phase === 'countdown' ? Math.ceil(state.countdown - 0.5) : 0;
  const label = n > 0 ? String(n) : 'GO!';
  const frac = n > 0 ? state.countdown - 0.5 - Math.floor(state.countdown - 0.5) : state.goT / 0.6;
  ctx.save();
  ctx.globalAlpha = n > 0 ? 1 : Math.max(0, 1 - frac);
  ctx.translate(w / 2, h / 2);
  ctx.scale(1 + frac * 0.4, 1 + frac * 0.4);
  ctx.rotate(-0.05);
  ctx.font = `bold 84px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = n > 0 ? INK.marker : INK.blue;
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

const starsFor = (wires) => STAR_WIRES.filter((t) => wires >= t).length;

let lastHud = '';
let hudStarCount = -1;
function updateHud() {
  const secs = Math.ceil(state.timeLeft);
  const key = `${secs}|${state.score}`;
  if (key === lastHud) return;
  lastHud = key;
  hudTime.textContent = formatTime(secs);
  hudTime.classList.toggle('low', secs <= 10);
  hudScore.textContent = `${state.score} 🔌`;
  const stars = starsFor(state.score);
  if (stars !== hudStarCount) {
    if (stars > hudStarCount && hudStarCount >= 0 && stars > 0) audio.sfx('star');
    hudStarCount = stars;
    hudStars.innerHTML = '';
    hudStars.append(renderStars(stars, { mini: true }));
  }
}

// ---- Flow ----------------------------------------------------------------

function showStart() {
  const rec = getRecord(GAME_ID);
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h1>Reconnet</h1>
    <p>Plug each loose wire into the socket that matches its colour and symbol before time runs out.</p>
    <p class="subtle"><b>Drag</b> anywhere to move your bot. Press <b>Grab</b> to grab the wire nearest its claw, anywhere along it, and <b>Release</b> to let go. Wires are stiff and can't stretch, and they snag on crates.<br>Keyboard: arrows / WASD to move, Space to grab or release.</p>
    <p class="subtle">Don't let your bot or a wire touch a <b style="color:#8a3fc4">space-time tear</b> or a <b>hole</b>. Clear a board for +${CLEAR_BONUS}s.</p>
    <ul class="star-goals"></ul>
    <div class="best"></div>
    <div class="actions"><button class="paper-btn primary" type="button">Start</button></div>`;
  const goals = card.querySelector('.star-goals');
  STAR_WIRES.forEach((t, i) => {
    const li = document.createElement('li');
    li.append(renderStars(i + 1, { mini: true }), `Reconnect ${t} wires`);
    goals.appendChild(li);
  });
  if (rec.plays > 0) {
    const p = document.createElement('p');
    p.className = 'subtle';
    p.textContent = `Best: ${formatScore(rec.highScore)} · Last: ${formatScore(rec.recentScore)}`;
    card.querySelector('.best').append(p);
  }
  card.querySelector('button').addEventListener('click', start);
  overlay.appendChild(card);
  overlay.hidden = false;
}

function start() {
  audio.unlock();
  audio.sfx('start');
  state = newState();
  startBoard();
  state.phase = 'countdown';
  overlay.hidden = true;
  lastHud = '';
  hudStarCount = -1;
}

function finish() {
  if (state.phase === 'done') return;
  const s = state;
  s.phase = 'done';
  audio.stopSong();
  const score = s.score;
  const stars = starsFor(score);
  const { record, newHigh, newBestStars } = saveResult(GAME_ID, score, stars);
  setTimeout(() => audio.sfx(stars === 0 ? 'lose' : 'win'), 150);
  const c = s.cause || { kind: 'time' };
  const title =
    c.kind === 'time' ? "Time's up!"
      : c.kind === 'tear' ? (c.wire ? 'A wire hit a tear!' : 'Zapped by a tear!')
        : c.wire ? 'A wire fell in a hole!' : 'Your bot fell in a hole!';
  let note = `Board ${s.board} · ${formatTime(s.played)} played.`;
  if (stars < 3) note += ` Next star at ${STAR_WIRES[stars]} wires.`;
  showResults(overlay, {
    title,
    scoreText: `${score} wire${score === 1 ? '' : 's'}`,
    stars,
    newHigh: newHigh && score > 0,
    newBestStars,
    record,
    formatScore,
    note,
    onRetry: start,
  });
}

addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !overlay.hidden && document.activeElement?.tagName !== 'BUTTON' && document.activeElement?.tagName !== 'A') {
    if (state.phase === 'ready' || state.phase === 'done') start();
  }
});

// ---- Loop ----------------------------------------------------------------

state = newState();
startBoard();
layout();
showStart();

if (new URLSearchParams(location.search).has('debug')) {
  window.reconnet = {
    get state() { return state; },
    start,
    consts: { W, H, SEG, REACH, SNAP, BOT_SPEED, PARTS, WALL },
    botRects,
    // Jump to board n (for checking generation and later boards).
    board(n) {
      state.board = n - 1;
      startBoard();
      return state;
    },
    autoplay(act) {
      autoAct = act;
    },
    // Fast-forward a run for balance testing. act(state) is called every
    // `every` seconds and steers by setting state.input = { x, y, grab }.
    sim(seconds, act, every = 0.1) {
      silent = true;
      state = newState();
      startBoard();
      state.phase = 'playing';
      let acc = 0;
      const dt = 1 / 60;
      for (let i = 0; i < seconds / dt && state.phase === 'playing'; i++) {
        update(dt);
        acc += dt;
        if (acc >= every) {
          acc -= every;
          act(state);
        }
      }
      silent = false;
      const r = { score: state.score, board: state.board, played: Math.round(state.played), cause: state.cause?.kind ?? 'running' };
      state = newState();
      startBoard();
      return r;
    },
  };
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
