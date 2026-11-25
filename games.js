// The shared list of minigames shown on the cabinet's selection screen.
// To add a game: create its folder and add an entry here.
//
// id          - folder name, also the localStorage key for its records
// name        - title shown on the selection screen
// tagline     - one line describing the goal
// formatScore - how to display a stored score

export const GAMES = [
  {
    id: 'bunker-clean-up',
    name: 'Bunker Clean-Up',
    tagline: "Scrub the floors. Don't touch the Alpha Ore.",
    formatScore: (s) => (s == null ? '--' : `${s}%`),
  },
  {
    id: 'containment',
    name: 'Containment',
    tagline: 'Fight off cyber attacks until the fleet returns.',
    formatScore: (s) => (s == null ? '--' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`),
  },
  {
    id: 'last-line-of-defense',
    name: 'Last Line of Defense',
    tagline: 'Shoot down raiders before they slip past. Unlocks with the PDC.',
    formatScore: (s) => (s == null ? '--' : `${s} pts`),
  },
  {
    id: 'we-be-jammin',
    name: "We Be Jammin'",
    tagline: 'Fly your satellite and jam smart missiles. How long can you last?',
    formatScore: (s) => (s == null ? '--' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`),
  },
];
