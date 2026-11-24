// Per-game player records in localStorage.
// Every access is wrapped in try/catch: private browsing or blocked storage
// must never break a game, it just means scores aren't remembered.

const PREFIX = 'structs-minigames:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const EMPTY = { highScore: null, recentScore: null, bestStars: 0, recentStars: null, plays: 0 };

export function getRecord(gameId) {
  return { ...EMPTY, ...read(`game:${gameId}`, {}) };
}

// Saves a finished run. Returns the updated record plus what improved.
export function saveResult(gameId, score, stars) {
  const prev = getRecord(gameId);
  const newHigh = prev.highScore == null || score > prev.highScore;
  const newBestStars = stars > prev.bestStars;
  const next = {
    highScore: newHigh ? score : prev.highScore,
    recentScore: score,
    bestStars: Math.max(prev.bestStars, stars),
    recentStars: stars,
    plays: prev.plays + 1,
  };
  write(`game:${gameId}`, next);
  return { record: next, newHigh, newBestStars };
}

export function getSetting(name, fallback) {
  return read(`setting:${name}`, fallback);
}

export function setSetting(name, value) {
  write(`setting:${name}`, value);
}
