# Mine Blaster

Calibrate the extraction laser: lock the drifting mineshaft segments into
line so the beam reaches the ore at the bottom without touching the sides.

## Spec

- **Goal:** lock every segment of the shaft so the gap through each one
  covers the beam, then fire through to the ore.
- **Clock:** starts at 1:30. Every clean blast adds 5 s. When it runs out
  the game ends. A beam that's already firing still lands.
- **Score:**

  | Event | Points | Clock |
  |---|---|---|
  | Clean blast | +100 × streak multiplier | +5 s |
  | Beam hits a side | −50 (score never drops below 0) | |
  | Reset | free | |

  Each clean blast in a row raises the multiplier for the next one: ×1, ×2,
  ×3, then ×4 at most. Hitting a side resets it to ×1. Resetting keeps it.
- **Getting harder:**
  - Every clean blast makes the next shaft faster (+7% sweep speed).
  - Shafts get longer: 4 segments, plus one every 3 clean blasts, up to 8.
  - New movement patterns join the mix:
    - smooth sine sweeps from the start;
    - constant-speed bounces from the 3rd shaft;
    - lurching sweeps that speed up and slow down mid-swing from the 6th.
  - Everything also speeds up as the clock runs: +1% per 1.5 s played.
  - The beam width changes every shaft to balance it: 14–26 wide, minus 2.5
    for each segment over 4, never under 8. The gaps are always 64 wide.

### How it works

- **Segments:** each one slides side to side with its own speed, pattern,
  direction and starting point. The next one to lock is outlined in yellow
  with arrows either side. Lock them top to bottom.
- **Locking:** a locked segment freezes and gets clamp bolts. The edges of
  its gap turn green if they clear the beam, red if they'd clip it, so you
  know straight away when a lock-in is bad.
- **Firing:** locking the last segment charges the laser, then fires it.
  - Clean: the ore blows up, you score, and a new shaft arrives.
  - Hit: the beam stops at the first segment it touches. You lose points and
    your streak, and the same shaft restarts from its starting positions.
- **Reset:** after a bad lock-in, Reset unlocks the shaft and restarts it from
  its starting positions. It costs no points and keeps your streak, but the
  clock keeps running.
- **Beam guide:** a red tint and dashed lines show exactly where the beam
  will go, at its real width.

## Controls

- Touch or mouse: **tap** anywhere on the shaft or press **Lock** to lock the
  next segment. **Reset** restarts the current shaft.
- Keyboard: Space (or ↓ / S) to lock, R (or Backspace) to reset.

## Visuals

Paper-prototype doodles drawn in code:
- A laser drill rig on a tripod over the mouth of the shaft. Its nozzle is as
  wide as the beam, and its lamp is yellow while aiming, red while firing,
  green after a clean blast.
- Hatched rock segments. Purple ripples run through the ones still drifting
  (the gravitational distortion).
- An ore pocket of crystals at the bottom with a target mark. A clean blast
  sends out a shockwave and shatters the crystals near the beam.
- Labels show the shaft number, segments locked, beam width and the next
  multiplier.

## Music

A mine-cart loop that speeds up from 112 to 150 BPM over the first 2:15. The drums
double up after halftime.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Stars | 1★ 1000 · 2★ 2500 · 3★ 4000 points |
| Clock | starts at 90 s; +5 s per clean blast |
| Segments | 4, +1 every 3 clean blasts, up to 8 |
| Sweep speed | 0.22–0.42 sweeps/s × (1 + 0.07 × clean blasts) × (1 + t / 150) |
| Swing | 70–125 either side of the middle |
| Gap / beam | gap 64; beam 14–26 − 2.5 per extra segment, at least 8 |
| Patterns | sine from 0, bounce from 2, lurch from 5 clean blasts |

Balance was checked with scripted bots (20 runs each). They tap when the
next segment will be centred, with a reaction delay and a random timing
error. Some reset straight away after a bad lock. They always know exactly
when a segment will line up, so real players will do a bit worse than the
same-paced bot.

| Bot | Timing error | Resets bad locks | Median score | Range | Lasted (median) |
|---|---|---|---|---|---|
| Perfect | 0 | — | 14900 | 14100–15900 | 5:05 |
| Good | ±35 ms | yes | 5800 | 4200–7500 | 3:00 |
| Casual | ±50 ms | yes | 3850 | 1850–5400 | 2:35 |
| Casual | ±50 ms | no | 1400 | 450–2400 | 2:20 |
| New player | ±80 ms | yes | 1600 | 650–4000 | 2:05 |
| New player | ±80 ms | no | 0 | 0–850 | 1:50 |

The +5 s per blast can't make a run endless: segments keep speeding up with
the time played, so even the perfect bot starts missing after about 4½
minutes.

Resetting bad lock-ins matters a lot: it's free and it protects the
multiplier.

`?debug` exposes `window.mine`:
- `sim(seconds, act)` fast-forwards a run. `act(state)` runs every frame and
  sets `state.input.lock` / `state.input.reset`.
- `makeBot({ sigma, react, resetBad })` builds the balance bot.
- `stars`, `roundTime`, `speed = [min, max]`, `speedPerLevel`, `timeRamp`,
  `segBase` and `segEvery` change the tuning.
