# Reconnet

Plug loose wires back into their matching sockets before time runs out. Your
bot is awkward, the wires are stiff, and the floor is full of things you
really don't want to touch.

## Spec

- **Goal:** reconnect as many wires as you can before time runs out.
- **Score:** number of wires reconnected.
- **Lose:** your bot or a loose wire touches a hazard. You keep the wires
  you've already reconnected.
- **Time:** 90 s. Clearing a board adds 10 s and brings a new, busier board.

| Board | Wires | Tears | Holes | Crates |
|---|---|---|---|---|
| 1 | 3 | 2 | 1 | 3 |
| 2 | 4 | up to 3 | up to 2 | up to 4 |
| 3 | 5 | up to 4 | up to 3 | up to 4 |
| 4+ | 5 | up to 6 | up to 4 | up to 6 |

On busy boards a hazard or crate is left out when there's no safe spot for it.

### Challenges

- **Awkward bot:** a tall, narrow arm (14 × 34 units) that never rotates,
  with its claw at the bottom. It can only move and grab or let go. Its body
  bumps into walls and crates, so the claw can't get right up against the top
  wall.
- **Grab anywhere:** the Grab button grabs the wire point nearest the claw, within a
  16-unit reach. Where loops of a coil overlap, it grabs the loop closest to
  the plug.
- **Stiff, fixed-length wires:** each wire is a chain of 8-unit segments that
  never stretch and bend at most 34° per segment. Each starts with a short
  straight lead out from its wall anchor (7 segments), then a loose coil
  (about 20-unit radius), then 16 segments of slack in a small S out to the
  plug. Starting wires never leave the floor, and crates stay 22 units clear
  of them. Only the wire you're holding moves;
  loose wires lie still. Pulling straightens coils. When a wire is at full
  stretch, the bot just can't move further that way: it slides along
  whichever direction still has slack, or stays put. A held wire never drags
  the bot around. Parts of a dragged wire move at most
  220 units/s, so wires don't whip around.
- **Fixed anchor, matching socket:** one end is fixed to a wall anchor. The
  plug only snaps into the floor socket with the same colour and symbol
  (circle, square, triangle, diamond, star), within 12 units. A wire is about
  1.25 × the anchor-to-socket distance plus 50.
- **Hazards:** random space-time tears and holes in the floor. They're kept
  clear of anchors, sockets, the starting wires, the bot's start and the straight line
  from each anchor to its socket.
- **Obstacles:** crates block the bot, and wires snag on them.

## Controls

- Touch or mouse: **drag** anywhere on the board to move the bot. The drag is
  relative, like a trackpad, and the bot follows at its own speed. Tapping
  the board does nothing else.
- **Grab / Release button** under the board: grabs the wire point nearest the
  claw, or lets go. It reacts the moment you press it, so you can steer with
  one finger and press it with another. It's grey when nothing is in reach,
  green when something is, and yellow (Release) while you're holding a wire.
- Keyboard: arrows or WASD to move, Space (or E) to grab or let go.

## Visuals

- Space-time tears: black orbs with a glowing, pulsing purple aura, swirling
  sparks and a crack of light. Only the black orb is deadly; the aura is a
  warning.
- Holes: jagged dark pits with cracked rims.
- Crates: hatched cardboard boxes with an X.
- Wires: thick coloured marker lines from a grey wall anchor with a colour
  stripe, ending in a white plug marked with its symbol.
- Sockets: white floor plates showing the symbol. The matching socket pulses
  while you hold its wire, and fills in once it's connected.
- The bot: a blue-grey upright arm with wheels on its sides, a face at the
  top and a claw at the bottom that opens and closes. A dashed ring shows its reach; it turns green and circles the point
  Grab would take. The bot shakes and its light turns red when a wire is
  pulled tight.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Stars | 1★ 3 wires · 2★ 6 wires · 3★ 9 wires (provisional) |
| Time | 90 s, +10 s per board cleared |
| Bot | 150 units/s, reach 16 |
| Wire | 8-unit segments, bend ≤ 0.6 rad, length 1.25 × distance + 50, snap 12 |
| Board | 400 × 560 units |

Balance was checked with a scripted bot that grabs the reachable point
closest to a plug, drags it straight at the socket, and re-grabs further
along when it's pulled tight. It steers its body around hazards but pays no
attention to where the trailing wire goes. That's the main skill here, so it
mostly dies by dragging a wire through a tear. Its best runs cleared the
first board (3 wires) in about 30 s, and typical runs got 0–2. A person who
watches the wire should do much better, so treat the star thresholds as a
guess until someone has played it.

`?debug` exposes `window.reconnet`:
- `board(n)` jumps to board n.
- `sim(seconds, act, every)` fast-forwards a run (`act` sets
  `state.input = { x, y, grab }`).
- `autoplay(act)` drives the live game with a bot.
