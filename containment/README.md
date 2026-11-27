# Containment

The enemy launches cyber attacks against the planetary shield's server. Contain
and mitigate them until the fleet returns.

## Spec

- **Score:** how long you last (seconds survived).
- **Overtime:** when the fleet returns at 3:00 the run counts as a win (3 stars), and the
  player chooses **Keep defending** or **Finish**. In overtime attacks keep getting worse
  until the shield falls; the score is the total time survived.
- **Lose:** the server runs out of memory (shield breach).
- Attacks consume CPU and memory. When CPU demand passes 100%, everything is
  throttled and runs slower.
- More viruses and more memory used means less time until a breach.

| Attack | What it does | How to deal with it |
|---|---|---|
| DDoS | Floods the log from a few sources posing as crew; each adds CPU load and fills the log buffer (memory) | Spot sources that appear far too often, select one of their lines, then press **Ban** |
| Worm | Copies itself every ~8 s; each copy uses CPU and memory | **Antivirus** removes every copy; **Kill** buys time |
| Trojan | Named to look like a real process (`kerneI`, `nav-synk`, `comms-reIay`…); memory grows steadily | Watch for growing memory (↑) and near-miss names; **Antivirus** |
| CPU virus | Uses ~42% CPU, which throttles everything else (including Antivirus) | **Kill** it first, then Antivirus |

## Countermeasures

- Every countermeasure works the same way: select a process or log line, then
  press its button.
- **Kill** (Task Killer): frees the process's CPU and memory immediately, but a
  virus restarts 10 s later. Killing a real system process makes it restart with
  a CPU spike; `kernel` is protected.
- **Antivirus**: removes a whole infection permanently (all worm copies). Reserves
  4 memory blocks and 8% CPU while it runs. Speed depends on free CPU: ~4 s on an
  idle server, ~10× slower when the CPU is maxed. One scan at a time. Scanning a
  real program finds nothing (time wasted).
- **Ban** (Ban Hammer): blocks a log source. Select one of its lines first, then
  press Ban under the log or in the bottom bar. Banning a real crew member files a
  complaint and locks the hammer for 5 s.
- Kills and bans take longer when the CPU is throttled.

## Tuning (top of `game.js`)

| Setting | Value |
|---|---|
| Fleet returns | 3:00 (a win; then optional overtime) |
| Stars | 1★ 2:00 · 2★ 2:30 · 3★ 3:00 |
| Memory | 64 blocks; system processes start at 30 |
| Opening attacks | DDoS 0:04, worm 0:20, trojan 0:38, CPU virus 0:56 |
| Later attacks | random type, gap shrinking from ~15 s to 5 s; floods grow to 6 sources |
| Overtime ramp | intensity = 1 + (overtime seconds ÷ 90): worms copy faster (down to every 3.5 s), trojans grow faster, CPU viruses get heavier (up to 1.5×), floods up to 10 sources, gap between attacks drops toward 1.5 s |

Balance was checked with scripted bots that know which things are hostile and act
at a fixed rate (8 runs each):

| Bot | Acts every | Notices new attacks after | Average survival | Wins |
|---|---|---|---|---|
| Idle | — | — | 0:52 | 0/8 |
| Sharp | 0.8 s | instantly | 2:58 | 7/8 |
| Average | 2 s | 6 s | 2:49 | 3/8 |
| Sloppy | 3.5 s | 12 s | 2:22 | 0/8 |

In overtime the sharp bot lasted between +0:05 and +1:25 (6 runs), so overtime
always ends eventually.

Real players also have to identify the attackers, so expect results between
"average" and "sloppy" at first.

## UI

- Memory map: 64 blocks coloured by the owning process (viruses use the same
  colours, so colour doesn't reveal them). Tap a block to select its process.
  The top-right estimate shows time until breach at the current growth rate.
- Process list: newest first. Tap a row, then Kill or Antivirus in the bottom bar.
- Log: tap a line to select its source and highlight every line from it.
  Selecting doesn't ban anything: press Ban to block it. Two buttons sit under
  the log:
  - **Pause / Play** freezes the log so you can read it. The game keeps
    running; new lines queue up and appear when you press Play.
  - **Ban** bans the selected source and shows its address. It's greyed out
    until you pick a line, and shows the cooldown after banning a crew member.
    The same Ban is also in the bottom bar.
- `?debug` exposes `window.containment`, including `sim(seconds, each, every)` to
  fast-forward the simulation for balance testing.
