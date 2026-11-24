import { buildMap, WALL_HALF, distToSegment } from './map.js';
import { INK, HAND_FONT, rng, hash, sketchLine, sketchRect, sketchCircle, hatch, graphPaper, fitCanvas } from '../shared/paper.js';
import { Keys, Joystick } from '../shared/input.js';
import { audio } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'bunker-clean-up';
const TIME_LIMIT = 90; // seconds (1:30)
// % cleaned for 1, 2, 3 stars. Estimates; tune from real play. (By rough
// math a strong run reaches ~80% of this map in about a minute.)
const STAR_THRESHOLDS = [60, 75, 90];

const formatTime = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
// How much of the map is visible, in square world units. Using area (not
// width) keeps phones and desktops seeing the same amount of bunker.
const VIEW_AREA = 200000;

const BOT = {
  length: 38,
  width: 28,
  maxSpeed: 172,
  maxReverse: 90,
  accel: 240,
  brake: 600,
  coastDrag: 1.1, // momentum: how quickly speed bleeds off with no throttle
  grip: 7, // how quickly sideways sliding is cancelled
  turnRadius: 47, // tightest arc the bot can drive at speed
  pivotRate: 3.6, // radians/second when turning on the spot
  pivotFade: 50, // above this speed there's no on-the-spot turning, only arcs
  bounce: 0.25,
};

const CELL = 8; // dirt grid resolution in world units

// The brushes spread out with speed: at a standstill only the floor under the
// bot gets cleaned; at top speed everything within CLEAN_RADIUS_MAX of the
// bot's center is cleaned too.
const CLEAN_RADIUS_MAX = 32;

// The ore can take two knocks; the third one blows it up.
const ORE_HITS_ALLOWED = 2;
const HIT_GRACE = 1.0; // seconds after a knock before another one counts

// ---- Setup ---------------------------------------------------------------

const shell = document.getElementById('shell');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <span class="hud-time" aria-label="Time left">${formatTime(TIME_LIMIT)}</span>
  <div class="meter" aria-hidden="true">
    <div class="fill"></div>
    ${STAR_THRESHOLDS.map((t, i) => `<i style="left:${t}%" data-i="${i}">★</i>`).join('')}
  </div>
  <span class="hud-pct" aria-label="Floor cleaned">0%</span>
  <span class="hud-hits" aria-label="Ore knocks left">${'<i></i>'.repeat(ORE_HITS_ALLOWED)}</span>`;
mountTopBar(shell, { extra: hud });
const hudTime = hud.querySelector('.hud-time');
const hudPct = hud.querySelector('.hud-pct');
const hudFill = hud.querySelector('.fill');
const hudMarks = hud.querySelectorAll('.meter i');
const hudHits = hud.querySelectorAll('.hud-hits i');
const hudHitsWrap = hud.querySelector('.hud-hits');

const keys = new Keys();
const stick = new Joystick(canvas, { radius: 56 });

const map = buildMap();
const worldW = map.width;
const worldH = map.height;

// Dirt grid: 1 = dirty, 0 = clean or not floor.
const dirtCols = Math.ceil(worldW / CELL);
const dirtRows = Math.ceil(worldH / CELL);
const dirt = new Uint8Array(dirtCols * dirtRows);
let dirtTotal = 0;

const dirtPattern = makeDirtPattern();

let state;

function resetDirt() {
  dirt.fill(0);
  dirtTotal = 0;
  for (let cy = 0; cy < dirtRows; cy++) {
    for (let cx = 0; cx < dirtCols; cx++) {
      const px = (cx + 0.5) * CELL;
      const py = (cy + 0.5) * CELL;
      if (!map.roomAt(px, py)) continue;
      // Floor under a cylinder or a wall can't be cleaned, so it doesn't count.
      if (map.ore.some((o) => Math.hypot(px - o.x, py - o.y) < o.r)) continue;
      if (map.walls.some((s) => distToSegment(px, py, s) < WALL_HALF + 1)) continue;
      dirt[cy * dirtCols + cx] = 1;
      dirtTotal++;
    }
  }
}

function newState() {
  resetDirt();
  return {
    phase: 'ready', // ready | countdown | playing | exploding | done
    time: TIME_LIMIT,
    countdown: 3.5,
    cleaned: 0,
    bot: { x: map.start.x, y: map.start.y, angle: map.start.angle, vx: 0, vy: 0 },
    cam: { x: map.start.x, y: map.start.y },
    shake: 0,
    particles: [],
    blast: null,
    lastTick: Math.ceil(TIME_LIMIT),
    brushTimer: 0,
    bumpCooldown: 0,
    oreHits: 0,
    grace: 0,
    wantsPivot: false,
    uturnDir: 0,
    pivotStuck: 0, // how long a requested on-the-spot turn has been blocked
    backup: 0, // seconds of automatic reversing left
    oreDamage: new Map(), // cylinder -> number of knocks it took
  };
}

// ---- Dirt texture -----------------------------------------------------

function makeDirtPattern() {
  const S = 4; // pattern pixels per world unit, keeps it crisp when zoomed
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size * S;
  const g = c.getContext('2d');
  g.scale(S, S);
  g.fillStyle = 'rgba(126, 104, 72, 0.32)';
  g.fillRect(0, 0, size, size);
  const r = rng(7);
  // graphite scribbles and grit
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgba(70, 58, 44, ${0.25 + r() * 0.3})`;
    g.lineWidth = 0.6 + r() * 1.2;
    const x = r() * size;
    const y = r() * size;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 3; k++) g.lineTo(x + (r() - 0.5) * 16, y + (r() - 0.5) * 16);
    // draw wrapped copies so the tile is seamless
    g.stroke();
    g.save();
    g.translate(x > size / 2 ? -size : size, 0);
    g.stroke();
    g.restore();
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(60, 50, 38, ${0.3 + r() * 0.4})`;
    g.beginPath();
    g.arc(r() * size, r() * size, 0.4 + r() * 1.1, 0, Math.PI * 2);
    g.fill();
  }
  const pattern = ctx.createPattern(c, 'repeat');
  pattern.setTransform(new DOMMatrix().scale(1 / S));
  return pattern;
}

// ---- Geometry --------------------------------------------------------

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Does the segment (in the bot's local frame) touch the box |x|<=hx, |y|<=hy?
// Liang-Barsky clipping.
function segmentHitsBox(ax, ay, bx, by, hx, hy) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax + hx) && clip(dx, hx - ax) && clip(-dy, ay + hy) && clip(dy, hy - ay);
}

// Walls are thick lines; the bot is a rotated rectangle. Returns the first
// wall the bot would overlap at this pose, or null.
function wallHit(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hx = BOT.length / 2 + WALL_HALF;
  const hy = BOT.width / 2 + WALL_HALF;
  const reach = hx + hy;
  for (const w of map.walls) {
    if (Math.min(w.x1, w.x2) > x + reach || Math.max(w.x1, w.x2) < x - reach) continue;
    if (Math.min(w.y1, w.y2) > y + reach || Math.max(w.y1, w.y2) < y - reach) continue;
    const ax = (w.x1 - x) * c + (w.y1 - y) * s;
    const ay = -(w.x1 - x) * s + (w.y1 - y) * c;
    const bx = (w.x2 - x) * c + (w.y2 - y) * s;
    const by = -(w.x2 - x) * s + (w.y2 - y) * c;
    if (segmentHitsBox(ax, ay, bx, by, hx, hy)) return w;
  }
  return null;
}

// Unit vector from the wall toward the point (the side the bot is on).
function wallNormal(w, px, py) {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / len2));
  let nx = px - (w.x1 + t * dx);
  let ny = py - (w.y1 + t * dy);
  const len = Math.hypot(nx, ny);
  if (len > 0.001) return { x: nx / len, y: ny / len };
  const l = Math.sqrt(len2);
  return { x: -dy / l, y: dx / l };
}

// Exact rectangle-vs-circle test in the bot's local frame.
function hitOre(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (const o of map.ore) {
    const dx = o.x - x;
    const dy = o.y - y;
    if (Math.abs(dx) > 80 || Math.abs(dy) > 80) continue;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const qx = Math.max(-BOT.length / 2, Math.min(BOT.length / 2, lx));
    const qy = Math.max(-BOT.width / 2, Math.min(BOT.width / 2, ly));
    if (Math.hypot(lx - qx, ly - qy) < o.r) return o;
  }
  return null;
}

function cleanRadius(b) {
  return CLEAN_RADIUS_MAX * Math.min(1, Math.hypot(b.vx, b.vy) / BOT.maxSpeed);
}

function cleanUnderBot(b) {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const radius = cleanRadius(b);
  const r2 = radius * radius;
  const reach = Math.max(Math.hypot(BOT.length, BOT.width) / 2, radius);
  const x0 = Math.max(0, Math.floor((b.x - reach) / CELL));
  const x1 = Math.min(dirtCols - 1, Math.floor((b.x + reach) / CELL));
  const y0 = Math.max(0, Math.floor((b.y - reach) / CELL));
  const y1 = Math.min(dirtRows - 1, Math.floor((b.y + reach) / CELL));
  let n = 0;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const i = cy * dirtCols + cx;
      if (!dirt[i]) continue;
      const dx = (cx + 0.5) * CELL - b.x;
      const dy = (cy + 0.5) * CELL - b.y;
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      if ((Math.abs(lx) <= BOT.length / 2 && Math.abs(ly) <= BOT.width / 2) || dx * dx + dy * dy <= r2) {
        dirt[i] = 0;
        n++;
      }
    }
  }
  return n;
}

function percentCleaned() {
  return dirtTotal ? (state.cleaned / dirtTotal) * 100 : 0;
}

function starsFor(pct) {
  return STAR_THRESHOLDS.filter((t) => pct >= t).length;
}

// ---- Controls ---------------------------------------------------------

// Returns { throttle: -1..1, steer: -1..1, brake: bool }.
function readControls(b) {
  let throttle = 0;
  let steer = 0;
  let brake = false;
  if (keys.any('ArrowUp', 'w', 'W')) throttle += 1;
  if (keys.any('ArrowDown', 's', 'S')) throttle -= 1;
  if (keys.any('ArrowRight', 'd', 'D')) steer += 1;
  if (keys.any('ArrowLeft', 'a', 'A')) steer -= 1;

  if (stick.active && stick.magnitude > 0.18) {
    // Point the stick where you want to go.
    //  - Moving: the bot keeps driving and arcs toward it, even pointing
    //    straight back (it swings round like holding W + A/D on a keyboard).
    //    How far you drag sets the speed.
    //  - Stopped: it turns on the spot to face the stick, then drives.
    //  - Wedged so it can't turn: it backs out on its own first.
    const target = Math.atan2(stick.y, stick.x);
    const diff = wrapAngle(target - b.angle);
    const power = Math.min(1, (stick.magnitude - 0.18) / 0.6);
    const vF = b.vx * Math.cos(b.angle) + b.vy * Math.sin(b.angle);
    const moving = vF > BOT.pivotFade * 0.6;
    const steerTo = Math.max(-1, Math.min(1, diff * 2.4));
    if (state.backup > 0) {
      throttle = -Math.max(power, 0.6);
      steer = 0;
    } else if (moving || Math.abs(diff) < 0.35) {
      throttle = power;
      // Pointing almost straight back: commit to one turning direction so the
      // bot doesn't wobble as the stick angle flips between +180 and -180.
      if (Math.abs(diff) > 2.8) state.uturnDir ||= Math.sign(diff) || 1;
      else state.uturnDir = 0;
      steer = state.uturnDir || steerTo;
    } else {
      // Turn on the spot, braking first if still rolling either way.
      throttle = 0;
      steer = steerTo;
      brake = Math.abs(vF) > 5;
    }
    state.wantsPivot = throttle === 0 && steer !== 0;
  } else {
    state.wantsPivot = false;
  }
  return { throttle, steer, brake };
}

// ---- Update ------------------------------------------------------------

function update(dt) {
  state.shake = Math.max(0, state.shake - dt * 2.5);
  state.bumpCooldown = Math.max(0, state.bumpCooldown - dt);
  state.grace = Math.max(0, state.grace - dt);
  updateParticles(dt);

  if (state.phase === 'countdown') {
    const before = Math.ceil(state.countdown - 0.5);
    state.countdown -= dt;
    const after = Math.ceil(state.countdown - 0.5);
    if (after !== before) {
      if (after > 0) audio.sfx('count');
      else if (after === 0) {
        audio.sfx('go');
        state.phase = 'playing';
        audio.playSong(SONG);
      }
    }
  }

  if (state.phase === 'playing') {
    state.time -= dt;
    const sec = Math.ceil(state.time);
    if (sec < state.lastTick) {
      state.lastTick = sec;
      if (sec <= 10 && sec > 0) audio.sfx('tick');
    }
    if (state.time <= 0) {
      state.time = 0;
      finish(false);
    } else {
      driveBot(dt, readControls(state.bot));
    }
  } else if (state.phase === 'exploding') {
    const b = state.bot;
    b.vx *= Math.exp(-4 * dt);
    b.vy *= Math.exp(-4 * dt);
    state.blast.t += dt;
    if (state.blast.t > 1.7 && !state.blast.done) {
      state.blast.done = true;
      finish(true);
    }
  }

  // Camera follows the bot and leads a little in the direction of travel.
  const b = state.bot;
  const tx = b.x + b.vx * 0.35;
  const ty = b.y + b.vy * 0.35;
  const k = 1 - Math.exp(-5 * dt);
  state.cam.x += (tx - state.cam.x) * k;
  state.cam.y += (ty - state.cam.y) * k;

  keys.endFrame();
}

function driveBot(dt, { throttle, steer, brake }) {
  const b = state.bot;
  const angleBefore = b.angle;
  state.backup = Math.max(0, state.backup - dt);
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  let vF = b.vx * c + b.vy * s;
  let vL = -b.vx * s + b.vy * c;

  if (brake) {
    vF = vF > 0 ? Math.max(0, vF - BOT.brake * dt) : Math.min(0, vF + BOT.brake * dt);
  } else if (throttle > 0) {
    const target = BOT.maxSpeed * throttle;
    if (vF < 0) vF = Math.min(0, vF + BOT.brake * dt);
    else if (vF < target) vF = Math.min(target, vF + BOT.accel * dt);
    else vF = Math.max(target, vF - BOT.accel * 0.5 * dt);
  } else if (throttle < 0) {
    const target = -BOT.maxReverse * -throttle;
    if (vF > 0) vF = Math.max(0, vF - BOT.brake * dt);
    else if (vF > target) vF = Math.max(target, vF - BOT.accel * dt);
    else vF = Math.min(target, vF + BOT.accel * 0.5 * dt);
  } else {
    vF *= Math.exp(-BOT.coastDrag * dt);
    if (Math.abs(vF) < 2) vF = 0;
  }
  vL *= Math.exp(-BOT.grip * dt);

  // At speed the turn rate depends on speed, so the bot drives in wide arcs.
  // Near a standstill it can also pivot on the spot (not while reversing).
  // A requested on-the-spot turn always goes the way the stick points, even
  // while the bot is still rolling backwards.
  let omega = (steer * (state.wantsPivot ? Math.abs(vF) : vF)) / BOT.turnRadius;
  if (throttle >= 0) omega += steer * BOT.pivotRate * Math.max(0, 1 - Math.abs(vF) / BOT.pivotFade);

  const steps = 3;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const na = b.angle + omega * h;
    let vx = vF * Math.cos(na) - vL * Math.sin(na);
    let vy = vF * Math.sin(na) + vL * Math.cos(na);
    let nx = b.x + vx * h;
    let ny = b.y + vy * h;

    const wall = wallHit(nx, ny, na);
    if (!wall) {
      b.x = nx;
      b.y = ny;
      b.angle = na;
    } else {
      // Slide along the wall: drop the part of the motion that pushes into it.
      const n = wallNormal(wall, b.x, b.y);
      const into = -(vx * n.x + vy * n.y);
      if (into > 0) {
        vx += into * n.x;
        vy += into * n.y;
        if (into > 70) {
          vx += n.x * into * BOT.bounce;
          vy += n.y * into * BOT.bounce;
          if (state.bumpCooldown <= 0) {
            audio.sfx('bump');
            state.shake = Math.min(1, into / 400);
            state.bumpCooldown = 0.25;
          }
        }
      }
      nx = b.x + vx * h;
      ny = b.y + vy * h;
      // Try, in order: slide and turn, turn while easing off the wall, slide
      // without turning, ease off without turning, and finally stay put.
      const push = 1.5;
      const options = [
        [nx, ny, na],
        [nx + n.x * push, ny + n.y * push, na],
        [nx, ny, b.angle],
        [b.x + n.x * push, b.y + n.y * push, b.angle],
      ];
      const ok = options.find(([x, y, a]) => !wallHit(x, y, a));
      if (ok) [b.x, b.y, b.angle] = ok;
      else if (wallHit(b.x, b.y, b.angle)) {
        // Already overlapping a wall somehow: ease out rather than freeze.
        b.x += n.x * push;
        b.y += n.y * push;
      }
      const fc = Math.cos(b.angle);
      const fs = Math.sin(b.angle);
      vF = vx * fc + vy * fs;
      vL = -vx * fs + vy * fc;
    }

    const ore = hitOre(b.x, b.y, b.angle);
    if (ore) {
      if (state.grace <= 0) state.oreHits++;
      if (state.oreHits > ORE_HITS_ALLOWED) {
        explode(ore);
        break;
      }
      const knocked = state.grace <= 0;
      ({ vF, vL } = bounceOffOre(ore, knocked));
      if (knocked) oreKnock(ore);
      continue;
    }

    const cleaned = cleanUnderBot(b);
    if (cleaned) {
      state.cleaned += cleaned;
      state.brushTimer -= h;
    }
  }

  const fc = Math.cos(b.angle);
  const fs = Math.sin(b.angle);
  b.vx = vF * fc - vL * fs;
  b.vy = vF * fs + vL * fc;

  // If the player is asking to turn on the spot but walls won't let the bot
  // rotate, back it out for a moment so it has room to turn.
  const turned = Math.abs(wrapAngle(b.angle - angleBefore));
  if (state.wantsPivot && turned < BOT.pivotRate * dt * 0.2) state.pivotStuck += dt;
  else state.pivotStuck = 0;
  if (state.pivotStuck > 0.2) {
    state.backup = 0.4;
    state.pivotStuck = 0;
  }

  if (state.brushTimer < 0 && state.phase === 'playing') {
    audio.noise({ dur: 0.05, vol: 0.035, rate: 1.8 });
    state.brushTimer = 0.09;
  }
}

// Push the bot clear of the cylinder and send it back the way it came.
// Returns the bot's new forward/sideways speed.
function bounceOffOre(ore, hard) {
  const b = state.bot;
  let nx = b.x - ore.x;
  let ny = b.y - ore.y;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  for (let i = 0; i < 40 && hitOre(b.x, b.y, b.angle) === ore; i++) {
    if (wallHit(b.x + nx, b.y + ny, b.angle)) break;
    b.x += nx;
    b.y += ny;
  }
  const speed = Math.max(hard ? 110 : 40, Math.hypot(b.vx, b.vy) * 0.6);
  const vx = nx * speed;
  const vy = ny * speed;
  b.vx = vx;
  b.vy = vy;
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  return { vF: vx * c + vy * s, vL: -vx * s + vy * c };
}

function oreKnock(ore) {
  state.grace = HIT_GRACE;
  state.shake = 0.7;
  state.oreDamage.set(ore, (state.oreDamage.get(ore) || 0) + 1);
  // warning klaxon: two falling square-wave blips
  audio.tone({ wave: 'pulse50', freq: 880, freqEnd: 660, dur: 0.12, vol: 0.25 });
  audio.tone({ wave: 'pulse50', freq: 880, freqEnd: 660, dur: 0.12, vol: 0.25, at: 0.16 });
  audio.noise({ dur: 0.12, vol: 0.2, rate: 0.4 });
  lastHud = '';
}

function explode(ore) {
  state.phase = 'exploding';
  state.blast = { x: ore.x, y: ore.y, t: 0, done: false, ore };
  state.shake = 1;
  audio.stopSong();
  audio.sfx('explode');
  const r = Math.random;
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2;
    const sp = 120 + r() * 380;
    state.particles.push({
      x: ore.x,
      y: ore.y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      rot: r() * 6,
      vr: (r() - 0.5) * 14,
      size: 4 + r() * 9,
      life: 1.2 + r() * 0.8,
      color: [INK.green, INK.greenLight, INK.yellow, '#ffffff', INK.marker][Math.floor(r() * 5)],
    });
  }
}

function updateParticles(dt) {
  for (const p of state.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= Math.exp(-2.5 * dt);
    p.vy *= Math.exp(-2.5 * dt);
    p.rot += p.vr * dt;
    p.life -= dt;
  }
  state.particles = state.particles.filter((p) => p.life > 0);
}

// ---- Rendering -----------------------------------------------------------

function render() {
  const { w, h, dpr } = fitCanvas(canvas);
  const scale = Math.sqrt((w * h) / VIEW_AREA);
  const viewW = w / scale;
  const viewH = h / scale;

  // Keep the camera inside the map (or centered if the map is smaller).
  let cx = viewW >= worldW ? worldW / 2 : Math.max(viewW / 2, Math.min(worldW - viewW / 2, state.cam.x));
  // Let the camera go a little past the top edge so the HUD doesn't hide it.
  const hudInset = 64 / scale;
  let cy = viewH >= worldH + hudInset ? worldH / 2 - hudInset / 2 : Math.max(viewH / 2 - hudInset, Math.min(worldH - viewH / 2, state.cam.y));
  if (state.shake > 0) {
    cx += (Math.random() - 0.5) * 14 * state.shake;
    cy += (Math.random() - 0.5) * 14 * state.shake;
  }
  const left = cx - viewW / 2;
  const top = cy - viewH / 2;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = INK.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -left * dpr * scale, -top * dpr * scale);

  graphPaper(ctx, left, top, viewW, viewH, 10, 4);

  drawRoomFloors();
  drawDirt(left, top, viewW, viewH);
  drawRoomLabels();
  drawOutside(left, top, viewW, viewH);
  drawDoors();
  drawWalls(left, top, viewW, viewH);
  drawOre(left, top, viewW, viewH);
  if (!state.blast || state.blast.t < 0.05) {
    drawBrushReach(state.bot);
    const blink = state.grace > 0 && Math.floor(state.grace * 12) % 2 === 0;
    if (!blink) drawBot(state.bot);
  }
  drawBlast();
  drawParticles();

  // Screen-space layers
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (stick.active && state.phase === 'playing') drawStick();
  if (state.phase === 'countdown' || (state.phase === 'playing' && state.time > TIME_LIMIT - 0.6)) drawCountdown(w, h);
  updateHud();
}

function drawDirt(left, top, viewW, viewH) {
  const cx0 = Math.max(0, Math.floor(left / CELL));
  const cy0 = Math.max(0, Math.floor(top / CELL));
  const cx1 = Math.min(dirtCols - 1, Math.floor((left + viewW) / CELL));
  const cy1 = Math.min(dirtRows - 1, Math.floor((top + viewH) / CELL));
  ctx.beginPath();
  for (let cy = cy0; cy <= cy1; cy++) {
    let run = -1;
    for (let cx = cx0; cx <= cx1 + 1; cx++) {
      const on = cx <= cx1 && dirt[cy * dirtCols + cx];
      if (on && run < 0) run = cx;
      else if (!on && run >= 0) {
        ctx.rect(run * CELL, cy * CELL, (cx - run) * CELL, CELL + 0.3);
        run = -1;
      }
    }
  }
  ctx.fillStyle = dirtPattern;
  ctx.fill();
}

function polygonPath(pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// A faint grey wash marks room floors, so clean rooms still read as rooms.
function drawRoomFloors() {
  ctx.fillStyle = 'rgba(85, 83, 78, 0.07)';
  for (const r of map.rooms) {
    polygonPath(r.points);
    ctx.fill();
  }
}

function drawRoomLabels() {
  ctx.fillStyle = 'rgba(85, 83, 78, 0.6)';
  ctx.font = `16px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of map.rooms) {
    ctx.fillText(r.name.toUpperCase(), r.label[0], r.label[1]);
  }
  ctx.textAlign = 'left';
}

// Hatch the border band and anything beyond the map edge.
function drawOutside(left, top, viewW, viewH) {
  const b = map.border;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 10, top - 10, viewW + 20, viewH + 20);
  ctx.rect(b, b, worldW - 2 * b, worldH - 2 * b);
  ctx.fillStyle = 'rgba(201, 162, 107, 0.35)';
  ctx.fill('evenodd');
  ctx.clip('evenodd');
  ctx.strokeStyle = 'rgba(85, 83, 78, 0.45)';
  ctx.lineWidth = 1.4;
  // Anchor the hatching to world space so it doesn't slide with the camera.
  const x = Math.floor(left / 200) * 200;
  const y = Math.floor(top / 200) * 200;
  hatch(ctx, x, y, viewW + 400, viewH + 400, { gap: 9, seed: 3 });
  ctx.restore();
}

// Entrances: a dashed red threshold line, like the red boxes on the design map.
function drawDoors() {
  ctx.save();
  ctx.strokeStyle = 'rgba(217, 65, 43, 0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  for (const d of map.doors) {
    ctx.beginPath();
    ctx.moveTo(d.x1, d.y1);
    ctx.lineTo(d.x2, d.y2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWalls(left, top, viewW, viewH) {
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = WALL_HALF * 2 - 2;
  ctx.lineCap = 'round';
  const pad = 20;
  for (const w of map.walls) {
    if (Math.max(w.x1, w.x2) < left - pad || Math.min(w.x1, w.x2) > left + viewW + pad) continue;
    if (Math.max(w.y1, w.y2) < top - pad || Math.min(w.y1, w.y2) > top + viewH + pad) continue;
    // Break long walls into marker-length strokes so each one wobbles a little.
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const n = Math.max(1, Math.round(len / 90));
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      sketchLine(
        ctx,
        w.x1 + (w.x2 - w.x1) * t0, w.y1 + (w.y2 - w.y1) * t0,
        w.x1 + (w.x2 - w.x1) * t1, w.y1 + (w.y2 - w.y1) * t1,
        hash(w.x1, w.y1, i), { wobble: 1.4, passes: 1 },
      );
    }
  }
}

function drawOre(left, top, viewW, viewH) {
  const t = performance.now() / 1000;
  for (const o of map.ore) {
    if (o.x + o.r < left - 20 || o.x - o.r > left + viewW + 20 || o.y + o.r < top - 20 || o.y - o.r > top + viewH + 20) continue;
    if (state.blast && state.blast.ore === o) continue;
    const seed = hash(o.x, o.y);
    // warning ring
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.lineDashOffset = -t * 8;
    ctx.strokeStyle = `rgba(217, 65, 43, ${0.35 + Math.sin(t * 3 + seed) * 0.15})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r + 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // cylinder
    ctx.save();
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
    ctx.fillStyle = INK.greenLight;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(46, 158, 79, 0.75)';
    ctx.lineWidth = 2;
    hatch(ctx, o.x - o.r, o.y - o.r, o.r * 2, o.r * 2, { gap: 5, seed, angle: Math.PI / 4 });
    ctx.restore();
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 2.6;
    sketchCircle(ctx, o.x, o.y, o.r, seed);
    ctx.lineWidth = 1.6;
    sketchCircle(ctx, o.x, o.y, o.r * 0.55, seed + 5, { passes: 1, wobble: 0.6 });
    const damage = state.oreDamage.get(o) || 0;
    if (damage) {
      ctx.strokeStyle = INK.red;
      ctx.lineWidth = 2;
      const cr = rng(seed + 31);
      for (let k = 0; k < damage * 2; k++) {
        const a = cr() * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(o.x + Math.cos(a) * o.r, o.y + Math.sin(a) * o.r);
        ctx.lineTo(o.x + Math.cos(a + 0.35) * o.r * 0.6, o.y + Math.sin(a + 0.35) * o.r * 0.6);
        ctx.lineTo(o.x + Math.cos(a - 0.1) * o.r * 0.3, o.y + Math.sin(a - 0.1) * o.r * 0.3);
        ctx.stroke();
      }
    }
    ctx.fillStyle = INK.marker;
    ctx.font = `bold 17px ${HAND_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('α', o.x, o.y + 1);
    ctx.textAlign = 'left';
  }
}

function drawBot(b) {
  // The artwork is drawn at a 60x44 reference size and scaled to the bot.
  // Marker lines are kept from getting too thin when the bot is small.
  const L = 60;
  const W = 44;
  const k = BOT.length / L;
  const lw = Math.max(1, 0.65 / k);
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.angle);
  ctx.scale(k, BOT.width / W);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // treads
  ctx.fillStyle = '#4a4741';
  ctx.fillRect(-L / 2 + 4, -W / 2 - 3, L - 8, 7);
  ctx.fillRect(-L / 2 + 4, W / 2 - 4, L - 8, 7);
  ctx.strokeStyle = '#f2efe6';
  ctx.lineWidth = 1.2 * lw;
  const roll = ((b.x + b.y) * 0.25 / k) % 6;
  for (let x = -L / 2 + 6 - roll; x < L / 2 - 4; x += 6) {
    if (x < -L / 2 + 5) continue;
    ctx.beginPath();
    ctx.moveTo(x, -W / 2 - 3);
    ctx.lineTo(x, -W / 2 + 4);
    ctx.moveTo(x, W / 2 - 4);
    ctx.lineTo(x, W / 2 + 3);
    ctx.stroke();
  }

  // body
  ctx.fillStyle = INK.yellow;
  ctx.fillRect(-L / 2 + 2, -W / 2 + 3, L - 8, W - 6);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.6 * lw;
  sketchRect(ctx, -L / 2 + 2, -W / 2 + 3, L - 8, W - 6, 11, { wobble: 1, passes: 1 });

  // brush bar at the front
  ctx.fillStyle = '#8fb8e8';
  ctx.fillRect(L / 2 - 8, -W / 2 - 2, 8, W + 4);
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2 * lw;
  sketchRect(ctx, L / 2 - 8, -W / 2 - 2, 8, W + 4, 21, { wobble: 0.6, passes: 1 });
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.55)';
  ctx.lineWidth = 1 * lw;
  for (let y = -W / 2 + 1; y < W / 2 + 2; y += 4) {
    ctx.beginPath();
    ctx.moveTo(L / 2 - 6, y);
    ctx.lineTo(L / 2 + 1.5, y + 1);
    ctx.stroke();
  }

  // heading arrow
  ctx.strokeStyle = INK.marker;
  ctx.lineWidth = 2.4 * lw;
  ctx.beginPath();
  ctx.moveTo(-12, 0);
  ctx.lineTo(10, 0);
  ctx.moveTo(4, -6);
  ctx.lineTo(10, 0);
  ctx.lineTo(4, 6);
  ctx.stroke();

  ctx.restore();
}

// Swirling brush spray that grows with speed: shows how wide the bot cleans.
function drawBrushReach(b) {
  const r = cleanRadius(b);
  if (r <= BOT.width / 2) return;
  const t = performance.now() / 1000;
  ctx.save();
  ctx.fillStyle = 'rgba(143, 184, 232, 0.22)';
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(47, 111, 192, 0.55)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 5]);
  ctx.lineDashOffset = -t * 40;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // a few bristle flicks spinning around the edge
  for (let i = 0; i < 6; i++) {
    const a = t * 9 + (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(b.x + Math.cos(a) * (r - 6), b.y + Math.sin(a) * (r - 6));
    ctx.lineTo(b.x + Math.cos(a + 0.25) * r, b.y + Math.sin(a + 0.25) * r);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBlast() {
  const bl = state.blast;
  if (!bl) return;
  const t = bl.t;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const tt = t - i * 0.12;
    if (tt <= 0 || tt > 0.9) continue;
    const r = 20 + tt * 260;
    ctx.globalAlpha = Math.max(0, 1 - tt / 0.9);
    ctx.strokeStyle = [INK.red, INK.yellow, INK.marker][i];
    ctx.lineWidth = 5 - i;
    sketchCircle(ctx, bl.x, bl.y, r, 40 + i, { wobble: 8, passes: 1 });
  }
  if (t < 0.5) {
    ctx.globalAlpha = 1 - t / 0.5;
    ctx.strokeStyle = INK.red;
    ctx.lineWidth = 3;
    const rr = rng(9);
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rr() * 0.2;
      const r0 = 18 + t * 60;
      const r1 = 40 + t * 220 + rr() * 30;
      ctx.moveTo(bl.x + Math.cos(a) * r0, bl.y + Math.sin(a) * r0);
      ctx.lineTo(bl.x + Math.cos(a) * r1, bl.y + Math.sin(a) * r1);
    }
    ctx.stroke();
  }
  if (t > 0.15) {
    ctx.globalAlpha = Math.min(1, (t - 0.15) * 4);
    ctx.fillStyle = INK.red;
    ctx.font = `bold 46px ${HAND_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(bl.x, bl.y - 70 - t * 10);
    ctx.rotate(-0.12);
    ctx.fillText('BOOM!', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life * 1.5);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = INK.marker;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-p.size / 2, -p.size / 3);
    ctx.lineTo(p.size / 2, -p.size / 2);
    ctx.lineTo(p.size / 3, p.size / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawStick() {
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.55)';
  ctx.lineWidth = 2.5;
  sketchCircle(ctx, stick.baseX, stick.baseY, stick.radius, 77, { passes: 1, wobble: 2 });
  ctx.fillStyle = 'rgba(47, 111, 192, 0.35)';
  ctx.beginPath();
  ctx.arc(stick.knobX, stick.knobY, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(36, 34, 31, 0.8)';
  sketchCircle(ctx, stick.knobX, stick.knobY, 22, 78, { passes: 1 });
}

function drawCountdown(w, h) {
  const n = state.phase === 'countdown' ? Math.ceil(state.countdown - 0.5) : 0;
  const label = n > 0 ? String(n) : 'GO!';
  const frac = n > 0 ? state.countdown - 0.5 - Math.floor(state.countdown - 0.5) : (state.time - (TIME_LIMIT - 0.6)) / 0.6;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(1 + frac * 0.4, 1 + frac * 0.4);
  ctx.rotate(-0.05);
  ctx.font = `bold 88px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = n > 0 ? INK.marker : INK.green;
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

let lastHud = '';
function updateHud() {
  const pct = percentCleaned();
  const secs = Math.ceil(state.time);
  const key = `${secs}|${Math.floor(pct)}|${state.oreHits}`;
  if (key === lastHud) return;
  lastHud = key;
  hudTime.textContent = formatTime(secs);
  hudTime.classList.toggle('urgent', secs <= 10 && state.phase === 'playing');
  hudPct.textContent = `${Math.floor(pct)}%`;
  hudFill.style.width = `${Math.min(100, pct)}%`;
  hudMarks.forEach((m, i) => m.classList.toggle('on', pct >= STAR_THRESHOLDS[i]));
  const left = Math.max(0, ORE_HITS_ALLOWED - state.oreHits);
  hudHits.forEach((el, i) => el.classList.toggle('used', i >= left));
  hudHitsWrap.setAttribute('aria-label', `${left} ore knocks left`);
}

// ---- Flow ------------------------------------------------------------------

function showStart() {
  const rec = getRecord(GAME_ID);
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h1>Bunker Clean-Up</h1>
    <p>Scrub as much of the room floors as you can in <b>${formatTime(TIME_LIMIT)}</b>. Hallways are already clean.</p>
    <p><b style="color:var(--red)">Watch out for the green Alpha Ore cylinders.</b> They survive ${ORE_HITS_ALLOWED} knocks; the ${ORE_HITS_ALLOWED + 1}rd blows up the bunker.</p>
    <p class="subtle">Drive faster to clean a wider path.</p>
    <p class="subtle">Drag anywhere to steer: point where you want the bot to go.<br>Keyboard: arrow keys or WASD.</p>
    <ul class="star-goals"></ul>
    <div class="best"></div>
    <div class="actions"><button class="paper-btn primary" type="button">Start</button></div>`;
  const goals = card.querySelector('.star-goals');
  STAR_THRESHOLDS.forEach((t, i) => {
    const li = document.createElement('li');
    li.append(renderStars(i + 1, { mini: true }), `Clean ${t}% of the floor`);
    goals.appendChild(li);
  });
  if (rec.plays > 0) {
    const best = card.querySelector('.best');
    const p = document.createElement('p');
    p.className = 'subtle';
    p.textContent = `High score: ${formatScore(rec.highScore)} · Last: ${formatScore(rec.recentScore)}`;
    best.append(p);
  }
  const btn = card.querySelector('button');
  btn.addEventListener('click', start);
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
}

function finish(exploded) {
  if (state.phase === 'done') return;
  state.phase = 'done';
  audio.stopSong();
  const pct = percentCleaned();
  const cleaned = Math.floor(pct);
  const score = exploded ? 0 : cleaned;
  const stars = exploded ? 0 : starsFor(pct);
  const { record, newHigh, newBestStars } = saveResult(GAME_ID, score, stars);

  setTimeout(() => audio.sfx(exploded || stars === 0 ? 'lose' : 'win'), 150);
  showResults(overlay, {
    title: exploded ? 'Kaboom!' : "Time's up!",
    scoreText: `${score}%`,
    stars,
    newHigh: newHigh && score > 0,
    newBestStars,
    record,
    formatScore,
    note: exploded
      ? `You had cleaned ${cleaned}%, but the bot hit the Alpha Ore ${ORE_HITS_ALLOWED + 1} times. An explosion scores 0.`
      : stars === 0
        ? `You need ${STAR_THRESHOLDS[0]}% for a star. Get in close to the ore!`
        : stars < 3
          ? `Next star at ${STAR_THRESHOLDS[stars]}%.`
          : 'Spotless. The bunker sparkles.',
    onRetry: start,
  });
}

// Press Enter/Space on the start or results card to (re)start.
addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !overlay.hidden && document.activeElement?.tagName !== 'BUTTON' && document.activeElement?.tagName !== 'A') {
    if (state.phase === 'ready' || state.phase === 'done') start();
  }
});

// ---- Music -----------------------------------------------------------------

// A tense little loop in A minor.
const SONG = {
  bpm: 132,
  stepsPerBeat: 4,
  wave1: 'pulse25',
  wave2: 'pulse12',
  tracks: {
    p1: `A4 - . A4 C5 - A4 . E5 - D5 - C5 - B4 -
         A4 - . A4 C5 - A4 . G5 - F5 - E5 - - -
         F5 - . F5 E5 - D5 . E5 - C5 - B4 - G4 -
         A4 - . A4 C5 - E5 . A5 - G5 - E5 - - -`,
    p2: `E4 . E4 . E4 . E4 . E4 . E4 . E4 . E4 .
         E4 . E4 . E4 . E4 . G4 . G4 . G4 . G4 .
         F4 . F4 . F4 . F4 . E4 . E4 . E4 . E4 .
         E4 . E4 . E4 . E4 . C5 . C5 . B4 . B4 .`,
    tri: `A2 - A3 - A2 - A3 - A2 - A3 - A2 - A3 -
          A2 - A3 - A2 - A3 - C3 - C4 - C3 - C4 -
          F2 - F3 - F2 - F3 - E2 - E3 - E2 - E3 -
          A2 - A3 - A2 - A3 - E2 - E3 - G#2 - G#3 -`,
    noise: `k . h . s . h . k . h k s . h .`,
  },
};

// ---- Loop --------------------------------------------------------------------

state = newState();
showStart();

// Add ?debug to the URL to poke at the game from the browser console.
if (new URLSearchParams(location.search).has('debug')) {
  window.bunker = { get state() { return state; }, map, BOT, dirtTotal: () => dirtTotal, percentCleaned };
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
