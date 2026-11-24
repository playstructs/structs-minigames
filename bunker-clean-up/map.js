// Bunker layout, traced from the design map (bunker-clean-up/map-design.png).
//
// Coordinates below are in the design image's pixels (1482 x 1026) and get
// multiplied by SCALE to become world units. Everything inside the outer
// border that isn't a room is hallway (already clean).
//
// Each room is a polygon whose edges are walls, except:
//   - edges lying on the outer border (the border is already a wall)
//   - entrances: [edgeIndex, from, to] where from/to are 0..1 along that edge
//     (edge i runs from points[i] to points[i + 1]).

export const SCALE = 0.63;
export const WALL_HALF = 5; // half wall thickness, world units

const DESIGN = {
  width: 1482,
  height: 1026,
  border: 10, // outer wall thickness in the design image
  start: { x: 560, y: 290, angle: 0 },
  rooms: [
    {
      name: 'Ore Storage A',
      label: [170, 55],
      points: [[0, 0], [355, 0], [355, 145], [12, 505], [0, 505]],
      entrances: [[2, 0.37, 0.86]],
    },
    {
      name: 'Ore Storage B',
      label: [1230, 100],
      // Right wall moved in from x=1405 so the corridor beside it fits the bot.
      points: [[815, 0], [815, 40], [945, 138], [1380, 258], [1380, 0]],
      entrances: [[3, 0.2, 0.66]],
    },
    {
      name: 'Ore Storage C',
      label: [930, 375],
      points: [[785, 335], [1010, 335], [1325, 455], [1325, 535], [1110, 688], [968, 688], [785, 345]],
      entrances: [[4, 0, 1]],
    },
    {
      name: 'Ore Storage D',
      label: [490, 465],
      points: [[0, 795], [320, 425], [655, 425], [892, 1026], [0, 1026]],
      entrances: [[1, 0.134, 0.866]],
    },
    {
      name: 'Ore Storage E',
      label: [1380, 975],
      points: [[1482, 575], [1115, 815], [1115, 900], [1178, 1026], [1482, 1026]],
      // The whole short wall is the doorway (the drawn gap was narrower than the bot).
      entrances: [[1, 0, 1]],
    },
  ],
  // Alpha Ore cylinders (design pixels). Placement is checked in buildMap so
  // the bot always has room to drive between a cylinder and anything else.
  // Room B is too narrow to hold one with that much room around it.
  ore: [
    [152, 152], // A
    [971, 452], [1152, 514], // C
    [429, 757], [119, 910], [724, 910], [576, 543], [362, 552], [219, 719], [633, 733], [310, 910], [538, 910], // D
    [1362, 790], // E (a second one fit, but sat right inside the doorway)
  ],
};

export const ORE_RADIUS = 22; // world units
export const ORE_CLEARANCE = 44; // min gap (world units) around each cylinder: bot width (28) + margin

function onBorder([x1, y1], [x2, y2]) {
  const W = DESIGN.width;
  const H = DESIGN.height;
  return (x1 === 0 && x2 === 0) || (y1 === 0 && y2 === 0) || (x1 === W && x2 === W) || (y1 === H && y2 === H);
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2));
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

export function buildMap(def = DESIGN) {
  const k = SCALE;
  const width = def.width * k;
  const height = def.height * k;
  const b = def.border * k;
  const walls = [];
  const doors = [];

  // Outer border: placed so its inner surface lines up with the drawn border.
  const e = Math.max(0, b - WALL_HALF);
  walls.push(
    { x1: e, y1: e, x2: width - e, y2: e },
    { x1: width - e, y1: e, x2: width - e, y2: height - e },
    { x1: width - e, y1: height - e, x2: e, y2: height - e },
    { x1: e, y1: height - e, x2: e, y2: e },
  );

  const rooms = def.rooms.map((room) => {
    const pts = room.points.map(([x, y]) => [x * k, y * k]);
    room.points.forEach((p, i) => {
      const q = room.points[(i + 1) % room.points.length];
      if (onBorder(p, q)) return;
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      const at = (t) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      const gaps = room.entrances.filter((e) => e[0] === i).map((e) => [e[1], e[2]]).sort((a, c) => a[0] - c[0]);
      let t = 0;
      for (const [g0, g1] of gaps) {
        if (g0 > t) walls.push(seg(at(t), at(g0)));
        doors.push(seg(at(g0), at(g1)));
        t = g1;
      }
      if (t < 1) walls.push(seg(at(t), at(1)));
    });
    return { name: room.name, label: [room.label[0] * k, room.label[1] * k], points: pts };
  });

  const ore = def.ore.map(([x, y]) => ({ x: x * k, y: y * k, r: ORE_RADIUS }));

  const map = {
    width,
    height,
    border: b,
    walls,
    doors,
    rooms,
    ore,
    start: { x: def.start.x * k, y: def.start.y * k, angle: def.start.angle },
    roomAt(x, y) {
      return rooms.find((r) => pointInPolygon(x, y, r.points)) || null;
    },
  };
  map.oreProblems = checkOre(map);
  map.oreProblems.forEach((p) => console.warn('Ore placement:', p));
  return map;
}

function seg([x1, y1], [x2, y2]) {
  return { x1, y1, x2, y2 };
}

// Every cylinder must sit in a room and leave a bot-sized gap to every wall,
// doorway edge and other cylinder.
export function checkOre(map) {
  const problems = [];
  const need = ORE_RADIUS + ORE_CLEARANCE + WALL_HALF;
  map.ore.forEach((o, i) => {
    const room = map.roomAt(o.x, o.y);
    if (!room) problems.push(`#${i} is not inside an ore storage room`);
    const edges = [...map.walls, ...map.doors];
    const wallGap = Math.min(...edges.map((s) => distToSegment(o.x, o.y, s)));
    if (wallGap < need) problems.push(`#${i} (${room?.name}) is ${Math.round(wallGap - ORE_RADIUS - WALL_HALF)} from a wall, needs ${ORE_CLEARANCE}`);
    map.ore.forEach((p, j) => {
      if (j <= i) return;
      const gap = Math.hypot(o.x - p.x, o.y - p.y) - 2 * ORE_RADIUS;
      if (gap < ORE_CLEARANCE) problems.push(`#${i} and #${j} are ${Math.round(gap)} apart, need ${ORE_CLEARANCE}`);
    });
  });
  return problems;
}
