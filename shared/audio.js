// NES-style sound, synthesized with the Web Audio API (no audio files).
// Mirrors the NES sound chip: two pulse channels (12.5/25/50% duty),
// a triangle channel, and a noise channel.
//
// Browsers (especially on phones) only allow sound after a user gesture,
// so call audio.unlock() from a tap/click/keydown handler.

import { getSetting, setSetting } from './storage.js';

const NOTE_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

export function noteFreq(name) {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!m) return null;
  const midi = NOTE_INDEX[m[1]] + (Number(m[2]) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const parseSteps = (s) => (s || '').trim().split(/\s+/).filter(Boolean);
const parseTracks = (song) => ({
  p1: parseSteps(song.tracks.p1),
  p2: parseSteps(song.tracks.p2),
  tri: parseSteps(song.tracks.tri),
  noise: parseSteps(song.tracks.noise),
});
const stepDurOf = (song) => 60 / song.bpm / (song.stepsPerBeat || 4);

class NesAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.waves = {};
    this.noiseBuffer = null;
    this.muted = getSetting('muted', false);
    this.song = null;
    this.listeners = new Set();
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      for (const duty of [0.125, 0.25, 0.5]) this.waves[duty] = this.makePulse(duty);
      this.noiseBuffer = this.makeNoise();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.ctx.suspend();
        else this.ctx.resume();
      });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMuted(muted) {
    this.muted = muted;
    setSetting('muted', muted);
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.01);
    this.listeners.forEach((fn) => fn(muted));
  }

  onMuteChange(fn) {
    this.listeners.add(fn);
  }

  makePulse(duty) {
    const n = 64;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      real[k] = Math.sin(2 * Math.PI * k * duty) / (Math.PI * k);
      imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k);
    }
    return this.ctx.createPeriodicWave(real, imag);
  }

  // 15-bit LFSR noise like the NES, sampled into a 1-second buffer.
  makeNoise() {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate, rate);
    const data = buf.getChannelData(0);
    let lfsr = 1;
    const stepEvery = 2; // hold each LFSR output for a couple of samples
    let out = 1;
    for (let i = 0; i < rate; i++) {
      if (i % stepEvery === 0) {
        const bit = (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = (lfsr >> 1) | (bit << 14);
        out = lfsr & 1 ? 1 : -1;
      }
      data[i] = out;
    }
    return buf;
  }

  // One note on a pulse or triangle channel.
  // wave: 'pulse12' | 'pulse25' | 'pulse50' | 'triangle'
  tone({ wave = 'pulse50', freq = 440, freqEnd = null, dur = 0.12, vol = 0.3, at = 0, decay = true, vibrato = 0 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    if (wave === 'triangle') osc.type = 'triangle';
    else osc.setPeriodicWave(this.waves[{ pulse12: 0.125, pulse25: 0.25, pulse50: 0.5 }[wave] ?? 0.5]);
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), t + dur);
    if (vibrato) {
      const lfo = this.ctx.createOscillator();
      const depth = this.ctx.createGain();
      lfo.frequency.value = 6;
      depth.gain.value = freq * vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.02);
    }
    const g = this.ctx.createGain();
    const level = wave === 'triangle' ? vol * 1.6 : vol;
    g.gain.setValueAtTime(level, t);
    if (decay) g.gain.linearRampToValueAtTime(level * 0.25, t + dur);
    g.gain.setValueAtTime(decay ? level * 0.25 : level, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.015);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  // A burst on the noise channel. rate < 1 is lower/rumblier, > 1 is hissier.
  noise({ dur = 0.15, vol = 0.3, rate = 1, rateEnd = null, at = 0 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.setValueAtTime(rate, t);
    if (rateEnd) src.playbackRate.exponentialRampToValueAtTime(rateEnd, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  // Common sound effects shared by every game.
  sfx(name) {
    const n = noteFreq;
    switch (name) {
      case 'select':
        this.tone({ wave: 'pulse25', freq: n('E5'), dur: 0.05, vol: 0.2 });
        this.tone({ wave: 'pulse25', freq: n('A5'), dur: 0.08, vol: 0.2, at: 0.05 });
        break;
      case 'move':
        this.tone({ wave: 'pulse12', freq: n('C6'), dur: 0.035, vol: 0.15 });
        break;
      case 'start':
        ['C5', 'E5', 'G5', 'C6'].forEach((note, i) =>
          this.tone({ wave: 'pulse50', freq: n(note), dur: 0.07, vol: 0.22, at: i * 0.07 }));
        break;
      case 'count':
        this.tone({ wave: 'pulse25', freq: n('A4'), dur: 0.12, vol: 0.25 });
        break;
      case 'go':
        this.tone({ wave: 'pulse25', freq: n('A5'), dur: 0.3, vol: 0.25 });
        break;
      case 'bump':
        this.tone({ wave: 'triangle', freq: 140, freqEnd: 60, dur: 0.1, vol: 0.35 });
        this.noise({ dur: 0.06, vol: 0.15, rate: 0.3 });
        break;
      case 'explode':
        this.noise({ dur: 1.4, vol: 0.6, rate: 0.5, rateEnd: 0.05 });
        this.tone({ wave: 'triangle', freq: 120, freqEnd: 30, dur: 0.8, vol: 0.4 });
        break;
      case 'star':
        this.tone({ wave: 'pulse25', freq: n('E6'), dur: 0.06, vol: 0.2 });
        this.tone({ wave: 'pulse25', freq: n('B6'), dur: 0.14, vol: 0.2, at: 0.06 });
        break;
      case 'nostar':
        this.tone({ wave: 'pulse50', freq: n('E3'), dur: 0.12, vol: 0.15 });
        break;
      case 'win':
        ['G4', 'C5', 'E5', 'G5', 'E5', 'G5'].forEach((note, i) =>
          this.tone({ wave: 'pulse50', freq: n(note), dur: i === 5 ? 0.4 : 0.09, vol: 0.2, at: i * 0.1 }));
        break;
      case 'lose':
        ['G4', 'F#4', 'F4', 'E4'].forEach((note, i) =>
          this.tone({ wave: 'pulse50', freq: n(note), dur: i === 3 ? 0.5 : 0.18, vol: 0.2, at: i * 0.2, vibrato: i === 3 ? 0.02 : 0 }));
        break;
      case 'tick':
        this.tone({ wave: 'pulse12', freq: n('B5'), dur: 0.04, vol: 0.12 });
        break;
      default:
        break;
    }
  }

  // ---- Music --------------------------------------------------------------
  // song = { bpm, stepsPerBeat, tracks: { p1, p2, tri, noise }, wave1, wave2 }
  // Pitched tracks are space-separated steps: a note ("C5"), "-" to hold the
  // previous note, or "." for silence. Noise steps: "k" kick, "s" snare,
  // "h" hat, "." silence. Tracks loop independently at their own length.
  playSong(song) {
    this.stopSong();
    if (!this.ctx) return;
    const state = { song, tracks: parseTracks(song), stepDur: stepDurOf(song), step: 0, nextTime: this.ctx.currentTime + 0.05, timer: null };
    const schedule = () => {
      while (state.nextTime < this.ctx.currentTime + 0.15) {
        this.scheduleStep(state, state.step, state.nextTime - this.ctx.currentTime);
        state.step++;
        state.nextTime += state.stepDur;
      }
      state.timer = setTimeout(schedule, 30);
    };
    this.song = state;
    schedule();
  }

  // Swap the playing song's tempo and parts without restarting it, so the
  // beat carries on (e.g. to speed up as a game goes on). Starts it if
  // nothing is playing.
  updateSong(song) {
    if (!this.song) {
      this.playSong(song);
      return;
    }
    this.song.song = song;
    this.song.tracks = parseTracks(song);
    this.song.stepDur = stepDurOf(song);
  }

  scheduleStep(state, step, at) {
    const { tracks, stepDur, song } = state;
    const pitched = [
      ['p1', song.wave1 || 'pulse50', song.vol1 ?? 0.09],
      ['p2', song.wave2 || 'pulse25', song.vol2 ?? 0.06],
      ['tri', 'triangle', song.volTri ?? 0.1],
    ];
    for (const [key, wave, vol] of pitched) {
      const t = tracks[key];
      if (!t.length) continue;
      const token = t[step % t.length];
      if (token === '-' || token === '.') continue;
      let len = 1;
      while (t[(step + len) % t.length] === '-' && len < t.length) len++;
      const freq = noteFreq(token);
      if (freq) this.tone({ wave, freq, dur: stepDur * len * 0.92, vol, at: Math.max(at, 0), decay: wave !== 'triangle' });
    }
    const nt = tracks.noise;
    if (nt.length) {
      const token = nt[step % nt.length];
      const v = song.volNoise ?? 0.12;
      if (token === 'k') this.noise({ dur: 0.08, vol: v * 1.3, rate: 0.12, at: Math.max(at, 0) });
      else if (token === 's') this.noise({ dur: 0.1, vol: v, rate: 0.6, at: Math.max(at, 0) });
      else if (token === 'h') this.noise({ dur: 0.03, vol: v * 0.5, rate: 1.4, at: Math.max(at, 0) });
    }
  }

  stopSong() {
    if (this.song) clearTimeout(this.song.timer);
    this.song = null;
  }
}

export const audio = new NesAudio();
