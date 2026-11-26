import { INK, HAND_FONT, rng, sketchLine, sketchRect, sketchCircle, hatch, graphPaper, fitCanvas } from '../shared/paper.js';
import { audio, noteFreq } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'last-line-of-defense';
const STAR_SCORES = [1600, 2200, 2800]; // points for 1, 2, 3 stars
const HEALTH = 10; // planetary struct health

// Targets, lowest to highest points. Sizes are in world units (the gallery
// is 400 units wide). speed is units/second at the start of a run.
const TYPES = {
  tank: { name: 'Tank', ambit: 'land', w: 92, h: 44, hits: 3, speed: 40, points: 10, damage: 1, lift: 3, every: 6.0 },
  bomber: { name: 'Stealth Bomber', ambit: 'air', w: 70, h: 30, hits: 3, speed: 60, points: 20, damage: 1, lift: 20, every: 7.0, upTime: 1.4, downTime: [0.8, 1.3] },
  battleship: { name: 'Battleship', ambit: 'space', w: 50, h: 22, hits: 3, speed: 72, points: 30, damage: 1, lift: 24, every: 6.5 },
  cruiser: { name: 'Cruiser', ambit: 'water', w: 150, h: 58, hits: 12, speed: 19, points: 100, damage: 3, lift: -10 },
  cmd: { name: 'Command Ship', w: 26, h: 16, hits: 12, points: 200, damage: 3 },
};

// Rows top to bottom, and which way each one scrolls.
const AMBITS = [
  { id: 'space', label: 'SPACE', dir: 1 },
  { id: 'air', label: 'AIR', dir: -1 },
  { id: 'land', label: 'LAND', dir: 1 },
  { id: 'water', label: 'WATER', dir: -1 },
];

// Difficulty ramps with time survived (seconds).
const speedMul = (t) => Math.min(3.5, 1 + t / 180);
const spawnMul = (t) => 1 + t / 120;

const CRUISER_FIRST = 22; // seconds
const CRUISER_GAP = [22, 34]; // after the previous one is gone
const CMD_FIRST = 50;
const CMD_GAP = [18, 28];
const CMD_VISITS = 5; // pop-ups before it gets away
const CMD_HOLD = 2.0; // seconds it stays up (shrinks with difficulty)

const FIRE_GAP = 0.085; // fastest tapping
const AUTO_GAP = 0.2; // holding down fires this often
const TOUCH_SLOP = 5; // extra hit margin for fingers (world units)

// ---- Layout --------------------------------------------------------------

const WORLD_W = 400;
const AWNING = 22;
const COUNTER = 62;
const STRIP = 18; // front strip at the bottom of each row
const MIN_H = 520;
const MAX_H = 720;
const TOP_PAD = 60; // room for the top bar (CSS px)

const shell = document.getElementById('shell');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;
const formatTime = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = '<span class="hud-score" aria-label="Score">0</span><span class="hud-stars"></span>';
mountTopBar(shell, { extra: hud });
const hudScore = hud.querySelector('.hud-score');
const hudStars = hud.querySelector('.hud-stars');

// Targets grow a little when the rows are tall (phones in portrait).
let K = 1;
let view = { scale: 1, ox: 0, oy: 0, worldH: MIN_H, rowH: 100, cw: 0, ch: 0, dpr: 1 };

function layout() {
  const { w, h, dpr } = fitCanvas(canvas);
  const top = TOP_PAD;
  const availH = Math.max(200, h - top - 6);
  const scale = Math.min(w / WORLD_W, availH / MIN_H);
  const worldH = Math.max(MIN_H, Math.min(MAX_H, availH / scale));
  view = {
    scale,
    worldH,
    rowH: (worldH - AWNING - COUNTER) / 4,
    ox: (w - WORLD_W * scale) / 2,
    oy: top + (availH - worldH * scale) / 2,
    cw: w,
    ch: h,
    dpr,
  };
  K = Math.max(1, Math.min(1.3, view.rowH / 120));
}

const rowTop = (r) => AWNING + r * view.rowH;
const stripTop = (r) => rowTop(r) + view.rowH - STRIP;
const CANNON = () => ({ x: WORLD_W / 2, y: view.worldH - COUNTER + 24 });

// ---- State ---------------------------------------------------------------

let state;
let silent = false; // true while the balance sim runs
let nextId = 1;

function newState() {
  return {
    phase: 'ready',
    countdown: 3.5,
    t: 0, // seconds survived
    score: 0,
    health: HEALTH,
    rows: AMBITS.map(() => ({ timer: 0.6 + Math.random() * 1.6, list: [] })),
    cruiserTimer: CRUISER_FIRST,
    cmd: null,
    cmdTimer: CMD_FIRST,
    cmdLastRow: -1,
    fireCd: 0,
    shots: 0,
    hits: 0,
    kills: 0,
    escaped: 0,
    escapedBy: {},
    particles: [],
    texts: [],
    misses: [],
    tracers: [],
    flashes: [],
    shake: 0,
    recoil: 0,
    aim: -Math.PI / 2,
    overT: 0,
    tempo: 0,
  };
}

function play(fn) {
  if (!silent) fn();
}

// ---- Spawning --------------------------------------------------------------

function spawn(type, row) {
  const T = TYPES[type];
  const dir = AMBITS[row].dir;
  const e = {
    id: nextId++,
    type,
    row,
    dir,
    x: dir > 0 ? -(T.w * K) / 2 - 4 : WORLD_W + (T.w * K) / 2 + 4,
    hp: T.hits,
    up: 1,
    upTarget: 1,
    holes: [],
    dead: false,
    deadT: 0,
    bob: Math.random() * 6,
    flipT: 0,
    seed: Math.floor(Math.random() * 1e6),
  };
  if (type === 'bomber') {
    // Rolls in face-down, then pops up for a moment at a time.
    e.up = 0;
    e.upTarget = 0;
    e.flipT = 0.35 + Math.random() * 0.5;
  }
  state.rows[row].list.push(e);
  return e;
}

// Room for a new target at the entry edge of a row?
function entryClear(row, w) {
  const list = state.rows[row].list.filter((e) => !e.dead);
  const last = list[list.length - 1];
  if (!last) return true;
  const T = TYPES[last.type];
  const gap = 18;
  return last.dir > 0
    ? last.x - (T.w * K) / 2 > w + gap
    : WORLD_W - (last.x + (T.w * K) / 2) > w + gap;
}

function updateSpawns(dt) {
  const t = state.t;
  // Regular traffic in space, air and land.
  const regular = { 0: 'battleship', 1: 'bomber', 2: 'tank' };
  for (const [rowStr, type] of Object.entries(regular)) {
    const row = Number(rowStr);
    const r = state.rows[row];
    r.timer -= dt;
    if (r.timer <= 0) {
      if (entryClear(row, TYPES[type].w * K)) {
        spawn(type, row);
        r.timer = (TYPES[type].every * (0.75 + Math.random() * 0.55)) / spawnMul(t);
      } else {
        r.timer = 0.2;
      }
    }
  }
  // Rare cruisers in the water, one at a time.
  const water = state.rows[3];
  if (!water.list.some((e) => !e.dead)) {
    state.cruiserTimer -= dt;
    if (state.cruiserTimer <= 0) {
      spawn('cruiser', 3);
      state.cruiserTimer = CRUISER_GAP[0] + Math.random() * (CRUISER_GAP[1] - CRUISER_GAP[0]);
    }
  }
  // One Command Ship at a time.
  if (!state.cmd) {
    state.cmdTimer -= dt;
    if (state.cmdTimer <= 0) {
      state.cmd = { hp: TYPES.cmd.hits, visits: 0, phase: 'away', t: 0.01, up: 0, holes: [], x: 0, y: 0, row: 0, seed: 7 };
      play(() => sfx('cmdAlarm'));
    }
  }
}

// ---- Update ----------------------------------------------------------------

function update(dt) {
  state.shake = Math.max(0, state.shake - dt * 3);
  state.recoil = Math.max(0, state.recoil - dt * 8);
  state.fireCd = Math.max(0, state.fireCd - dt);
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
        play(() => audio.playSong(song(0)));
      }
    }
  }

  if (state.phase === 'playing') {
    state.t += dt;
    state.goT += dt;
    updateSpawns(dt);
    updateTargets(dt);
    updateCmd(dt);
    updateHold(dt);
    // Music speeds up every minute.
    const tempo = Math.min(3, Math.floor(state.t / 60));
    if (tempo !== state.tempo) {
      state.tempo = tempo;
      play(() => audio.playSong(song(tempo)));
    }
  } else if (state.phase === 'over') {
    updateTargets(dt * 0.25);
    state.overT += dt;
    if (state.overT > 1.4 && !silent) finish();
  }
}

function updateTargets(dt) {
  const sm = speedMul(state.t);
  for (const row of state.rows) {
    for (const e of row.list) {
      const T = TYPES[e.type];
      if (e.dead) {
        e.deadT += dt;
        e.up = Math.max(0, e.up - dt * 5);
        continue;
      }
      e.x += e.dir * T.speed * (e.type === 'cruiser' ? Math.sqrt(sm) : sm) * dt;
      e.bob += dt;
      if (e.type === 'bomber') {
        e.flipT -= dt;
        if (e.flipT <= 0) {
          if (e.upTarget === 0) {
            e.upTarget = 1;
            e.flipT = T.upTime / Math.sqrt(sm);
            play(() => sfx('flipUp'));
          } else {
            e.upTarget = 0;
            e.flipT = (T.downTime[0] + Math.random() * (T.downTime[1] - T.downTime[0])) / Math.sqrt(sm);
            play(() => sfx('flipDown'));
          }
        }
      }
      const rate = 7;
      e.up += Math.sign(e.upTarget - e.up) * Math.min(Math.abs(e.upTarget - e.up), rate * dt);
      // Off the far edge without being shot down?
      const off = e.dir > 0 ? e.x - (T.w * K) / 2 > WORLD_W + 2 : e.x + (T.w * K) / 2 < -2;
      if (off) {
        e.dead = true;
        e.gone = true;
        damage(T.damage, e.row, e.dir, T.name);
      }
    }
    row.list = row.list.filter((e) => !(e.dead && (e.gone || e.deadT > 0.5)));
  }
}

function updateCmd(dt) {
  const c = state.cmd;
  if (!c) return;
  c.t -= dt;
  const hold = Math.max(0.95, CMD_HOLD / Math.sqrt(speedMul(state.t)));
  if (c.phase === 'dead') {
    c.up = Math.max(0, c.up - dt * 5);
    if (c.t <= 0) endCmd();
    return;
  }
  if (c.phase === 'away' && c.t <= 0) {
    if (c.visits >= CMD_VISITS) {
      // It got away.
      damage(TYPES.cmd.damage, c.row, 1, 'Command Ship', true);
      endCmd();
      return;
    }
    // Pick a different ambit and spot, then show a hint where it'll pop up.
    let row;
    do row = Math.floor(Math.random() * 4);
    while (row === state.cmdLastRow);
    state.cmdLastRow = row;
    c.row = row;
    c.x = 30 + Math.random() * (WORLD_W - 60);
    // Up in the top part of the row, above the regular traffic.
    const hi = rowTop(row) + 14 + TYPES.cmd.h * K + 8;
    const lo = Math.max(hi, rowTop(row) + view.rowH * 0.42);
    c.lift = stripTop(row) - (hi + Math.random() * (lo - hi));
    c.phase = 'hint';
    c.t = 0.45;
    c.visits++;
  } else if (c.phase === 'hint' && c.t <= 0) {
    c.phase = 'up';
    c.t = hold;
    play(() => sfx('flipUp'));
  } else if (c.phase === 'up' && c.t <= 0) {
    c.phase = 'away';
    c.t = 0.55;
    play(() => sfx('flipDown'));
  }
  const target = c.phase === 'up' ? 1 : 0;
  c.up += Math.sign(target - c.up) * Math.min(Math.abs(target - c.up), 8 * dt);
}

function endCmd() {
  state.cmd = null;
  state.cmdTimer = CMD_GAP[0] + Math.random() * (CMD_GAP[1] - CMD_GAP[0]);
}

function damage(amount, row, dir, name, cmd = false) {
  state.health = Math.max(0, state.health - amount);
  state.escaped++;
  state.escapedBy[name] = (state.escapedBy[name] || 0) + 1;
  state.shake = Math.max(state.shake, cmd ? 1 : 0.6);
  state.flashes.push({ row, side: dir > 0 ? 1 : -1, t: 0, cmd });
  const y = rowTop(row) + view.rowH * 0.45;
  state.texts.push({ x: dir > 0 ? WORLD_W - 30 : 30, y, text: `-${amount}`, color: INK.red, t: 0, size: 22 });
  if (cmd) state.texts.push({ x: WORLD_W / 2, y, text: 'Command Ship escaped!', color: INK.red, t: -0.1, size: 18 });
  play(() => sfx(cmd ? 'cmdEscape' : 'escape'));
  if (state.health <= 0 && state.phase === 'playing') {
    state.phase = 'over';
    state.overT = 0;
    play(() => {
      audio.stopSong();
      audio.sfx('explode');
    });
  }
}

// ---- Shooting -------------------------------------------------------------

function targetBottom(e) {
  const T = TYPES[e.type];
  let y = stripTop(e.row) + 4 - T.lift * K;
  if (e.type === 'cruiser') y += Math.sin(e.bob * 1.8) * 4;
  return y;
}

function cmdBottom(c) {
  return stripTop(c.row) - c.lift;
}

// Topmost live target under a world point, or null.
function targetAt(wx, wy, slop) {
  const c = state.cmd;
  if (c && c.phase === 'up' && c.up > 0.6) {
    const T = TYPES.cmd;
    const b = cmdBottom(c);
    if (Math.abs(wx - c.x) <= (T.w * K) / 2 + slop + 2 && wy <= b + slop && wy >= b - (T.h * K) * c.up - slop - 2) {
      return { cmd: c, lx: wx - c.x, ly: wy - b };
    }
  }
  for (let r = 3; r >= 0; r--) {
    const list = state.rows[r].list;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dead || e.up < 0.6) continue;
      const T = TYPES[e.type];
      const b = targetBottom(e);
      const visibleBottom = Math.min(b, stripTop(e.row));
      if (Math.abs(wx - e.x) <= (T.w * K) / 2 + slop && wy <= visibleBottom + slop && wy >= b - (T.h * K) * e.up - slop) {
        return { e, lx: (wx - e.x) * e.dir, ly: wy - b };
      }
    }
  }
  return null;
}

// Fire the cannon at a world point. Returns true on a hit.
function fire(wx, wy, slop = 0) {
  if (state.phase !== 'playing' || state.fireCd > 0) return false;
  state.fireCd = FIRE_GAP;
  state.shots++;
  const cn = CANNON();
  state.aim = Math.atan2(wy - cn.y, wx - cn.x);
  state.recoil = 1;
  state.tracers.push({ x1: cn.x + Math.cos(state.aim) * 34, y1: cn.y + Math.sin(state.aim) * 34, x2: wx, y2: wy, t: 0 });
  const hit = targetAt(wx, wy, slop);
  if (!hit) {
    state.misses.push({ x: wx, y: wy, t: 0, seed: Math.floor(Math.random() * 1000) });
    if (state.misses.length > 40) state.misses.shift();
    play(() => sfx('shot'));
    return false;
  }
  state.hits++;
  const tgt = hit.cmd || hit.e;
  const type = hit.cmd ? 'cmd' : hit.e.type;
  tgt.holes.push({ x: hit.lx / K, y: Math.max(hit.ly / K, -TYPES[type].h + 2), s: Math.floor(Math.random() * 1000) });
  if (tgt.holes.length > 40) tgt.holes.shift();
  tgt.hp--;
  burst(wx, wy, 5, '#fff');
  if (tgt.hp <= 0) {
    const pts = TYPES[type].points;
    state.score += pts;
    state.kills++;
    state.texts.push({ x: wx, y: wy - 10, text: `+${pts}`, color: INK.green, t: 0, size: type === 'cmd' || type === 'cruiser' ? 26 : 20 });
    burst(wx, wy, type === 'cruiser' ? 26 : 14, INK.cardboard);
    if (hit.cmd) {
      hit.cmd.phase = 'dead';
      hit.cmd.t = 0.5;
    } else {
      hit.e.dead = true;
      hit.e.upTarget = 0;
    }
    play(() => sfx(type === 'cruiser' || type === 'cmd' ? 'bigKill' : 'kill'));
    if (!silent) bumpScore();
  } else {
    play(() => sfx(type === 'cruiser' ? 'clank' : 'hit'));
  }
  return true;
}

function burst(x, y, n, color) {
  if (silent) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 110;
    state.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, t: 0, life: 0.5 + Math.random() * 0.4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, size: 2 + Math.random() * 3, color });
  }
}

function updateEffects(dt) {
  for (const p of state.particles) {
    p.t += dt;
    p.vy += 260 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
  }
  state.particles = state.particles.filter((p) => p.t < p.life);
  for (const list of [state.texts, state.misses, state.tracers, state.flashes]) for (const x of list) x.t += dt;
  state.texts = state.texts.filter((x) => x.t < 1);
  state.misses = state.misses.filter((x) => x.t < 1.2);
  state.tracers = state.tracers.filter((x) => x.t < 0.09);
  state.flashes = state.flashes.filter((x) => x.t < 0.6);
}

// ---- Input -------------------------------------------------------------------

const pointer = { x: 0, y: 0, inside: false, mouse: false, held: null, autoT: 0, touches: [] };

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale };
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  const p = toWorld(e);
  pointer.mouse = e.pointerType === 'mouse';
  pointer.x = p.x;
  pointer.y = p.y;
  pointer.inside = true;
  pointer.held = e.pointerId;
  pointer.autoT = AUTO_GAP + 0.08; // a little longer before auto-fire kicks in
  if (!pointer.mouse) pointer.touches.push({ x: p.x, y: p.y, t: 0 });
  fire(p.x, p.y, pointer.mouse ? 0 : TOUCH_SLOP);
});
canvas.addEventListener('pointermove', (e) => {
  const p = toWorld(e);
  if (e.pointerType === 'mouse') {
    pointer.mouse = true;
    pointer.inside = true;
  }
  if (e.pointerType === 'mouse' || e.pointerId === pointer.held) {
    pointer.x = p.x;
    pointer.y = p.y;
  }
});
const release = (e) => {
  if (e.pointerId === pointer.held) pointer.held = null;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', (e) => {
  release(e);
  if (e.pointerType === 'mouse') pointer.inside = false;
});

function updateHold(dt) {
  for (const t of pointer.touches) t.t += dt;
  pointer.touches = pointer.touches.filter((t) => t.t < 0.35);
  if (pointer.held == null) return;
  pointer.autoT -= dt;
  if (pointer.autoT <= 0) {
    pointer.autoT = AUTO_GAP;
    if (!pointer.mouse) pointer.touches.push({ x: pointer.x, y: pointer.y, t: 0 });
    fire(pointer.x, pointer.y, pointer.mouse ? 0 : TOUCH_SLOP);
  }
}

// Space bar fires at the mouse crosshair.
addEventListener('keydown', (e) => {
  if (e.key === ' ' && state.phase === 'playing' && pointer.inside) {
    e.preventDefault();
    if (!e.repeat) fire(pointer.x, pointer.y);
  }
});

// ---- Sound -------------------------------------------------------------------

function sfx(name) {
  const n = noteFreq;
  switch (name) {
    case 'shot':
      audio.noise({ dur: 0.05, vol: 0.22, rate: 1.3 });
      audio.tone({ wave: 'pulse12', freq: 900, freqEnd: 260, dur: 0.05, vol: 0.08 });
      break;
    case 'hit':
      audio.noise({ dur: 0.04, vol: 0.2, rate: 1.3 });
      audio.tone({ wave: 'pulse25', freq: 1500, dur: 0.04, vol: 0.13, at: 0.01 });
      break;
    case 'clank':
      audio.noise({ dur: 0.04, vol: 0.2, rate: 1.3 });
      audio.tone({ wave: 'pulse50', freq: 520, freqEnd: 480, dur: 0.06, vol: 0.12, at: 0.01 });
      break;
    case 'kill':
      audio.noise({ dur: 0.22, vol: 0.32, rate: 0.7, rateEnd: 0.15 });
      ['C6', 'E6', 'G6'].forEach((note, i) => audio.tone({ wave: 'pulse25', freq: n(note), dur: 0.05, vol: 0.13, at: 0.03 + i * 0.045 }));
      break;
    case 'bigKill':
      audio.noise({ dur: 0.6, vol: 0.45, rate: 0.5, rateEnd: 0.06 });
      ['C5', 'E5', 'G5', 'C6', 'E6', 'G6'].forEach((note, i) => audio.tone({ wave: 'pulse25', freq: n(note), dur: 0.06, vol: 0.14, at: 0.05 + i * 0.055 }));
      break;
    case 'escape':
      audio.tone({ wave: 'triangle', freq: 150, freqEnd: 45, dur: 0.3, vol: 0.4 });
      audio.noise({ dur: 0.2, vol: 0.25, rate: 0.2 });
      break;
    case 'cmdEscape':
      audio.tone({ wave: 'triangle', freq: 150, freqEnd: 40, dur: 0.5, vol: 0.45 });
      audio.noise({ dur: 0.35, vol: 0.3, rate: 0.2 });
      ['A4', 'F4', 'D4'].forEach((note, i) => audio.tone({ wave: 'pulse50', freq: n(note), dur: 0.12, vol: 0.13, at: 0.1 + i * 0.13 }));
      break;
    case 'flipUp':
      audio.tone({ wave: 'pulse12', freq: 500, freqEnd: 1100, dur: 0.06, vol: 0.06 });
      break;
    case 'flipDown':
      audio.tone({ wave: 'pulse12', freq: 900, freqEnd: 400, dur: 0.06, vol: 0.05 });
      break;
    case 'cmdAlarm':
      [0, 0.16, 0.32].forEach((at) => audio.tone({ wave: 'pulse25', freq: n('A5'), freqEnd: n('E5'), dur: 0.12, vol: 0.12, at }));
      break;
    default:
      break;
  }
}

// A carnival waltz (3/4) on the NES channels; tempo goes up each minute.
function song(level) {
  const melody = [
    'G4 - C5 - E5 -', 'G5 - - - E5 -', 'F5 - D5 - B4 -', 'C5 - - - G4 -',
    'A4 - C5 - F5 -', 'A5 - - - F5 -', 'G5 - E5 - D5 -', 'C5 - - - . .',
    'E5 F5 G5 - E5 -', 'C6 - - - G5 -', 'A5 G5 F5 - D5 -', 'G5 - - - F5 -',
    'E5 F5 G5 - C6 -', 'B5 - A5 - G5 -', 'F5 - D5 - B4 -', 'C5 - - - . .',
  ];
  const chords = 'C C G C F F G C C C F G C G G C'.split(' ');
  const voicing = { C: ['C3', 'E4', 'G4'], G: ['G2', 'D4', 'F4'], F: ['F2', 'F4', 'A4'] };
  const tri = chords.map((c) => `${voicing[c][0]} - . . . .`).join(' ');
  const p2 = chords.map((c) => `. . ${voicing[c][1]} . ${voicing[c][2]} .`).join(' ');
  return {
    bpm: 168 + level * 14,
    stepsPerBeat: 2,
    wave1: 'pulse25',
    wave2: 'pulse12',
    vol2: 0.05,
    tracks: { p1: melody.join(' '), p2, tri, noise: 'k . h . h .' },
  };
}

// ---- Render ----------------------------------------------------------------

function render() {
  layout();
  const { scale, ox, oy, cw, ch, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let sx = 0;
  let sy = 0;
  if (state.shake > 0) {
    sx = (Math.random() - 0.5) * state.shake * 8;
    sy = (Math.random() - 0.5) * state.shake * 8;
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
  const left = -ox / scale - 10;
  const top = -oy / scale - 10;
  const vw = cw / scale + 20;
  const vh = ch / scale + 20;
  graphPaper(ctx, left, top, vw, vh, 10, 4);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let r = 0; r < 4; r++) drawRow(r);
  drawMisses();
  drawPosts();
  drawAwning();
  drawCounter();
  drawTracers();
  drawParticles();
  drawTexts();
  drawFlashes();
  drawAim();
  if (state.phase === 'countdown' || (state.phase === 'playing' && state.goT < 0.6)) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCountdown(cw, ch);
  }
  updateHud();
}

const AMBIT_TINT = {
  space: 'rgba(60, 50, 120, 0.07)',
  air: 'rgba(90, 170, 230, 0.08)',
  land: 'rgba(170, 120, 60, 0.08)',
  water: 'rgba(40, 110, 200, 0.1)',
};

function drawRow(r) {
  const a = AMBITS[r];
  const y0 = rowTop(r);
  const h = view.rowH;
  const st = stripTop(r);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y0, WORLD_W, h);
  ctx.clip();
  ctx.fillStyle = AMBIT_TINT[a.id];
  ctx.fillRect(0, y0, WORLD_W, h);
  drawRowDoodles(a.id, y0, st);

  const c = state.cmd;
  const cmdHere = c && c.row === r && c.phase !== 'away';
  // The Command Ship's stick goes behind the regular targets.
  if (cmdHere && c.phase !== 'hint') drawStick(c.x, cmdBottom(c) - 2, stripTop(r) + STRIP);
  for (const e of state.rows[r].list) drawTarget(e);
  if (cmdHere) drawCmd(c);
  drawStrip(a, r, st);
  ctx.restore();

  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  sketchLine(ctx, 0, y0 + h, WORLD_W, y0 + h, 400 + r, { wobble: 1 });
}

function drawRowDoodles(id, y0, st) {
  const r = rng(77 + id.length * 13);
  ctx.strokeStyle = 'rgba(85, 83, 78, 0.35)';
  ctx.lineWidth = 1.3;
  if (id === 'space') {
    for (let i = 0; i < 14; i++) {
      const x = r() * WORLD_W;
      const y = y0 + 6 + r() * (st - y0 - 12);
      const s = 2 + r() * 2.5;
      ctx.beginPath();
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      ctx.stroke();
    }
    sketchCircle(ctx, 335, y0 + 26, 14, 31);
    ctx.beginPath();
    ctx.ellipse(335, y0 + 26, 24, 5, -0.25, 0, Math.PI * 2);
    ctx.stroke();
  } else if (id === 'air') {
    for (let i = 0; i < 4; i++) {
      const x = 40 + i * 100 + r() * 30;
      const y = y0 + 14 + r() * 26;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(x + k * 12, y - (k === 1 ? 4 : 0), 8, Math.PI, 0);
        ctx.stroke();
      }
    }
  } else if (id === 'land') {
    ctx.beginPath();
    ctx.moveTo(0, st - 18);
    for (let x = 0; x <= WORLD_W; x += 20) ctx.lineTo(x, st - 18 - Math.sin(x / 60) * 12 - 8);
    ctx.stroke();
  } else {
    for (let i = 0; i < 5; i++) {
      const x = r() * WORLD_W;
      const y = y0 + 12 + r() * (st - y0 - 30);
      ctx.beginPath();
      ctx.arc(x, y, 6, Math.PI * 0.15, Math.PI * 0.85);
      ctx.arc(x + 12, y, 6, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  }
}

function drawStrip(a, r, st) {
  const t = performance.now() / 1000;
  const bottom = rowTop(r) + view.rowH;
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK.marker;
  if (a.id === 'water') {
    // Two layers of waves, the cruiser sails between them.
    for (const [k, color, off] of [[0, '#9cc3ea', -4], [1, '#6fa3dc', 4]]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-10, bottom);
      const phase = t * (k ? -1.4 : 1.1) * 18;
      for (let x = -10; x <= WORLD_W + 10; x += 4) {
        ctx.lineTo(x, st + off + Math.sin((x + phase) / 11) * 3.2);
      }
      ctx.lineTo(WORLD_W + 10, bottom);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = INK.cardboard;
    ctx.beginPath();
    if (a.id === 'air') {
      ctx.moveTo(-10, bottom);
      ctx.lineTo(-10, st + 6);
      for (let x = -10; x < WORLD_W + 10; x += 22) ctx.arc(x + 11, st + 6, 11, Math.PI, 0);
      ctx.lineTo(WORLD_W + 10, bottom);
      ctx.fillStyle = '#fff';
    } else if (a.id === 'land') {
      ctx.moveTo(-10, bottom);
      for (let x = -10, i = 0; x <= WORLD_W + 10; x += 8, i++) ctx.lineTo(x, i % 2 === 0 ? st - 2 : st + 4);
      ctx.lineTo(WORLD_W + 10, bottom);
      ctx.fillStyle = '#8fcf8a';
    } else {
      ctx.rect(-10, st, WORLD_W + 20, bottom - st);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (a.id === 'space') {
      // Rail ticks moving the way the row scrolls.
      ctx.strokeStyle = 'rgba(36, 34, 31, 0.5)';
      ctx.lineWidth = 1.5;
      const off = ((t * 30 * a.dir) % 16 + 16) % 16;
      ctx.beginPath();
      for (let x = -16 + off; x < WORLD_W + 16; x += 16) {
        ctx.moveTo(x, st + 5);
        ctx.lineTo(x + 6, st + 5);
      }
      ctx.stroke();
    }
  }
  // Ambit label tag.
  ctx.save();
  ctx.translate(8, bottom - 4);
  ctx.font = `13px ${HAND_FONT}`;
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(a.label).width + 10;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.5;
  ctx.fillRect(0, -15, w, 14);
  ctx.strokeRect(0, -15, w, 14);
  ctx.fillStyle = INK.marker;
  ctx.fillText(a.label, 5, -1.5);
  ctx.restore();
}

function drawStick(x, from, to) {
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, from);
  ctx.lineTo(x, to);
  ctx.stroke();
  ctx.strokeStyle = INK.cardboard;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawTarget(e) {
  const T = TYPES[e.type];
  const b = targetBottom(e);
  const st = stripTop(e.row);
  if (e.type !== 'cruiser') drawStick(e.x, b - 2, st + STRIP);
  if (e.up <= 0.02) {
    // Flipped flat: just the edge of the cutout.
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(e.x - (T.w * K) / 2, b);
    ctx.lineTo(e.x + (T.w * K) / 2, b);
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.translate(e.x, b);
  if (e.type === 'cruiser') ctx.rotate(Math.sin(e.bob * 1.8 + 1) * 0.02);
  ctx.scale(e.dir * K, Math.max(0.04, e.up) * K);
  if (e.dead) ctx.globalAlpha = Math.max(0, 1 - e.deadT * 2);
  SHAPES[e.type](e.seed);
  drawHoles(e.holes);
  ctx.restore();
  if (!e.dead && e.up > 0.6) drawHealth(e.x, b - (T.h * K) - 6, e.hp, T.hits, e.type === 'cruiser');
}

function drawCmd(c) {
  const T = TYPES.cmd;
  const b = cmdBottom(c);
  if (c.phase === 'hint') {
    // A puff of dust where it's about to pop up.
    ctx.strokeStyle = 'rgba(36, 34, 31, 0.6)';
    ctx.lineWidth = 1.5;
    const k = 1 - c.t / 0.45;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c.x + Math.cos(a) * 9 * k, b - 6 + Math.sin(a) * 5 * k, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }
  if (c.up <= 0.02) return;
  ctx.save();
  ctx.translate(c.x, b);
  ctx.scale(K, Math.max(0.04, c.up) * K);
  SHAPES.cmd(c.seed);
  drawHoles(c.holes);
  ctx.restore();
  if (c.phase === 'up' && c.up > 0.6) {
    drawHealth(c.x, b - (T.h * K) - 6, c.hp, T.hits);
    // Pop-ups left before it escapes.
    ctx.fillStyle = INK.red;
    ctx.font = `11px ${HAND_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${CMD_VISITS - c.visits + 1}`, c.x + 20, b - 2);
    ctx.textAlign = 'left';
  }
}

function drawHealth(x, y, hp, max, wide = false) {
  if (max <= 3) {
    for (let i = 0; i < max; i++) {
      const px = x + (i - (max - 1) / 2) * 9;
      ctx.beginPath();
      ctx.arc(px, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = i < hp ? INK.red : '#fff';
      ctx.fill();
      ctx.strokeStyle = INK.marker;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    return;
  }
  const w = wide ? 70 : 34;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - w / 2, y - 3, w, 6);
  ctx.fillStyle = INK.red;
  ctx.fillRect(x - w / 2, y - 3, (w * hp) / max, 6);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.3;
  ctx.strokeRect(x - w / 2, y - 3, w, 6);
}

function drawHoles(holes) {
  for (const h of holes) {
    ctx.fillStyle = INK.marker;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(36, 34, 31, 0.45)';
    ctx.lineWidth = 0.8;
    const r = rng(h.s);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2;
      ctx.moveTo(h.x + Math.cos(a) * 2.5, h.y + Math.sin(a) * 2.5);
      ctx.lineTo(h.x + Math.cos(a) * 5, h.y + Math.sin(a) * 5);
    }
    ctx.stroke();
  }
}

// Cardboard cutouts, drawn facing right with the origin at the bottom center.
function poly(pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// Fills and outlines the current path, optionally with marker hatching inside.
function inked(fill, seed, hatchColor = null) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (hatchColor) {
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = hatchColor;
    ctx.lineWidth = 1.2;
    hatch(ctx, -80, -70, 160, 80, { gap: 5, seed });
    ctx.restore();
  }
}

const SHAPES = {
  tank(seed) {
    // treads
    ctx.beginPath();
    ctx.roundRect(-44, -15, 88, 15, 7);
    inked('#fff', seed);
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(-35 + i * 14, -7.5, 4.6, 0, Math.PI * 2);
      inked('#fff', seed + i);
    }
    // hull
    poly([[-40, -15], [40, -15], [33, -27], [-35, -27]]);
    inked('#cfe6c4', seed, 'rgba(46,158,79,0.55)');
    // turret + barrel
    ctx.beginPath();
    ctx.rect(8, -36, 38, 5);
    inked('#fff', seed);
    ctx.beginPath();
    ctx.arc(-3, -27, 14, Math.PI, 0);
    ctx.closePath();
    inked('#cfe6c4', seed + 3, 'rgba(46,158,79,0.55)');
  },
  bomber(seed) {
    poly([[34, -14], [-18, -30], [-33, -28], [-25, -21], [-31, -15], [-25, -9], [-33, -2], [-18, 0]]);
    inked('#77757e', seed, 'rgba(255,255,255,0.35)');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(26, -14);
    ctx.lineTo(12, -14);
    ctx.stroke();
  },
  battleship(seed) {
    // engine flame
    poly([[-25, -13], [-34, -9], [-25, -5]]);
    inked(INK.yellow, seed);
    ctx.beginPath();
    ctx.rect(-10, -21, 11, 7);
    inked('#fff', seed);
    ctx.beginPath();
    ctx.moveTo(6, -16);
    ctx.lineTo(18, -18);
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2;
    ctx.stroke();
    poly([[25, -9], [14, -15.5], [-18, -15.5], [-25, -12], [-25, -6], [-18, -2], [14, -3]]);
    inked('#c9dcf4', seed, 'rgba(47,111,192,0.5)');
  },
  cruiser(seed) {
    // mast + bridge + superstructure
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-2, -54);
    ctx.lineTo(-2, -66);
    ctx.moveTo(-8, -62);
    ctx.lineTo(4, -62);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(-12, -54, 20, 10);
    inked('#fff', seed);
    ctx.beginPath();
    ctx.rect(-34, -44, 52, 18);
    inked('#e3e1da', seed + 1, 'rgba(85,83,78,0.4)');
    // turrets
    for (const [tx, flip] of [[40, 1], [-52, -1]]) {
      ctx.beginPath();
      ctx.rect(tx + (flip > 0 ? 4 : -24), -35, 20, 3.5);
      inked('#fff', seed);
      ctx.beginPath();
      ctx.arc(tx, -26, 9, Math.PI, 0);
      ctx.closePath();
      inked('#e3e1da', seed + 2);
    }
    // hull
    poly([[76, -27], [64, 4], [-66, 4], [-74, -25]]);
    inked('#bdbab2', seed + 4, 'rgba(36,34,31,0.35)');
    // portholes
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(-45 + i * 18, -15, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  },
  cmd(seed) {
    poly([[13, -8], [-4, -16], [-13, -13], [-9, -8], [-13, -3], [-4, 0]]);
    inked(INK.yellow, seed);
    const blink = Math.floor(performance.now() / 250) % 2;
    ctx.beginPath();
    ctx.arc(-2, -8, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = blink ? INK.red : '#fff';
    ctx.fill();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1;
    ctx.stroke();
  },
};

function drawMisses() {
  ctx.strokeStyle = INK.pencil;
  ctx.lineWidth = 1.5;
  for (const m of state.misses) {
    ctx.globalAlpha = Math.max(0, 1 - m.t / 1.2) * 0.8;
    ctx.beginPath();
    ctx.moveTo(m.x - 3, m.y - 3);
    ctx.lineTo(m.x + 3, m.y + 3);
    ctx.moveTo(m.x + 3, m.y - 3);
    ctx.lineTo(m.x - 3, m.y + 3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Cardboard booth posts either side of the gallery (only visible when the
// screen is wider than the gallery).
const POST = 22;
function drawPosts() {
  for (const x of [-POST, WORLD_W]) {
    ctx.fillStyle = INK.cardboard;
    ctx.fillRect(x, -6, POST, view.worldH + 6);
    ctx.strokeStyle = 'rgba(36, 34, 31, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 4; y < view.worldH; y += 9) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + POST, y);
    }
    ctx.stroke();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2.5;
    sketchRect(ctx, x, -6, POST, view.worldH + 6, 501 + x, { wobble: 1 });
  }
}

function drawAwning() {
  const n = 10;
  const w = WORLD_W / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#ec8f80';
    ctx.beginPath();
    ctx.moveTo(i * w, 0);
    ctx.lineTo(i * w, AWNING - 8);
    ctx.arc(i * w + w / 2, AWNING - 8, w / 2, Math.PI, 0, true);
    ctx.lineTo((i + 1) * w, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawCounter() {
  const y = view.worldH - COUNTER;
  const h = COUNTER;
  ctx.fillStyle = INK.cardboard;
  ctx.fillRect(-POST, y, WORLD_W + POST * 2, h);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.5;
  sketchRect(ctx, -POST, y, WORLD_W + POST * 2, h, 601);
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let yy = y + 8; yy < y + h; yy += 8) {
    ctx.moveTo(0, yy);
    ctx.lineTo(WORLD_W, yy);
  }
  ctx.stroke();

  // Planetary struct health.
  ctx.fillStyle = INK.marker;
  ctx.font = `12px ${HAND_FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('PLANET HEALTH', 12, y + 22);
  for (let i = 0; i < HEALTH; i++) {
    const px = 12 + i * 14;
    const on = i < state.health;
    ctx.fillStyle = on ? INK.green : '#fff';
    if (!on && state.health <= 3) ctx.fillStyle = '#f6d3cc';
    ctx.fillRect(px, y + 28, 11, 16);
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1.5;
    sketchRect(ctx, px, y + 28, 11, 16, 700 + i, { wobble: 0.8, passes: 1 });
  }
  if (state.health <= 3 && state.phase === 'playing' && Math.floor(performance.now() / 300) % 2) {
    ctx.fillStyle = INK.red;
    ctx.fillText('CRITICAL', 12, y + 56);
  }

  // Time survived.
  ctx.fillStyle = INK.marker;
  ctx.textAlign = 'right';
  ctx.fillText('HELD FOR', WORLD_W - 12, y + 22);
  ctx.font = `22px ${HAND_FONT}`;
  ctx.fillText(formatTime(state.t), WORLD_W - 12, y + 46);
  ctx.textAlign = 'left';

  // The Planetary Defense Cannon.
  const cn = CANNON();
  const aim = Math.max(-Math.PI + 0.25, Math.min(-0.25, state.aim));
  ctx.save();
  ctx.translate(cn.x, cn.y);
  ctx.rotate(aim);
  ctx.translate(-state.recoil * 5, 0);
  ctx.beginPath();
  ctx.rect(4, -5, 32, 10);
  ctx.fillStyle = '#e3e1da';
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(30, -6.5, 7, 13);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cn.x, cn.y + 4, 20, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = '#d8e6f7';
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = INK.marker;
  ctx.font = `10px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('PDC', cn.x, cn.y + 1);
  ctx.textAlign = 'left';
  ctx.beginPath();
  ctx.rect(cn.x - 30, cn.y + 4, 60, 10);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.stroke();
}

function drawTracers() {
  for (const t of state.tracers) {
    ctx.globalAlpha = 1 - t.t / 0.09;
    ctx.strokeStyle = INK.yellow;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(t.x1, t.y1);
    ctx.lineTo(t.x2, t.y2);
    ctx.stroke();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(t.x2, t.y2, 6, 0, Math.PI * 2);
    ctx.fillStyle = INK.yellow;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
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
    if (t.t < 0) continue;
    ctx.globalAlpha = Math.max(0, 1 - t.t);
    ctx.font = `bold ${t.size}px ${HAND_FONT}`;
    const y = t.y - t.t * 26;
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

function drawFlashes() {
  for (const f of state.flashes) {
    const y0 = f.cmd ? AWNING : rowTop(f.row);
    const h = f.cmd ? view.rowH * 4 : view.rowH;
    const x = f.cmd ? 0 : f.side > 0 ? WORLD_W - 60 : 0;
    const w = f.cmd ? WORLD_W : 60;
    const g = ctx.createLinearGradient(f.side > 0 ? WORLD_W : 0, 0, f.side > 0 ? WORLD_W - 60 : 60, 0);
    const alpha = 0.45 * (1 - f.t / 0.6);
    if (f.cmd) ctx.fillStyle = `rgba(217, 65, 43, ${alpha * 0.5})`;
    else {
      g.addColorStop(0, `rgba(217, 65, 43, ${alpha})`);
      g.addColorStop(1, 'rgba(217, 65, 43, 0)');
      ctx.fillStyle = g;
    }
    ctx.fillRect(x, y0, w, h);
  }
}

function drawAim() {
  for (const t of pointer.touches) {
    ctx.globalAlpha = 1 - t.t / 0.35;
    ctx.strokeStyle = INK.red;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 6 + t.t * 30, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (!pointer.mouse || !pointer.inside) return;
  const { x, y } = pointer;
  ctx.strokeStyle = INK.red;
  ctx.lineWidth = 2;
  sketchCircle(ctx, x, y, 9, 900, { wobble: 0.6, passes: 1 });
  ctx.beginPath();
  ctx.moveTo(x - 14, y);
  ctx.lineTo(x - 5, y);
  ctx.moveTo(x + 5, y);
  ctx.lineTo(x + 14, y);
  ctx.moveTo(x, y - 14);
  ctx.lineTo(x, y - 5);
  ctx.moveTo(x, y + 5);
  ctx.lineTo(x, y + 14);
  ctx.stroke();
}

function drawCountdown(w, h) {
  const n = state.phase === 'countdown' ? Math.ceil(state.countdown - 0.5) : 0;
  const label = n > 0 ? String(n) : 'FIRE!';
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
  ctx.fillStyle = n > 0 ? INK.marker : INK.red;
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

const starsFor = (score) => STAR_SCORES.filter((s) => score >= s).length;

let lastHud = '';
let hudStarCount = -1;
function updateHud() {
  const key = `${state.score}`;
  if (key === lastHud) return;
  lastHud = key;
  hudScore.textContent = state.score;
  const stars = starsFor(state.score);
  if (stars !== hudStarCount) {
    hudStarCount = stars;
    hudStars.innerHTML = '';
    hudStars.append(renderStars(stars, { mini: true }));
    if (stars > 0 && state.phase === 'playing') audio.sfx('star');
  }
}

function bumpScore() {
  hudScore.classList.remove('bump');
  void hudScore.offsetWidth;
  hudScore.classList.add('bump');
}

// ---- Flow ------------------------------------------------------------------

function showStart() {
  const rec = getRecord(GAME_ID);
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h1>Last Line of Defense</h1>
    <p>Raiders are scrolling past in every ambit. Shoot them down before they get by. Each one that escapes damages your planet.</p>
    <ul class="targets"></ul>
    <p class="subtle">Tap or click to fire. Hold to keep firing.<br>It gets faster and busier the longer you hold out.</p>
    <ul class="star-goals"></ul>
    <div class="best"></div>
    <div class="actions"><button class="paper-btn primary" type="button">Start</button></div>`;
  const list = card.querySelector('.targets');
  list.style.cssText = 'list-style:none;padding:0;margin:6px auto;display:inline-block;text-align:left;font-size:0.95rem;color:var(--pencil);line-height:1.35';
  const notes = {
    tank: 'land, slow',
    bomber: 'air, flips up and down',
    battleship: 'space, small and fast',
    cruiser: 'water, rare, 12 hits',
    cmd: 'pops up anywhere, 12 hits',
  };
  for (const [id, T] of Object.entries(TYPES)) {
    const li = document.createElement('li');
    li.innerHTML = `<b style="color:var(--ink)">${T.points}</b> ${T.name} <span>(${notes[id]})</span>`;
    list.appendChild(li);
  }
  const goals = card.querySelector('.star-goals');
  STAR_SCORES.forEach((t, i) => {
    const li = document.createElement('li');
    li.append(renderStars(i + 1, { mini: true }), `Score ${t} points`);
    goals.appendChild(li);
  });
  if (rec.plays > 0) {
    const p = document.createElement('p');
    p.className = 'subtle';
    p.textContent = `High score: ${formatScore(rec.highScore)} · Last: ${formatScore(rec.recentScore)}`;
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
  state.phase = 'done';
  audio.stopSong();
  const score = state.score;
  const stars = starsFor(score);
  const { record, newHigh, newBestStars } = saveResult(GAME_ID, score, stars);
  const acc = state.shots ? Math.round((state.hits / state.shots) * 100) : 0;
  setTimeout(() => audio.sfx(stars === 0 ? 'lose' : 'win'), 150);
  showResults(overlay, {
    title: 'Planet overrun!',
    scoreText: `${score}`,
    stars,
    newHigh: newHigh && score > 0,
    newBestStars,
    record,
    formatScore,
    note: `Held for ${formatTime(state.t)} · ${state.kills} shot down · ${acc}% accuracy.${stars < 3 ? ` Next star at ${STAR_SCORES[stars]}.` : ''}`,
    onRetry: start,
  });
}

addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !overlay.hidden && document.activeElement?.tagName !== 'BUTTON' && document.activeElement?.tagName !== 'A') {
    if (state.phase === 'ready' || state.phase === 'done') start();
  }
});

// ---- Loop --------------------------------------------------------------------

state = newState();
layout();
showStart();

if (new URLSearchParams(location.search).has('debug')) {
  window.gallery = {
    get state() { return state; },
    TYPES,
    start,
    fire,
    targetBottom,
    cmdBottom,
    view: () => view,
    // Fast-forward a run for balance testing. act(state, api) is called every
    // `every` seconds. Returns { t, score, kills, shots, hits }.
    sim(seconds, act, every = 0.15) {
      silent = true;
      state = newState();
      state.phase = 'playing';
      state.goT = 1;
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
      const r = { t: Math.round(state.t), score: state.score, kills: state.kills, shots: state.shots, hits: state.hits, escaped: state.escaped, by: state.escapedBy };
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
