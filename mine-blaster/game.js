import { INK, HAND_FONT, rng, sketchLine, sketchRect, sketchCircle, hatch, graphPaper, fitCanvas } from '../shared/paper.js';
import { audio, noteFreq } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'mine-blaster';
let STAR_POINTS = [1000, 2500, 4000]; // points for 1, 2 and 3 stars
let ROUND_TIME = 90; // seconds on the clock

const PTS_BLAST = 100; // a clean blast, times the streak multiplier
const PTS_HIT = 50; // lost when the beam hits a side
const TIME_BLAST = 5; // seconds a clean blast adds to the clock
const MAX_MULT = 4;

// The shaft. Each blast is a fresh "challenge": new segments, speeds,
// patterns and beam width. `level` is how many clean blasts you've made.
const OPENING = 64; // width of the gap through each segment
let SEG_BASE = 4; // segments in the first shaft...
let SEG_EVERY = 3; // ...plus one every this many clean blasts...
const SEG_MAX = 8; // ...up to this many
let SPEED = [0.22, 0.42]; // sweeps per second at the start (random per segment)
let SPEED_PER_LEVEL = 0.07; // +7% per clean blast
let TIME_RAMP = 150; // and everything speeds up by 1/TIME_RAMP per second played
const AMP = [70, 125]; // how far a segment swings either side of the middle
const BEAM = [14, 26]; // beam width range before it's narrowed for longer shafts
const BEAM_PER_SEG = 2.5; // narrower beam per segment over SEG_BASE
const BEAM_MIN = 8;
// Movement patterns unlock as you go: sine (smooth), bounce (constant speed,
// sharp turns), lurch (speeds up and slows down mid-swing).
const PATTERN_LEVEL = { sine: 0, bounce: 2, lurch: 5 };

const CHARGE_TIME = 0.35; // pause between the last lock and the beam
const BEAM_SPEED = 1500; // units/s the beam travels down
const AFTER_HIT = 1.0; // seconds before a missed shaft restarts
const AFTER_BLAST = 1.1; // seconds before the next shaft

// ---- World layout (world units) -------------------------------------------

const W = 400;
const H = 600;
const TOP_PAD = 60;
const BOTTOM_PAD = 84; // screen px for the buttons
const SHAFT_L = 22;
const SHAFT_R = W - 22;
const SHAFT_TOP = 96;
const SHAFT_BOT = 520;
const BEAM_X = W / 2;
const SEG_GAP = 3; // visible crack between segments

const shell = document.getElementById('shell');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const controls = document.getElementById('controls');
const lockBtn = document.getElementById('lock');
const resetBtn = document.getElementById('reset');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;
const formatTime = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = '<span class="hud-time" aria-label="Time left">1:30</span><span class="hud-score" aria-label="Score">0</span><span class="hud-mult" aria-label="Streak multiplier">×1</span><span class="hud-stars"></span>';
mountTopBar(shell, { extra: hud });
const hudTime = hud.querySelector('.hud-time');
const hudScore = hud.querySelector('.hud-score');
const hudMult = hud.querySelector('.hud-mult');
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
const TAU = Math.PI * 2;

// ---- Shaft segments ------------------------------------------------------------

// Position of a segment's opening, -1..1, for sweep progress u (cycles).
function wave(pattern, u) {
  if (pattern === 'bounce') {
    const f = (((u + 0.25) % 1) + 1) % 1;
    return 1 - 4 * Math.abs(f - 0.5);
  }
  if (pattern === 'lurch') return Math.sin(TAU * (u - 0.07 * Math.sin(2 * TAU * u)));
  return Math.sin(TAU * u);
}

const segCenter = (s, tau = s.tau) => s.mid + s.amp * wave(s.pattern, s.phase + s.speed * tau);
const segClear = (s, beamW) => {
  const c = segCenter(s);
  return BEAM_X - beamW / 2 >= c - OPENING / 2 && BEAM_X + beamW / 2 <= c + OPENING / 2;
};

function segmentCount(level) {
  return Math.min(SEG_MAX, SEG_BASE + Math.floor(level / SEG_EVERY));
}

function newChallenge(level) {
  const n = segmentCount(level);
  const patterns = Object.keys(PATTERN_LEVEL).filter((p) => level >= PATTERN_LEVEL[p]);
  const bandH = (SHAFT_BOT - SHAFT_TOP) / n;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const amp = rand(AMP[0], AMP[1]);
    let phase = Math.random();
    // Don't start a segment already lined up with the beam.
    if (Math.abs(wave('sine', phase)) < 0.35) phase += 0.25;
    segs.push({
      i,
      y: SHAFT_TOP + i * bandH,
      h: bandH,
      amp,
      mid: W / 2 + rand(-1, 1) * Math.min(10, 140 - amp),
      speed: rand(SPEED[0], SPEED[1]) * (1 + SPEED_PER_LEVEL * level) * (Math.random() < 0.5 ? -1 : 1),
      phase,
      pattern: patterns[Math.floor(Math.random() * patterns.length)],
      tau: 0,
      locked: false,
      lockFlash: 0,
      seed: Math.floor(Math.random() * 1e6),
    });
  }
  // Wider beam for short shafts, narrower for long ones.
  const beamW = Math.round(clamp(rand(BEAM[0], BEAM[1]) - (n - SEG_BASE) * BEAM_PER_SEG, BEAM_MIN, OPENING - 16));
  return { level, segs, beamW, attempt: 1 };
}

// Start the current shaft again from the same positions.
function restartChallenge() {
  const c = state.challenge;
  for (const s of c.segs) {
    s.tau = 0;
    s.locked = false;
    s.lockFlash = 0;
  }
  c.attempt++;
  state.cursor = 0;
  state.beam = null;
  state.shot = 'aim';
}

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
    streak: 0, // clean blasts in a row
    level: 0, // clean blasts so far
    stats: { blasts: 0, hits: 0, resets: 0, bestStreak: 0, timeAdded: 0 },
    challenge: newChallenge(0),
    cursor: 0, // the next segment to lock
    shot: 'aim', // aim | charge | fire | hit | blast
    shotT: 0,
    beam: null, // { y, stopY, hitSeg }
    input: { lock: false, reset: false }, // set by the bot in the sim
    particles: [],
    texts: [],
    shake: 0,
    overT: 0,
    tickT: 0,
    shockT: 0,
  };
}

const multFor = (streak) => Math.min(MAX_MULT, streak + 1);

function addScore(n, x, y, color, size) {
  state.score = Math.max(0, state.score + n);
  if (!silent) {
    text(x, y, n >= 0 ? `+${n}` : `${n}`, color || (n >= 0 ? INK.green : INK.red), size || (Math.abs(n) >= 100 ? 18 : 14));
    hudScore.classList.remove('bump');
    void hudScore.offsetWidth;
    hudScore.classList.add('bump');
  }
}

function play(fn) {
  if (!silent) fn();
}

// ---- Actions ---------------------------------------------------------------------

function canAct() {
  return state.phase === 'playing' && state.shot === 'aim';
}

function lock() {
  if (!canAct()) return;
  const c = state.challenge;
  const s = c.segs[state.cursor];
  if (!s) return;
  s.locked = true;
  s.lockFlash = 1;
  state.cursor++;
  const ok = segClear(s, c.beamW);
  play(() => sfx('lock', ok ? 0 : 1));
  if (!silent) burst(segCenter(s) - OPENING / 2, s.y + s.h / 2, 4, '#a9824d');
  if (!silent) burst(segCenter(s) + OPENING / 2, s.y + s.h / 2, 4, '#a9824d');
  if (state.cursor >= c.segs.length) {
    state.shot = 'charge';
    state.shotT = 0;
    play(() => sfx('charge'));
  }
}

function reset() {
  if (!canAct()) return;
  if (state.cursor === 0) return; // nothing locked yet
  state.stats.resets++;
  play(() => sfx('reset'));
  const c = state.challenge;
  c.attempt--; // a self-reset isn't a failed attempt
  restartChallenge();
}

function fire() {
  const c = state.challenge;
  const hitSeg = c.segs.find((s) => !segClear(s, c.beamW));
  state.shot = 'fire';
  state.shotT = 0;
  state.beam = { y: SHAFT_TOP - 20, stopY: hitSeg ? hitSeg.y + 2 : SHAFT_BOT + 30, hitSeg: hitSeg ? hitSeg.i : -1 };
  play(() => sfx('fire'));
}

function resolveBeam() {
  const b = state.beam;
  const c = state.challenge;
  state.shotT = 0;
  if (b.hitSeg >= 0) {
    state.shot = 'hit';
    state.stats.hits++;
    state.streak = 0;
    addScore(-PTS_HIT, BEAM_X, b.stopY - 18);
    state.shake = 0.8;
    const s = c.segs[b.hitSeg];
    s.lockFlash = 1;
    play(() => sfx('hit'));
    if (!silent) {
      burst(BEAM_X, b.stopY, 18, INK.red);
      burst(BEAM_X, b.stopY, 10, INK.yellow);
      text(BEAM_X, b.stopY - 40, 'Streak lost', INK.red, 13);
    }
  } else {
    state.shot = 'blast';
    const mult = multFor(state.streak);
    state.streak++;
    state.level++;
    state.stats.blasts++;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, state.streak);
    addScore(PTS_BLAST * mult, BEAM_X, SHAFT_BOT + 6, INK.green, 22);
    state.timeLeft += TIME_BLAST;
    state.stats.timeAdded += TIME_BLAST;
    if (!silent) text(BEAM_X + 70, SHAFT_BOT + 6, `+${TIME_BLAST}s`, INK.blue, 16);
    if (!silent && mult > 1) text(BEAM_X, SHAFT_BOT - 22, `×${mult}`, INK.blue, 16);
    state.shake = 1;
    state.shockT = 0.01;
    play(() => sfx('blast', mult));
    if (!silent) {
      burst(BEAM_X, SHAFT_BOT + 40, 26, INK.yellow);
      burst(BEAM_X, SHAFT_BOT + 40, 18, '#8a7a66');
      burst(BEAM_X, SHAFT_BOT + 40, 10, '#7cc7e8');
    }
  }
}

// ---- Update ------------------------------------------------------------------

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
        play(() => audio.playSong(song(0)));
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
    if (!silent) updateMusic();
    // Time's up, unless a beam is already on its way: let that one land.
    if (state.timeLeft <= 0 && state.shot !== 'fire' && state.shot !== 'charge') {
      state.timeLeft = 0;
      state.phase = 'over';
      state.overT = 0;
      play(() => audio.stopSong());
      play(() => sfx('whistle'));
      syncButtons();
      return;
    }
    state.timeLeft = Math.max(0, state.timeLeft);
    if (silent) botInput();
    updateShaft(dt);
  } else if (state.phase === 'over') {
    state.overT += dt;
    if (state.overT > 1.2 && !silent) finish();
  }
  syncButtons();
}

const speedScale = () => 1 + state.t / TIME_RAMP;

function updateShaft(dt) {
  const c = state.challenge;
  const k = speedScale();
  for (const s of c.segs) {
    if (!s.locked) s.tau += dt * k;
    s.lockFlash = Math.max(0, s.lockFlash - dt * 2.5);
  }
  if (state.shockT > 0) state.shockT += dt;
  state.shotT += dt;
  if (state.shot === 'charge' && state.shotT >= CHARGE_TIME) fire();
  else if (state.shot === 'fire') {
    const b = state.beam;
    b.y = Math.min(b.stopY, b.y + BEAM_SPEED * dt);
    if (b.y >= b.stopY) resolveBeam();
  } else if (state.shot === 'hit' && state.shotT >= AFTER_HIT) {
    restartChallenge();
  } else if (state.shot === 'blast' && state.shotT >= AFTER_BLAST) {
    state.challenge = newChallenge(state.level);
    state.cursor = 0;
    state.beam = null;
    state.shot = 'aim';
    state.shockT = 0;
    play(() => sfx('next'));
  }
}

// ---- Effects -----------------------------------------------------------------------

function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(40, 200);
    state.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: rand(0.4, 0.9), max: 0.9, color, r: rand(1.5, 3.5) });
  }
}

function text(x, y, str, color, size = 12) {
  state.texts.push({ x, y, text: str, color, size, life: 1.1 });
}

function updateEffects(dt) {
  for (const p of state.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 300 * dt;
    p.life -= dt;
  }
  state.particles = state.particles.filter((p) => p.life > 0);
  for (const t of state.texts) {
    t.y -= 26 * dt;
    t.life -= dt;
  }
  state.texts = state.texts.filter((t) => t.life > 0);
}

// ---- Input -----------------------------------------------------------------------

function onLock(e) {
  if (e) e.preventDefault();
  audio.unlock();
  lock();
}

canvas.addEventListener('pointerdown', (e) => {
  if (!overlay.hidden) return;
  onLock(e);
});
lockBtn.addEventListener('pointerdown', onLock);
lockBtn.addEventListener('click', (e) => {
  // Keyboard activation of the focused button (pointer taps already locked).
  if (e.detail === 0) onLock(e);
});
resetBtn.addEventListener('click', () => {
  audio.unlock();
  reset();
});

addEventListener('keydown', (e) => {
  if (!overlay.hidden) {
    if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON' && document.activeElement?.tagName !== 'A') {
      if (state.phase === 'ready' || state.phase === 'done') start();
    }
    return;
  }
  if (e.repeat) return;
  if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
    e.preventDefault();
    audio.unlock();
    lock();
  } else if (e.key === 'r' || e.key === 'R' || e.key === 'Backspace') {
    e.preventDefault();
    audio.unlock();
    reset();
  }
});

let lastButtons = '';
function syncButtons() {
  if (silent) return;
  const playing = state.phase === 'playing' || state.phase === 'countdown';
  const key = `${playing}|${canAct()}|${state.cursor > 0}`;
  if (key === lastButtons) return;
  lastButtons = key;
  controls.hidden = !playing;
  lockBtn.disabled = !canAct();
  resetBtn.disabled = !canAct() || state.cursor === 0;
}

// ---- Sound ---------------------------------------------------------------------

function sfx(name, arg = 0) {
  const n = noteFreq;
  switch (name) {
    case 'lock':
      audio.noise({ dur: 0.07, vol: 0.18, rate: 0.35 });
      audio.tone({ wave: 'pulse25', freq: n(arg ? 'C4' : 'G4'), dur: 0.06, vol: 0.14 });
      break;
    case 'charge':
      audio.tone({ wave: 'pulse12', freq: n('C5'), freqEnd: n('C7'), dur: CHARGE_TIME, vol: 0.12 });
      break;
    case 'fire':
      audio.tone({ wave: 'pulse50', freq: n('C7'), freqEnd: n('C5'), dur: 0.3, vol: 0.14 });
      audio.noise({ dur: 0.3, vol: 0.1, rate: 2 });
      break;
    case 'hit':
      audio.noise({ dur: 0.5, vol: 0.3, rate: 0.6, rateEnd: 0.1 });
      audio.tone({ wave: 'pulse50', freq: n('E3'), dur: 0.15, vol: 0.18 });
      audio.tone({ wave: 'pulse50', freq: n('D#3'), dur: 0.3, vol: 0.18, at: 0.15 });
      break;
    case 'blast': {
      audio.noise({ dur: 0.9, vol: 0.45, rate: 0.5, rateEnd: 0.06 });
      audio.tone({ wave: 'triangle', freq: 110, freqEnd: 35, dur: 0.6, vol: 0.35 });
      const notes = ['C5', 'E5', 'G5', 'C6', 'E6', 'G6'];
      for (let i = 0; i < 2 + arg; i++) audio.tone({ wave: 'pulse50', freq: n(notes[i]), dur: 0.07, vol: 0.13, at: 0.15 + i * 0.06 });
      break;
    }
    case 'reset':
      audio.tone({ wave: 'pulse25', freq: n('G5'), freqEnd: n('C5'), dur: 0.12, vol: 0.12 });
      audio.noise({ dur: 0.15, vol: 0.08, rate: 0.8 });
      break;
    case 'next':
      audio.tone({ wave: 'pulse12', freq: n('E5'), dur: 0.05, vol: 0.1 });
      audio.tone({ wave: 'pulse12', freq: n('A5'), dur: 0.06, vol: 0.1, at: 0.06 });
      break;
    case 'whistle':
      audio.tone({ wave: 'pulse25', freq: n('C6'), dur: 0.5, vol: 0.18, vibrato: 0.03 });
      break;
    default:
      break;
  }
}

// A driving mine-cart loop that gets faster as the clock runs.
const MUSIC_BPM = [112, 150]; // at the start, and once the clock is nearly out
function song(frac) {
  return {
    bpm: Math.round(MUSIC_BPM[0] + (MUSIC_BPM[1] - MUSIC_BPM[0]) * frac),
    stepsPerBeat: 4,
    wave1: 'pulse25',
    wave2: 'pulse12',
    vol1: 0.065,
    vol2: 0.04,
    tracks: {
      p1: 'E5 . G5 . A5 . . G5 E5 . D5 . E5 - - . E5 . G5 . B5 . A5 G5 A5 . . . . . . . ' +
        'C6 . B5 . A5 . G5 . E5 . G5 . A5 - - . B5 . A5 . G5 . D5 . E5 - - - . . . .',
      p2: 'E4 B4 E4 B4 E4 B4 E4 B4 D4 A4 D4 A4 D4 A4 D4 A4 C4 G4 C4 G4 C4 G4 C4 G4 B3 F#4 B3 F#4 B3 F#4 B3 F#4',
      tri: 'E2 . E2 E3 . E2 . E2 D2 . D2 D3 . D2 . D2 C2 . C2 C3 . C2 . C2 B1 . B1 B2 . B1 B2 .',
      noise: frac > 0.5 ? 'k h s h k k s h k h s h k k s s' : 'k . h . s . h . k k h . s . h .',
    },
  };
}

let musicStage = -1;
function updateMusic() {
  const frac = clamp(state.t / (ROUND_TIME * 1.5), 0, 1);
  const stage = Math.floor(frac * 8);
  if (stage !== musicStage) {
    musicStage = stage;
    audio.updateSong(song(stage / 8));
  }
}

// ---- Render ----------------------------------------------------------------------

function render() {
  layout();
  const { scale, ox, oy, cw, ch, dpr } = view;
  let sx = 0;
  let sy = 0;
  if (state.shake > 0) {
    sx = (Math.random() - 0.5) * state.shake * 7;
    sy = (Math.random() - 0.5) * state.shake * 7;
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
  graphPaper(ctx, -ox / scale - 10, -oy / scale - 10, cw / scale + 20, ch / scale + 20, 10, 4);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawSurface();
  drawOre();
  drawGuide(false);
  for (const s of state.challenge.segs) drawSegment(s);
  drawGuide(true);
  drawBeam();
  drawRig();
  drawParticles();
  drawTexts();
  drawHint();
  if (state.phase === 'countdown' || (state.phase === 'playing' && state.goT < 0.6)) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCountdown(cw, ch);
  }
  updateHud();
}

function drawSurface() {
  // Ground line and the shaft's outer walls.
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4;
  sketchLine(ctx, 0, SHAFT_TOP - 6, SHAFT_L, SHAFT_TOP - 6, 11);
  sketchLine(ctx, SHAFT_R, SHAFT_TOP - 6, W, SHAFT_TOP - 6, 12);
  ctx.fillStyle = '#e9dcc4';
  ctx.fillRect(0, SHAFT_TOP - 6, SHAFT_L - 2, H - SHAFT_TOP + 6);
  ctx.fillRect(SHAFT_R + 2, SHAFT_TOP - 6, W - SHAFT_R - 2, H - SHAFT_TOP + 6);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, SHAFT_TOP - 6, SHAFT_L - 2, H);
  ctx.rect(SHAFT_R + 2, SHAFT_TOP - 6, W - SHAFT_R, H);
  ctx.clip();
  ctx.strokeStyle = 'rgba(85, 83, 78, 0.35)';
  ctx.lineWidth = 1;
  hatch(ctx, 0, SHAFT_TOP - 6, W, H, { gap: 9, seed: 3 });
  ctx.restore();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4;
  sketchLine(ctx, SHAFT_L - 2, SHAFT_TOP - 6, SHAFT_L - 2, H - 4, 13);
  sketchLine(ctx, SHAFT_R + 2, SHAFT_TOP - 6, SHAFT_R + 2, H - 4, 14);
}

function drawOre() {
  // The ore pocket at the bottom: the beam's target.
  const y = SHAFT_BOT + 4;
  ctx.fillStyle = '#ddd2bd';
  ctx.fillRect(SHAFT_L, y, SHAFT_R - SHAFT_L, H - y - 4);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2;
  sketchLine(ctx, SHAFT_L, H - 4, SHAFT_R, H - 4, 21);
  const r = rng(77 + state.level * 7);
  const blown = state.shot === 'blast' ? Math.min(1, state.shotT / 0.25) : 0;
  for (let i = 0; i < 9; i++) {
    const x = SHAFT_L + 24 + i * ((SHAFT_R - SHAFT_L - 48) / 8) + (r() - 0.5) * 10;
    const cy = y + 30 + (r() - 0.5) * 30;
    const near = Math.abs(x - BEAM_X) < 90;
    if (near && blown > 0) continue;
    drawCrystal(x, cy, 9 + r() * 7, i % 3 === 0 ? '#7cc7e8' : i % 3 === 1 ? '#b9a6e6' : '#9ee0a4', 40 + i);
  }
  // Target mark under the beam.
  ctx.strokeStyle = INK.red;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  sketchCircle(ctx, BEAM_X, y + 32, 18, 9, { passes: 1 });
  ctx.setLineDash([]);
  sketchLine(ctx, BEAM_X - 8, y + 32, BEAM_X + 8, y + 32, 91, { passes: 1 });
  sketchLine(ctx, BEAM_X, y + 24, BEAM_X, y + 40, 92, { passes: 1 });
  // Shockwave ring after a blast.
  if (state.shockT > 0 && state.shockT < 0.7) {
    const k = state.shockT / 0.7;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = INK.yellow;
    ctx.lineWidth = 5;
    sketchCircle(ctx, BEAM_X, y + 32, 10 + k * 130, 5, { passes: 1 });
    ctx.globalAlpha = 1;
  }
}

function drawCrystal(x, y, s, color, seed) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.6, y);
  ctx.lineTo(x, y + s * 0.7);
  ctx.lineTo(x - s * 0.6, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.6;
  sketchLine(ctx, x, y - s, x + s * 0.6, y, seed, { passes: 1 });
  sketchLine(ctx, x + s * 0.6, y, x, y + s * 0.7, seed + 1, { passes: 1 });
  sketchLine(ctx, x, y + s * 0.7, x - s * 0.6, y, seed + 2, { passes: 1 });
  sketchLine(ctx, x - s * 0.6, y, x, y - s, seed + 3, { passes: 1 });
}

function drawGuide(lines) {
  // Where the beam will go, at its real width: a tint under the rock and
  // dashed edges over it, so you can line openings up against it.
  const bw = state.challenge.beamW;
  if (!lines) {
    ctx.fillStyle = 'rgba(217, 65, 43, 0.08)';
    ctx.fillRect(BEAM_X - bw / 2, SHAFT_TOP, bw, SHAFT_BOT - SHAFT_TOP);
    return;
  }
  if (state.shot !== 'aim') return;
  ctx.strokeStyle = 'rgba(217, 65, 43, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 6]);
  for (const x of [BEAM_X - bw / 2, BEAM_X + bw / 2]) {
    ctx.beginPath();
    ctx.moveTo(x, SHAFT_TOP);
    ctx.lineTo(x, SHAFT_BOT);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

const ROCK = '#c9b08a';
const ROCK_LOCKED = '#b39770';

function drawSegment(s) {
  const c = state.challenge;
  const cx = segCenter(s);
  const y = s.y + SEG_GAP / 2;
  const h = s.h - SEG_GAP;
  const l = cx - OPENING / 2;
  const r = cx + OPENING / 2;
  const current = state.shot === 'aim' && state.phase === 'playing' && s.i === state.cursor;
  const bad = s.locked && !segClear(s, c.beamW);
  const hit = state.beam && state.beam.hitSeg === s.i && (state.shot === 'hit' || state.shot === 'fire');

  // Gravitational shimmer inside moving segments.
  if (!s.locked) {
    ctx.strokeStyle = 'rgba(140, 90, 200, 0.28)';
    ctx.lineWidth = 1.2;
    const t = state.t * 3 + s.seed;
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      for (let x = SHAFT_L; x <= SHAFT_R; x += 8) {
        const yy = y + h * (0.35 + k * 0.3) + Math.sin(x * 0.06 + t + k * 2) * 3;
        if (x === SHAFT_L) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }

  for (const [x0, x1, side] of [[SHAFT_L, l, 0], [r, SHAFT_R, 1]]) {
    if (x1 - x0 < 1) continue;
    ctx.fillStyle = s.locked ? ROCK_LOCKED : ROCK;
    ctx.fillRect(x0, y, x1 - x0, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y, x1 - x0, h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(36, 34, 31, 0.22)';
    ctx.lineWidth = 1;
    hatch(ctx, x0, y, x1 - x0, h, { gap: 8, seed: s.seed + side, angle: side ? -Math.PI / 4 : Math.PI / 4 });
    ctx.restore();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2;
    sketchRect(ctx, x0, y, x1 - x0, h, s.seed + side * 5, { wobble: 1, passes: 1 });
  }

  // The opening's edges: red where it would clip the beam.
  const beamL = BEAM_X - c.beamW / 2;
  const beamR = BEAM_X + c.beamW / 2;
  if (s.locked) {
    const badL = l > beamL;
    const badR = r < beamR;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = badL ? INK.red : INK.green;
    sketchLine(ctx, l, y + 1, l, y + h - 1, s.seed + 9, { passes: 1 });
    ctx.strokeStyle = badR ? INK.red : INK.green;
    sketchLine(ctx, r, y + 1, r, y + h - 1, s.seed + 10, { passes: 1 });
    // Clamp bolts.
    for (const bx of [SHAFT_L + 7, SHAFT_R - 7]) {
      ctx.fillStyle = '#efece4';
      ctx.beginPath();
      ctx.arc(bx, y + h / 2, 4, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = INK.marker;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  if (s.lockFlash > 0) {
    ctx.globalAlpha = s.lockFlash * 0.6;
    ctx.fillStyle = bad || hit ? INK.red : '#fff';
    ctx.fillRect(SHAFT_L, y, SHAFT_R - SHAFT_L, h);
    ctx.globalAlpha = 1;
  }
  if (current) {
    // Pointer at the segment to lock next.
    const pulse = 0.5 + 0.5 * Math.sin(state.t * 8);
    ctx.strokeStyle = INK.yellow;
    ctx.lineWidth = 3 + pulse * 2;
    ctx.globalAlpha = 0.8;
    ctx.strokeRect(SHAFT_L + 1, y + 1, SHAFT_R - SHAFT_L - 2, h - 2);
    ctx.globalAlpha = 1;
    drawArrow(SHAFT_L - 13, y + h / 2, 1);
    drawArrow(SHAFT_R + 13, y + h / 2, -1);
  }
}

function drawArrow(x, y, dir) {
  ctx.fillStyle = INK.yellow;
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x + dir * 7, y);
  ctx.lineTo(x - dir * 6, y - 8);
  ctx.lineTo(x - dir * 6, y + 8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawBeam() {
  const c = state.challenge;
  const bw = c.beamW;
  if (state.shot === 'charge') {
    const k = state.shotT / CHARGE_TIME;
    ctx.fillStyle = `rgba(217, 65, 43, ${0.15 + k * 0.5})`;
    ctx.beginPath();
    ctx.arc(BEAM_X, SHAFT_TOP - 16, 4 + k * bw * 0.5, 0, TAU);
    ctx.fill();
    return;
  }
  const b = state.beam;
  if (!b) return;
  const fade = state.shot === 'fire' ? 1 : Math.max(0, 1 - state.shotT / 0.5);
  if (fade <= 0) return;
  const top = SHAFT_TOP - 16;
  const flick = 0.85 + Math.random() * 0.15;
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgba(217, 65, 43, 0.25)';
  ctx.fillRect(BEAM_X - bw / 2 - 5, top, bw + 10, b.y - top);
  ctx.fillStyle = INK.red;
  ctx.fillRect(BEAM_X - (bw / 2) * flick, top, bw * flick, b.y - top);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(BEAM_X - bw * 0.18, top, bw * 0.36, b.y - top);
  ctx.globalAlpha = 1;
}

function drawRig() {
  // The laser drill sitting over the mouth of the shaft.
  const y = SHAFT_TOP - 16;
  const bw = state.challenge.beamW;
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.2;
  // Legs.
  sketchLine(ctx, BEAM_X - 70, SHAFT_TOP - 6, BEAM_X - 30, 18, 61);
  sketchLine(ctx, BEAM_X + 70, SHAFT_TOP - 6, BEAM_X + 30, 18, 62);
  sketchLine(ctx, BEAM_X - 50, 56, BEAM_X + 50, 56, 63, { passes: 1 });
  // Body.
  ctx.fillStyle = '#efece4';
  ctx.fillRect(BEAM_X - 34, 10, 68, 44);
  ctx.save();
  ctx.beginPath();
  ctx.rect(BEAM_X - 34, 10, 68, 44);
  ctx.clip();
  ctx.fillStyle = 'rgba(244, 196, 48, 0.7)';
  for (let x = -40; x < 40; x += 14) {
    ctx.beginPath();
    ctx.moveTo(BEAM_X + x, 54);
    ctx.lineTo(BEAM_X + x + 7, 54);
    ctx.lineTo(BEAM_X + x + 15, 46);
    ctx.lineTo(BEAM_X + x + 8, 46);
    ctx.fill();
  }
  ctx.restore();
  sketchRect(ctx, BEAM_X - 34, 10, 68, 44, 64);
  // Nozzle, as wide as the beam.
  ctx.fillStyle = '#8a8680';
  ctx.fillRect(BEAM_X - bw / 2 - 4, 54, bw + 8, y - 54);
  sketchRect(ctx, BEAM_X - bw / 2 - 4, 54, bw + 8, y - 54, 65, { passes: 1 });
  // Status lamp.
  const lamp = state.shot === 'charge' || state.shot === 'fire' ? INK.red : state.shot === 'blast' ? INK.green : state.shot === 'hit' ? INK.red : INK.yellow;
  ctx.fillStyle = lamp;
  ctx.beginPath();
  ctx.arc(BEAM_X, 27, 7, 0, TAU);
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // Labels.
  ctx.font = `13px ${HAND_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK.pencil;
  const n = state.challenge.segs.length;
  ctx.fillText(`Shaft ${state.level + (state.shot === 'blast' ? 0 : 1)}`, 6, 22);
  ctx.fillText(`${Math.min(state.cursor, n)}/${n} locked`, 6, 42);
  ctx.textAlign = 'right';
  ctx.fillText(`Beam ${bw}`, W - 6, 22);
  const mult = multFor(state.streak);
  ctx.fillStyle = mult > 1 ? INK.blue : INK.pencil;
  ctx.fillText(`Next ×${mult}`, W - 6, 42);
  ctx.textAlign = 'left';
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawTexts() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of state.texts) {
    ctx.globalAlpha = Math.min(1, t.life * 2);
    ctx.font = `bold ${t.size}px ${HAND_FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(t.text, t.x, t.y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawHint() {
  if (state.phase !== 'playing' || state.level > 0 || state.challenge.attempt > 1 || state.cursor > 0 || state.t > 8) return;
  ctx.font = `bold 16px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#fff';
  const y = SHAFT_BOT + 66;
  ctx.strokeText('Tap to lock each segment over the beam', BEAM_X, y);
  ctx.fillStyle = INK.blue;
  ctx.fillText('Tap to lock each segment over the beam', BEAM_X, y);
  ctx.textAlign = 'left';
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
  const mult = multFor(state.streak);
  const key = `${secs}|${state.score}|${mult}`;
  if (key === lastHud) return;
  lastHud = key;
  hudTime.textContent = formatTime(secs);
  hudTime.classList.toggle('low', secs <= 10);
  hudScore.textContent = state.score;
  hudMult.textContent = `×${mult}`;
  hudMult.classList.toggle('on', mult > 1);
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
    <h1>Mine Blaster</h1>
    <p>Lock the drifting shaft segments one at a time, top to bottom, so the laser can reach the ore without touching the sides.</p>
    <p class="subtle"><b>Tap</b> or Space to lock. Clean blasts add 5s and, in a row, raise your multiplier up to ×4. Hitting a side costs points and your streak. <b>Reset</b> (or R) is free, but the clock keeps running.</p>
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
  overlay.hidden = true;
  lastHud = '';
  hudStarCount = -1;
  musicStage = -1;
  lastButtons = '';
}

function finish() {
  if (state.phase === 'done') return;
  const s = state;
  s.phase = 'done';
  audio.stopSong();
  syncButtons();
  const score = s.score;
  const stars = starsFor(score);
  const { record, newHigh, newBestStars } = saveResult(GAME_ID, score, stars);
  setTimeout(() => audio.sfx(stars === 0 ? 'lose' : 'win'), 150);
  const st = s.stats;
  let note = `Lasted ${formatTime(s.t)} · ${st.blasts} blast${st.blasts === 1 ? '' : 's'} (+${st.timeAdded}s) · best streak ${st.bestStreak} · ${st.hits} side hit${st.hits === 1 ? '' : 's'} · ${st.resets} reset${st.resets === 1 ? '' : 's'}.`;
  if (stars < 3) note += ` Next star at ${STAR_POINTS[stars]}.`;
  showResults(overlay, {
    title: 'Shift over!',
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

// ---- Debug / balance sim -----------------------------------------------------------

function botInput() {
  const i = state.input;
  if (i.reset) {
    reset();
    i.reset = false;
  }
  if (i.lock) {
    lock();
    i.lock = false;
  }
}

// A human-ish bot: watches the current segment, waits until it will next be
// centred at least `react` seconds from now, then taps with a timing error
// of `sigma` seconds. With `resetBad` it resets after a lock that would clip.
function makeBot({ sigma = 0.05, react = 0.3, resetBad = false } = {}) {
  let plan = null;
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  return (st) => {
    if (st.shot !== 'aim') {
      plan = null;
      return;
    }
    const c = st.challenge;
    if (resetBad && c.segs.some((s) => s.locked && !segClear(s, c.beamW))) {
      st.input.reset = true;
      plan = null;
      return;
    }
    const s = c.segs[st.cursor];
    if (!s) return;
    if (!plan || plan.seg !== s || plan.attempt !== c.attempt) {
      // Find when the opening will next be centred on the beam.
      const k = 1 + st.t / TIME_RAMP;
      let best = null;
      for (let dt = react; dt < react + 6; dt += 1 / 240) {
        const off = Math.abs(segCenter(s, s.tau + dt * k) - BEAM_X);
        if (off < 1.5) {
          best = dt;
          break;
        }
      }
      if (best == null) best = react;
      plan = { seg: s, attempt: c.attempt, at: st.t + best + gauss() * sigma };
    }
    if (st.t >= plan.at) {
      st.input.lock = true;
      plan = null;
    }
  };
}

state = newState();
layout();
showStart();

if (new URLSearchParams(location.search).has('debug')) {
  window.mine = {
    get state() { return state; },
    start,
    lock,
    reset,
    makeBot,
    segCenter,
    segClear,
    set stars(v) { STAR_POINTS = v; },
    set roundTime(v) { ROUND_TIME = v; },
    set speed(v) { SPEED = v; },
    set speedPerLevel(v) { SPEED_PER_LEVEL = v; },
    set timeRamp(v) { TIME_RAMP = v; },
    set segBase(v) { SEG_BASE = v; },
    set segEvery(v) { SEG_EVERY = v; },
    // Fast-forward a run. act(state) is called every frame.
    sim(seconds, act) {
      silent = true;
      state = newState();
      state.phase = 'playing';
      const dt = 1 / 60;
      for (let i = 0; i < seconds / dt && state.phase === 'playing'; i++) {
        act(state);
        update(dt);
      }
      silent = false;
      const r = { score: state.score, level: state.level, lasted: Math.round(state.t), ...state.stats };
      state = newState();
      lastButtons = '';
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
