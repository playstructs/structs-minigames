# Machine Chemical Romance

Collect formulas from three refinery machines, mix them in the synthesizer,
and deliver each flask to the right machine before its request runs out.

## Spec

- **Goal:** collect formulas, synthesize chemicals and deliver them to the
  right machine.
- **Clock:** starts at 2:00. Good deliveries add time and mistakes take it
  away. The game ends when the clock runs out.
- **Score and time:**

  | Event | Points | Clock |
  |---|---|---|
  | Collect a formula (first visit to a machine with a new request) | +10 | |
  | A chemical finishes in the synthesizer | +25 | |
  | Deliver the right chemical | +100 | +10 s |
  | Request runs out | | −10 s |
  | Wrong formula, or a flask the machine doesn't need right now | | −10 s |

  There's no streak or multiplier: every right delivery is worth the same.
- **Getting harder:** request timers shrink the longer you last, by about
  0.55% of their starting length per second, but never below 25 s. Formulas
  grow by one symbol every 30 s: 3 symbols at first, then 4, 5, 6, 7, and 8
  from 2:30. Formulas longer than 5 symbols show on two rows in the request
  bubble.

### How it works

- **Machines:** the Crusher, the Smelter and the Centrifuge stand side by
  side across the top and collide as one solid wall, so there are no joins
  to get caught on. Along the row you're "at" whichever machine's column
  you're standing in. Each
  asks for its own chemical, one request at a time. A new request shows a **?** bubble
  with a countdown. Requests start at 22–45 s, a different length each
  time, and get shorter as you go. Walk up to the machine to see the formula:
  a string of symbols (circle, triangle, square, diamond, star). A machine
  asks again 3–7 s after a request is filled
  or missed.
- **Synthesizer:** stop at it and a panel opens at the bottom of the
  screen (walking past doesn't open it, but does grab a finished flask if
  your hands are free), with the machines still visible above so you can copy the formula.
  Pick the machine it's for, tap the symbols, then press Synthesize. Once
  it closes, for whatever reason, it stays closed until you step away and
  walk back up (or press Space).
  While the menu is open the worker can't move: close it with ✕ (or Esc), or
  wait for a finished flask to land in your hands, which closes it for you. It
  holds 2 orders, whether brewing or waiting on the rack. Each takes a fixed
  2.5 s to brew, however long the formula, one at a time.
  - If you're standing at the synthesizer with empty hands when a chemical
    finishes, it goes straight into your hands and the menu closes, so you can
    head off to deliver. If you've already started typing another formula, the
    menu stays open until you press Synthesize, then closes.
  - Otherwise it waits on the rack, and you pick it up automatically the next
    time you walk up with empty hands. When that happens the menu doesn't
    open, so you can head straight off to deliver. Step away and back if you
    want it.
- **Carrying:** you hold one flask at a time. A label above it shows the
  formula you mixed.
- **Delivering:** walk a flask up to the machine it was made for and it's
  delivered automatically. If you mixed the wrong formula, that still counts
  as a wrong delivery: the flask is used up and the request stays open.
  Walking past a different machine does nothing, so a flask can never go to
  the wrong machine. That drops the spec's wrong-machine penalty: there's no
  way to trigger it.
- **Waste bin:** stop at it and it automatically dumps whatever you're
  carrying, for free. Walking past it doesn't.

## Controls

- Touch or mouse: **tap** to walk there, or hold and drag to lead the worker.
  The worker walks around the synthesizer and bin on its own. Tapping on a
  machine, the synthesizer or the bin walks you up to it (machines from
  below).
  Everything else happens when you walk up: collecting formulas, opening the
  synthesizer, delivering to the right machine and dumping at the waste bin.
  There's no action button.
- Keyboard: arrows or WASD to walk, Space (or E) at the synthesizer to reopen
  it, Esc to close it. There are no keyboard shortcuts for entering formulas:
  on desktop you click the same buttons you tap on a phone, so neither
  device has an edge.

## Visuals

Paper-prototype doodles drawn in code:
- Three colour-coded machines. The Crusher has toothed rollers, the Smelter a
  furnace mouth and chimney, the Centrifuge a spinning drum.
- Each machine has a status light: grey when idle, yellow when it has a
  request, green when running. A machine shakes and puffs smoke while
  running, and sputters after a miss or a wrong formula.
- An ore belt runs behind the machines. Rocks turn into shiny bars as they
  pass a running machine.
- Request bubbles show a timer bar that goes green, then yellow, then red,
  and blink when under 8 s.
- The synthesizer has a bubbling tank and a rack of finished flasks.
- The worker wears a hard hat. Flasks are filled with their machine's
  colour.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Stars | 1★ 2000 · 2★ 2500 · 3★ 3000 points |
| Clock | starts at 120 s; +10 s per right delivery; −10 s per miss or wrong formula |
| Requests | max(25 s, 22–45 s × (1 − t/180)); next one 3–7 s later; first at 1.5 s, 5 s and 9 s |
| Formula length | 3 symbols, +1 every 30 s, up to 8 |
| Synthesizer | 2 slots, 2.5 s per brew |
| Walk speed | 300 units/s on a 400 × 480 floor |

Balance was checked with scripted bots that walk to the next job, type each
formula at a set pace and sometimes get a symbol wrong (15 runs each, 2.5 s brews). They
read formulas perfectly, so real people will be slower than the same-paced
bot. The stars are set from human-paced bots:

| Bot | Per symbol | Mistakes | Score | Lasted |
|---|---|---|---|---|
| New player | 1.6 s | 15% | 645–1125, average 865 | 1:34–2:18 |
| Casual | 1.3 s | 10% | 925–1800, average 1313 | 1:51–3:01 |
| Skilled (fetches formulas while brewing, dumps bad flasks) | 1.0 s | 6% | 1275–2185, average 1785 | 2:17–3:20 |

With these stars the bots rarely earn any: only the best skilled runs (up
to 2185) reach 1★. 2★ and 3★ are for players faster than 1.0 s per symbol
who rarely make mistakes

**Known issue:** with the 25 s floor on requests, a superhuman typist
(0.35 s per symbol) never runs out of time: it makes a delivery about every
6.5 s, and each one adds 10 s. At human pace the clock does run out.

`?debug` exposes `window.mcr`:
- `sim(seconds, act, every)` fast-forwards a run. `act` sets `state.input`:
  `{ tx, ty }` to walk, `synth: { formula, machine }`, `take` (finished
  flasks are also picked up automatically).
- `reqTime = [min, max]`, `reqShrink`, `reqFloor`, `reqMin`, `formulaStep`,
  `formulaMax` and `roundTime` change the request timers, the ramp and the
  starting clock.
