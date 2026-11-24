import { audio, noteFreq } from '../shared/audio.js';
import { getRecord, saveResult } from '../shared/storage.js';
import { mountTopBar, showResults, renderStars } from '../shared/ui.js';
import { GAMES } from '../games.js';

// ---- Tuning --------------------------------------------------------------

const GAME_ID = 'containment';
const FLEET_TIME = 180; // seconds until the fleet returns (a win)
const STAR_TIMES = [120, 150, 180]; // seconds survived for 1, 2, 3 stars

const MEM_BLOCKS = 64; // memory is shown as 64 blocks; filling it is a breach
const KILL_RESPAWN = 10; // seconds a killed virus stays down before restarting
const LEGIT_RESTART = 3; // seconds a wrongly killed system process is down
const RESTART_STORM = { cpu: 35, secs: 5 }; // CPU spike while it recovers
const AV = { mem: 4, cpu: 8, rate: 0.35 }; // rate = progress/s with an idle CPU
const AV_MIN_SPEED = 0.1; // AV speed factor when the CPU is maxed out
const BAN_COOLDOWN = 0.6;
const BAN_PENALTY = 5; // cooldown after banning a real user
const ACTION_DELAY = 0.25; // seconds for a kill/ban; longer when throttled

const DDOS_CPU = 9; // CPU load per attacking source
const DDOS_LOG_MEM = 0.12; // log buffer growth (blocks/s) per attacking source
const ATTACKER_RATE = 2.4; // log lines per second per attacking source
const LEGIT_RATE = 3.2; // log lines per second from all real users together

const WORM = { cpu: 5, mem: 2, every: 8, maxCopies: 12 };
const TROJAN = { cpu: 2, mem: 1.5, grow: 0.3 };
const CPU_VIRUS = { cpu: 42, mem: 2 };

// Overtime (after the fleet returns, if the player keeps going): attacks keep
// getting nastier. Intensity is 1 at 3:00 and grows by 1 every OVERTIME_RAMP s.
const OVERTIME_RAMP = 90;
function intensity() {
  return state.t > FLEET_TIME ? 1 + (state.t - FLEET_TIME) / OVERTIME_RAMP : 1;
}

// Scripted opening, then random attacks that come faster over time.
const SCRIPT = [
  [4, 'ddos'],
  [20, 'worm'],
  [38, 'trojan'],
  [56, 'cpu'],
];

const SYSTEM = [
  { name: 'kernel', cpu: 4, mem: 6, protected: true },
  { name: 'shield-ctrl', cpu: 10, mem: 8 },
  { name: 'nav-sync', cpu: 5, mem: 4 },
  { name: 'comms-relay', cpu: 6, mem: 5 },
  { name: 'telemetry', cpu: 4, mem: 4 },
  { name: 'logd', cpu: 3, mem: 3, logd: true },
];

const WORM_NAMES = ['replik8', 'w0rmhole', 'netcrawl', 'lovebug.x', 'spreadr'];
const CPU_NAMES = ['c0inmnr', 'hashbrwn', 'xmr-lite', 'burnr.exe'];
// Trojans borrow names that look like the real system processes.
const TROJAN_NAMES = ['shield-ctl', 'nav-synk', 'comms-reIay', 'telemetryd', 'kerneI', 'logd2', 'shield_ctrl'];

const USERS = [
  'cmdr.vale', 'lt.mara', 'ens.okoro', 'dr.ishii', 'sgt.reyes', 'eng.pak',
  'nav.lund', 'med.adair', 'cpl.voss', 'lt.haddad', 'eng.mbeki', 'ops.tran',
];
const PATHS = [
  'GET /shield/status', 'GET /fleet/eta', 'POST /comms/msg', 'GET /nav/chart',
  'GET /telemetry/feed', 'POST /auth/login', 'GET /roster', 'GET /shield/freq',
];

// Pastel marker colours. Viruses get them too, so colour never gives one away.
const PALETTE = ['#8fb8e8', '#f4c430', '#9ee0a4', '#f2a07b', '#c7a6e8', '#f7c6d6', '#b8d98f', '#e8c39e', '#a6d8d8', '#d9b8f0', '#f0e08f', '#9fc3c0'];

// ---- DOM -------------------------------------------------------------------

const shell = document.getElementById('shell');
const overlay = document.getElementById('overlay');
const serverEl = document.getElementById('server');
const cpuBar = document.getElementById('cpu-bar');
const cpuFill = cpuBar.querySelector('.fill');
const cpuPct = document.getElementById('cpu-pct');
const throttleStamp = serverEl.querySelector('.stamp');
const memUsedEl = document.getElementById('mem-used');
const breachEta = document.getElementById('breach-eta');
const memGrid = document.getElementById('mem-grid');
const procList = document.getElementById('proc-list');
const logEl = document.getElementById('log');
const logPanel = document.getElementById('log-panel');
const actionBar = document.getElementById('action-bar');
const formatScore = GAMES.find((g) => g.id === GAME_ID).formatScore;

const fmt = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <span class="hud-label">Fleet</span>
  <div class="track" aria-hidden="true">
    <svg class="ship" width="18" height="14" viewBox="0 0 18 14"><path d="M1 7 L15 2 L12 7 L15 12 Z" fill="#fff" stroke="#24221f" stroke-width="1.8" stroke-linejoin="round"/></svg>
    <span class="base"></span>
  </div>
  <span class="fleet-time" aria-label="Time until the fleet returns">${fmt(FLEET_TIME)}</span>`;
mountTopBar(shell, { extra: hud });
const hudShip = hud.querySelector('.ship');
const hudTime = hud.querySelector('.fleet-time');
const hudLabel = hud.querySelector('.hud-label');
hudShip.style.transform = 'translateX(-50%)';

const cells = Array.from({ length: MEM_BLOCKS }, (_, i) => {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'cell';
  c.setAttribute('aria-label', `Memory block ${i + 1}`);
  if (i >= MEM_BLOCKS * 0.8) c.classList.add('danger-zone');
  memGrid.appendChild(c);
  return c;
});

// ---- State -------------------------------------------------------------------

let state;
let nextProcId = 1;
let nextFamilyId = 1;

function newState() {
  nextProcId = 1;
  nextFamilyId = 1;
  const s = {
    phase: 'ready', // ready | playing | fleet (choice) | done
    overtime: false,
    t: 0,
    procs: [],
    families: [],
    attackers: [], // { ip, banned }
    users: USERS.map((user, i) => ({ user, ip: `10.0.${(i % 4) + 2}.${20 + i * 7}`, banned: false })),
    logBuffer: 0, // extra log memory from floods
    av: null, // { procId, familyId, progress }
    banCooldown: 0,
    pending: [], // delayed actions { at, fn }
    scriptIndex: 0,
    nextRandomAt: 70,
    selected: null, // { type: 'proc', id } | { type: 'ip', ip }
    memUsed: 0,
    memRate: 0,
    demand: 0,
    throttle: 1,
    lastWarn: 0,
    legitLineAcc: 0,
    usedNames: new Set(),
  };
  SYSTEM.forEach((d) => addProc(s, { ...d, kind: 'sys', baseCpu: d.cpu }));
  return s;
}

function addProc(s, p) {
  const proc = {
    id: nextProcId++,
    state: 'run',
    downUntil: 0,
    recoverUntil: 0,
    trend: 0,
    color: PALETTE[(nextProcId - 2) % PALETTE.length],
    ...p,
  };
  proc.baseCpu ??= proc.cpu;
  s.procs.push(proc);
  return proc;
}

const family = (id) => state.families.find((f) => f.id === id);

// ---- Log ---------------------------------------------------------------------

let logPaused = false;
const logQueue = [];

function clock() {
  return `T+${fmt(state.t).padStart(5, '0')}`;
}

function log(text, cls = 'net', ip = null) {
  const line = { text: `${clock()} ${text}`, cls, ip };
  if (logPaused) logQueue.push(line);
  else appendLog(line);
}

function appendLog({ text, cls, ip }) {
  const el = document.createElement('div');
  el.className = `log-line ${cls}`;
  if (ip) {
    el.dataset.ip = ip;
    const i = text.indexOf(ip);
    el.append(text.slice(0, i));
    const b = document.createElement('span');
    b.className = 'ip';
    b.textContent = ip;
    el.append(b, text.slice(i + ip.length));
    if (state.selected?.type === 'ip' && state.selected.ip === ip) el.classList.add('hl');
    if (isBanned(ip)) el.classList.add('banned');
  } else {
    el.textContent = text;
  }
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
  logEl.appendChild(el);
  while (logEl.childElementCount > 120) logEl.firstElementChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function isBanned(ip) {
  return state.attackers.some((a) => a.ip === ip && a.banned) || state.users.some((u) => u.ip === ip && u.banned);
}

// Hold the log to stop it scrolling while you read it.
logEl.addEventListener('pointerdown', () => {
  logPaused = true;
  logPanel.classList.add('paused');
});
const resumeLog = () => {
  if (!logPaused) return;
  logPaused = false;
  logPanel.classList.remove('paused');
  logQueue.splice(0).forEach(appendLog);
};
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => logEl.addEventListener(t, resumeLog));
logEl.addEventListener('click', (e) => {
  const line = e.target.closest('.log-line[data-ip]');
  if (!line || state.phase !== 'playing') return;
  select({ type: 'ip', ip: line.dataset.ip });
});

function randomPath() {
  return PATHS[Math.floor(Math.random() * PATHS.length)];
}

function trafficLines(dt) {
  // Real users: a steady trickle spread across the crew.
  state.legitLineAcc += LEGIT_RATE * dt;
  while (state.legitLineAcc >= 1) {
    state.legitLineAcc -= 1;
    const active = state.users.filter((u) => !u.banned);
    const u = active[Math.floor(Math.random() * active.length)];
    if (u) log(`${u.ip} ${randomPath()} 200 (${u.user})`, 'net', u.ip);
  }
  // Attack sources: same requests, just far too many of them.
  for (const a of state.attackers) {
    if (a.banned) continue;
    a.acc = (a.acc || 0) + ATTACKER_RATE * dt * (0.6 + Math.random() * 0.8);
    while (a.acc >= 1) {
      a.acc -= 1;
      log(`${a.ip} ${randomPath()} ${Math.random() < 0.7 ? 200 : 503} (${a.alias})`, 'net', a.ip);
    }
  }
}

// ---- Attacks -------------------------------------------------------------------

function pickName(list) {
  const free = list.filter((n) => !state.usedNames.has(n));
  const name = (free.length ? free : list)[Math.floor(Math.random() * (free.length || list.length))];
  state.usedNames.add(name);
  return name;
}

const ATTACKS = {
  ddos() {
    const n = Math.min(state.overtime ? 10 : 6, 2 + Math.floor(state.t / 45));
    for (let i = 0; i < n; i++) {
      const ip = `${Math.random() < 0.5 ? '203.0.113' : '198.51.100'}.${10 + Math.floor(Math.random() * 240)}`;
      // Attackers pose as crew accounts too, so only frequency gives them away.
      const alias = USERS[Math.floor(Math.random() * USERS.length)];
      state.attackers.push({ ip, alias, banned: false, acc: Math.random() });
    }
    log('[net] inbound traffic spike on shield uplink', 'warn');
    alertSound();
  },
  worm() {
    const f = { id: nextFamilyId++, kind: 'worm', name: pickName(WORM_NAMES), removed: false, copies: 0 };
    state.families.push(f);
    spawnWorm(f);
    alertSound();
  },
  trojan() {
    const f = { id: nextFamilyId++, kind: 'trojan', name: pickName(TROJAN_NAMES), removed: false };
    state.families.push(f);
    addProc(state, { name: f.name, kind: 'trojan', familyId: f.id, cpu: TROJAN.cpu, mem: TROJAN.mem, grow: TROJAN.grow * intensity() });
    log(`[sys] started ${f.name}`, 'sys'); // no alarm: it's meant to blend in
  },
  cpu() {
    const f = { id: nextFamilyId++, kind: 'cpu', name: pickName(CPU_NAMES), removed: false };
    state.families.push(f);
    addProc(state, { name: f.name, kind: 'cpu', familyId: f.id, cpu: Math.round(CPU_VIRUS.cpu * Math.min(1.5, intensity())), mem: CPU_VIRUS.mem });
    log(`[sys] started ${f.name}`, 'sys');
    alertSound();
  },
};

function wormEvery() {
  return Math.max(3.5, WORM.every / intensity());
}

function spawnWorm(f) {
  if (f.removed) return;
  const copies = state.procs.filter((p) => p.familyId === f.id).length;
  if (copies >= WORM.maxCopies) return;
  f.copies += 1;
  const name = f.copies === 1 ? f.name : `${f.name}:${f.copies}`;
  addProc(state, { name, kind: 'worm', familyId: f.id, cpu: WORM.cpu, mem: WORM.mem, replicateIn: wormEvery() * (0.9 + Math.random() * 0.25) });
  log(`[sys] started ${name}`, 'sys');
}

function scheduleAttacks() {
  const s = state;
  while (s.scriptIndex < SCRIPT.length && s.t >= SCRIPT[s.scriptIndex][0]) {
    ATTACKS[SCRIPT[s.scriptIndex][1]]();
    s.scriptIndex++;
  }
  if (s.t >= s.nextRandomAt) {
    const kinds = ['ddos', 'worm', 'trojan', 'cpu'];
    ATTACKS[kinds[Math.floor(Math.random() * kinds.length)]]();
    // Gaps shrink to 5 s by 2:20; in overtime the floor keeps dropping to 1.5 s.
    const floor = s.t > FLEET_TIME ? Math.max(1.5, 5 - (s.t - FLEET_TIME) / 30) : 5;
    const gap = Math.max(floor, 15 - (s.t - 60) / 8);
    s.nextRandomAt = s.t + gap * (0.8 + Math.random() * 0.4);
  }
}

// ---- Countermeasures ---------------------------------------------------------

function later(secs, fn) {
  state.pending.push({ at: state.t + secs, fn });
}

function killProc(p) {
  if (p.protected) {
    log(`[sys] kill ${p.name}: access denied (protected)`, 'warn');
    sfx('wrong');
    return;
  }
  if (p.state !== 'run') return;
  sfx('kill');
  later(ACTION_DELAY / state.throttle, () => {
    if (p.state !== 'run' || !state.procs.includes(p)) return;
    p.state = 'down';
    if (p.kind === 'sys') {
      p.downUntil = state.t + LEGIT_RESTART;
      log(`[sys] ${p.name} killed: critical service! restarting...`, 'warn');
      sfx('wrong');
    } else {
      p.downUntil = state.t + KILL_RESPAWN;
      log(`[sys] killed ${p.name} (pid ${p.id})`, 'sys');
    }
  });
}

function startAntivirus(p) {
  if (state.av) return;
  if (state.memUsed + AV.mem >= MEM_BLOCKS) {
    log('[av] not enough free memory to start a scan', 'warn');
    sfx('wrong');
    return;
  }
  state.av = { procId: p.id, familyId: p.familyId ?? null, name: p.name, progress: 0 };
  log(`[av] scanning ${p.name}...`, 'sys');
  sfx('scan');
}

function finishAntivirus() {
  const job = state.av;
  state.av = null;
  const f = job.familyId ? family(job.familyId) : null;
  if (!f) {
    log(`[av] ${job.name}: no threat found`, 'warn');
    sfx('wrong');
    return;
  }
  const removed = state.procs.filter((p) => p.familyId === f.id);
  state.procs = state.procs.filter((p) => p.familyId !== f.id);
  f.removed = true;
  const what = f.kind === 'worm' ? `worm ${f.name} (${removed.length} ${removed.length === 1 ? 'copy' : 'copies'})` : f.kind === 'trojan' ? `trojan ${f.name}` : `cpu virus ${f.name}`;
  log(`[av] removed ${what}`, 'good');
  sfx('clean');
  if (state.selected?.type === 'proc' && !state.procs.some((p) => p.id === state.selected.id)) select(null);
}

function ban(ip) {
  if (state.banCooldown > 0 || isBanned(ip)) return;
  sfx('ban');
  state.banCooldown = BAN_COOLDOWN + ACTION_DELAY / state.throttle;
  later(ACTION_DELAY / state.throttle, () => {
    const a = state.attackers.find((x) => x.ip === ip);
    if (a) {
      a.banned = true;
      log(`[fw] banned ${ip}`, 'good');
    } else {
      const u = state.users.find((x) => x.ip === ip);
      if (!u) return;
      u.banned = true;
      state.banCooldown = BAN_PENALTY;
      log(`[fw] banned ${ip}: complaint filed by ${u.user}! ban hammer locked ${BAN_PENALTY}s`, 'warn');
      sfx('wrong');
    }
    logEl.querySelectorAll(`.log-line[data-ip="${CSS.escape(ip)}"]`).forEach((el) => el.classList.add('banned'));
  });
}

// ---- Simulation ----------------------------------------------------------------

function update(dt) {
  if (state.phase !== 'playing') return;
  const s = state;
  s.t += dt;
  s.banCooldown = Math.max(0, s.banCooldown - dt);

  scheduleAttacks();

  // Delayed actions (kills and bans take longer when the CPU is throttled).
  const due = s.pending.filter((a) => a.at <= s.t);
  s.pending = s.pending.filter((a) => a.at > s.t);
  due.forEach((a) => a.fn());

  // Restarts and respawns.
  for (const p of s.procs) {
    if (p.state === 'down' && s.t >= p.downUntil) {
      if (p.familyId && family(p.familyId)?.removed) continue;
      p.state = 'run';
      if (p.kind === 'sys') {
        p.recoverUntil = s.t + RESTART_STORM.secs;
        log(`[sys] ${p.name} restarted, recovering`, 'sys');
      } else {
        if (p.kind === 'trojan') p.mem = TROJAN.mem;
        log(`[sys] started ${p.name}`, 'sys');
      }
    }
  }

  // CPU demand and throttling.
  const active = s.attackers.filter((a) => !a.banned).length;
  let demand = 0;
  for (const p of s.procs) {
    if (p.state !== 'run') continue;
    if (p.kind === 'sys') {
      p.cpu = p.baseCpu + (p.recoverUntil > s.t ? RESTART_STORM.cpu : 0) + (p.logd ? active * DDOS_CPU : 0);
    }
    demand += p.cpu;
  }
  const demandNoAv = demand;
  if (s.av) demand += AV.cpu;
  s.demand = demand;
  s.throttle = demand > 100 ? 100 / demand : 1;
  const th = s.throttle;

  // Viruses do their thing (slowed down too when throttled).
  for (const p of [...s.procs]) {
    if (p.state !== 'run') continue;
    if (p.kind === 'trojan') p.mem += p.grow * dt * th;
    if (p.kind === 'worm') {
      p.replicateIn -= dt * th;
      if (p.replicateIn <= 0) {
        p.replicateIn = wormEvery() * (0.9 + Math.random() * 0.25);
        spawnWorm(family(p.familyId));
      }
    }
  }

  // Floods fill the log buffer; once they stop, log rotation drains it.
  if (active) s.logBuffer += active * DDOS_LOG_MEM * dt * th;
  else s.logBuffer = Math.max(0, s.logBuffer - 0.4 * dt);
  const logd = s.procs.find((p) => p.logd);
  logd.mem = SYSTEM.find((d) => d.logd).mem + s.logBuffer;

  // Antivirus: speed depends on how much CPU is free.
  if (s.av) {
    const free = Math.max(0, 100 - demandNoAv) / 100;
    s.av.progress += AV.rate * Math.max(AV_MIN_SPEED, free) * dt;
    if (s.av.progress >= 1) finishAntivirus();
  }

  // Memory.
  let mem = s.av ? AV.mem : 0;
  for (const p of s.procs) if (p.state === 'run') mem += p.mem;
  const prev = s.memUsed;
  s.memUsed = mem;
  if (dt > 0) s.memRate += ((mem - prev) / dt - s.memRate) * Math.min(1, dt * 0.8);
  for (const p of s.procs) {
    p.trend = p.state === 'run' && (p.kind === 'trojan' || (p.logd && active)) ? 1 : 0;
  }

  if (mem / MEM_BLOCKS > 0.8 && s.t - s.lastWarn > 2) {
    s.lastWarn = s.t;
    sfx('warn');
    if (Math.random() < 0.5) log(`[warn] memory at ${Math.round((100 * mem) / MEM_BLOCKS)}%`, 'warn');
  }

  trafficLines(dt);

  if (mem >= MEM_BLOCKS) {
    s.memUsed = MEM_BLOCKS;
    finish(false);
  } else if (s.t >= FLEET_TIME && !s.overtime) {
    s.t = FLEET_TIME;
    fleetReturned();
  }
}

// ---- Rendering -------------------------------------------------------------------

let renderClock = 0;

function render(dt) {
  if (!state) return;
  const s = state;
  // Fleet countdown
  const left = Math.max(0, FLEET_TIME - s.t);
  if (s.overtime) {
    hudLabel.textContent = 'Overtime';
    hudTime.textContent = `+${fmt(s.t - FLEET_TIME)}`;
  } else {
    hudLabel.textContent = 'Fleet';
    hudTime.textContent = fmt(Math.ceil(left));
  }
  hudShip.style.left = `${Math.min(100, (100 * s.t) / FLEET_TIME)}%`;

  // CPU
  const pct = Math.round(s.demand);
  cpuFill.style.width = `${Math.min(100, s.demand)}%`;
  cpuBar.classList.toggle('hot', s.demand > 85);
  cpuPct.textContent = `${pct}%`;
  serverEl.classList.toggle('throttled', s.throttle < 1);
  throttleStamp.textContent = `THROTTLED ×${s.throttle.toFixed(2)}`;

  renderClock -= dt;
  if (renderClock > 0) return;
  renderClock = 0.1;

  // Memory map
  memUsedEl.textContent = Math.min(MEM_BLOCKS, Math.round(s.memUsed));
  const eta = s.memRate > 0.03 ? (MEM_BLOCKS - s.memUsed) / s.memRate : Infinity;
  breachEta.textContent = eta < 600 && s.phase === 'playing' ? `breach in ~${fmt(eta)}` : '';
  breachEta.classList.toggle('danger', eta < 30);
  const owners = memoryOwners();
  const selId = s.selected?.type === 'proc' ? s.selected.id : null;
  cells.forEach((c, i) => {
    const o = owners[i];
    c.classList.toggle('av', o === 'av');
    c.style.background = o && o !== 'av' ? o.color : '';
    c.dataset.pid = o && o !== 'av' ? o.id : '';
    c.classList.toggle('sel', !!o && o !== 'av' && o.id === selId);
  });

  renderProcs();
  renderActionBar();
}

// Which process owns each memory block, in process order.
function memoryOwners() {
  const owners = new Array(MEM_BLOCKS).fill(null);
  let acc = 0;
  const fill = (owner, amount) => {
    const start = Math.round(acc);
    acc += amount;
    const end = Math.min(MEM_BLOCKS, Math.round(acc));
    for (let i = start; i < end; i++) owners[i] = owner;
  };
  for (const p of state.procs) if (p.state === 'run') fill(p, p.mem);
  if (state.av) fill('av', AV.mem);
  return owners;
}

const rowEls = new Map();

function renderProcs() {
  const s = state;
  const seen = new Set();
  // Newest first, so a new process shows up at the top instead of below the
  // fold. The order otherwise stays put, so rows don't jump under your finger.
  [...s.procs].reverse().forEach((p, index) => {
    seen.add(p.id);
    let li = rowEls.get(p.id);
    if (!li) {
      li = document.createElement('li');
      li.className = 'proc';
      li.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="cpu"><i></i><span></span></span><span class="mem"></span><span class="scan"></span>';
      li.querySelector('.swatch').style.background = p.color;
      li.addEventListener('click', () => s.phase === 'playing' && select({ type: 'proc', id: p.id }));
      rowEls.set(p.id, li);
    }
    if (procList.children[index] !== li) procList.insertBefore(li, procList.children[index] || null);
    const down = p.state !== 'run';
    li.classList.toggle('down', down);
    li.classList.toggle('sel', s.selected?.type === 'proc' && s.selected.id === p.id);
    const note = down
      ? p.kind === 'sys' ? 'restarting' : `back in ${Math.ceil(p.downUntil - s.t)}s`
      : p.recoverUntil > s.t ? 'recovering' : '';
    const nameEl = li.querySelector('.name');
    nameEl.textContent = p.name;
    if (note) {
      const n = document.createElement('span');
      n.className = 'note';
      n.textContent = note;
      nameEl.append(n);
    }
    const cpu = down ? 0 : p.cpu;
    li.querySelector('.cpu i').style.width = `${Math.min(34, cpu * 0.8)}px`;
    li.querySelector('.cpu span').textContent = `${Math.round(cpu)}%`;
    const memEl = li.querySelector('.mem');
    memEl.textContent = down ? '-' : p.mem.toFixed(1);
    memEl.classList.toggle('up', p.trend > 0 && !down);
    const scan = li.querySelector('.scan');
    scan.style.width = s.av?.procId === p.id ? `${Math.round(s.av.progress * 100)}%` : '0';
  });
  for (const [id, li] of rowEls) {
    if (!seen.has(id)) {
      li.remove();
      rowEls.delete(id);
    }
  }
}

memGrid.addEventListener('click', (e) => {
  const id = Number(e.target.dataset?.pid);
  if (id && state.phase === 'playing') select({ type: 'proc', id });
});

// ---- Selection + action bar -----------------------------------------------------------

function select(sel) {
  const s = state;
  if (sel && s.selected && sel.type === s.selected.type && (sel.id ?? sel.ip) === (s.selected.id ?? s.selected.ip)) sel = null; // tap again to deselect
  s.selected = sel;
  logEl.querySelectorAll('.log-line.hl').forEach((el) => el.classList.remove('hl'));
  if (sel?.type === 'ip') {
    logEl.querySelectorAll(`.log-line[data-ip="${CSS.escape(sel.ip)}"]`).forEach((el) => el.classList.add('hl'));
  }
  if (sel) sfx('select');
  renderClock = 0;
  lastBarKey = '';
}

let lastBarKey = '';

function renderActionBar() {
  const s = state;
  const sel = s.selected;
  let key;
  let html;
  if (sel?.type === 'proc') {
    const p = s.procs.find((x) => x.id === sel.id);
    if (!p) {
      s.selected = null;
      return renderActionBar();
    }
    const avBusy = !!s.av;
    const avLabel = s.av?.procId === p.id ? `Scanning ${Math.round(s.av.progress * 100)}%` : avBusy ? 'AV busy' : 'Antivirus';
    key = `p${p.id}|${p.state}|${avLabel}`;
    html = `
      <div class="target"><b>${p.name}</b><span class="hint">pid ${p.id}${p.state !== 'run' ? ' · down' : ''}</span></div>
      <button class="paper-btn kill" type="button" data-act="kill" ${p.state !== 'run' ? 'disabled' : ''}>Kill</button>
      <button class="paper-btn av" type="button" data-act="av" ${avBusy ? 'disabled' : ''}>${avLabel}</button>`;
  } else if (sel?.type === 'ip') {
    const banned = isBanned(sel.ip);
    const cd = Math.ceil(s.banCooldown);
    key = `i${sel.ip}|${banned}|${cd}`;
    html = `
      <div class="target"><b>${sel.ip}</b><span class="hint">${banned ? 'banned' : 'highlighted in the log'}</span></div>
      <button class="paper-btn ban" type="button" data-act="ban" ${banned || s.banCooldown > 0 ? 'disabled' : ''}>${!banned && s.banCooldown > BAN_COOLDOWN + 0.5 ? `Ban (${cd}s)` : 'Ban'}</button>`;
  } else {
    key = `none|${!!s.av}`;
    html = `<div class="target"><span class="hint">Tap a process to <b style="display:inline;font-family:inherit">Kill</b> or run <b style="display:inline;font-family:inherit">Antivirus</b>.<br>Tap a log line to <b style="display:inline;font-family:inherit">Ban</b> its source.</span></div>`;
  }
  if (key === lastBarKey) return;
  lastBarKey = key;
  actionBar.innerHTML = html;
}

actionBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled || state.phase !== 'playing') return;
  const sel = state.selected;
  if (btn.dataset.act === 'kill') killProc(state.procs.find((p) => p.id === sel.id));
  if (btn.dataset.act === 'av') startAntivirus(state.procs.find((p) => p.id === sel.id));
  if (btn.dataset.act === 'ban') ban(sel.ip);
  lastBarKey = '';
  renderClock = 0;
});

// ---- Sound -------------------------------------------------------------------------------

function alertSound() {
  audio.tone({ wave: 'pulse25', freq: 988, freqEnd: 740, dur: 0.12, vol: 0.2 });
  audio.tone({ wave: 'pulse25', freq: 988, freqEnd: 740, dur: 0.12, vol: 0.2, at: 0.15 });
}

function sfx(name) {
  const n = noteFreq;
  switch (name) {
    case 'select':
      audio.sfx('move');
      break;
    case 'kill':
      audio.tone({ wave: 'pulse12', freq: 1400, freqEnd: 180, dur: 0.16, vol: 0.2 });
      audio.noise({ dur: 0.08, vol: 0.12, rate: 1.2 });
      break;
    case 'ban':
      audio.tone({ wave: 'triangle', freq: 150, freqEnd: 50, dur: 0.16, vol: 0.4 });
      audio.noise({ dur: 0.12, vol: 0.25, rate: 0.3 });
      break;
    case 'scan':
      audio.tone({ wave: 'pulse25', freq: n('C5'), dur: 0.06, vol: 0.15 });
      audio.tone({ wave: 'pulse25', freq: n('G5'), dur: 0.06, vol: 0.15, at: 0.07 });
      break;
    case 'clean':
      ['C6', 'E6', 'G6', 'C7'].forEach((note, i) => audio.tone({ wave: 'pulse25', freq: n(note), dur: 0.07, vol: 0.16, at: i * 0.06 }));
      break;
    case 'wrong':
      audio.tone({ wave: 'pulse50', freq: 130, dur: 0.12, vol: 0.22 });
      audio.tone({ wave: 'pulse50', freq: 110, dur: 0.18, vol: 0.22, at: 0.14 });
      break;
    case 'warn':
      audio.tone({ wave: 'pulse12', freq: n('A5'), dur: 0.05, vol: 0.14 });
      break;
    default:
      break;
  }
}

// Driving minor-key loop.
const SONG = {
  bpm: 126,
  stepsPerBeat: 4,
  wave1: 'pulse25',
  wave2: 'pulse12',
  vol1: 0.07,
  vol2: 0.045,
  tracks: {
    p1: `E5 - . E5 G5 - E5 . B5 - A5 - G5 - F#5 -
         E5 - . E5 G5 - B5 . C6 - B5 - A5 - - -
         D5 - . D5 F#5 - D5 . A5 - G5 - F#5 - E5 -
         D5 - . D5 F#5 - A5 . B5 - - - . . . .`,
    p2: `B4 . B4 . B4 . B4 . B4 . B4 . B4 . B4 .
         C5 . C5 . C5 . C5 . C5 . C5 . C5 . C5 .
         A4 . A4 . A4 . A4 . A4 . A4 . A4 . A4 .
         B4 . B4 . B4 . B4 . D#5 . D#5 . D#5 . D#5 .`,
    tri: `E2 - E3 - E2 - E3 - E2 - E3 - E2 - E3 -
          C2 - C3 - C2 - C3 - C2 - C3 - C2 - C3 -
          D2 - D3 - D2 - D3 - D2 - D3 - D2 - D3 -
          B1 - B2 - B1 - B2 - B1 - B2 - D#2 - D#3 -`,
    noise: `k . h . s . h h k . h k s . h .`,
  },
};

// ---- Flow ----------------------------------------------------------------------------------

function showStart() {
  const rec = getRecord(GAME_ID);
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h1>Containment</h1>
    <p>Enemy hackers are hitting the planetary shield's server. Keep it alive for <b>${fmt(FLEET_TIME)}</b> until the fleet returns, then keep going in overtime for a high score. <b style="color:var(--red)">If memory fills up, the shield is breached.</b></p>
    <ul class="tools">
      <li><b>Kill</b> a process: frees its CPU and memory, but a virus restarts in ${KILL_RESPAWN}s. Killing a real system process causes trouble.</li>
      <li><b>Antivirus</b>: removes a whole infection for good. Needs ${AV.mem} memory blocks and runs slowly when the CPU is maxed.</li>
      <li><b>Ban</b>: tap a log line to ban its source. Floods come from sources that show up far too often. Hold the log to pause it.</li>
    </ul>
    <ul class="star-goals"></ul>
    <div class="best"></div>
    <div class="actions"><button class="paper-btn primary" type="button">Start</button></div>`;
  const goals = card.querySelector('.star-goals');
  STAR_TIMES.forEach((t, i) => {
    const li = document.createElement('li');
    li.append(renderStars(i + 1, { mini: true }), t >= FLEET_TIME ? 'Hold until the fleet returns' : `Survive ${fmt(t)}`);
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
  state.phase = 'playing';
  procList.innerHTML = '';
  rowEls.clear();
  logEl.innerHTML = '';
  logQueue.length = 0;
  serverEl.classList.remove('breached');
  lastBarKey = '';
  renderClock = 0;
  overlay.hidden = true;
  log('[sys] shield server online. fleet ETA ' + fmt(FLEET_TIME), 'good');
  audio.playSong(SONG);
}

// The fleet is back: the run is a win. Offer overtime for a higher score.
function fleetReturned() {
  const s = state;
  s.phase = 'fleet';
  audio.stopSong();
  audio.sfx('win');
  log('[fleet] fleet docked. shield held!', 'good');
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Fleet returned!</h2>
    <div class="stars-slot"></div>
    <p>The shield held for <b>${fmt(FLEET_TIME)}</b>. Keep defending in <b>overtime</b> for a higher score? Attacks keep getting worse, and your score is however long you last.</p>
    <div class="actions">
      <button class="paper-btn primary" type="button" data-act="more">Keep defending</button>
      <button class="paper-btn" type="button" data-act="stop">Finish</button>
    </div>`;
  card.querySelector('.stars-slot').append(renderStars(STAR_TIMES.filter((t) => FLEET_TIME >= t).length));
  card.querySelector('[data-act="more"]').addEventListener('click', continueOvertime);
  card.querySelector('[data-act="stop"]').addEventListener('click', () => finish(true));
  overlay.appendChild(card);
  overlay.hidden = false;
}

function continueOvertime() {
  const s = state;
  if (s.phase !== 'fleet') return;
  audio.unlock();
  s.overtime = true;
  s.phase = 'playing';
  overlay.hidden = true;
  log('[fleet] overtime: hold the shield as long as you can', 'warn');
  audio.playSong({ ...SONG, bpm: SONG.bpm + 14 });
}

function finish(won) {
  const s = state;
  s.phase = 'done';
  audio.stopSong();
  const score = Math.floor(s.t);
  const stars = STAR_TIMES.filter((t) => score >= t).length;
  const { record, newHigh, newBestStars } = saveResult(GAME_ID, score, stars);
  if (!won) {
    serverEl.classList.add('breached');
    log('[!!!] MEMORY EXHAUSTED: SHIELD BREACH', 'warn');
    audio.noise({ dur: 1.0, vol: 0.4, rate: 0.6, rateEnd: 0.1 });
  }
  renderClock = 0;
  render(0);
  setTimeout(() => {
    audio.sfx(won ? 'win' : stars ? 'win' : 'lose');
    showResults(overlay, {
      title: won ? 'Fleet returned!' : s.overtime ? 'Overtime over!' : 'Shield breached!',
      scoreText: fmt(score),
      stars,
      newHigh,
      newBestStars,
      record,
      formatScore,
      note: won
        ? 'The shield held until the fleet got home.'
        : s.overtime
          ? `The fleet made it home, and you held on for +${fmt(score - FLEET_TIME)} of overtime.`
          : stars < 3
          ? `The fleet was ${fmt(FLEET_TIME - score)} away. ${stars ? `Next star at ${fmt(STAR_TIMES[stars])}.` : `Survive ${fmt(STAR_TIMES[0])} for a star.`}`
          : '',
      onRetry: start,
    });
  }, won ? 150 : 1300);
}

// ---- Loop ------------------------------------------------------------------------------------

state = newState();
render(0);
renderActionBar();
showStart();

if (new URLSearchParams(location.search).has('debug')) {
  window.containment = {
    get state() { return state; }, continueOvertime, ATTACKS, select, killProc, startAntivirus, ban, AV, MEM_BLOCKS, start,
    // Fast-forward the simulation (for balance testing): calls `each(state)`
    // every simulated `every` seconds so a script can play.
    sim(seconds, each = null, every = 0.5) {
      let acc = 0;
      for (let t = 0; t < seconds && state.phase === 'playing'; t += 0.05) {
        update(0.05);
        acc += 0.05;
        if (each && acc >= every) { acc = 0; each(state); }
      }
      return { t: +state.t.toFixed(1), phase: state.phase, mem: +state.memUsed.toFixed(1), cpu: Math.round(state.demand) };
    },
  };
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
