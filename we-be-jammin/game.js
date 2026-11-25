import { INK, HAND_FONT, rng, sketchLine, sketchCircle, hatch, graphPaper, fitCanvas } from '../shared/paper.js';
import { audio, noteFreq } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'we-be-jammin';
const STAR_TIMES = [105, 150, 225]; // seconds survived for 1, 2 and 3 stars

// Fleets. Each side gets one of each; ambit decides where it sits.
const FLEET = [
  { name: 'Battleship', ambit: 'space' },
  { name: 'Starfighter', ambit: 'space' },
  { name: 'Pursuit Fighter', ambit: 'air' },
  { name: 'Stealth Bomber', ambit: 'air' },
  { name: 'Tank', ambit: 'land' },
  { name: 'Artillery', ambit: 'land' },
  { name: 'Cruiser', ambit: 'water' },
  { name: 'Destroyer', ambit: 'water' },
];
// Rare enemy whose missiles fly twice as fast. Only arrives as a reinforcement.
const FAST = { name: 'Interceptor', ambit: 'air', fast: true };
const FAST_FIRST = 45; // seconds before the first can appear
const FAST_CHANCE = 0.15; // chance that a reinforcement is one
const FAST_MAX = 2; // at most this many alive at once
const WRECK_TIME = 10; // seconds a destroyed enemy's icon stays

const ALLY_HP = 3;
const ENEMY_HP = 3;

// Missiles: travel time = base + path length / speed + time per ambit crossed.
const MISSILE_BASE = 2.0;
const MISSILE_SPEED = 27.5; // world units per second
const AMBIT_GAP_TIME = 1.4; // per ambit between launcher and target
const MISSILE_SPEED_UP = 1.25; // every missile flies this much faster than the times above
let ENEMY_SLOW = 1.5; // enemy missiles take this much longer
const MIN_SEP = 0.55; // radians kept between any enemy struct and your structs

const ALLY_GAP = [12, 17]; // seconds between your structs' shots
const ENEMY_GAP = [10, 15]; // between enemy shots, divided by fireMul
const ENEMY_FIRST = [2.5, 8];
const RAMP = { fire: 60, gap: 15, minGap: 2, maxEnemies: 30 }; // tuning for the ramps below
const fireMul = (t) => 1 + t / RAMP.fire;

// New enemy structs keep warping in, more and more often. There is no win:
// the score is how long your fleet lasts.
const REINFORCE_FIRST = 8;
const reinforceGap = (t) => Math.max(RAMP.minGap, 10 - t / RAMP.gap);
// Living enemies are capped so the screen stays readable; fire rate keeps rising.

// The satellite: always orbiting clockwise; you can only speed up or slow down.
const SAT_R = 180; // orbit radius
// Drag right to speed up, left to slow down;
// let go and it eases back to its default speed.
let SPEED_MIN = 20; // units/s along the orbit
let SPEED_DEFAULT = 60;
let SPEED_MAX = 220;
const SPEED_ACCEL = 160; // units/s² toward the speed you're asking for
const SPEED_RETURN = 45; // units/s² back to the default after letting go
const DRAG_FULL = 70; // world units of drag for full speed up / slow down
const TAP_MOVE = 8; // a press that moves less than this (screen px) is a tap: jam
let JAM_R = 88; // jamming pulse radius: from the orbit (180) it just dips into the planet (100)
const JAM_WINDOW = 0.2; // how long a pulse stays active
const JAM_COOLDOWN = 1.0; // seconds before the next pulse
let MISS_COOLDOWN = 3.0; // recharge after a pulse that jams nothing (stops blind mashing)
const COOLDOWN_PER_LOSS = 0.2; // both recharges grow by this for each of your structs destroyed
const lostAllies = () => state.structs.filter((s) => s.side === 'ally' && s.hp <= 0).length;
const jamCooldown = () => JAM_COOLDOWN + COOLDOWN_PER_LOSS * lostAllies();
const missCooldown = () => MISS_COOLDOWN + COOLDOWN_PER_LOSS * lostAllies();

// ---- World ---------------------------------------------------------------

const R = 100; // planet radius
const AMBIT_R = { space: 152, air: 124, land: R, water: R };
const AMBIT_ORDER = ['space', 'air', 'land', 'water'];
const BOX = 420; // square of world shown around the planet
const TOKEN = 12; // struct icon radius
const LEGEND = 36; // fleet roster under the planet
const CONTROLS = 30; // speed gauge under the roster
const GAUGE_Y = BOX / 2 + LEGEND + 14;
const TOP_PAD = 60;

const shell = document.getElementById('shell');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;
const formatTime = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = '<span class="hud-time" aria-label="Time survived">0:00</span><span class="hud-stars"></span>';
mountTopBar(shell, { extra: hud });
const hudTime = hud.querySelector('.hud-time');
const hudStars = hud.querySelector('.hud-stars');

let view = { scale: 1, cx: 0, cy: 0, cw: 0, ch: 0, dpr: 1 };

function layout() {
  const { w, h, dpr } = fitCanvas(canvas);
  const availH = Math.max(200, h - TOP_PAD - 6);
  const tall = BOX + LEGEND + CONTROLS;
  const scale = Math.min(w / BOX, availH / tall);
  view = {
    scale,
    cx: w / 2,
    cy: TOP_PAD + (availH - tall * scale) / 2 + (BOX / 2) * scale,
    cw: w,
    ch: h,
    dpr,
  };
}

const rand = (a, b) => a + Math.random() * (b - a);
const angDiff = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// ---- State ---------------------------------------------------------------

let state;
let silent = false; // true while the balance sim runs
let nextId = 1;

function makeStruct(side, def, ang) {
  return {
    id: nextId++,
    side,
    name: def.name,
    ambit: def.ambit,
    fast: !!def.fast,
    ang,
    r: AMBIT_R[def.ambit],
    x: Math.cos(ang) * AMBIT_R[def.ambit],
    y: Math.sin(ang) * AMBIT_R[def.ambit],
    hp: side === 'ally' ? ALLY_HP : ENEMY_HP,
    max: side === 'ally' ? ALLY_HP : ENEMY_HP,
    timer: side === 'ally' ? rand(3, 9) : rand(...ENEMY_FIRST),
    flash: 0,
    warp: 0, // > 0 while warping in
    deadT: 0,
    seed: Math.floor(Math.random() * 1e6),
  };
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Angle from `ang` to the nearest living ally.
const allyGap = (structs, ang) =>
  Math.min(99, ...structs.filter((s) => s.side === 'ally' && s.hp > 0).map((s) => Math.abs(angDiff(s.ang, ang))));

// Pairs alternate evenly around the planet: yours, theirs, yours, theirs...
// 45° apart. Each pair is one surface struct and one orbiting one, so the
// icons don't overlap, and every enemy is at least ~33° from your structs.
function placeFleets() {
  const pairs = { ally: [], enemy: [] };
  for (const side of ['ally', 'enemy']) {
    const surface = shuffle(FLEET.filter((d) => d.ambit === 'land' || d.ambit === 'water'));
    const orbit = shuffle(FLEET.filter((d) => d.ambit === 'space' || d.ambit === 'air'));
    for (let i = 0; i < 4; i++) pairs[side].push([surface[i], orbit[i]]);
  }
  const off = Math.random() * Math.PI * 2;
  const out = [];
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 'enemy' : 'ally';
    const centre = off + (i * Math.PI) / 4 + rand(-0.04, 0.04);
    const flip = Math.random() < 0.5 ? 1 : -1;
    const [surface, orbit] = pairs[side][i >> 1];
    out.push(makeStruct(side, surface, centre + 0.1 * flip));
    out.push(makeStruct(side, orbit, centre - 0.1 * flip));
  }
  return out;
}

function newState() {
  const structs = placeFleets();
  return {
    phase: 'ready',
    countdown: 3.5,
    goT: 1,
    t: 0, // seconds survived
    structs,
    continents: makeContinents(structs),
    missiles: [],
    sat: { ang: -Math.PI / 2, v: SPEED_DEFAULT, x: 0, y: -SAT_R, throttle: 0, push: 0 },
    input: { throttle: 0, jam: false }, // set by the bot in the sim
    reinforceT: REINFORCE_FIRST,
    jamCd: 0, // cooldown left
    jamCdMax: JAM_COOLDOWN, // length of the current cooldown
    pulseT: 99, // time since the last pulse
    pulses: 0,
    jammed: 0,
    hitsTaken: 0,
    enemyKills: 0,
    particles: [],
    texts: [],
    shake: 0,
    overT: 0,
    tempo: 0,
    thrustSfx: 0,
  };
}

function makeContinents(structs) {
  const r = rng(Math.floor(Math.random() * 1e6));
  const out = [];
  for (const s of structs) {
    if (s.ambit === 'land') out.push({ x: Math.cos(s.ang) * (R - 14), y: Math.sin(s.ang) * (R - 14), rad: 24 + r() * 6, seed: Math.floor(r() * 1e5) });
  }
  for (let i = 0; i < 3; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 45;
    out.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, rad: 14 + r() * 14, seed: Math.floor(r() * 1e5) });
  }
  return out;
}

function play(fn) {
  if (!silent) fn();
}

const alive = (side) => state.structs.filter((s) => s.side === side && s.hp > 0);

// ---- Missiles --------------------------------------------------------------

// A path that leaves the launcher, arcs outward and comes down on the target.
// Sampled so the missile moves at a steady speed along it.
function makePath(a, b) {
  const d = angDiff(a.ang, b.ang);
  const h = 12 + (46 * Math.abs(d)) / Math.PI;
  const N = 48;
  const pts = [];
  let len = 0;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const th = a.ang + d * u;
    const rr = a.r + (b.r - a.r) * u + h * Math.sin(Math.PI * u);
    const p = { x: Math.cos(th) * rr, y: Math.sin(th) * rr, s: 0 };
    if (i > 0) len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    p.s = len;
    pts.push(p);
  }
  return { pts, len };
}

function pathAt(path, frac) {
  const want = Math.max(0, Math.min(1, frac)) * path.len;
  const pts = path.pts;
  let i = 1;
  while (i < pts.length - 1 && pts[i].s < want) i++;
  const p0 = pts[i - 1];
  const p1 = pts[i];
  const k = p1.s > p0.s ? (want - p0.s) / (p1.s - p0.s) : 0;
  return { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k, dx: p1.x - p0.x, dy: p1.y - p0.y };
}

function launch(from, to) {
  const path = makePath(from, to);
  const gap = Math.abs(AMBIT_ORDER.indexOf(from.ambit) - AMBIT_ORDER.indexOf(to.ambit));
  const dur = ((MISSILE_BASE + path.len / MISSILE_SPEED + gap * AMBIT_GAP_TIME) * (from.side === 'enemy' ? ENEMY_SLOW : 1)) / (from.fast ? 2 : 1) / MISSILE_SPEED_UP;
  const p = pathAt(path, 0);
  state.missiles.push({ id: nextId++, fast: from.fast, side: from.side, from: from.id, to: to.id, tx: to.x, ty: to.y, path, dur, t: 0, x: p.x, y: p.y, dx: p.dx, dy: p.dy, jammed: 0, spin: 0, vx: 0, vy: 0 });
  play(() => sfx(from.fast ? 'fastLaunch' : from.side === 'enemy' ? 'launch' : 'allyLaunch'));
}

function updateFiring(dt) {
  const allies = alive('ally');
  const enemies = alive('enemy');
  const mul = fireMul(state.t);
  for (const s of state.structs) {
    if (s.hp <= 0) continue;
    if (s.warp > 0) {
      s.warp = Math.max(0, s.warp - dt);
      continue;
    }
    s.timer -= dt;
    if (s.timer > 0) continue;
    if (s.side === 'ally') {
      s.timer = rand(...ALLY_GAP);
      if (enemies.length) launch(s, enemies[Math.floor(Math.random() * enemies.length)]);
    } else {
      s.timer = rand(...ENEMY_GAP) / mul;
      if (allies.length) launch(s, allies[Math.floor(Math.random() * allies.length)]);
    }
  }
}

function updateMissiles(dt) {
  const sat = state.sat;
  for (const m of state.missiles) {
    if (m.jammed > 0) {
      // Tumbling away after losing its guidance.
      m.jammed += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.vx *= 1 - dt * 1.5;
      m.vy *= 1 - dt * 1.5;
      m.spin += dt * 14;
      continue;
    }
    m.t += dt;
    const p = pathAt(m.path, m.t / m.dur);
    m.x = p.x;
    m.y = p.y;
    m.dx = p.dx;
    m.dy = p.dy;
    if (m.side === 'enemy' && state.pulseT < JAM_WINDOW && Math.hypot(m.x - sat.x, m.y - sat.y) < JAM_R) {
      jam(m);
      continue;
    }
    if (m.t >= m.dur) {
      m.done = true;
      impact(m);
    }
  }
  state.missiles = state.missiles.filter((m) => !m.done && m.jammed < 0.9);
}

function jam(m) {
  m.jammed = 0.001;
  const len = Math.hypot(m.dx, m.dy) || 1;
  const speed = 40;
  const a = Math.atan2(m.dy, m.dx) + rand(-1.4, 1.4);
  m.vx = Math.cos(a) * speed + (m.dx / len) * 10;
  m.vy = Math.sin(a) * speed + (m.dy / len) * 10;
  state.jammed++;
  state.pulseHits++;
  if (!silent) {
    burst(m.x, m.y, 5, INK.yellow);
    text(m.x, m.y - 10, 'JAMMED', INK.blue, 11);
  }
  play(() => sfx('jam'));
}

// Tap: fire a jamming pulse around the satellite.
function fireJam() {
  if (state.phase !== 'playing') return;
  if (state.jamCd > 0) {
    play(() => sfx('jamEmpty'));
    return;
  }
  state.jamCd = jamCooldown();
  state.jamCdMax = state.jamCd;
  state.pulseT = 0;
  state.pulseHits = 0;
  state.pulseOpen = true;
  state.pulses++;
  play(() => sfx('pulse'));
}

function impact(m) {
  const target = state.structs.find((s) => s.id === m.to);
  if (!target || target.hp <= 0) {
    if (!silent) burst(m.x, m.y, 3, '#ccc');
    return;
  }
  target.hp--;
  target.flash = 0.5;
  if (m.side === 'enemy') {
    state.hitsTaken++;
    state.shake = Math.max(state.shake, 0.6);
    if (!silent) burst(m.x, m.y, 8, INK.red);
    play(() => sfx(target.hp <= 0 ? 'allyDown' : 'allyHit'));
  } else {
    if (!silent) burst(m.x, m.y, 6, INK.blue);
    play(() => sfx(target.hp <= 0 ? 'enemyDown' : 'enemyHit'));
  }
  if (target.hp <= 0) {
    target.deadT = 0;
    if (target.side === 'enemy') state.enemyKills++;
    if (!silent) {
      burst(target.x, target.y, 14, target.side === 'ally' ? INK.blue : INK.red);
      text(target.x, target.y - 18, target.side === 'ally' ? `${target.name} lost!` : `${target.name} down!`, target.side === 'ally' ? INK.red : INK.green, 12);
      if (target.side === 'ally') text(state.sat.x, state.sat.y - 26, `+${COOLDOWN_PER_LOSS}s recharge`, INK.red, 10);
    }
  }
}

// ---- Infinite mode -----------------------------------------------------------

function reinforce() {
  const fastAlive = state.structs.filter((o) => o.fast && o.hp > 0).length;
  const def = state.t >= FAST_FIRST && fastAlive < FAST_MAX && Math.random() < FAST_CHANCE
    ? FAST
    : FLEET[Math.floor(Math.random() * FLEET.length)];
  // Find a spot well away from your structs, and with room from other
  // living structs at that height.
  let best = null;
  for (let tries = 0; tries < 40; tries++) {
    const a = Math.random() * Math.PI * 2;
    const r = AMBIT_R[def.ambit];
    const room = Math.min(...state.structs.filter((s) => s.hp > 0).map((s) => Math.hypot(Math.cos(a) * r - s.x, Math.sin(a) * r - s.y)), 999);
    const gap = allyGap(state.structs, a);
    const score = Math.min(gap, MIN_SEP) * 100 + Math.min(room, 34);
    if (!best || score > best.score) best = { a, score };
    if (gap >= MIN_SEP && room > 34) break;
  }
  const s = makeStruct('enemy', def, best.a);
  s.warp = 1.2;
  s.timer = rand(2, 4);
  // Old wrecks in the same spot are cleared away.
  state.structs = state.structs.filter((o) => o.hp > 0 || o.side === 'ally' || Math.hypot(o.x - s.x, o.y - s.y) > 20);
  state.structs.push(s);
  if (def.ambit === 'land') state.continents.push({ x: Math.cos(s.ang) * (R - 14), y: Math.sin(s.ang) * (R - 14), rad: 24, seed: s.seed });
  play(() => sfx('warp'));
}

// ---- Update ------------------------------------------------------------------

function update(dt) {
  state.shake = Math.max(0, state.shake - dt * 2.5);
  updateEffects(dt);
  for (const s of state.structs) {
    s.flash = Math.max(0, s.flash - dt);
    if (s.hp <= 0) s.deadT += dt;
  }
  // Destroyed enemy icons are cleared away after a while.
  if (state.structs.some((s) => s.side === 'enemy' && s.hp <= 0 && s.deadT >= WRECK_TIME)) {
    state.structs = state.structs.filter((s) => s.side === 'ally' || s.hp > 0 || s.deadT < WRECK_TIME);
  }

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
        play(() => audio.playSong(song(0)));
        state.tempo = 0;
      }
    }
  }

  if (state.phase === 'playing') {
    state.t += dt;
    state.goT += dt;
    state.reinforceT -= dt;
    if (state.reinforceT <= 0) {
      state.reinforceT = reinforceGap(state.t);
      if (alive('enemy').length < RAMP.maxEnemies) reinforce();
    }
    updateSat(dt);
    updateFiring(dt);
    updateMissiles(dt);
    if (state.pulseOpen && state.pulseT >= JAM_WINDOW) {
      state.pulseOpen = false;
      if (state.pulseHits === 0 && MISS_COOLDOWN > JAM_COOLDOWN) {
        state.jamCd = missCooldown() - JAM_WINDOW;
        state.jamCdMax = missCooldown();
        if (!silent) text(state.sat.x, state.sat.y - 26, 'MISSED', INK.pencil, 10);
      }
    }

    if (alive('ally').length === 0) {
      state.phase = 'over';
      state.overT = 0;
      play(() => audio.stopSong());
    }
    // The music speeds up a notch every few seconds and gets busier in stages.
    const tempo = Math.floor(state.t / MUSIC_STEP);
    if (tempo !== state.tempo) {
      state.tempo = tempo;
      play(() => audio.updateSong(song(state.t)));
    }
  } else if (state.phase === 'over') {
    updateMissiles(dt * 0.3);
    updateSat(dt * 0.3);
    state.overT += dt;
    if (state.overT > 1.4 && !silent) finish();
  }
}

function updateSat(dt) {
  const sat = state.sat;
  state.jamCd = Math.max(0, state.jamCd - dt);
  state.pulseT += dt;
  let throttle = 0;
  if (state.phase === 'playing') {
    if (silent) {
      throttle = state.input.throttle;
      if (state.input.jam) fireJam();
    } else {
      throttle = speedInput();
    }
  }
  throttle = Math.max(-1, Math.min(1, throttle));
  sat.throttle = throttle;
  const target = throttle >= 0 ? SPEED_DEFAULT + throttle * (SPEED_MAX - SPEED_DEFAULT) : SPEED_DEFAULT + throttle * (SPEED_DEFAULT - SPEED_MIN);
  const rate = (throttle !== 0 ? SPEED_ACCEL : SPEED_RETURN) * dt;
  const before = sat.v;
  sat.v = Math.abs(target - sat.v) <= rate ? target : sat.v + Math.sign(target - sat.v) * rate;
  sat.push = throttle !== 0 && sat.v !== before ? Math.sign(sat.v - before) : 0; // jets fire only while you steer
  // Clockwise on screen (y points down), so the angle only ever grows.
  sat.ang += (sat.v / SAT_R) * dt;
  if (sat.ang > Math.PI) sat.ang -= Math.PI * 2;
  sat.x = Math.cos(sat.ang) * SAT_R;
  sat.y = Math.sin(sat.ang) * SAT_R;

  if (sat.push && !silent) {
    state.thrustSfx -= dt;
    if (state.thrustSfx <= 0) {
      state.thrustSfx = 0.09;
      sfx('thrust');
    }
    if (Math.random() < dt * 30) {
      // Puffs out the back when speeding up, out the front when slowing.
      const tx = -Math.sin(sat.ang) * sat.push;
      const ty = Math.cos(sat.ang) * sat.push;
      state.particles.push({ x: sat.x - tx * 12, y: sat.y - ty * 12, vx: -tx * 60 + rand(-15, 15), vy: -ty * 60 + rand(-15, 15), t: 0, life: 0.35, size: 3, rot: 0, vr: 0, color: '#fff', puff: true });
    }
  }
}

// ---- Effects -----------------------------------------------------------------

function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(20, 70);
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
  state.texts = state.texts.filter((t) => t.t < 1.2);
}

// ---- Input -------------------------------------------------------------------

// The pointer that is dragging (null when none). A press that barely moves
// is a tap and jams when released; a second finger jams straight away.
let drag = null;

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.cx) / view.scale, y: (e.clientY - r.top - view.cy) / view.scale };
}

canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  if (drag) {
    fireJam();
    return;
  }
  const p = toWorld(e);
  drag = { id: e.pointerId, sx: p.x, sy: p.y, x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, moved: false };
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
  if (Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) > TAP_MOVE) drag.moved = true;
});
const release = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const tap = !drag.moved && e.type === 'pointerup';
  drag = null;
  if (tap) fireJam();
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.key === ' ' && state.phase === 'playing') e.preventDefault();
  if ((e.key === ' ' || e.key.toLowerCase() === 'j') && !e.repeat && state.phase === 'playing') fireJam();
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => {
  keys.clear();
  drag = null;
});

// How hard you're asking to change speed: -1 (slowest) .. 0 (default) .. 1 (fastest).
function speedInput() {
  const k = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
  if (k) return k;
  if (!drag || !drag.moved) return 0;
  // Screen-relative: drag right to speed up, left to slow down.
  return Math.max(-1, Math.min(1, (drag.x - drag.sx) / DRAG_FULL));
}

// ---- Sound -------------------------------------------------------------------

function sfx(name) {
  const n = noteFreq;
  switch (name) {
    case 'thrust':
      audio.noise({ dur: 0.08, vol: 0.05, rate: 0.9 });
      break;
    case 'launch':
      audio.noise({ dur: 0.25, vol: 0.12, rate: 1.6, rateEnd: 0.5 });
      audio.tone({ wave: 'pulse12', freq: n('A3'), freqEnd: n('A5'), dur: 0.25, vol: 0.08 });
      break;
    case 'fastLaunch':
      audio.noise({ dur: 0.18, vol: 0.14, rate: 2.4, rateEnd: 0.8 });
      audio.tone({ wave: 'pulse25', freq: n('E4'), freqEnd: n('E6'), dur: 0.14, vol: 0.1 });
      audio.tone({ wave: 'pulse25', freq: n('E5'), freqEnd: n('E7'), dur: 0.1, vol: 0.06, at: 0.08 });
      break;
    case 'allyLaunch':
      audio.noise({ dur: 0.15, vol: 0.06, rate: 1.4, rateEnd: 0.6 });
      break;
    case 'pulse':
      audio.tone({ wave: 'pulse25', freq: n('C5'), freqEnd: n('C7'), dur: 0.12, vol: 0.1 });
      audio.noise({ dur: 0.15, vol: 0.07, rate: 1.8, rateEnd: 3 });
      break;
    case 'jamEmpty':
      audio.tone({ wave: 'pulse12', freq: n('C3'), dur: 0.05, vol: 0.08 });
      break;
    case 'jam':
      audio.tone({ wave: 'pulse12', freq: n('E6'), freqEnd: n('E4'), dur: 0.18, vol: 0.14, vibrato: 0.08 });
      audio.tone({ wave: 'pulse25', freq: n('B5'), freqEnd: n('B3'), dur: 0.22, vol: 0.08, at: 0.04, vibrato: 0.1 });
      audio.noise({ dur: 0.12, vol: 0.08, rate: 2 });
      break;
    case 'allyHit':
      audio.noise({ dur: 0.35, vol: 0.35, rate: 0.5, rateEnd: 0.15 });
      audio.tone({ wave: 'triangle', freq: 160, freqEnd: 50, dur: 0.25, vol: 0.3 });
      break;
    case 'allyDown':
      audio.sfx('explode');
      audio.tone({ wave: 'pulse50', freq: n('E4'), freqEnd: n('E3'), dur: 0.5, vol: 0.12 });
      break;
    case 'enemyHit':
      audio.noise({ dur: 0.15, vol: 0.12, rate: 0.7 });
      break;
    case 'enemyDown':
      audio.noise({ dur: 0.4, vol: 0.2, rate: 0.6, rateEnd: 0.2 });
      ['C5', 'E5', 'G5'].forEach((note, i) => audio.tone({ wave: 'pulse25', freq: n(note), dur: 0.06, vol: 0.15, at: 0.05 + i * 0.06 }));
      break;
    case 'warp':
      audio.tone({ wave: 'pulse12', freq: n('C4'), freqEnd: n('C6'), dur: 0.4, vol: 0.1, vibrato: 0.05 });
      break;
    default:
      break;
  }
}

// Music: a frantic ska-reggae groove that starts at 104 bpm, climbs about
// 0.45 bpm a second up to 176, and adds a busier layer every 40 s.
const MUSIC_STEP = 4; // seconds between tempo updates
const MUSIC_BPM = [104, 0.45, 176]; // start, per second, cap
const MUSIC_LAYER = 40; // seconds per extra layer (up to 3)

function song(t) {
  const bpm = Math.min(MUSIC_BPM[2], MUSIC_BPM[0] + MUSIC_BPM[1] * t);
  const layer = Math.min(3, Math.floor(t / MUSIC_LAYER));
  // Am, D, G, Em: one bar each.
  const chords = [
    ['A3', 'C4', 'E4', 'A4'],
    ['D4', 'F#4', 'A4', 'D5'],
    ['G3', 'B3', 'D4', 'G4'],
    ['E4', 'G4', 'B4', 'E5'],
  ];
  const melody = [
    'A4 . C5 . E5 - . D5 . C5 . A4 - - . .',
    '. . F#4 . A4 . D5 - - . C5 . A4 . . .',
    'G4 . B4 . D5 - . E5 . D5 . B4 - - . .',
    'E5 - - . D5 . B4 . G4 - . A4 - - - .',
  ];
  // Twitchier lead once things heat up: 16th-note runs up the chord.
  const runs = chords.map((c) => `${c[3]} ${c[2]} ${c[3]} . ${c[1]} ${c[2]} ${c[3]} . ${c[3]} ${c[2]} ${c[1]} ${c[0]} ${c[1]} ${c[2]} ${c[3]} .`);
  const lead = layer >= 2 ? melody.map((m, i) => (i % 2 ? runs[i] : m)) : melody;
  // Skank: offbeat chops, doubling up, then a constant arpeggio.
  const chop = chords.map((c) => {
    const n = c[2];
    if (layer === 0) return `. . ${n} . . . ${n} . . . ${n} . . . ${n} .`;
    if (layer === 1) return `. ${n} . ${n} . ${n} . ${n} . ${n} . ${n} . ${n} . ${n}`;
    return `${c[0]} ${c[1]} ${c[2]} ${c[3]} ${c[2]} ${c[1]} ${c[0]} ${c[1]} ${c[2]} ${c[3]} ${c[2]} ${c[1]} ${c[0]} ${c[1]} ${c[2]} ${c[3]}`;
  });
  const roots = ['A2', 'D2', 'G2', 'E2'];
  const fifths = ['E3', 'A2', 'D3', 'B2'];
  const bass = layer === 0
    ? ['A2 - . A2 . . C3 . E3 - . . D3 . C3 .', 'D2 - . D2 . . F#2 . A2 - . . G2 . F#2 .', 'G2 - . G2 . . B2 . D3 - . . C3 . B2 .', 'E2 - . E2 . . G2 . B2 - . . A2 . G2 .']
    : roots.map((r, i) => `${r} . ${r} . ${fifths[i]} . ${r} . ${r} . ${r} . ${fifths[i]} . ${r} ${fifths[i]}`);
  const drums = [
    'k . h . s . h k k . h . s . h h', // driving
    'k h h h s h h k k h h h s h s h', // busier hats
    'k h s h k h s h k h s h k s s s', // snare-heavy with a fill
    'k h s k k h s h k k s h k s s s', // flat out
  ][layer];
  return {
    bpm,
    stepsPerBeat: 4,
    wave1: 'pulse25',
    wave2: 'pulse12',
    vol1: 0.08,
    vol2: layer >= 2 ? 0.045 : 0.06,
    volNoise: 0.12 + layer * 0.02,
    tracks: { p1: lead.join(' '), p2: chop.join(' '), tri: bass.join(' '), noise: drums },
  };
}

// ---- Render ------------------------------------------------------------------

function render() {
  layout();
  const { scale, cx, cy, cw, ch, dpr } = view;
  let sx = 0;
  let sy = 0;
  if (state.shake > 0) {
    sx = (Math.random() - 0.5) * state.shake * 6;
    sy = (Math.random() - 0.5) * state.shake * 6;
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (cx + sx), dpr * (cy + sy));
  graphPaper(ctx, -cx / scale - 10, -cy / scale - 10, cw / scale + 20, ch / scale + 20, 10, 4);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawOrbits();
  drawPlanet();
  drawTargetWarnings();
  for (const s of state.structs) drawStruct(s);
  drawMissiles();
  drawSat();
  drawParticles();
  drawTexts();
  drawLegend();
  drawControls();
  if (state.phase === 'countdown' || (state.phase === 'playing' && state.goT < 0.6)) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCountdown(cw, ch);
  }
  updateHud();
}

function drawOrbits() {
  // Atmosphere band.
  ctx.beginPath();
  ctx.arc(0, 0, AMBIT_R.air + 14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120, 180, 235, 0.10)';
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.setLineDash([3, 6]);
  ctx.strokeStyle = 'rgba(47, 111, 192, 0.45)';
  ctx.beginPath();
  ctx.arc(0, 0, AMBIT_R.air, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(80, 60, 150, 0.4)';
  ctx.beginPath();
  ctx.arc(0, 0, AMBIT_R.space, 0, Math.PI * 2);
  ctx.stroke();
  // The satellite's fixed orbit, with chevrons showing it runs clockwise.
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = 'rgba(85, 83, 78, 0.45)';
  ctx.beginPath();
  ctx.arc(0, 0, SAT_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(85, 83, 78, 0.4)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    const px = nx * SAT_R + tx * 2.5;
    const py = ny * SAT_R + ty * 2.5;
    ctx.beginPath();
    ctx.moveTo(px - tx * 5 + nx * 4, py - ty * 5 + ny * 4);
    ctx.lineTo(px, py);
    ctx.lineTo(px - tx * 5 - nx * 4, py - ty * 5 - ny * 4);
    ctx.stroke();
  }

  ctx.font = `9px ${HAND_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(80, 60, 150, 0.7)';
  ctx.fillText('SPACE', 6, -AMBIT_R.space + 1);
  ctx.fillStyle = 'rgba(47, 111, 192, 0.8)';
  ctx.fillText('AIR', 6, -AMBIT_R.air + 1);
}

function drawPlanet() {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = '#d6e8f7';
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(47, 111, 192, 0.25)';
  ctx.lineWidth = 1;
  hatch(ctx, -R, -R, R * 2, R * 2, { gap: 8, angle: -0.5, seed: 11 });
  // Continents: lumpy green blobs.
  for (const c of state.continents) {
    const r = rng(c.seed);
    ctx.beginPath();
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = c.rad * (0.75 + r() * 0.4);
      const px = c.x + Math.cos(a) * rr;
      const py = c.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = '#bfe3b0';
    ctx.fill();
    ctx.strokeStyle = INK.green;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = INK.marker;
  // Two smooth marker passes (a polygonal sketch looks jagged at this size).
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0.8, -0.6, R + 0.4, 0.3, Math.PI * 2.2);
  ctx.stroke();
}

// A red ring around any of your structs with a missile coming for it.
function drawTargetWarnings() {
  const now = performance.now() / 1000;
  const targeted = new Map();
  for (const m of state.missiles) {
    if (m.side !== 'enemy' || m.jammed) continue;
    const left = m.dur - m.t;
    targeted.set(m.to, Math.min(targeted.get(m.to) ?? 99, left));
  }
  for (const s of state.structs) {
    if (!targeted.has(s.id) || s.hp <= 0) continue;
    const left = targeted.get(s.id);
    const blink = left < 1.5 ? 8 : 3;
    ctx.globalAlpha = 0.45 + 0.45 * Math.abs(Math.sin(now * blink));
    ctx.strokeStyle = INK.red;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, TOKEN + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

const GLYPH = {
  // Simple marker doodles, about 12 units across, drawn at (0, 0).
  space(c) {
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4.5, 4);
    c.lineTo(0, 2);
    c.lineTo(-4.5, 4);
    c.closePath();
    c.stroke();
  },
  air(c) {
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(0, 5);
    c.moveTo(-6, 1);
    c.lineTo(0, -2);
    c.lineTo(6, 1);
    c.moveTo(-2.5, 5);
    c.lineTo(2.5, 5);
    c.stroke();
  },
  land(c) {
    c.beginPath();
    c.rect(-5.5, -1, 11, 5);
    c.moveTo(-3, -1);
    c.lineTo(-3, -4);
    c.lineTo(2, -4);
    c.lineTo(2, -1);
    c.moveTo(2, -3);
    c.lineTo(7, -5);
    c.stroke();
  },
  water(c) {
    c.beginPath();
    c.moveTo(-6, 0);
    c.lineTo(6, 0);
    c.lineTo(3.5, 4);
    c.lineTo(-3.5, 4);
    c.closePath();
    c.moveTo(-1, 0);
    c.lineTo(-1, -5);
    c.lineTo(3, -2);
    c.lineTo(-1, -2);
    c.stroke();
  },
};

// Zigzag crown that marks the fast-missile enemy.
function drawSpikes(c, r) {
  const n = 10;
  c.beginPath();
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const rr = i % 2 ? r + 1 : r + 7;
    if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  c.closePath();
  c.fillStyle = INK.yellow;
  c.fill();
  c.strokeStyle = INK.red;
  c.lineWidth = 1.6;
  c.stroke();
}

function drawStruct(s) {
  const ally = s.side === 'ally';
  const dead = s.hp <= 0;
  ctx.save();
  ctx.translate(s.x, s.y);
  if (dead && !ally) ctx.globalAlpha = Math.max(0, Math.min(1, WRECK_TIME - s.deadT));
  if (s.warp > 0) {
    const k = 1 - s.warp / 1.2;
    ctx.globalAlpha = k;
    ctx.scale(0.3 + k * 0.7, 0.3 + k * 0.7);
    ctx.strokeStyle = INK.red;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, 14 + s.warp * 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const shake = s.flash > 0 ? Math.sin(s.flash * 60) * 1.5 : 0;
  ctx.translate(shake, 0);
  if (s.fast && !dead) drawSpikes(ctx, TOKEN);
  ctx.beginPath();
  ctx.arc(0, 0, TOKEN, 0, Math.PI * 2);
  ctx.fillStyle = dead ? '#ece9e0' : s.flash > 0.25 ? '#fff' : ally ? '#d8e6f7' : '#f8d9d2';
  ctx.fill();
  ctx.strokeStyle = dead ? INK.pencil : ally ? INK.marker : INK.red;
  ctx.lineWidth = ally ? 2 : 2.4;
  sketchCircle(ctx, 0, 0, TOKEN, s.seed, { wobble: 0.6, passes: 1 });
  ctx.strokeStyle = dead ? 'rgba(85, 83, 78, 0.6)' : ally ? INK.blue : INK.red;
  ctx.lineWidth = 1.5;
  ctx.save();
  ctx.scale(1.15, 1.15);
  GLYPH[s.ambit](ctx);
  ctx.restore();
  if (dead) {
    // Scribbled out.
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2;
    sketchLine(ctx, -9, -9, 9, 9, s.seed + 1, { wobble: 1 });
    sketchLine(ctx, 9, -9, -9, 9, s.seed + 2, { wobble: 1 });
  } else if (s.warp <= 0) {
    // Health as a segmented ring around the token.
    const seg = (Math.PI * 2) / s.max;
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    for (let i = 0; i < s.max; i++) {
      const a0 = -Math.PI / 2 + i * seg + 0.18;
      ctx.beginPath();
      ctx.arc(0, 0, TOKEN + 3.5, a0, a0 + seg - 0.36);
      ctx.strokeStyle = i < s.hp ? (ally ? INK.green : INK.red) : 'rgba(85, 83, 78, 0.2)';
      ctx.stroke();
    }
    ctx.lineCap = 'round';
  }
  ctx.restore();
}

// Enemy missiles heat up from amber to deep red as they close on their target.
const HEAT = [
  [0, [236, 178, 52]],
  [0.55, [232, 112, 36]],
  [1, [190, 20, 40]],
];
function heat(k, alpha = 1) {
  k = Math.max(0, Math.min(1, k));
  let i = 1;
  while (i < HEAT.length - 1 && HEAT[i][0] < k) i++;
  const [k0, c0] = HEAT[i - 1];
  const [k1, c1] = HEAT[i];
  const u = (k - k0) / (k1 - k0);
  const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * u));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

function drawMissiles() {
  const now = performance.now() / 1000;
  for (const m of state.missiles) {
    const enemy = m.side === 'enemy';
    const k = Math.min(1, m.t / m.dur);
    const alpha = m.jammed ? Math.max(0, 1 - m.jammed / 0.9) : 1;
    ctx.globalAlpha = alpha * (enemy ? 1 : 0.7);
    // Dotted trail: the path flown so far.
    if (!m.jammed) {
      const pts = m.path.pts;
      const upto = k * m.path.len;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length && pts[i].s <= upto; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(m.x, m.y);
      ctx.setLineDash(m.fast ? [1, 2.5] : [1, 4]);
      ctx.lineWidth = (m.fast ? 2 : 1.6) + (enemy ? k * 0.8 : 0);
      ctx.strokeStyle = enemy ? heat(k, 0.55 + 0.45 * k) : INK.blue;
      ctx.stroke();
      ctx.setLineDash([]);
      // Glow that grows and throbs faster as the missile closes in.
      if (enemy && k > 0.35) {
        const kk = (k - 0.35) / 0.65;
        const throb = 0.5 + 0.5 * Math.sin(now * (6 + kk * 18));
        ctx.globalAlpha = 0.12 + 0.3 * kk * throb;
        ctx.fillStyle = heat(k);
        ctx.beginPath();
        ctx.arc(m.x, m.y, 6 + kk * 6 + throb * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(Math.atan2(m.dy, m.dx) + m.spin);
    const grow = enemy && !m.jammed ? 1 + k * 0.25 : 1;
    ctx.scale(grow, grow);
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1;
    if (m.fast) {
      // Longer, dark-nosed, with speed lines.
      ctx.fillStyle = heat(k);
      ctx.fillRect(-7, -2, 14, 4);
      ctx.fillStyle = INK.marker;
      ctx.fillRect(3, -2, 4, 4);
      ctx.strokeRect(-7, -2, 14, 4);
      if (!m.jammed) {
        ctx.beginPath();
        ctx.moveTo(-10, -3.5);
        ctx.lineTo(-16, -3.5);
        ctx.moveTo(-10, 3.5);
        ctx.lineTo(-16, 3.5);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = enemy ? heat(k) : '#9fc0ea';
      ctx.fillRect(-4.5, -1.8, 9, 3.6);
      ctx.strokeRect(-4.5, -1.8, 9, 3.6);
    }
    if (m.jammed) {
      // Squiggle of static.
      ctx.strokeStyle = INK.yellow;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) ctx.lineTo(-6 + i * 2.4, (i % 2 ? -4 : 4) * (1 - m.jammed));
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawSat() {
  const sat = state.sat;
  const now = performance.now() / 1000;
  // Jamming range: bold when ready, faint while recharging.
  const ready = state.jamCd <= 0;
  ctx.beginPath();
  ctx.arc(sat.x, sat.y, JAM_R, 0, Math.PI * 2);
  ctx.fillStyle = ready ? 'rgba(244, 196, 48, 0.10)' : 'rgba(244, 196, 48, 0.04)';
  ctx.fill();
  ctx.strokeStyle = ready ? 'rgba(200, 150, 20, 0.75)' : 'rgba(200, 150, 20, 0.3)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 5]);
  ctx.lineDashOffset = -now * 8;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  // Recharge meter: an arc that fills back up around the satellite.
  if (!ready) {
    ctx.strokeStyle = INK.yellow;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sat.x, sat.y, 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - state.jamCd / state.jamCdMax));
    ctx.stroke();
  }
  // The pulse itself: a burst of rings out to the edge of the range.
  if (state.pulseT < 0.45) {
    const k = state.pulseT / 0.45;
    for (let i = 0; i < 3; i++) {
      const kk = Math.max(0, k - i * 0.12);
      ctx.globalAlpha = Math.max(0, 1 - kk) * 0.9;
      ctx.strokeStyle = i === 0 ? INK.yellow : 'rgba(200, 150, 20, 0.8)';
      ctx.lineWidth = 3 - i;
      ctx.beginPath();
      ctx.arc(sat.x, sat.y, 8 + kk * (JAM_R - 8), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (state.pulseT < JAM_WINDOW) {
      ctx.globalAlpha = 0.18 * (1 - state.pulseT / JAM_WINDOW);
      ctx.fillStyle = INK.yellow;
      ctx.beginPath();
      ctx.arc(sat.x, sat.y, JAM_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.translate(sat.x, sat.y);
  // Face along the orbit; a jet fires out the back to speed up, the front to slow.
  ctx.rotate(sat.ang + Math.PI / 2);
  if (sat.push) {
    ctx.save();
    if (sat.push < 0) ctx.rotate(Math.PI);
    const fl = 9 + Math.random() * 5;
    ctx.beginPath();
    ctx.moveTo(-18, -2.5);
    ctx.lineTo(-18 - fl, 0);
    ctx.lineTo(-18, 2.5);
    ctx.closePath();
    ctx.fillStyle = sat.push < 0 ? '#fff3c4' : '#ffd166';
    ctx.fill();
    ctx.strokeStyle = INK.red;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.4;
  // Solar panels.
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 4, 0);
    ctx.lineTo(side * 6, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(side > 0 ? 6 : -17, -3.5, 11, 7);
    ctx.fillStyle = '#9fc0ea';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(side > 0 ? 9.7 : -13.3, -3.5);
    ctx.lineTo(side > 0 ? 9.7 : -13.3, 3.5);
    ctx.moveTo(side > 0 ? 13.3 : -9.7, -3.5);
    ctx.lineTo(side > 0 ? 13.3 : -9.7, 3.5);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.rect(-4.5, -4.5, 9, 9);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // Dish.
  ctx.beginPath();
  ctx.moveTo(0, -4.5);
  ctx.lineTo(0, -8);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -9, 3, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.restore();
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    ctx.translate(p.x, p.y);
    if (p.puff) {
      ctx.beginPath();
      ctx.arc(0, 0, p.size * (1 + p.t * 3), 0, Math.PI * 2);
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
    ctx.globalAlpha = Math.max(0, 1 - t.t / 1.2);
    ctx.font = `bold ${t.size}px ${HAND_FONT}`;
    const y = t.y - t.t * 18;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(t.text, t.x, y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Your fleet's roster under the planet, plus the enemy kill count.
function drawLegend() {
  const y0 = BOX / 2 + 10;
  const rows = [{ label: 'YOURS', side: 'ally', y: y0 + 10 }];
  ctx.font = `12px ${HAND_FONT}`;
  ctx.textBaseline = 'middle';
  for (const row of rows) {
    const list = state.structs.filter((s) => s.side === row.side && (row.side === 'ally' || s.hp > 0));
    const ally = row.side === 'ally';
    ctx.fillStyle = ally ? INK.blue : INK.red;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, -BOX / 2 + 12, row.y);
    const shown = list.slice(0, 12);
    shown.forEach((s, i) => {
      const x = -BOX / 2 + 72 + i * 24;
      ctx.save();
      ctx.translate(x, row.y);
      ctx.scale(0.8, 0.8);
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fillStyle = s.hp <= 0 ? '#ece9e0' : ally ? '#d8e6f7' : '#f8d9d2';
      ctx.fill();
      ctx.strokeStyle = s.hp <= 0 ? INK.pencil : ally ? INK.marker : INK.red;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.strokeStyle = s.hp <= 0 ? 'rgba(85, 83, 78, 0.5)' : ally ? INK.blue : INK.red;
      ctx.lineWidth = 1.5;
      GLYPH[s.ambit](ctx);
      if (s.hp <= 0) {
        ctx.strokeStyle = INK.marker;
        ctx.beginPath();
        ctx.moveTo(-8, -8);
        ctx.lineTo(8, 8);
        ctx.moveTo(8, -8);
        ctx.lineTo(-8, 8);
        ctx.stroke();
      }
      ctx.restore();
    });
    if (list.length > shown.length) {
      ctx.fillStyle = INK.pencil;
      ctx.fillText(`+${list.length - shown.length}`, -BOX / 2 + 72 + shown.length * 24 - 8, row.y);
    }
  }
  ctx.fillStyle = INK.pencil;
  ctx.textAlign = 'right';
  ctx.fillText(`${state.enemyKills} enemy destroyed`, BOX / 2 - 10, y0 + 10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Speed gauge under the roster (the tick is the default speed), plus a guide
// line while dragging.
function drawControls() {
  if (drag && drag.moved && state.phase === 'playing') {
    const t = speedInput();
    ctx.strokeStyle = t >= 0 ? 'rgba(200, 150, 20, 0.8)' : 'rgba(85, 83, 78, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(drag.sx, drag.sy);
    ctx.lineTo(drag.x, drag.sy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(drag.sx, drag.sy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  const y = GAUGE_Y;
  const gw = 200;
  const gx = -gw / 2;
  const at = (v) => gx + (gw * (v - SPEED_MIN)) / (SPEED_MAX - SPEED_MIN);
  ctx.fillStyle = '#fff';
  ctx.fillRect(gx, y - 5, gw, 10);
  ctx.fillStyle = INK.yellow;
  ctx.fillRect(gx, y - 5, at(state.sat.v) - gx, 10);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(gx, y - 5, gw, 10);
  ctx.beginPath();
  ctx.moveTo(at(SPEED_DEFAULT), y - 8);
  ctx.lineTo(at(SPEED_DEFAULT), y + 8);
  ctx.stroke();
  ctx.fillStyle = INK.pencil;
  ctx.font = `11px ${HAND_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText('SLOW', gx - 8, y);
  ctx.textAlign = 'left';
  ctx.fillText('FAST', gx + gw + 8, y);
  ctx.textBaseline = 'alphabetic';
}

function drawCountdown(w, h) {
  const n = state.phase === 'countdown' ? Math.ceil(state.countdown - 0.5) : 0;
  const label = n > 0 ? String(n) : 'JAM!';
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

const starsFor = (secs) => STAR_TIMES.filter((t) => secs >= t).length;

let lastHud = '';
let hudStarCount = -1;
function updateHud() {
  const secs = Math.floor(state.t);
  const key = `${secs}`;
  if (key === lastHud) return;
  lastHud = key;
  hudTime.textContent = formatTime(secs);
  const stars = starsFor(secs);
  if (stars !== hudStarCount) {
    if (stars > hudStarCount && hudStarCount >= 0 && stars > 0) audio.sfx('star');
    hudStarCount = stars;
    hudStars.innerHTML = '';
    hudStars.append(renderStars(stars, { mini: true }));
  }
}

// ---- Flow --------------------------------------------------------------------

function showStart() {
  const rec = getRecord(GAME_ID);
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h1>We Be Jammin'</h1>
    <p>Your <b>Jamming Satellite</b> orbits the planet. <b>Tap</b> to jam enemy missiles before they hit your structs. How long can you last?</p>
    <p class="subtle"><b>Drag right</b> to speed up, <b>left</b> to slow down. Missed pulses and lost structs slow your recharge. Watch for <b>Interceptors</b> (yellow crown): their missiles are twice as fast.<br>Keyboard: A / D for speed, Space to jam.</p>
    <ul class="star-goals"></ul>
    <div class="best"></div>
    <div class="actions"><button class="paper-btn primary" type="button">Start</button></div>`;
  const goals = card.querySelector('.star-goals');
  STAR_TIMES.map((t) => `Survive ${formatTime(t)}`).forEach((g, i) => {
    const li = document.createElement('li');
    li.append(renderStars(i + 1, { mini: true }), g);
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
  overlay.hidden = true;
  lastHud = '';
  hudStarCount = -1;
}

function finish() {
  if (state.phase === 'done') return;
  const s = state;
  s.phase = 'done';
  audio.stopSong();
  const score = Math.floor(s.t);
  const stars = starsFor(score);
  const { record, newHigh, newBestStars } = saveResult(GAME_ID, score, stars);
  setTimeout(() => audio.sfx(stars === 0 ? 'lose' : 'win'), 150);
  const title = 'Fleet destroyed!';
  const notes = [`${s.jammed} missiles jammed`, `${s.enemyKills} enemy structs destroyed`];
  let note = `${notes.join(' · ')}.`;
  if (stars < 3) note += ` Next star at ${formatTime(STAR_TIMES[stars])}.`;
  showResults(overlay, {
    title,
    scoreText: formatTime(score),
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

// ---- Loop --------------------------------------------------------------------

state = newState();
layout();
showStart();

if (new URLSearchParams(location.search).has('debug')) {
  window.jammin = {
    get state() { return state; },
    start,
    pathAt,
    view: () => view,
    RAMP,
    get jamR() { return JAM_R; },
    set jamR(v) { JAM_R = v; },
    // Balance testing: change a few tunables at runtime.
    tune(o) {
      if (o.jamR != null) JAM_R = o.jamR;
      if (o.speedMin != null) SPEED_MIN = o.speedMin;
      if (o.speedMax != null) SPEED_MAX = o.speedMax;
      if (o.speedDefault != null) SPEED_DEFAULT = o.speedDefault;
      if (o.enemySlow != null) ENEMY_SLOW = o.enemySlow;
      if (o.missCd != null) MISS_COOLDOWN = o.missCd;
      Object.assign(RAMP, o.ramp || {});
      return { JAM_R, MISS_COOLDOWN, SPEED_MIN, SPEED_DEFAULT, SPEED_MAX, ENEMY_SLOW, ...RAMP };
    },
    get consts() { return { JAM_R, JAM_COOLDOWN, SAT_R, SPEED_MIN, SPEED_DEFAULT, SPEED_MAX, SPEED_ACCEL, SPEED_RETURN }; },
    // Fast-forward a run for balance testing. act(state) is called every
    // `every` seconds and steers by setting state.input = { throttle (-1..1), jam }.
    sim(seconds, act, every = 0.1) {
      silent = true;
      state = newState();
      state.phase = 'playing';
      let acc = 0;
      const dt = 1 / 60;
      for (let i = 0; i < seconds / dt && state.phase === 'playing'; i++) {
        update(dt);
        state.input.jam = false;
        acc += dt;
        if (acc >= every) {
          acc -= every;
          act(state);
        }
      }
      silent = false;
      const r = {
        t: Math.round(state.t),
        pulses: state.pulses,
        kills: state.enemyKills,
        alliesLeft: alive('ally').length,
        enemiesLeft: alive('enemy').length,
        jammed: state.jammed,
        hitsTaken: state.hitsTaken,
      };
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
