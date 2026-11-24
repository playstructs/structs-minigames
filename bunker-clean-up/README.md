# Bunker Clean-Up

Clean the bunker floor without bumping into the Alpha Ore.

## Spec

- **Score:** % of dirty floor cleaned before the timer runs out.
- **Lose:** the bot hits Alpha Ore a third time and it explodes (two knocks are survivable).
- The faster the bot goes, the wider it cleans.
- The bot is rectangular, has momentum, and turns in wide arcs.
- Ore sits in cylinders (circles, top-down) and only appears in ore storage rooms.
- There must be room for the bot to drive around every cylinder.
- The map is bigger than the screen, so you have to search for dirty floor.
- Hallways start clean.

## Map

The layout is traced from `map-design.png` (1482 × 1026 px). In `map.js` the
coordinates are in those design pixels and get scaled by `SCALE` (0.63) into
world units. Each room is a polygon; its edges are walls except where they lie
on the outer border or are marked as entrances.

`buildMap()` checks every cylinder: it has to be inside a room and leave at
least `ORE_CLEARANCE` (44 units: bot width 28 + margin) to every wall, doorway and
other cylinder. Problems are logged to the browser console.

| Room | Cylinders |
|---|---|
| Ore Storage A | 1 |
| Ore Storage B | 0 (too narrow for a cylinder with clearance) |
| Ore Storage C | 2 |
| Ore Storage D | 9 |
| Ore Storage E | 1 |

Small changes from the drawing so the bot fits: room B's right wall sits a little
further left (wider corridor beside it), and room E's whole short wall is its
doorway.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Time limit | 1:30 |
| Stars | 1★ 60% · 2★ 75% · 3★ 90% (estimates, need real play) |
| Ore knocks | 2 allowed (bot bounces off, cylinder cracks, 1 s grace); the 3rd explodes |
| Explosion | Run scores 0% and 0 stars |
| Cleaning width | Bot footprint when slow; up to a 32-radius circle (64 wide) at top speed |
| Bot | 38×28, top speed 172, reverse 90, turn radius 47 at speed, turns on the spot when stopped |
| Narrowest doorway | 54 units (room E, ≈1.9 bot widths) |
| View | ~200,000 sq units visible on any screen |

- Floor under a cylinder or a wall doesn't count toward the total.
- Walls never trap the bot: it slides along them, and a hard hit bounces it back a little (no penalty).
- Controls (touch): drag anywhere and point where you want to go. Moving, the bot keeps
  driving and arcs toward the stick (pointing straight back swings it round); drag
  distance sets speed. Stopped, it turns on the spot first. If walls block a
  turn on the spot, it backs out on its own for 0.4 s, then turns.
  Keyboard: arrows / WASD (up = drive, down = reverse, left/right = steer or turn on the spot).
- Add `?debug` to the URL to expose `window.bunker` in the console.
