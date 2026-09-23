/**
 * The floor plan of the "Zammy depot" (ADR-0029): where each station stands,
 * where an actor stands to use it, and how actors walk between them.
 *
 * The playback page draws a request as a robot carrying it through a small
 * warehouse. Every station a touch can reach is a machine on this floor — the
 * CDN edge an awning outside the door, the rate limiter a turnstile inside it,
 * Redis a rack of ten bins (one per key class), Postgres a vault, Currents a
 * radio mast, the queue a hatch in the partition wall whose conveyor carries
 * crates into the back room, Google News a kiosk and Gemini an oracle. The back
 * room is where the job runs happen: three worker robots wait at their homes,
 * pick a crate up at the bay, and walk it back out to the machines they need.
 *
 * Two plans with the same rooms: WIDE (320×180 logical px, the desktop stage) and
 * TALL (160×240, stacked, so a 375px phone gets a clean 2× rather than a blurry
 * 2.3×). Coordinates are integers in LOGICAL pixels; the stage multiplies them by
 * an integer scale (`chooseLayout`), which is what keeps the pixel art crisp.
 *
 * Geometry conventions, shared with the art (`sprites.ts` draws to them, and
 * `drawList.test.ts` checks the two agree):
 *  - every sprite is anchored BOTTOM-CENTRE: `StationSlot.sprite` is where the
 *    anchor lands, so a station's footprint is
 *    `{ x: sprite.x − floor(w/2), y: sprite.y − h, w, h }` (`stationRect`);
 *  - an actor's anchor is its feet, so every Point an actor stands on is a feet
 *    position, and the sprite rises 16px above it;
 *  - the Redis rack's bin i spans x ∈ [2 + 12i, 14 + 12i) of the sprite, in
 *    `RedisKeyClass.options` order, so bin i's feet point sits at
 *    x = rackLeft + 8 + 12i.
 *
 * Walking is ORTHOGONAL, along a small network: horizontal AISLES (y values) and
 * vertical CONNECTORS (x values), cut wherever a wall or a machine stands. Every
 * spot lies on an aisle or a connector by construction, so a route is a
 * shortest-with-fewest-turns path over that grid (`walkPath`) and never cuts a
 * corner through a wall or walks behind a machine. The one machine the network
 * deliberately passes THROUGH is the turnstile: every request goes through the
 * rate limiter on its way in, and the plan says so.
 *
 * Deliberately not here: timing (`choreography.ts` is layout-independent, so a
 * resize never changes what a step means), drawing (`drawList.ts`), and any
 * colour. This module knows sizes, not sprites: `STATION_FOOTPRINT` repeats each
 * station sprite's size, and `drawList.test.ts` pins it to `SPRITES` so a sprite
 * redrawn a pixel taller fails there rather than overlapping its neighbour.
 */
import { RedisKeyClass, Station } from "@zammy/shared/request-trace";

/** A logical-pixel position. For an actor or a sprite, the bottom-centre anchor. */
export interface Point {
  x: number;
  y: number;
}

/** A logical-pixel rectangle covering columns [x, x+w) and rows [y, y+h). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutName = "wide" | "tall";
export type Room = "outside" | "front" | "back";

/** Where one station lives on a plan. */
export interface StationSlot {
  station: Station;
  /** Where the station sprite's bottom-centre anchor lands. */
  sprite: Point;
  /** Feet position of an actor using it. Redis actors use `bins` instead (`spotFor`). */
  service: Point;
  /**
   * Top-left of the station's name plate (`stationPlate`, ≤ 8 glyphs). The line
   * below it (plate.y + LINE_H) is kept free for the station's tag ("FIXTURE",
   * "VQS", "OFF"), so a plate never collides with another plate or its tag.
   */
  plate: Point;
  room: Room;
}

/** One floor plan. Everything is in logical pixels. */
export interface FloorLayout {
  name: LayoutName;
  width: number;
  height: number;
  /** Rows [0, hudHeight) are the canvas HUD (clock, banner); nothing walks there. */
  hudHeight: number;
  stations: Readonly<Record<Station, StationSlot>>;
  /** Feet positions in front of the Redis rack, one per key class, left to right. */
  bins: Readonly<Record<RedisKeyClass, Point>>;
  /** Where the runner stands on arrival and on its way out: the reader's side of the door. */
  door: Point;
  /** Bottom-centre anchor of the door sprite (16×28), standing in the doorway. */
  doorSprite: Point;
  /** Where a worker stands to take a crate off the conveyor. */
  bay: Point;
  /** Where the three workers wait between runs. */
  homes: readonly [Point, Point, Point];
  /** A crate's anchor at the hatch end and at the bay end; the belt runs straight between. */
  conveyor: readonly [Point, Point];
  /** The walking network: horizontal aisles (y) and vertical connectors (x). */
  aisles: readonly number[];
  connectors: readonly number[];
  /** Solid walls, for drawing (with a top and a front face) and for routing. */
  walls: readonly Rect[];
  /** Floor areas, so the outside can be paved differently from the rooms. */
  rooms: Readonly<Record<Room, Rect>>;
}

/** Rows reserved for the HUD at the top of every plan. */
export const HUD_HEIGHT = 10;

/**
 * Each station sprite's size (`sprites.ts` STATION_SPRITE): edge→awning,
 * rate_limit→turnstile, redis→rack, postgres→vault, queue→hatch, currents→mast,
 * google_news→kiosk, gemini→oracle. Used for the footprint, the overlap and
 * in-bounds tests, and as routing obstacles.
 */
export const STATION_FOOTPRINT: Readonly<Record<Station, { w: number; h: number }>> = {
  edge: { w: 32, h: 24 },
  rate_limit: { w: 16, h: 24 },
  redis: { w: 124, h: 30 },
  postgres: { w: 56, h: 40 },
  queue: { w: 16, h: 24 },
  currents: { w: 32, h: 48 },
  google_news: { w: 32, h: 32 },
  gemini: { w: 32, h: 40 },
};

/**
 * The rack sprite's bins (`sprites.ts` rack: a 2 px frame, then ten 12 px bins): bin i's
 * centre is 8 + 12i from its left edge.
 */
const RACK_BIN_FIRST_CENTRE = 8;
const RACK_BIN_PITCH = 12;

/** The footprint a station's sprite covers on a plan. */
export function stationRect(layout: FloorLayout, station: Station): Rect {
  const { w, h } = STATION_FOOTPRINT[station];
  const anchor = layout.stations[station].sprite;
  return { x: anchor.x - Math.floor(w / 2), y: anchor.y - h, w, h };
}

// ── the two plans ────────────────────────────────────────────────────────────

interface PlanSpec {
  name: LayoutName;
  width: number;
  height: number;
  slots: Record<Station, Omit<StationSlot, "station">>;
  /** The y of the feet line in front of the rack. */
  binLine: number;
  door: Point;
  doorSprite: Point;
  bay: Point;
  homes: readonly [Point, Point, Point];
  conveyor: readonly [Point, Point];
  aisles: readonly number[];
  connectors: readonly number[];
  walls: readonly Rect[];
  rooms: Record<Room, Rect>;
}

type XY = readonly [x: number, y: number];

/** A station's slot, compactly: its room, then the sprite anchor, service spot and plate. */
function slot(room: Room, sprite: XY, service: XY, plate: XY): Omit<StationSlot, "station"> {
  const point = ([x, y]: XY): Point => ({ x, y });
  return { sprite: point(sprite), service: point(service), plate: point(plate), room };
}

function plan(spec: PlanSpec): FloorLayout {
  const rack = spec.slots.redis.sprite;
  const rackLeft = rack.x - Math.floor(STATION_FOOTPRINT.redis.w / 2);
  const bins = Object.fromEntries(
    RedisKeyClass.options.map((key, i) => [
      key,
      { x: rackLeft + RACK_BIN_FIRST_CENTRE + RACK_BIN_PITCH * i, y: spec.binLine },
    ]),
  ) as Record<RedisKeyClass, Point>;
  const stations = Object.fromEntries(
    Station.options.map((station) => [station, { station, ...spec.slots[station] }]),
  ) as Record<Station, StationSlot>;
  return {
    name: spec.name,
    width: spec.width,
    height: spec.height,
    hudHeight: HUD_HEIGHT,
    stations,
    bins,
    door: spec.door,
    doorSprite: spec.doorSprite,
    bay: spec.bay,
    homes: spec.homes,
    conveyor: spec.conveyor,
    aisles: spec.aisles,
    connectors: spec.connectors,
    walls: spec.walls,
    rooms: spec.rooms,
  };
}

/**
 * The desktop plan, 320×180.
 *
 *   x 0–48    outside: the street, the CDN awning at the left edge
 *   x 48–52   the outer wall, its door at the main aisle (y 100)
 *   x 52–224  the FRONT room: turnstile inside the door, the Redis rack along the
 *             back wall with the Currents mast beside it, the Postgres vault on
 *             the floor below, the hatch in the partition at the end of the aisle
 *   x 224–232 the partition: solid but for the hatch and a doorway at the bottom
 *   x 232–316 the BACK room: the Google News kiosk on the back wall, the conveyor
 *             out of the hatch to the bay, the Gemini oracle and the three worker
 *             homes along the bottom
 *
 * Three aisles: the bin line (y 60) along the rack, the main aisle (y 100) from
 * the street to the hatch, and the bottom aisle (y 166) that alone crosses into
 * the back room, through the doorway.
 */
export const WIDE: FloorLayout = plan({
  name: "wide",
  width: 320,
  height: 180,
  binLine: 60,
  slots: {
    edge: slot("outside", [18, 92], [18, 100], [7, 59]),
    rate_limit: slot("front", [70, 101], [70, 100], [56, 67]),
    redis: slot("front", [124, 54], [124, 60], [110, 15]),
    currents: slot("front", [206, 58], [206, 60], [176, 64]),
    postgres: slot("front", [138, 160], [138, 166], [115, 109]),
    queue: slot("front", [228, 100], [212, 100], [236, 66]),
    google_news: slot("back", [292, 54], [292, 60], [274, 64]),
    gemini: slot("back", [256, 160], [256, 166], [239, 102]),
  },
  door: { x: 38, y: 100 },
  doorSprite: { x: 50, y: 104 },
  bay: { x: 296, y: 100 },
  homes: [
    { x: 278, y: 166 },
    { x: 292, y: 166 },
    { x: 306, y: 166 },
  ],
  conveyor: [
    { x: 240, y: 96 },
    { x: 286, y: 96 },
  ],
  aisles: [60, 100, 166],
  connectors: [94, 212, 306],
  walls: [
    { x: 48, y: 10, w: 272, h: 16 }, // the back wall, over both rooms
    { x: 48, y: 26, w: 4, h: 64 }, // outer wall, above the door
    { x: 48, y: 110, w: 4, h: 64 }, // outer wall, below the door
    { x: 224, y: 26, w: 8, h: 124 }, // the partition, down to the doorway
    { x: 316, y: 26, w: 4, h: 148 }, // the right wall
    { x: 48, y: 174, w: 272, h: 6 }, // the front wall (only its top shows)
  ],
  rooms: {
    outside: { x: 0, y: 10, w: 48, h: 170 },
    front: { x: 52, y: 26, w: 172, h: 148 },
    back: { x: 232, y: 26, w: 84, h: 148 },
  },
});

/**
 * The phone plan, 160×240: the same rooms stacked.
 *
 *   y 10–40   outside: the street, the CDN awning at its left end, the door
 *             at its right end in the front room's back wall
 *   y 40–52   the front room's back wall, with the doorway at x 136–152
 *   y 52–140  the FRONT room: the rack along the back wall, the turnstile under
 *             the door, the vault and the mast on the floor below, the hatch in
 *             the partition between them
 *   y 140–148 the partition: solid but for the hatch and a doorway at the right
 *   y 148–234 the BACK room: the conveyor out of the hatch to the bay, the
 *             kiosk against the partition, the oracle and the homes at the bottom
 *
 * 160 wide so that a 343px column (375 less its gutters) renders at exactly 2×.
 */
export const TALL: FloorLayout = plan({
  name: "tall",
  width: 160,
  height: 240,
  binLine: 86,
  slots: {
    edge: slot("outside", [20, 34], [20, 38], [40, 14]),
    rate_limit: slot("front", [144, 87], [144, 86], [106, 30]),
    redis: slot("front", [68, 80], [68, 86], [20, 42]),
    postgres: slot("front", [36, 132], [36, 138], [13, 95]),
    currents: slot("front", [136, 136], [136, 138], [113, 94]),
    queue: slot("front", [88, 148], [72, 138], [92, 166]),
    google_news: slot("back", [28, 182], [28, 188], [11, 191]),
    gemini: slot("back", [128, 226], [128, 230], [74, 204]),
  },
  door: { x: 144, y: 58 },
  doorSprite: { x: 144, y: 52 },
  bay: { x: 136, y: 164 },
  homes: [
    { x: 24, y: 230 },
    { x: 40, y: 230 },
    { x: 56, y: 230 },
  ],
  conveyor: [
    { x: 92, y: 160 },
    { x: 124, y: 160 },
  ],
  aisles: [38, 86, 112, 138, 164, 188, 230],
  connectors: [72, 106, 144, 148],
  walls: [
    { x: 0, y: 40, w: 136, h: 12 }, // the front room's back wall, left of the doorway
    { x: 152, y: 40, w: 8, h: 12 }, // and right of it
    { x: 0, y: 52, w: 4, h: 182 }, // the left wall
    { x: 156, y: 52, w: 4, h: 182 }, // the right wall
    { x: 4, y: 140, w: 136, h: 8 }, // the partition, up to the doorway at x 140–156
    { x: 0, y: 234, w: 160, h: 6 }, // the front wall (only its top shows)
  ],
  rooms: {
    outside: { x: 0, y: 10, w: 160, h: 30 },
    front: { x: 4, y: 52, w: 152, h: 88 },
    back: { x: 4, y: 148, w: 152, h: 86 },
  },
});

// ── choosing a plan and a scale ──────────────────────────────────────────────

/** A container at least this wide gets the WIDE plan (at 2× or 3×); below it, TALL. */
export const WIDE_MIN_CSS_WIDTH = 640;

/** A plan and the integer scales it is drawn at. */
export interface LayoutChoice {
  layout: FloorLayout;
  /** CSS pixels per logical pixel. */
  scale: 1 | 2 | 3;
  /** Backing-store pixels per logical pixel: `scale × max(1, round(dpr))`. */
  backingScale: number;
  cssWidth: number;
  cssHeight: number;
}

/**
 * The plan and scale for a container: ≥ 640 css px → WIDE at min(3, floor(w/320));
 * otherwise TALL at clamp(floor(w/160), 1, 3). Integer scales only — a fractional
 * one resamples every pixel and the art turns to mush — so the stage is never
 * wider than its container for any container at least 160 wide.
 *
 * The backing store multiplies in the device pixel ratio (rounded, at least 1) so
 * a 3× phone draws 6 device pixels per logical pixel instead of letting the
 * browser upscale a 2× canvas.
 */
export function chooseLayout(containerCssWidth: number, devicePixelRatio: number): LayoutChoice {
  const width = Number.isFinite(containerCssWidth) ? containerCssWidth : 0;
  const dpr = Number.isFinite(devicePixelRatio) ? Math.max(1, Math.round(devicePixelRatio)) : 1;
  const wide = width >= WIDE_MIN_CSS_WIDTH;
  const layout = wide ? WIDE : TALL;
  const raw = wide ? Math.min(3, Math.floor(width / WIDE.width)) : Math.floor(width / TALL.width);
  const scale = Math.min(3, Math.max(1, raw)) as 1 | 2 | 3;
  return {
    layout,
    scale,
    backingScale: scale * dpr,
    cssWidth: layout.width * scale,
    cssHeight: layout.height * scale,
  };
}

// ── spots ────────────────────────────────────────────────────────────────────

/** Where an actor stands to use a station. Redis resolves to its key's bin (`other` if none). */
export function spotFor(layout: FloorLayout, station: Station, key: RedisKeyClass | null): Point {
  if (station === "redis") return layout.bins[key ?? "other"];
  return layout.stations[station].service;
}

// ── routing ──────────────────────────────────────────────────────────────────

/**
 * How much a corner costs, in pixels of walking. Enough that of two equally long
 * routes the one with fewer corners wins (an L rather than a staircase), and that
 * a route prefers a long straight run over a slightly shorter zig-zag — robots
 * walking a warehouse keep to the aisles.
 */
const TURN_COST = 6;

/** Obstacles an actor's feet never cross: the walls, and every machine but the turnstile. */
const obstacleCache = new WeakMap<FloorLayout, readonly Rect[]>();
function obstacles(layout: FloorLayout): readonly Rect[] {
  let found = obstacleCache.get(layout);
  if (!found) {
    found = [
      ...layout.walls,
      ...Station.options.filter((s) => s !== "rate_limit").map((s) => stationRect(layout, s)),
    ];
    obstacleCache.set(layout, found);
  }
  return found;
}

function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Whether the axis-aligned segment a→b touches no obstacle pixel. */
function clear(blockers: readonly Rect[], a: Point, b: Point): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  for (const r of blockers) {
    // Rect columns [r.x, r.x + r.w), rows [r.y, r.y + r.h), against the closed segment.
    if (x1 >= r.x && x0 < r.x + r.w && y1 >= r.y && y0 < r.y + r.h) return false;
  }
  return true;
}

interface Edge {
  to: number;
  length: number;
  /** 0 = horizontal, 1 = vertical. */
  axis: 0 | 1;
}

const pathCache = new WeakMap<FloorLayout, Map<string, readonly Point[]>>();
const PATH_CACHE_LIMIT = 4096;

/**
 * An orthogonal walking route from `from` to `to`: deterministic, starting exactly
 * at `from` and ending exactly at `to`, every segment horizontal or vertical, and
 * never crossing a wall or a machine other than the turnstile.
 *
 * It is a Dijkstra search over the aisles × connectors grid, with the two end
 * points joined to it: a point lying on an aisle or a connector becomes a node on
 * that line, and a point on neither (which no spot is, but a caller may pass one)
 * reaches the nearest line above, below and to either side by a short spur.
 * Consecutive nodes along a line are joined where nothing stands between them. The
 * cost is length plus `TURN_COST` per corner, and ties break on node order, so the
 * same two points always get the same route.
 *
 * If the two points cannot be joined — a plan broken badly enough that the tests
 * below would already be red — it returns a plain L rather than throwing: a robot
 * walking through a wall is a visible bug, a blank stage is not a debuggable one.
 * Results are memoized per plan; the frame loop asks for the same few routes 60
 * times a second.
 */
export function walkPath(layout: FloorLayout, from: Point, to: Point): Point[] {
  let cache = pathCache.get(layout);
  if (!cache) {
    cache = new Map();
    pathCache.set(layout, cache);
  }
  const key = `${from.x},${from.y}>${to.x},${to.y}`;
  let found = cache.get(key);
  if (!found) {
    found = route(layout, from, to);
    if (cache.size >= PATH_CACHE_LIMIT) cache.clear();
    cache.set(key, found);
  }
  return found.map((p) => ({ x: p.x, y: p.y }));
}

function route(layout: FloorLayout, from: Point, to: Point): readonly Point[] {
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const blockers = obstacles(layout);
  const nodes: Point[] = [];
  const index = new Map<string, number>();
  const node = (p: Point): number => {
    const k = `${p.x},${p.y}`;
    let i = index.get(k);
    if (i === undefined) {
      i = nodes.length;
      nodes.push({ x: p.x, y: p.y });
      index.set(k, i);
    }
    return i;
  };
  const start = node(from);
  const goal = node(to);
  const edges = new Map<number, Edge[]>();
  const link = (a: number, b: number): void => {
    if (a === b) return;
    const pa = nodes[a]!;
    const pb = nodes[b]!;
    if (pa.x !== pb.x && pa.y !== pb.y) return;
    if (!clear(blockers, pa, pb)) return;
    const axis: 0 | 1 = pa.y === pb.y ? 0 : 1;
    const length = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
    (edges.get(a) ?? edges.set(a, []).get(a)!).push({ to: b, length, axis });
    (edges.get(b) ?? edges.set(b, []).get(b)!).push({ to: a, length, axis });
  };

  // The grid's intersections.
  for (const y of layout.aisles) {
    for (const x of layout.connectors) {
      if (!blockers.some((r) => inside(r, x, y))) node({ x, y });
    }
  }
  // Join each end point to the grid by spurs, unless it already lies on a line.
  for (const end of [from, to]) {
    const onAisle = layout.aisles.includes(end.y);
    const onConnector = layout.connectors.includes(end.x);
    if (onAisle || onConnector) continue;
    const above = Math.max(...layout.aisles.filter((y) => y < end.y), -Infinity);
    const below = Math.min(...layout.aisles.filter((y) => y > end.y), Infinity);
    const left = Math.max(...layout.connectors.filter((x) => x < end.x), -Infinity);
    const right = Math.min(...layout.connectors.filter((x) => x > end.x), Infinity);
    for (const y of [above, below]) if (Number.isFinite(y)) link(node(end), node({ x: end.x, y }));
    for (const x of [left, right]) if (Number.isFinite(x)) link(node(end), node({ x, y: end.y }));
  }
  // Consecutive nodes along each aisle and each connector.
  for (const y of layout.aisles) {
    const along = nodes
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.y === y)
      .sort((a, b) => a.p.x - b.p.x);
    for (let k = 1; k < along.length; k += 1) link(along[k - 1]!.i, along[k]!.i);
  }
  for (const x of layout.connectors) {
    const along = nodes
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.x === x)
      .sort((a, b) => a.p.y - b.p.y);
    for (let k = 1; k < along.length; k += 1) link(along[k - 1]!.i, along[k]!.i);
  }
  // Two points that share a line with nothing between them need no grid at all.
  link(start, goal);

  const found = dijkstra(nodes.length, edges, start, goal);
  if (!found) return simplify([from, { x: to.x, y: from.y }, to]);
  return simplify(found.map((i) => nodes[i]!));
}

/** Dijkstra over (node, arriving axis) states, so a corner can be charged for. */
function dijkstra(
  count: number,
  edges: ReadonlyMap<number, readonly Edge[]>,
  start: number,
  goal: number,
): number[] | null {
  // State s = node * 3 + axis, axis 2 = "arrived by no edge yet" (the start).
  const states = count * 3;
  const dist = new Array<number>(states).fill(Infinity);
  const prev = new Array<number>(states).fill(-1);
  const done = new Array<boolean>(states).fill(false);
  const first = start * 3 + 2;
  dist[first] = 0;
  for (;;) {
    let best = -1;
    for (let s = 0; s < states; s += 1) {
      if (!done[s] && dist[s]! < Infinity && (best === -1 || dist[s]! < dist[best]!)) best = s;
    }
    if (best === -1) return null;
    const at = Math.floor(best / 3);
    if (at === goal) {
      const order: number[] = [];
      for (let s = best; s !== -1; s = prev[s]!) order.push(Math.floor(s / 3));
      return order.reverse();
    }
    done[best] = true;
    const arrived = best % 3;
    for (const edge of edges.get(at) ?? []) {
      const next = edge.to * 3 + edge.axis;
      const turn = arrived !== 2 && arrived !== edge.axis ? TURN_COST : 0;
      const cost = dist[best]! + edge.length + turn;
      if (cost < dist[next]!) {
        dist[next] = cost;
        prev[next] = best;
      }
    }
  }
}

/** Drops repeated points and merges collinear runs into single segments. */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = out.at(-2);
    const collinear =
      before &&
      last &&
      ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y));
    if (collinear) {
      out[out.length - 1] = { x: p.x, y: p.y };
      continue;
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Total length of a polyline, in logical pixels. */
export function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  }
  return total;
}

/**
 * The point `fraction` of the way along a path (clamped to [0, 1]), and which way
 * an actor there faces.
 *
 * Sprites only flip horizontally, so facing comes from the nearest horizontal
 * segment: the one it is on, else the last one before it, else the next one after
 * it (an actor about to turn faces where it is heading), else right. The point is
 * NOT rounded — the caller snaps to whole pixels when it draws.
 */
export function pointAlong(
  path: readonly Point[],
  fraction: number,
): { at: Point; facing: -1 | 1 } {
  const first = path[0];
  if (!first) return { at: { x: 0, y: 0 }, facing: 1 };
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const total = pathLength(path);
  if (path.length === 1 || total === 0) {
    return { at: { ...path.at(-1)! }, facing: facingAt(path, 0) };
  }
  let remaining = f * total;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === path.length - 1) {
      const t = length === 0 ? 1 : Math.min(1, remaining / length);
      return {
        at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        facing: facingAt(path, i - 1),
      };
    }
    remaining -= length;
  }
  return { at: { ...path.at(-1)! }, facing: facingAt(path, path.length - 2) };
}

/** Facing on segment `k` (from path[k] to path[k+1]); see `pointAlong`. */
function facingAt(path: readonly Point[], k: number): -1 | 1 {
  const dx = (i: number) => (path[i + 1]?.x ?? 0) - (path[i]?.x ?? 0);
  const segments = path.length - 1;
  const sign = (i: number): -1 | 1 => (dx(i) < 0 ? -1 : 1);
  for (let i = Math.min(k, segments - 1); i >= 0; i -= 1) if (dx(i) !== 0) return sign(i);
  for (let i = k + 1; i < segments; i += 1) if (dx(i) !== 0) return sign(i);
  return 1;
}

/** Whether a path has any horizontal run — without one, `pointAlong`'s facing is only a default. */
export function pathTurnsSideways(path: readonly Point[]): boolean {
  for (let i = 1; i < path.length; i += 1) if (path[i]!.x !== path[i - 1]!.x) return true;
  return false;
}
