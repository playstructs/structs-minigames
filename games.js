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
];
