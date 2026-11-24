// Shared DOM pieces for game pages: top bar (back + mute), stars and the
// results card.

import { audio } from './audio.js';
import { rng } from './paper.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// A five-point star with slightly uneven points so it looks hand-drawn.
export function starSvg(seed = 1) {
  const r = rng(seed * 97 + 13);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = (i % 2 === 0 ? 22 : 9.5) + (r() - 0.5) * 2.2;
    pts.push(`${(25 + Math.cos(a) * rad).toFixed(1)},${(26 + Math.sin(a) * rad).toFixed(1)}`);
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 50 50');
  svg.setAttribute('class', 'star');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M${pts.join(' L')} Z`);
  svg.appendChild(path);
  return svg;
}

export function renderStars(count, { mini = false, label = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = mini ? 'stars mini' : 'stars';
  if (label) {
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `${count} of 3 stars`);
  }
  for (let i = 0; i < 3; i++) {
    const s = starSvg(i + 1);
    if (i < count) s.classList.add('on');
    wrap.appendChild(s);
  }
  return wrap;
}

const ICONS = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 L8 12 L15 19"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9 H8 L13 5 V19 L8 15 H4 Z"/><path d="M16.5 9 Q18.5 12 16.5 15"/><path d="M19 6.5 Q23 12 19 17.5"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9 H8 L13 5 V19 L8 15 H4 Z"/><path d="M17 9.5 L22 14.5 M22 9.5 L17 14.5"/></svg>',
};

// Back-to-cabinet link and a mute toggle. `extra` is placed in the middle.
export function mountTopBar(shell, { backHref = '../', extra = null } = {}) {
  const bar = document.createElement('div');
  bar.className = 'top-bar';

  const back = document.createElement('a');
  back.className = 'paper-btn small';
  back.href = backHref;
  back.innerHTML = `${ICONS.back}<span>Cabinet</span>`;

  const mute = document.createElement('button');
  mute.className = 'paper-btn icon';
  mute.type = 'button';
  const paint = () => {
    mute.innerHTML = audio.muted ? ICONS.muted : ICONS.sound;
    mute.setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  };
  paint();
  mute.addEventListener('click', () => {
    audio.unlock();
    audio.setMuted(!audio.muted);
  });
  audio.onMuteChange(paint);

  bar.append(back);
  if (extra) bar.append(extra);
  bar.append(mute);
  shell.appendChild(bar);
  return bar;
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// Fills in the results card and animates the stars one at a time.
// opts: { title, scoreText, stars, newHigh, newBestStars, record, scoreLabel,
//         formatScore, note, onRetry }
export async function showResults(overlay, opts) {
  const { title, scoreText, stars, newHigh, newBestStars, record, formatScore, note, onRetry } = opts;
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';

  const h = document.createElement('h2');
  h.textContent = title;
  card.appendChild(h);

  const starRow = renderStars(0);
  starRow.setAttribute('aria-label', `${stars} of 3 stars`);
  card.appendChild(starRow);

  const score = document.createElement('div');
  score.className = 'big-score';
  score.textContent = scoreText;
  if (newHigh) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = 'New best!';
    score.appendChild(b);
  }
  card.appendChild(score);

  if (note) {
    const p = document.createElement('p');
    p.textContent = note;
    card.appendChild(p);
  }

  const best = document.createElement('p');
  best.className = 'subtle';
  best.textContent = `High score: ${formatScore(record.highScore)}${newBestStars && stars > 0 ? ' · new star record!' : ''}`;
  card.appendChild(best);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const retry = document.createElement('button');
  retry.className = 'paper-btn primary';
  retry.type = 'button';
  retry.textContent = 'Play again';
  retry.addEventListener('click', () => {
    audio.unlock();
    onRetry();
  });
  const back = document.createElement('a');
  back.className = 'paper-btn';
  back.href = '../';
  back.textContent = 'Cabinet';
  actions.append(retry, back);
  card.appendChild(actions);

  overlay.appendChild(card);
  overlay.hidden = false;

  const starEls = starRow.querySelectorAll('.star');
  await wait(350);
  for (let i = 0; i < 3; i++) {
    if (i < stars) {
      starEls[i].classList.add('on', 'pop');
      audio.sfx('star');
    } else if (stars === 0 && i === 0) {
      audio.sfx('nostar');
    }
    await wait(330);
  }
}
