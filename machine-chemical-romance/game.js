import { INK, HAND_FONT, rng, sketchLine, sketchRect, hatch, graphPaper, fitCanvas } from '../shared/paper.js';
import { audio, noteFreq } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'machine-chemical-romance';
const STAR_POINTS = [2000, 2500, 3000]; // points for 1, 2 and 3 stars
let ROUND_TIME = 120; // seconds on the clock at the start

// Points and time.
const PTS_COLLECT = 10; // seeing a machine's formula
const PTS_SYNTH = 25; // a chemical finishing in the synthesizer
const PTS_DELIVER = 100; // a right chemical delivered
const TIME_DELIVER = 10; // seconds it adds to the clock
const TIME_PENALTY = 10; // seconds lost for a missed request or a wrong formula

// Requests. It gets harder the longer you last: request timers shrink and
// formulas grow.
let REQ_TIME = [22, 45]; // seconds to fill a request at the start (varies per request)
let REQ_SHRINK = 180; // timers shrink by 1/REQ_SHRINK per second played...
let REQ_FLOOR = 0.25; // ...down to this fraction of the start
let REQ_MIN = 25; // but a request never gets less than this many seconds
const REQ_GAP = [3, 7]; // seconds before a machine asks again
const FIRST_REQ = [1.5, 5, 9]; // when each machine first asks
let FORMULA_STEP = 30; // seconds per extra symbol
let FORMULA_MAX = 8;
const formulaLength = (t) => Math.min(FORMULA_MAX, 3 + Math.floor(t / FORMULA_STEP));
const reqTimeScale = (t) => Math.max(REQ_FLOOR, 1 - t / REQ_SHRINK);
const SYMBOLS = ['circle', 'triangle', 'square', 'diamond', 'star'];

// Synthesizer.
const SYNTH_SLOTS = 2; // orders queued, brewing or waiting on the rack
const BREW_TIME = 2.5; // seconds to brew any formula, however long
const MAX_SYMBOLS = 8; // the longest formula a machine asks for

// Player.
const WALK_SPEED = 300; // units/s
const REACH = 26; // how close to a station's edge counts as "at" it

// ---- World ---------------------------------------------------------------

const W = 400;
const H = 480;
const TOP_PAD = 60;
const BOTTOM_PAD = 12; // screen px

const MACHINES = [
  { name: 'Crusher', color: '#d9412b', light: '#f6c3b9', x: 400 / 6 },
  { name: 'Smelter', color: '#e08a12', light: '#f8ddb2', x: 200 },
  { name: 'Centrifuge', color: '#2f6fc0', light: '#c3d8f3', x: (400 * 5) / 6 },
];
const MACHINE_Y = 120;
const MACHINE_W = 400 / 3; // the three machines form one wall, no gaps to get stuck in
const MACHINE_H = 74;
// The synthesizer and the bin sit flush against the bottom wall (and the bin
// in the corner), so there's no space behind them to wander into.
const SYNTH_BOX = { x: 200 - 70, y: H - 72, w: 140, h: 72 };
const BIN_BOX = { x: 0, y: H - 56, w: 50, h: 56 };
const PLAYER_START = { x: 200, y: 300 };

const shell = document.getElementById('shell');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const synthEl = document.getElementById('synth');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;
const formatTime = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = '<span class="hud-time" aria-label="Time left">2:00</span><span class="hud-score" aria-label="Score">0</span><span class="hud-stars"></span>';
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
const sameFormula = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const machineBox = (m) => ({ x: m.x - MACHINE_W / 2, y: MACHINE_Y - MACHINE_H / 2, w: MACHINE_W, h: MACHINE_H });
const rectDist = (px, py, r) => Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.w)), Math.max(r.y - py, 0, py - (r.y + r.h)));

// ---- State ---------------------------------------------------------------

let state;
let silent = false; // true while the balance sim runs

function newState() {
  return {
    phase: 'ready',
    countdown: 3.5,
    goT: 1,
    timeLeft: ROUND_TIME,
    t: 0,
    score: 0,
    stats: { collected: 0, made: 0, delivered: 0, missed: 0, wrong: 0, dumped: 0, timeAdded: 0 },
    machines: MACHINES.map((d, i) => ({ ...d, i, req: null, nextT: FIRST_REQ[i], runT: 0, sputterT: 0, flash: 0 })),
    jobs: [], // synthesizer: { formula, machine, t, total, ready }
    player: { x: PLAYER_START.x, y: PLAYER_START.y, tx: null, ty: null, path: [], carry: null, face: 1, walkT: 0 },
    at: null, // station the player is standing at
    input: { tx: null, ty: null, synth: null, take: null }, // set by the bot in the sim
    particles: [],
    texts: [],
    shake: 0,
    overT: 0,
    tickT: 0,
    ore: Array.from({ length: 14 }, (_, k) => ({ x: k * 30, seed: k * 13 + 7 })),
  };
}


function addScore(n, x, y, color) {
  state.score = Math.max(0, state.score + n);
  if (!silent) {
    text(x, y, n >= 0 ? `+${n}` : `${n}`, color || (n >= 0 ? INK.green : INK.red), n >= 100 ? 16 : 12);
    hudScore.classList.remove('bump');
    void hudScore.offsetWidth;
    hudScore.classList.add('bump');
  }
}

function addTime(n, x, y) {
  state.timeLeft += n;
  state.stats.timeAdded += n;
  if (!silent) text(x, y, `+${n}s`, INK.blue, 13);
}

function loseTime(x, y) {
  state.timeLeft = Math.max(0, state.timeLeft - TIME_PENALTY);
  if (!silent) text(x, y, `-${TIME_PENALTY}s`, INK.red, 13);
}


// ---- Requests --------------------------------------------------------------

function newRequest(m) {
  const len = formulaLength(state.t);
  const formula = Array.from({ length: len }, () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
  const total = Math.max(REQ_MIN, rand(...REQ_TIME) * reqTimeScale(state.t));
  m.req = { formula, time: total, total, seen: false };
  play(() => sfx('request'));
}

function updateMachines(dt) {
  for (const m of state.machines) {
    m.runT = Math.max(0, m.runT - dt);
    m.sputterT = Math.max(0, m.sputterT - dt);
    m.flash = Math.max(0, m.flash - dt);
    if (!m.req) {
      m.nextT -= dt;
      if (m.nextT <= 0) newRequest(m);
      continue;
    }
    m.req.time -= dt;
    if (m.req.time <= 0) {
      // Missed it.
      m.req = null;
      m.nextT = rand(...REQ_GAP);
      m.sputterT = 1.5;
      state.stats.missed++;
      loseTime(m.x, MACHINE_Y - 60);
      play(() => sfx('miss'));
      if (!silent) burst(m.x, MACHINE_Y - 10, 8, '#999');
    }
  }
}

// ---- Synthesizer -------------------------------------------------------------

function synthesize(formula, machine) {
  if (state.at !== 'synth' || state.jobs.length >= SYNTH_SLOTS || !formula.length || machine == null) return false;
  state.jobs.push({ formula: [...formula], machine, t: 0, total: BREW_TIME, ready: false });
  play(() => sfx('brew'));
  return true;
}

function updateJobs(dt) {
  // One at a time, in order.
  const job = state.jobs.find((j) => !j.ready);
  if (!job) return;
  job.t += dt;
  if (job.t >= job.total) {
    job.ready = true;
    state.stats.made++;
    addScore(PTS_SYNTH, SYNTH_BOX.x + SYNTH_BOX.w / 2, SYNTH_BOX.y - 10);
    play(() => sfx('ready'));
    if (!silent) burst(SYNTH_BOX.x + SYNTH_BOX.w / 2, SYNTH_BOX.y + 10, 6, MACHINES[job.machine].color);
    // Standing here with empty hands? It goes straight into them, and the
    // menu closes so you can head off and deliver it. If you're halfway
    // through typing another formula, the menu waits until you press
    // Synthesize.
    if (autoTake()) {
      if (synthOpen && entry.length) closeAfterMake = true;
      else closeSynth();
    }
  }
}

// Hand the player the first finished flask, if they're at the synthesizer
// with empty hands.
function autoTake() {
  const i = state.jobs.findIndex((j) => j.ready);
  return i >= 0 && takeFlask(i);
}

function takeFlask(i) {
  const job = state.jobs[i];
  if (state.at !== 'synth' || !job || !job.ready || state.player.carry) return false;
  state.jobs.splice(i, 1);
  state.player.carry = { formula: job.formula, machine: job.machine };
  play(() => sfx('pick'));
  return true;
}

// ---- Actions -----------------------------------------------------------------

// Only ever called for the machine the flask was made for (on arrival).
function deliver(m) {
  const flask = state.player.carry;
  state.player.carry = null;
  const y = MACHINE_Y - 64;
  if (!m.req || !sameFormula(flask.formula, m.req.formula)) {
    state.stats.wrong++;
    loseTime(m.x, y);
    m.sputterT = 1.5;
    play(() => sfx('wrong'));
    if (!silent) text(m.x, y + 18, m.req ? 'Wrong formula!' : 'Not needed!', INK.red, 13);
    return;
  }
  state.stats.delivered++;
  addScore(PTS_DELIVER, m.x, y, INK.green);
  addTime(TIME_DELIVER, m.x, y + 18);
  m.req = null;
  m.nextT = rand(...REQ_GAP);
  m.runT = 8;
  m.flash = 0.5;
  play(() => sfx('deliver'));
  if (!silent) burst(m.x, MACHINE_Y, 12, m.color);
}

function dump() {
  state.player.carry = null;
  state.stats.dumped++;
  play(() => sfx('dump'));
  if (!silent) burst(BIN_BOX.x + BIN_BOX.w / 2, BIN_BOX.y + 10, 6, '#8bc34a');
}

// Collecting a formula: just walk up to a machine with a new request.
function visit(i) {
  const m = state.machines[i];
  if (m.req && !m.req.seen) {
    m.req.seen = true;
    state.stats.collected++;
    addScore(PTS_COLLECT, m.x, MACHINE_Y - 64);
    play(() => sfx('collect'));
  }
}

// ---- Update ------------------------------------------------------------------

function play(fn) {
  if (!silent) fn();
}

function update(dt) {
  state.shake = Math.max(0, state.shake - dt * 2.5);
  updateEffects(dt);

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
    state.t += dt;
    state.timeLeft -= dt;
    if (state.timeLeft <= 10 && Math.ceil(state.timeLeft) !== state.tickT) {
      state.tickT = Math.ceil(state.timeLeft);
      if (state.tickT > 0) play(() => audio.sfx('tick'));
    }
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      state.phase = 'over';
      state.overT = 0;
      closeSynth();
      play(() => audio.stopSong());
      play(() => sfx('whistle'));
      return;
    }
    if (silent) botInput();
    updatePlayer(dt);
    updateMachines(dt);
    updateJobs(dt);
  } else if (state.phase === 'over') {
    state.overT += dt;
    if (state.overT > 1.2 && !silent) finish();
  }
  // Ore keeps sliding along the belt under running machines.
  for (const o of state.ore) {
    o.x += dt * 18;
    if (o.x > W + 20) o.x -= W + 60;
  }
}

function stationAt(x, y) {
  // Along the machine row, you're at the machine whose column you stand in
  // (so standing under the join between two never picks the wrong one).
  if (rectDist(x, y, MACHINE_WALL) < REACH) return clamp(Math.floor(x / MACHINE_W), 0, MACHINES.length - 1);
  if (rectDist(x, y, SYNTH_BOX) < REACH) return 'synth';
  if (rectDist(x, y, BIN_BOX) < REACH) return 'bin';
  return null;
}

// Stations are solid: push the player out of them.
// The machines stand edge to edge, so they collide as one long wall. Separate
// boxes would leave seams where sliding along the row could push you sideways
// and pin you between two machines.
const MACHINE_WALL = { x: 0, y: MACHINE_Y - MACHINE_H / 2, w: W, h: MACHINE_H };

function solid(p) {
  const r = 9;
  const minX = 12;
  const maxX = W - 12;
  const minY = 40;
  const maxY = H - 12;
  p.x = clamp(p.x, minX, maxX);
  p.y = clamp(p.y, minY, maxY);
  for (const b of [MACHINE_WALL, SYNTH_BOX, BIN_BOX]) {
    if (p.x > b.x - r && p.x < b.x + b.w + r && p.y > b.y - r && p.y < b.y + b.h + r) {
      // Push out through the nearest side that leads back onto the floor
      // (boxes against a wall can't be left through that wall).
      const sides = [
        { d: p.x - (b.x - r), x: b.x - r, y: p.y },
        { d: b.x + b.w + r - p.x, x: b.x + b.w + r, y: p.y },
        { d: p.y - (b.y - r), x: p.x, y: b.y - r },
        { d: b.y + b.h + r - p.y, x: p.x, y: b.y + b.h + r },
      ].filter((s) => s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY);
      if (!sides.length) continue;
      const s = sides.reduce((a, c) => (c.d < a.d ? c : a));
      p.x = s.x;
      p.y = s.y;
    }
  }
}

// ---- Walking around the synthesizer and bin -------------------------------

const PLAYER_R = 9;
const OBSTACLES = [SYNTH_BOX, BIN_BOX]; // the machine row is a wall you never need to pass

// Does the segment a-b pass through the box grown by pad?
function segHitsBox(a, b, box, pad) {
  const x0 = box.x - pad;
  const x1 = box.x + box.w + pad;
  const y0 = box.y - pad;
  const y1 = box.y + box.h + pad;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return t1 - t0 > 1e-3;
}

const clear = (a, b) => !OBSTACLES.some((o) => segHitsBox(a, b, o, PLAYER_R));

// Shortest walk from `from` to `to` that goes around the obstacles' corners.
function planPath(from, to) {
  if (clear(from, to)) return [to];
  const g = PLAYER_R + 3;
  const nodes = [from, to];
  for (const o of OBSTACLES) {
    for (const [x, y] of [[o.x - g, o.y - g], [o.x + o.w + g, o.y - g], [o.x - g, o.y + o.h + g], [o.x + o.w + g, o.y + o.h + g]]) {
      nodes.push({ x: clamp(x, 12, W - 12), y: clamp(y, 40, H - 12) });
    }
  }
  const dist = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v] || !clear(nodes[u], nodes[v])) continue;
      const d = dist[u] + Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  if (dist[1] === Infinity) return [to]; // no way round: just head for it
  const path = [];
  for (let v = 1; v !== 0; v = prev[v]) path.unshift(nodes[v]);
  return path;
}

function setWalkTarget(x, y) {
  const p = state.player;
  const t = { x: clamp(x, 0, W), y: clamp(y, 0, H) };
  // Tapping on a machine, the synthesizer or the bin means "walk up to it":
  // aim for the nearest spot just outside it. Machines are only reachable
  // from below, so a tap anywhere on (or above) the row aims under it.
  const below = MACHINE_WALL.y + MACHINE_WALL.h + PLAYER_R;
  if (t.y < below) t.y = below;
  solid(t);
  // Remember which station (if any) this walk ends at, so arriving at the
  // bin on purpose dumps straight away while walking past it doesn't.
  p.dest = stationAt(t.x, t.y);
  p.path = planPath({ x: p.x, y: p.y }, t);
  const n = p.path.shift();
  p.tx = n.x;
  p.ty = n.y;
}

function updatePlayer(dt) {
  const p = state.player;
  const k = keyMove();
  let vx = 0;
  let vy = 0;
  if (synthOpen) {
    // No walking while the synthesizer menu is open.
  } else if (!silent && (k.x || k.y)) {
    vx = k.x;
    vy = k.y;
    p.tx = null;
    p.path = [];
    p.dest = null;
  } else if (p.tx != null) {
    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) {
      // Next corner of the route, or done.
      const n = p.path && p.path.shift();
      if (n) {
        p.tx = n.x;
        p.ty = n.y;
      } else p.tx = null;
    } else {
      vx = dx / d;
      vy = dy / d;
    }
  }
  const m = Math.hypot(vx, vy);
  if (m > 0) {
    // Never step past a waypoint (at this speed that made the worker jitter
    // back and forth around it forever).
    let step = WALK_SPEED * dt;
    if (p.tx != null && !(k.x || k.y)) step = Math.min(step, Math.hypot(p.tx - p.x, p.ty - p.y));
    p.x += (vx / m) * step;
    p.y += (vy / m) * step;
    p.walkT += dt;
    if (Math.abs(vx) > 0.2) p.face = Math.sign(vx);
  }
  solid(p);

  const at = stationAt(p.x, p.y);
  if (at !== state.at) {
    state.at = at;
    state.synthDismissed = false;
    if (typeof at === 'number') {
      visit(at);
      // Walking a flask up to the machine it was made for delivers it.
      if (state.player.carry && state.player.carry.machine === at) deliver(state.machines[at]);
    }
    // Coming to the synthesizer with free hands picks up a finished flask.
    // If you got one, the menu stays shut: you came to collect, so go deliver.
    if (at === 'synth') {
      if (autoTake()) state.synthDismissed = true;
    } else closeSynth();
  }
  // Reaching the bin on purpose dumps what you carry: a tap or drag that
  // ends on it, pushing towards it with the keys, or stopping beside it.
  // Walking past it on the way somewhere else doesn't. Stopping at the
  // synthesizer opens its menu.
  const stopped = p.tx == null && !(k.x || k.y);
  if (at === 'bin' && p.carry) {
    // With the keys, it's when you're up against the bin and pushing into it.
    const nx = clamp(p.x, BIN_BOX.x, BIN_BOX.x + BIN_BOX.w) - p.x;
    const ny = clamp(p.y, BIN_BOX.y, BIN_BOX.y + BIN_BOX.h) - p.y;
    const touching = Math.hypot(nx, ny) <= PLAYER_R + 1;
    const keysTowards = touching && (k.x || k.y) && k.x * nx + k.y * ny > 0;
    const headedHere = p.tx != null && !(k.x || k.y) && p.dest === 'bin';
    if (stopped || keysTowards || headedHere) dump();
  }
  if (stopped && at === 'synth' && !synthOpen && !state.synthDismissed && !silent) openSynth();
}

// ---- Effects -------------------------------------------------------------------

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

// ---- Input -------------------------------------------------------------------

// Tap to walk somewhere; hold and drag to lead the worker around.
let drag = null;

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale };
}

function walkTo(p) {
  // The worker stays put while the synthesizer menu is open.
  if (state.phase !== 'playing' || synthOpen) return;
  setWalkTarget(p.x, p.y);
}

canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  if (drag) return;
  drag = { id: e.pointerId };
  walkTo(toWorld(e));
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* fine without capture */
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.id) walkTo(toWorld(e));
});
const release = (e) => {
  if (drag && e.pointerId === drag.id) drag = null;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);

const keys = new Set();
addEventListener('keydown', (e) => {
  if (state.phase !== 'playing') return;
  const k = e.key.toLowerCase();
  if (!synthOpen) {
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    if ((k === ' ' || k === 'e') && !e.repeat && state.at === 'synth') openSynth();
    keys.add(k);
    return;
  }
  // Formulas are entered by tapping/clicking only, the same on desktop and
  // mobile. Esc still closes the menu.
  if (k === 'escape') document.getElementById('synth-close').click();
  else if (k.startsWith('arrow')) e.preventDefault(); // no walking while the menu is open
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


// ---- Synthesizer panel -----------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
function symbolSvg(sym, fill = '#fff', stroke = INK.marker) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-12 -12 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('d', symbolPath(sym, 9));
  el.setAttribute('fill', fill);
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(el);
  return svg;
}

function symbolPath(sym, s) {
  const f = (n) => n.toFixed(1);
  if (sym === 'circle') return `M ${f(-s)} 0 A ${s} ${s} 0 1 0 ${f(s)} 0 A ${s} ${s} 0 1 0 ${f(-s)} 0 Z`;
  if (sym === 'square') return `M ${f(-s * 0.85)} ${f(-s * 0.85)} H ${f(s * 0.85)} V ${f(s * 0.85)} H ${f(-s * 0.85)} Z`;
  if (sym === 'triangle') return `M 0 ${f(-s * 1.05)} L ${f(s)} ${f(s * 0.75)} L ${f(-s)} ${f(s * 0.75)} Z`;
  if (sym === 'diamond') return `M 0 ${f(-s * 1.15)} L ${f(s)} 0 L 0 ${f(s * 1.15)} L ${f(-s)} 0 Z`;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? s * 0.5 : s * 1.15;
    pts.push(`${f(Math.cos(a) * rr)} ${f(Math.sin(a) * rr)}`);
  }
  return `M ${pts.join(' L ')} Z`;
}

const SYMBOL_FILL = { circle: '#f6c3b9', triangle: '#c2e8cc', square: '#c3d8f3', diamond: '#f8ddb2', star: '#e0c9f2' };

let synthOpen = false;
let closeAfterMake = false; // a flask landed in your hands mid-formula: close once you synthesize
let entry = [];
let target = null;
const targetsEl = document.getElementById('targets');
const slotsEl = document.getElementById('slots');
const keysEl = document.getElementById('keys');
const makeBtn = document.getElementById('make');
const queueEl = document.getElementById('queue');

MACHINES.forEach((m, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = m.name;
  b.style.background = m.light;
  b.style.borderColor = m.color;
  b.addEventListener('click', () => {
    target = i;
    audio.sfx('move');
    renderSynth();
  });
  targetsEl.appendChild(b);
});
SYMBOLS.forEach((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'key';
  b.setAttribute('aria-label', s);
  b.appendChild(symbolSvg(s, SYMBOL_FILL[s]));
  b.addEventListener('click', () => addSymbol(s));
  keysEl.appendChild(b);
});
document.getElementById('clear').addEventListener('click', clearSymbols);
document.getElementById('synth-close').addEventListener('click', () => {
  closeSynth();
  // Step straight away from it so it doesn't pop back open.
  const p = state.player;
  const cx = SYNTH_BOX.x + SYNTH_BOX.w / 2;
  const cy = SYNTH_BOX.y + SYNTH_BOX.h / 2;
  const d = Math.hypot(p.x - cx, p.y - cy) || 1;
  setWalkTarget(p.x + ((p.x - cx) / d) * 40, p.y + ((p.y - cy) / d) * 40);
});
makeBtn.addEventListener('click', make);

function addSymbol(s) {
  if (entry.length >= MAX_SYMBOLS) return;
  entry.push(s);
  sfx('key', SYMBOLS.indexOf(s));
  renderSynth();
}

function clearSymbols() {
  entry = [];
  audio.sfx('move');
  renderSynth();
}

function make() {
  if (synthesize(entry, target)) {
    entry = [];
    if (closeAfterMake) closeSynth();
    else renderSynth();
  } else play(() => sfx('nope'));
}

function openSynth() {
  if (synthOpen || state.phase !== 'playing') return;
  synthOpen = true;
  synthEl.hidden = false;
  keys.clear();
  state.player.tx = null; // stop where you are
  state.player.path = [];
  renderSynth();
}

function closeSynth() {
  closeAfterMake = false;
  if (!synthOpen) return;
  // However it closed (✕, Esc, or a flask landing in your hands), it stays
  // shut until you step away and come back.
  if (state.at === 'synth') state.synthDismissed = true;
  synthOpen = false;
  synthEl.hidden = true;
}

let queueKey = '';
function renderSynth() {
  if (!synthOpen) return;
  [...targetsEl.children].forEach((b, i) => b.classList.toggle('on', i === target));
  slotsEl.innerHTML = '';
  if (!entry.length) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = 'Tap symbols to copy a formula';
    slotsEl.appendChild(h);
  } else entry.forEach((s) => slotsEl.appendChild(symbolSvg(s, SYMBOL_FILL[s])));
  const full = state.jobs.length >= SYNTH_SLOTS;
  makeBtn.disabled = full || !entry.length || target == null;
  makeBtn.textContent = full ? 'Synthesizer full' : target == null ? 'Pick a machine' : `Synthesize for ${MACHINES[target].name}`;
  queueKey = '';
  renderQueue();
}

// The queue changes every frame while brewing, so redraw it cheaply.
function renderQueue() {
  if (!synthOpen) return;
  const carrying = !!state.player.carry;
  const key = state.jobs.map((j) => `${j.machine}${j.formula.join('')}${j.ready}${Math.floor((j.t / j.total) * 20)}`).join('|') + carrying;
  if (key === queueKey) return;
  queueKey = key;
  queueEl.innerHTML = '';
  for (let i = 0; i < SYNTH_SLOTS; i++) {
    const j = state.jobs[i];
    const el = document.createElement('div');
    el.className = 'job';
    if (!j) {
      el.classList.add('empty');
      el.textContent = 'empty';
    } else {
      const m = MACHINES[j.machine];
      el.style.borderColor = m.color;
      const name = document.createElement('span');
      name.textContent = j.ready ? 'Ready (hands full)' : j === state.jobs.find((o) => !o.ready) ? 'Brewing…' : 'Queued';
      const sym = document.createElement('span');
      sym.className = 'sym';
      j.formula.forEach((s) => sym.appendChild(symbolSvg(s, SYMBOL_FILL[s])));
      const tag = document.createElement('span');
      tag.textContent = m.name;
      tag.style.color = m.color;
      el.append(tag, sym, name);
      if (j.ready) {
        el.classList.add('ready');
        if (carrying) el.classList.add('full');
      } else {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.width = `${Math.round((j.t / j.total) * 100)}%`;
        el.appendChild(bar);
      }
    }
    queueEl.appendChild(el);
  }
}

// ---- Sound ---------------------------------------------------------------------

function sfx(name, arg = 0) {
  const n = noteFreq;
  switch (name) {
    case 'request':
      audio.tone({ wave: 'pulse25', freq: n('E5'), dur: 0.05, vol: 0.1 });
      audio.tone({ wave: 'pulse25', freq: n('E5'), dur: 0.05, vol: 0.1, at: 0.09 });
      break;
    case 'collect':
      audio.tone({ wave: 'pulse25', freq: n('A5'), freqEnd: n('E6'), dur: 0.08, vol: 0.14 });
      break;
    case 'key':
      audio.tone({ wave: 'pulse12', freq: n(['C5', 'D5', 'E5', 'G5', 'A5'][arg] || 'C5'), dur: 0.05, vol: 0.12 });
      break;
    case 'brew':
      audio.noise({ dur: 0.3, vol: 0.08, rate: 2.2, rateEnd: 1 });
      audio.tone({ wave: 'triangle', freq: n('C4'), freqEnd: n('G4'), dur: 0.2, vol: 0.2 });
      break;
    case 'ready':
      ['G5', 'C6'].forEach((note, i) => audio.tone({ wave: 'pulse25', freq: n(note), dur: 0.07, vol: 0.13, at: i * 0.07 }));
      break;
    case 'pick':
      audio.tone({ wave: 'pulse25', freq: n('C5'), freqEnd: n('G5'), dur: 0.07, vol: 0.14 });
      break;
    case 'deliver': {
      const notes = ['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7'];
      for (let i = 0; i < 4; i++) audio.tone({ wave: 'pulse50', freq: n(notes[i]), dur: 0.07, vol: 0.15, at: i * 0.055 });
      audio.noise({ dur: 0.4, vol: 0.1, rate: 0.5, at: 0.1 });
      break;
    }
    case 'wrong':
      audio.tone({ wave: 'pulse50', freq: n('E3'), dur: 0.18, vol: 0.2 });
      audio.tone({ wave: 'pulse50', freq: n('D#3'), dur: 0.3, vol: 0.2, at: 0.18 });
      break;
    case 'miss':
      audio.tone({ wave: 'pulse25', freq: n('A4'), freqEnd: n('A3'), dur: 0.35, vol: 0.16 });
      audio.noise({ dur: 0.3, vol: 0.12, rate: 0.4 });
      break;
    case 'dump':
      audio.noise({ dur: 0.35, vol: 0.18, rate: 1.2, rateEnd: 0.3 });
      break;
    case 'nope':
      audio.tone({ wave: 'pulse12', freq: n('C3'), dur: 0.07, vol: 0.1 });
      break;
    case 'whistle':
      audio.tone({ wave: 'pulse25', freq: n('C6'), dur: 0.5, vol: 0.18, vibrato: 0.03 });
      break;
    default:
      break;
  }
}

// A bouncy factory-floor loop.
const SONG = {
  bpm: 140,
  stepsPerBeat: 4,
  wave1: 'pulse25',
  wave2: 'pulse12',
  vol1: 0.07,
  vol2: 0.045,
  tracks: {
    p1: 'D5 . D5 F5 . D5 A5 . G5 . F5 . E5 . C5 . D5 . D5 F5 . D5 A5 . C6 . A5 . G5 - - .',
    p2: 'D4 A4 D4 A4 D4 A4 D4 A4 C4 G4 C4 G4 C4 G4 C4 G4 A#3 F4 A#3 F4 A#3 F4 A#3 F4 A3 E4 A3 E4 C4 G4 C4 G4',
    tri: 'D2 . D3 . D2 . D3 . C2 . C3 . C2 . C3 . A#1 . A#2 . A#1 . A#2 . A1 . A2 . C2 . C3 .',
    noise: 'k . h . s . h k k . h . s . h h',
  },
};

// ---- Render ----------------------------------------------------------------------

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

  drawFloor();
  drawBelt();
  for (const m of state.machines) drawMachine(m);
  drawSynth();
  drawBin();
  drawPlayer();
  for (const m of state.machines) drawRequest(m);
  drawParticles();
  drawTexts();
  if (state.phase === 'countdown' || (state.phase === 'playing' && state.goT < 0.6)) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCountdown(cw, ch);
  }
  updateHud();
  renderQueue();
}

function drawFloor() {
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4;
  sketchRect(ctx, 0, 0, W, H, 5, { wobble: 1.2 });
  // Hazard stripes along the walk-way in front of the machines.
  ctx.save();
  ctx.beginPath();
  ctx.rect(4, MACHINE_Y + MACHINE_H / 2 + 56, W - 8, 6);
  ctx.clip();
  ctx.fillStyle = 'rgba(244, 196, 48, 0.6)';
  ctx.fillRect(0, MACHINE_Y + MACHINE_H / 2 + 56, W, 6);
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.6)';
  ctx.lineWidth = 3;
  for (let x = -10; x < W + 10; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, MACHINE_Y + MACHINE_H / 2 + 66);
    ctx.lineTo(x + 10, MACHINE_Y + MACHINE_H / 2 + 52);
    ctx.stroke();
  }
  ctx.restore();
}

// Ore rides a belt behind the machines; it comes out refined where a machine is running.
function drawBelt() {
  const y = MACHINE_Y - MACHINE_H / 2 - 18;
  ctx.fillStyle = '#d8d4c8';
  ctx.fillRect(4, y - 9, W - 8, 18);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(4, y - 9, W - 8, 18);
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.35)';
  ctx.lineWidth = 1;
  const off = (state.t * 18) % 12;
  for (let x = 4 + off; x < W - 4; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x, y + 9);
    ctx.stroke();
  }
  for (const o of state.ore) {
    // Past a running machine the ore becomes a shiny bar.
    const refined = state.machines.some((m) => m.runT > 0 && o.x > m.x && o.x < m.x + 70);
    const r = rng(o.seed);
    ctx.beginPath();
    if (refined) {
      ctx.rect(o.x - 6, y - 4, 12, 8);
      ctx.fillStyle = '#ffe28a';
    } else {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const rr = 5 * (0.75 + r() * 0.45);
        const px = o.x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr * 0.8;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#8a8478';
    }
    ctx.fill();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function drawMachine(m) {
  const b = machineBox(m);
  const running = m.runT > 0;
  const shake = running ? Math.sin(state.t * 40) * 0.8 : m.sputterT > 0 ? Math.sin(state.t * 25) * 1.5 : 0;
  ctx.save();
  ctx.translate(shake, 0);
  // Body.
  ctx.fillStyle = m.flash > 0 ? '#fff' : m.light;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.18)';
  ctx.lineWidth = 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  hatch(ctx, b.x, b.y, b.w, b.h, { gap: 8, seed: m.i + 3 });
  ctx.restore();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4;
  sketchRect(ctx, b.x, b.y, b.w, b.h, 20 + m.i, { wobble: 1 });
  // Each machine has its own doodle.
  ctx.lineWidth = 2;
  ctx.strokeStyle = m.color;
  const cx = m.x;
  const cy = MACHINE_Y + 4;
  const spin = running ? state.t * 6 : 0;
  if (m.i === 0) {
    // Crusher: two toothed rollers.
    for (const dx of [-14, 14]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy, 11, 0, Math.PI * 2);
      ctx.stroke();
      for (let k = 0; k < 6; k++) {
        const a = spin * (dx < 0 ? 1 : -1) + (k / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + dx + Math.cos(a) * 11, cy + Math.sin(a) * 11);
        ctx.lineTo(cx + dx + Math.cos(a) * 15, cy + Math.sin(a) * 15);
        ctx.stroke();
      }
    }
  } else if (m.i === 1) {
    // Smelter: a furnace mouth with flames.
    ctx.beginPath();
    ctx.arc(cx, cy + 6, 16, Math.PI, 0);
    ctx.lineTo(cx + 16, cy + 18);
    ctx.lineTo(cx - 16, cy + 18);
    ctx.closePath();
    ctx.fillStyle = running ? '#ffb347' : '#5a4636';
    ctx.fill();
    ctx.stroke();
    if (running) {
      ctx.fillStyle = INK.red;
      for (let k = 0; k < 3; k++) {
        const h = 8 + Math.sin(state.t * 12 + k * 2) * 3;
        ctx.beginPath();
        ctx.moveTo(cx - 10 + k * 10 - 4, cy + 16);
        ctx.lineTo(cx - 10 + k * 10, cy + 16 - h);
        ctx.lineTo(cx - 10 + k * 10 + 4, cy + 16);
        ctx.fill();
      }
    }
    // Chimney.
    ctx.strokeStyle = INK.marker;
    ctx.strokeRect(cx + 24, b.y - 16, 10, 16);
  } else {
    // Centrifuge: a spinning drum.
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.stroke();
    for (let k = 0; k < 3; k++) {
      const a = spin * 2 + (k / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * 18, cy + Math.sin(a) * 18);
      ctx.stroke();
    }
  }
  // Name plate.
  ctx.fillStyle = '#fff';
  ctx.fillRect(b.x + 8, b.y + b.h - 15, b.w - 16, 12);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(b.x + 8, b.y + b.h - 15, b.w - 16, 12);
  ctx.fillStyle = INK.marker;
  ctx.font = `10px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(m.name.toUpperCase(), m.x, b.y + b.h - 8.5);
  // Status light.
  ctx.beginPath();
  ctx.arc(b.x + b.w - 9, b.y + 9, 4, 0, Math.PI * 2);
  ctx.fillStyle = running ? INK.green : m.req ? INK.yellow : '#bbb';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // Smoke puffs while running.
  if (running && Math.random() < 0.15 && !silent) {
    state.particles.push({ x: m.x + (m.i === 1 ? 29 : 0), y: b.y - 16, vx: rand(-8, 8), vy: -25, t: 0, life: 1, size: 5, rot: 0, vr: 0, color: '#fff', puff: true });
  }
  textAlignReset();
}

function textAlignReset() {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawSymbol(sym, x, y, s, fill, stroke = INK.marker, lw = 1.4) {
  ctx.save();
  ctx.translate(x, y);
  const p = new Path2D(symbolPath(sym, s));
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(p);
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke(p);
  ctx.restore();
}

// Speech bubble under each machine: "?" until visited, then the formula, with
// a timer bar that turns red as it runs out.
function drawRequest(m) {
  if (!m.req) return;
  const r = m.req;
  const n = r.formula.length;
  // Long formulas wrap onto two rows so bubbles stay inside their machine.
  const rows = r.seen && n > 5 ? 2 : 1;
  const perRow = Math.ceil(n / rows);
  const bw = r.seen ? Math.max(56, perRow * 21 + 10) : 40;
  const bh = 24 + (rows - 1) * 20;
  const bx = m.x - bw / 2;
  const by = MACHINE_Y + MACHINE_H / 2 + 6;
  const urgent = r.time < 8;
  ctx.fillStyle = '#fff';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = urgent && Math.sin(state.t * 14) > 0 ? INK.red : INK.marker;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  if (r.seen) {
    r.formula.forEach((s, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      drawSymbol(s, bx + 5 + 10.5 + col * 21, by + 11.5 + row * 20, 7.8, SYMBOL_FILL[s], INK.marker, 1.6);
    });
  } else {
    ctx.fillStyle = INK.marker;
    ctx.font = `bold 16px ${HAND_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', m.x, by + 12);
    textAlignReset();
  }
  // Timer bar.
  const ty = by + bh + 2;
  const k = Math.max(0, r.time / r.total);
  ctx.fillStyle = '#eee';
  ctx.fillRect(bx, ty, bw, 5);
  ctx.fillStyle = k < 0.25 ? INK.red : k < 0.5 ? INK.yellow : INK.green;
  ctx.fillRect(bx, ty, bw * k, 5);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, ty, bw, 5);
  ctx.fillStyle = urgent ? INK.red : INK.pencil;
  ctx.font = `10px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.ceil(r.time)}s`, m.x, ty + 16);
  textAlignReset();
}

function drawFlask(x, y, machine, s = 1, formula = null) {
  const m = MACHINES[machine];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(-3, -12);
  ctx.lineTo(-3, -5);
  ctx.lineTo(-9, 7);
  ctx.quadraticCurveTo(-10, 10, -6, 10);
  ctx.lineTo(6, 10);
  ctx.quadraticCurveTo(10, 10, 9, 7);
  ctx.lineTo(3, -5);
  ctx.lineTo(3, -12);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = m.color;
  ctx.fillRect(-12, 0, 24, 12);
  ctx.restore();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
  if (formula) {
    const w = formula.length * 9 + 4;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - w / 2, y - 26 * s, w, 11);
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2, y - 26 * s, w, 11);
    formula.forEach((sym, i) => drawSymbol(sym, x - w / 2 + 6.5 + i * 9, y - 26 * s + 5.5, 3.2, SYMBOL_FILL[sym], INK.marker, 0.9));
  }
}

function drawSynth() {
  const b = SYNTH_BOX;
  ctx.fillStyle = '#e8e2f4';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4;
  sketchRect(ctx, b.x, b.y, b.w, b.h, 31, { wobble: 1 });
  // Bubbling tank.
  const brewing = state.jobs.find((j) => !j.ready);
  ctx.fillStyle = '#fff';
  ctx.fillRect(b.x + 10, b.y + 10, 34, 44);
  if (brewing) {
    ctx.fillStyle = MACHINES[brewing.machine].light;
    const lvl = 44 * (brewing.t / brewing.total);
    ctx.fillRect(b.x + 10, b.y + 54 - lvl, 34, lvl);
    ctx.fillStyle = MACHINES[brewing.machine].color;
    for (let k = 0; k < 3; k++) {
      const yy = b.y + 50 - ((state.t * 30 + k * 15) % 40);
      ctx.beginPath();
      ctx.arc(b.x + 18 + k * 9, yy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(b.x + 10, b.y + 10, 34, 44);
  // Rack of ready flasks and queue dots.
  for (let i = 0; i < SYNTH_SLOTS; i++) {
    const j = state.jobs[i];
    const fx = b.x + 64 + i * 25;
    const fy = b.y + 34;
    if (j && j.ready) drawFlask(fx, fy, j.machine, 0.95);
    else {
      ctx.strokeStyle = 'rgba(36, 34, 31, 0.35)';
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(fx - 9, fy - 12, 18, 23);
      ctx.setLineDash([]);
      if (j) {
        ctx.fillStyle = MACHINES[j.machine].color;
        ctx.beginPath();
        ctx.arc(fx, fy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.fillStyle = INK.marker;
  ctx.font = `11px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SYNTHESIZER', b.x + b.w / 2, b.y + b.h - 8);
  textAlignReset();
}

function drawBin() {
  const b = BIN_BOX;
  ctx.fillStyle = '#c9cfb8';
  ctx.beginPath();
  ctx.moveTo(b.x + 4, b.y + 8);
  ctx.lineTo(b.x + b.w - 4, b.y + 8);
  ctx.lineTo(b.x + b.w - 8, b.y + b.h);
  ctx.lineTo(b.x + 8, b.y + b.h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillRect(b.x, b.y + 2, b.w, 6);
  ctx.strokeRect(b.x, b.y + 2, b.w, 6);
  ctx.lineWidth = 1.2;
  for (const dx of [16, 25, 34]) sketchLine(ctx, b.x + dx, b.y + 16, b.x + dx, b.y + b.h - 6, dx, { wobble: 0.6, passes: 1 });
  ctx.fillStyle = INK.marker;
  ctx.font = `9px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('WASTE', b.x + b.w / 2, b.y - 3);
  textAlignReset();
}

function drawPlayer() {
  const p = state.player;
  const bob = p.tx != null || keyMove().x || keyMove().y ? Math.sin(p.walkT * 14) * 1.5 : 0;
  // Walk target marker.
  if (p.tx != null) {
    ctx.strokeStyle = 'rgba(85, 83, 78, 0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(p.tx - 4, p.ty - 4);
    ctx.lineTo(p.tx + 4, p.ty + 4);
    ctx.moveTo(p.tx + 4, p.ty - 4);
    ctx.lineTo(p.tx - 4, p.ty + 4);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(p.x, p.y + bob);
  // Shadow.
  ctx.fillStyle = 'rgba(36, 34, 31, 0.15)';
  ctx.beginPath();
  ctx.ellipse(0, 12, 10, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // Body (overalls) and head with a hard hat.
  ctx.fillStyle = '#7fa7d9';
  ctx.fillRect(-7, -4, 14, 15);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.8;
  ctx.strokeRect(-7, -4, 14, 15);
  ctx.beginPath();
  ctx.arc(0, -10, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = '#f3d2b3';
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -12, 7.5, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = INK.yellow;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK.marker;
  ctx.beginPath();
  ctx.arc(p.face * 2.5, -9, 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (p.carry) drawFlask(p.x + p.face * 11, p.y + bob - 2, p.carry.machine, 0.8, p.carry.formula);
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    ctx.translate(p.x, p.y);
    if (p.puff) {
      ctx.beginPath();
      ctx.arc(0, 0, p.size * (1 + p.t * 2), 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(85, 83, 78, 0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else {
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.strokeStyle = INK.marker;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
    }
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
  textAlignReset();
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

const starsFor = (pts) => STAR_POINTS.filter((t) => pts >= t).length;

let lastHud = '';
let hudStarCount = -1;
function updateHud() {
  const secs = Math.ceil(state.timeLeft);
  const key = `${secs}|${state.score}`;
  if (key === lastHud) return;
  lastHud = key;
  hudTime.textContent = formatTime(secs);
  hudTime.classList.toggle('low', secs <= 10);
  hudScore.textContent = state.score;
  const stars = starsFor(state.score);
  if (stars !== hudStarCount) {
    if (stars > hudStarCount && hudStarCount >= 0 && stars > 0) audio.sfx('star');
    hudStarCount = stars;
    hudStars.innerHTML = '';
    hudStars.append(renderStars(stars, { mini: true }));
  }
}

// ---- Flow ------------------------------------------------------------------------

function showStart() {
  const rec = getRecord(GAME_ID);
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h1>Machine Chemical Romance</h1>
    <p>Visit a machine to see its formula, copy it into the <b>synthesizer</b>, then carry the flask back before the timer runs out.</p>
    <p class="subtle"><b>Tap</b> to walk (keyboard: arrows / WASD). Right deliveries add 10s to the clock; wrong formulas and missed timers cost 10s. Dump bad flasks in the waste bin.</p>
    <ul class="star-goals"></ul>
    <div class="best"></div>
    <div class="actions"><button class="paper-btn primary" type="button">Start</button></div>`;
  const goals = card.querySelector('.star-goals');
  STAR_POINTS.forEach((t, i) => {
    const li = document.createElement('li');
    li.append(renderStars(i + 1, { mini: true }), `Score ${t}`);
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
  state.phase = 'countdown';
  entry = [];
  target = null;
  closeSynth();
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
  const st = s.stats;
  let note = `Lasted ${formatTime(s.t)} · ${st.delivered} delivered (+${st.timeAdded}s) · ${st.missed} missed · ${st.wrong} wrong.`;
  if (stars < 3) note += ` Next star at ${STAR_POINTS[stars]}.`;
  showResults(overlay, {
    title: "Shift's over!",
    scoreText: `${score} pts`,
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

// ---- Debug / balance sim -----------------------------------------------------------

// In the sim a bot drives state.input: { tx, ty } to walk, synth: { formula, machine }, take: index.
function botInput() {
  const i = state.input;
  if (i.tx != null) {
    setWalkTarget(i.tx, i.ty);
    i.tx = null;
  }
  if (i.synth) {
    synthesize(i.synth.formula, i.synth.machine);
    i.synth = null;
  }
  if (i.take != null) {
    takeFlask(i.take);
    i.take = null;
  }
}

state = newState();
layout();
showStart();

if (new URLSearchParams(location.search).has('debug')) {
  window.mcr = {
    get state() { return state; },
    start,
    consts: { W, H, MACHINE_Y, MACHINE_H, SYNTH_BOX, BIN_BOX, BREW_TIME, SYNTH_SLOTS, WALK_SPEED },
    machineBox,
    view: () => view,
    set reqTime(v) { REQ_TIME = v; },
    set roundTime(v) { ROUND_TIME = v; },
    set reqShrink(v) { REQ_SHRINK = v; },
    set reqFloor(v) { REQ_FLOOR = v; },
    set reqMin(v) { REQ_MIN = v; },
    set formulaStep(v) { FORMULA_STEP = v; },
    set formulaMax(v) { FORMULA_MAX = v; },
    // Fast-forward a run. act(state) is called every `every` seconds.
    sim(seconds, act, every = 0.1) {
      silent = true;
      state = newState();
      state.phase = 'playing';
      let acc = 0;
      const dt = 1 / 60;
      for (let i = 0; i < seconds / dt && state.phase === 'playing'; i++) {
        acc += dt;
        if (acc >= every) {
          acc -= every;
          act(state);
        }
        update(dt);
      }
      silent = false;
      const r = { score: state.score, lasted: Math.round(state.t), ...state.stats };
      state = newState();
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
