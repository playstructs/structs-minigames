# Last Line of Defense

A carnival-style shooting gallery. Raiders scroll past in their ambits; shoot
them down with the Planetary Defense Cannon before they get by.

## Spec

- **Score:** points for each struct shot down.
- **Lose:** planetary struct health (10) reaches zero. Every struct that
  scrolls off screen without being shot down does damage.
- Scroll speed and the number of targets go up over time.

| Target | Ambit | Size | Hits | Points | Damage if it escapes | Notes |
|---|---|---|---|---|---|---|
| Tank | Land | large | 3 | 10 | 1 | slow |
| Stealth Bomber | Air | medium | 3 | 20 | 1 | faster than tanks; pops up for ~1.4 s, then flips down (can't be hit while down) |
| Battleship | Space | small | 3 | 30 | 1 | faster than bombers |
| Cruiser | Water | largest | 12 | 100 | 3 | slowest, rare (one at a time), bobs on the waves |
| Command Ship | any | tiniest | 12 | 200 | 3 | rare, one at a time; pops up somewhere, holds still ~2 s, flips down, then moves to another ambit. Gets away after 5 pop-ups |

Rows scroll in alternating directions: space →, air ←, land →, water ←.

## Controls

- Tap or click to fire. Hold to keep firing (5 shots/s); tapping is faster.
- Desktop: a crosshair follows the mouse; Space also fires at it.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Stars | 1★ 1600 · 2★ 2200 · 3★ 2800 points |
| Health | 10 |
| Speed ramp | ×(1 + t/180), max ×3.5 |
| Spawn ramp | ×(1 + t/120), no cap |
| Starting spawn gaps | tank ~6 s, bomber ~7 s, battleship ~6.5 s (randomised) |
| Cruiser | first at 0:22, then 22–34 s after the last one is gone |
| Command Ship | first at 0:50, then 18–28 s after the last one is gone |

Balance was checked with scripted bots that aim with some error, tap at a fixed
rate, and pause before switching to a new target (8 runs each):

| Bot | Taps every | Aim error | Switch delay | Survival | Average score |
|---|---|---|---|---|---|
| Sharp | 0.11 s | 5 | 0.3 s | 2:22–3:12 | 3379 (3★) |
| Average | 0.15 s | 7 | 0.45 s | ~1:05 | 763 (0★) |
| Sloppy | 0.2 s | 9 | 0.65 s | ~0:40 | 140 (0★) |

Stealth Bombers and Battleships are what get past most often.

## Art

Paper-prototype cutouts on sticks, drawn in code. Targets scale up a little
when the rows are tall (phones in portrait). On wide screens the gallery stays
400 units wide inside a cardboard booth, so every screen gets the same travel
distance.

`?debug` exposes `window.gallery`, including `sim(seconds, act, every)` to
fast-forward a run for balance testing.
