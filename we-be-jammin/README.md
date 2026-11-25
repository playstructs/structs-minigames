# We Be Jammin'

Your Jamming Satellite orbits the planet. Time it to meet the enemy's smart
missiles and jam them before they hit your structs. It's an endless survival
game.

## Spec

- **No win:** new enemy structs keep warping in, more and more often, and
  enemies fire faster over time. Your fleet fires back on its own.
- **Lose:** all of your structs are destroyed.
- **Score:** time survived.
- The satellite is on a fixed orbit and always travels clockwise at a default
  speed. You can only speed it up or slow it down. When you let go, it
  gradually eases back to the default speed.
- Missile travel time depends on the distance and the ambit gap between the two
  structs.
- Several missiles are in the air at once, so you have to pick which to
  intercept first.

Each side has one each of: Battleship and Starfighter (space), Pursuit Fighter
and Stealth Bomber (air), Tank and Artillery (land), Cruiser and Destroyer
(water). They sit in eight pairs spread evenly around the planet, 45° apart
and alternating (yours, theirs, yours, theirs...). Each pair is one surface
struct and one orbiting one, so icons don't overlap. Every enemy starts at
least ~33° from your structs. Reinforcements warp in at least 31° from any of
your living structs when there's room. This keeps every missile's flight long
enough to intercept.

**Interceptor** (air): a rare enemy that only arrives as a reinforcement, from
0:45 on (15% of reinforcements, at most 2 alive at once). Its missiles fly
twice as fast. It has a spiky yellow crown around its icon, and its missiles
are longer, with a dark nose, speed lines and a denser trail.

Both fleets fire on their own. Jamming is manual: tap to send a jamming pulse
(radius 88) around the satellite. From the orbit, it just dips into the
planet's edge. It jams every enemy missile inside it for
0.2 s. If it caught at least one missile it recharges in 1 s. If it caught
nothing, it recharges in 3 s and shows "MISSED", so mashing doesn't pay.
Both recharge times grow by 0.2 s for each of your structs destroyed (shown
as "+0.2s recharge" by the satellite), so losses snowball. Only
enemy missiles can be jammed, at any point in their flight.

## Controls

- Touch or mouse: **drag right** to speed up, **drag left** to slow down. This
  is relative to the screen, not to the satellite's heading. Dragging 70 world
  units sideways gets full speed. **Tap** (a press that moves less than 8 px)
  to jam. While dragging, a second finger jams.
- Keyboard: D to speed up, A to slow down, Space (or J) to jam.

## Visuals

- Structs are round icon tokens: blue for yours, red for the enemy. The ring
  around each token is its health. A destroyed enemy's icon fades out after
  10 s; yours stay crossed out.
- The satellite's orbit is a dotted ring with chevrons pointing clockwise. A
  jet puffs out the back when speeding up and out the front when slowing. A
  horizontal dashed line shows your drag. The gauge under the roster shows the current
  speed, with a tick at the default.
- Missiles are small rectangles with a dotted line showing the path flown so
  far. Enemy missiles and their trails turn from amber to deep red as they
  close on their target. Past a third of the way, they grow a glow that gets
  bigger and throbs faster. A red dashed ring marks one of your structs with a
  missile coming for it.
- The yellow dashed circle around the satellite is the jamming range. It fades
  while recharging, and a yellow arc fills back up around the satellite.
- Under the planet: your fleet's roster and how many enemy structs you've
  destroyed.

## Music

A frantic ska-reggae loop (Am, D, G, Em) that keeps playing without
restarting while it changes:

- **Tempo:** starts at 104 bpm and rises every 4 s by about 0.45 bpm a second
  (around 140 at 1:20), capping at 176 by about 2:40.
- **Layers:** every 40 s it gets busier:
  - 0:00: driving drums and offbeat chops.
  - 0:40: busier hats, doubled-up chops and a pumping bass.
  - 1:20: an arpeggiating skank, and the lead breaks into 16th-note runs.
  - 2:00: flat-out snare-heavy drums.

This uses `audio.updateSong(song)` in `shared/audio.js`, which swaps a playing
song's tempo and parts in place.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Stars | 1★ survive 1:45 · 2★ survive 2:30 · 3★ survive 3:45 |
| Health | your structs 3, enemy structs 3 (1 damage per missile) |
| Missile time | (2.0 s + path length ÷ 27.5 + 1.4 s per ambit between them) ÷ 1.25; enemy missiles ×1.5 |
| Jamming | radius 88 (just reaches the planet from the orbit), active 0.2 s, recharge 1 s (3 s after a pulse that jams nothing), +0.2 s to both per struct of yours destroyed |
| Satellite | orbit radius 180, default speed 60, range 20–220; changes at 160/s² while steering, eases back at 45/s² |
| Your fire | every 12–17 s per struct |
| Enemy fire | every 10–15 s per struct, ÷ (1 + t/60) |
| Reinforcements | first at 0:08, then every 10 s, shrinking to every 2 s by 2:00; at most 30 enemies alive |
| Interceptor | from 0:45, 15% of reinforcements, max 2 alive, missiles ×2 speed |

Balance was checked with scripted bots that know every missile's path, pick
the missile that will land first among those they can still meet, set their
speed to meet it, and pulse when a missile is in range. They vary in how soon
they react, how much of the range they trust, how late they tap, and how
noisy their speed control is. There's also a masher that holds full speed and
pulses whenever it can (2–4 runs each):

| Bot | Reacts after | Taps at | Taps when | Survival |
|---|---|---|---|---|
| Idle | — | — | never | 0:50–0:53 |
| Sloppy | 1.2 s | 65% of range | 0.4 s late | 1:07–1:40 |
| Average | 0.6 s | 75% of range | 0.2 s late | 2:05–2:19 |
| Masher | — | always | whenever ready | 2:06–2:54 |
| Sharp | 0.2 s | 85% of range | at once | 3:08–4:31 |

**Mashing:** holding full speed and pulsing nonstop does about as well as the
average bot, but clearly worse than the sharp one. Two things narrowed the
gap. At radius 88 the masher dropped to about 4 minutes, down from 7:37–12:54
at 104. The extra recharge per lost struct then cut it to under 3 minutes.

`?debug` exposes `window.jammin`, including `sim(seconds, act, every)` to
fast-forward a run for balance testing (`act` sets
`state.input = { throttle: -1..1, jam }`) and `tune({...})` to change the
jam radius, speed range, miss recharge, enemy missile slowdown and ramps at
runtime.
