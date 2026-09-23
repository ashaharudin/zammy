/**
 * The playback stage as data (ADR-0029): every rectangle, sprite, word and dot
 * the canvas draws for one frame, in painting order. `renderer.ts` is a loop over this list
 * and nothing else, so everything that makes the scene read — which machine sits in front of
 * which robot, where a bubble goes so it stays on the stage, what colour a word is — is
 * decided here, in node, where a test can check it.
 *
 * **Two colour systems, never crossed** (`palette.ts`). The ART — floors, walls, machines,
 * robots, the belt, route dots — is the sixteen-colour palette and looks the same in both
 * themes, like a game cartridge does. The WORDS — plates, tags, bubbles, the HUD, the
 * overview's step numbers — are `Ink`, the page's own tokens, and every one of them sits on
 * an ink backing (a plate, a bubble, the HUD band), so its contrast is the theme's contrast
 * whatever art is behind it. `drawList.test.ts` pins that no text op carries a palette
 * colour. Station LAMPS are ink too (`lampColour`), in an ink housing, for the same reason:
 * a lamp is a signal the reader must be able to read, not decoration.
 *
 * **Depth.** The floor is seen from above and a little in front (the SNES "three-quarter"
 * view), so a thing lower on the stage stands in front of a thing higher up. Floors, wall
 * shadows and the belt are flat and drawn first; walls are drawn with a lit top face and a
 * shaded front face; then every machine, crate and robot is painted in order of its
 * bottom-centre anchor's y — a robot at the rack stands in front of it, a robot walking
 * through the turnstile passes behind its bar. Signs (plates and tags), bubbles and the HUD
 * are an overlay on top of all of it, because a word hidden behind a robot is a word lost.
 *
 * **Liveliness is a function of t.** The oracle breathes, the belt runs while a crate rides
 * it, the drone's rotor spins, a mast calling out radiates, dust kicks up behind walking
 * feet — all read off `frame.t`, never a clock, so a paused frame is perfectly still and the
 * same frame always draws the same ops (the transport can seek anywhere; a test can too).
 * Under reduced motion t only ever lands on step starts, so nothing flickers between them.
 *
 * Deliberately not here: any canvas call (`renderer.ts`), any timing or placement decision
 * about the choreography (`frame.ts` decided where every robot is), and any text wording
 * (`stepText.ts`, `frame.ts`). The floor's static layer (floors, walls, shadows) depends only
 * on the plan, so it is built once per plan and shared by every frame.
 */
import type { RedisKeyClass, Station, TouchOutcome } from "@zammy/shared/request-trace";
import type { Step, Timeline } from "./choreography.js";
import { frameAt, type ActorPose, type FrameState } from "./frame.js";
import {
  stationRect,
  walkPath,
  type FloorLayout,
  type Point,
  type Rect,
  type Room,
} from "./layout.js";
import { ATTENTION_OUTCOMES, lampColour, PALETTE, toneColour, type Ink } from "./palette.js";
import { GLYPH_H, LINE_H, normaliseForFont, textWidth, wrapText } from "./pixelFont.js";
import type { DrawOp } from "./renderer.js";
import {
  RACK_BIN_ORDER,
  RACK_BIN_WIDTH,
  RACK_FRAME_WIDTH,
  SPRITES,
  STATION_SPRITE,
  WALK_BOB,
  type SpriteId,
} from "./sprites.js";

export type { DrawOp } from "./renderer.js";

// ── the palette, by role ─────────────────────────────────────────────────────

const pal = (i: number): string => PALETTE[i] ?? "#000000";

/** The palette entries the scene paints with directly, named for what they are here. */
const ART = {
  outline: pal(0),
  plum: pal(1),
  red: pal(2),
  orange: pal(3),
  yellow: pal(4),
  lime: pal(5),
  green: pal(6),
  teal: pal(7),
  navy: pal(8),
  blue: pal(9),
  sky: pal(10),
  aqua: pal(11),
  white: pal(12),
  steel: pal(13),
  steelDark: pal(14),
  slate: pal(15),
} as const;

/** A floor's material: its base, the joints between tiles, a lit edge, and wall shadow. */
interface Material {
  base: string;
  joint: string;
  light: string;
  shadow: string;
  /** Tile size, px. */
  tile: number;
}

const FLOORS: Readonly<Record<Room, Material>> = {
  // Paving outside the door: dark slabs.
  outside: { base: ART.steelDark, joint: ART.slate, light: ART.steel, shadow: ART.slate, tile: 8 },
  // The front room: pale concrete tiles.
  front: {
    base: ART.steel,
    joint: ART.steelDark,
    light: ART.white,
    shadow: ART.steelDark,
    tile: 16,
  },
  // The back room, the loading bay: darker, so the workers and the belt stand out.
  back: {
    base: ART.slate,
    joint: ART.outline,
    light: ART.steelDark,
    shadow: ART.outline,
    tile: 16,
  },
};

// ── small builders ───────────────────────────────────────────────────────────

function rect(x: number, y: number, w: number, h: number, colour: string): DrawOp {
  return { op: "rect", x, y, w, h, colour };
}

function sprite(id: SpriteId, frame: number, x: number, y: number, flip = false): DrawOp {
  return { op: "sprite", id, frame, x, y, flip };
}

/** A sprite placed by its bottom-centre anchor (`sprites.ts`: `{ x: floor(w / 2), y: h }`). */
function anchored(id: SpriteId, frame: number, at: Point, flip = false): DrawOp {
  const s = SPRITES[id];
  return sprite(id, frame, Math.round(at.x) - s.anchor.x, Math.round(at.y) - s.anchor.y, flip);
}

function text(value: string, x: number, y: number, colour: string, plate: string | null): DrawOp {
  return { op: "text", text: normaliseForFont(value), x, y, colour, plate };
}

/** The part of `r` inside `bounds`, or null. */
function clip(r: Rect, bounds: Rect): Rect | null {
  const x0 = Math.max(r.x, bounds.x);
  const y0 = Math.max(r.y, bounds.y);
  const x1 = Math.min(r.x + r.w, bounds.x + bounds.w);
  const y1 = Math.min(r.y + r.h, bounds.y + bounds.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function clippedRect(r: Rect, bounds: Rect, colour: string): DrawOp[] {
  const c = clip(r, bounds);
  return c ? [rect(c.x, c.y, c.w, c.h, colour)] : [];
}

/** Every other pixel of a rectangle, in a checkerboard: the scene's one dither. */
function dither(r: Rect, bounds: Rect, colour: string): DrawOp[] {
  const c = clip(r, bounds);
  if (!c) return [];
  const points: Point[] = [];
  for (let y = c.y; y < c.y + c.h; y += 1) {
    for (let x = c.x; x < c.x + c.w; x += 1) if ((x + y) % 2 === 0) points.push({ x, y });
  }
  return points.length > 0 ? [{ op: "dots", points, colour }] : [];
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const stageOf = (layout: FloorLayout): Rect => ({ x: 0, y: 0, w: layout.width, h: layout.height });

// ── the static layer: floors, walls, shadows ────────────────────────────────

/** A room's floor: its base, tile joints, and a lit corner on every tile. */
function floorOps(layout: FloorLayout, room: Room): DrawOp[] {
  const r = layout.rooms[room];
  const m = FLOORS[room];
  const stage = stageOf(layout);
  const ops: DrawOp[] = clippedRect(r, stage, m.base);
  // Joints on each tile's right and bottom edge, dithered so the grid reads as grout rather
  // than graph paper; a lit pixel where each tile's top-left corner catches the light.
  const joints: Point[] = [];
  const lit: Point[] = [];
  for (let y = r.y; y < r.y + r.h; y += 1) {
    const rowJoint = (y - r.y) % m.tile === m.tile - 1;
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const colJoint = (x - r.x) % m.tile === m.tile - 1;
      if ((rowJoint || colJoint) && (x + y) % 2 === 0) joints.push({ x, y });
      else if ((x - r.x) % m.tile === 0 && (y - r.y) % m.tile === 0) lit.push({ x, y });
    }
  }
  if (joints.length > 0) ops.push({ op: "dots", points: joints, colour: m.joint });
  if (lit.length > 0) ops.push({ op: "dots", points: lit, colour: m.light });
  return ops;
}

/** Which room's floor a point is on, for the shadow a wall casts there. */
function roomAt(layout: FloorLayout, x: number, y: number): Room | null {
  for (const room of ["front", "back", "outside"] as const) {
    const r = layout.rooms[room];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return room;
  }
  return null;
}

/**
 * Shadows the walls cast, light coming from the top-left: a soft (dithered) band below every
 * wall and to the right of every upright one, in the darker tone of whichever floor it falls on.
 */
function shadowOps(layout: FloorLayout): DrawOp[] {
  const ops: DrawOp[] = [];
  for (const wall of layout.walls) {
    const bands: Rect[] = [
      { x: wall.x, y: wall.y + wall.h, w: wall.w, h: 2 },
      { x: wall.x + wall.w, y: wall.y, w: 2, h: wall.h + 2 },
    ];
    for (const band of bands) {
      for (const room of ["front", "back", "outside"] as const) {
        const part = clip(band, layout.rooms[room]);
        if (part) ops.push(...dither(part, stageOf(layout), FLOORS[room].shadow));
      }
    }
  }
  return ops;
}

/** How deep a wall's front face is drawn, px: the part of its footprint that faces the viewer. */
const WALL_CAP = 4;

/**
 * One wall with depth. A wall lying across the stage shows a lit top face (its cap) over a
 * shaded front face with panel seams and a baseboard; an upright wall shows mostly cap, lit
 * down its left edge, with its front face only where it ends in a doorway.
 */
function wallOps(layout: FloorLayout, wall: Rect, blockers: readonly Rect[]): DrawOp[] {
  const stage = stageOf(layout);
  const ops: DrawOp[] = [];
  const across = wall.w > wall.h;
  if (across) {
    const cap = Math.min(WALL_CAP, wall.h);
    ops.push(...clippedRect({ x: wall.x, y: wall.y, w: wall.w, h: cap }, stage, ART.steelDark));
    ops.push(...clippedRect({ x: wall.x, y: wall.y, w: wall.w, h: 1 }, stage, ART.steel));
    const face = wall.h - cap;
    if (face > 0) {
      const top = wall.y + cap;
      ops.push(...clippedRect({ x: wall.x, y: top, w: wall.w, h: face }, stage, ART.navy));
      ops.push(...clippedRect({ x: wall.x, y: top, w: wall.w, h: 1 }, stage, ART.outline));
      if (face >= 6) {
        // Corrugated panels: a lit rib every 4 px, a seam every 16.
        for (let x = wall.x + 2; x < wall.x + wall.w; x += 4) {
          ops.push(...clippedRect({ x, y: top + 1, w: 1, h: face - 2 }, stage, ART.blue));
        }
        for (let x = wall.x + 15; x < wall.x + wall.w; x += 16) {
          ops.push(...clippedRect({ x, y: top + 1, w: 1, h: face - 2 }, stage, ART.outline));
        }
        ops.push(...windowOps(layout, { x: wall.x, y: top, w: wall.w, h: face }, blockers));
      }
    }
    // The baseboard where the wall meets the floor.
    const base = { x: wall.x, y: wall.y + wall.h - 1, w: wall.w, h: 1 };
    ops.push(...clippedRect(base, stage, ART.outline));
    return ops;
  }
  // Upright: an outlined cap, lit on the left.
  ops.push(...clippedRect(wall, stage, ART.steelDark));
  ops.push(...clippedRect({ x: wall.x, y: wall.y, w: 1, h: wall.h }, stage, ART.outline));
  ops.push(
    ...clippedRect({ x: wall.x + wall.w - 1, y: wall.y, w: 1, h: wall.h }, stage, ART.outline),
  );
  if (wall.w > 2) {
    ops.push(...clippedRect({ x: wall.x + 1, y: wall.y, w: 1, h: wall.h }, stage, ART.steel));
  }
  // Where it ends above open floor (a doorway, the room's edge), its front face shows.
  const below = roomAt(layout, wall.x + 1, wall.y + wall.h);
  if (below !== null) {
    const face = Math.min(6, wall.h);
    const top = wall.y + wall.h - face;
    ops.push(...clippedRect({ x: wall.x, y: top, w: wall.w, h: face }, stage, ART.navy));
    ops.push(...clippedRect({ x: wall.x, y: top, w: wall.w, h: 1 }, stage, ART.outline));
    ops.push(
      ...clippedRect({ x: wall.x, y: wall.y + wall.h - 1, w: wall.w, h: 1 }, stage, ART.outline),
    );
  }
  return ops;
}

/** Daylight windows along a wall's front face, wherever no machine stands in front of one. */
function windowOps(layout: FloorLayout, face: Rect, blockers: readonly Rect[]): DrawOp[] {
  const stage = stageOf(layout);
  const ops: DrawOp[] = [];
  const h = Math.min(6, face.h - 4);
  if (h < 3) return ops;
  const w = 10;
  for (let x = face.x + 12; x + w <= face.x + face.w - 4; x += 40) {
    const pane: Rect = { x, y: face.y + 2, w, h };
    const frame: Rect = { x: x - 1, y: pane.y - 1, w: w + 2, h: h + 2 };
    if (blockers.some((b) => overlaps(b, frame))) continue;
    ops.push(...clippedRect(frame, stage, ART.outline));
    ops.push(...clippedRect(pane, stage, ART.sky));
    ops.push(...clippedRect({ x, y: pane.y, w, h: 1 }, stage, ART.aqua));
    ops.push(...clippedRect({ x: x + Math.floor(w / 2), y: pane.y, w: 1, h }, stage, ART.outline));
  }
  return ops;
}

/**
 * Paint on the floor: a parking box at each worker's home, hazard stripes where a worker takes
 * a crate off the belt, and a doormat where the request arrives. Where robots rest is marked,
 * as it would be in a real depot, so a robot standing still reads as parked, not stalled.
 */
function markingOps(layout: FloorLayout): DrawOp[] {
  const ops: DrawOp[] = [];
  for (const home of layout.homes) {
    const box = { x: home.x - 7, y: home.y - 5, w: 14, h: 7 };
    ops.push(
      rect(box.x, box.y, box.w, 1, ART.yellow),
      rect(box.x, box.y + box.h - 1, box.w, 1, ART.yellow),
      rect(box.x, box.y, 1, box.h, ART.yellow),
      rect(box.x + box.w - 1, box.y, 1, box.h, ART.yellow),
    );
  }
  const bay = { x: layout.bay.x - 8, y: layout.bay.y - 4, w: 16, h: 6 };
  const stripes: Point[] = [];
  for (let y = bay.y; y < bay.y + bay.h; y += 1) {
    for (let x = bay.x; x < bay.x + bay.w; x += 1) if ((x + y) % 6 < 3) stripes.push({ x, y });
  }
  ops.push(rect(bay.x, bay.y, bay.w, bay.h, ART.outline), {
    op: "dots",
    points: stripes,
    colour: ART.yellow,
  });
  const mat = { x: layout.door.x - 6, y: layout.door.y - 3, w: 12, h: 4 };
  ops.push(
    rect(mat.x, mat.y, mat.w, mat.h, ART.plum),
    rect(mat.x + 1, mat.y + 1, mat.w - 2, mat.h - 2, ART.red),
  );
  return ops.flatMap((op) =>
    op.op === "rect" ? clippedRect(op, stageOf(layout), op.colour) : [op],
  );
}

const staticCache = new WeakMap<FloorLayout, readonly DrawOp[]>();

/** Floors, wall shadows and walls: everything that depends on the plan alone. */
function staticOps(layout: FloorLayout): readonly DrawOp[] {
  let found = staticCache.get(layout);
  if (!found) {
    // Windows keep clear of every machine and of every sign's widest possible plate.
    const blockers = (Object.keys(layout.stations) as Station[]).flatMap((s) => {
      const { plate } = layout.stations[s];
      const sign = { x: plate.x - 4, y: plate.y - 2, w: 8 * 6 + 8, h: GLYPH_H + LINE_H + 4 };
      return [stationRect(layout, s), sign];
    });
    // The front room's concrete under everything first, so a doorway — floor that belongs to
    // no room, between two of them — is floor and not a hole.
    const ops: DrawOp[] = [
      rect(0, 0, layout.width, layout.height, ART.outline),
      rect(0, layout.hudHeight, layout.width, layout.height - layout.hudHeight, FLOORS.front.base),
    ];
    for (const room of ["outside", "front", "back"] as const) ops.push(...floorOps(layout, room));
    ops.push(...shadowOps(layout), ...markingOps(layout));
    // Uprights first, so a wall lying across the stage caps the ends of the uprights it meets.
    const walls = [...layout.walls].sort((a, b) => Number(a.w > a.h) - Number(b.w > b.h));
    for (const wall of walls) ops.push(...wallOps(layout, wall, blockers));
    found = ops;
    staticCache.set(layout, found);
  }
  return found;
}

// ── machines ─────────────────────────────────────────────────────────────────

/**
 * Where each machine's warning lamp sits, relative to its sprite's top-left: over a light the
 * art already has (the mast's beacon, the turnstile's head, the hatch's signal) or a corner of
 * its housing.
 */
const LAMP_AT: Readonly<Record<Station, Point>> = {
  edge: { x: 26, y: 9 },
  rate_limit: { x: 6, y: 3 },
  redis: { x: 116, y: 0 },
  postgres: { x: 49, y: 3 },
  queue: { x: 6, y: 2 },
  currents: { x: 14, y: 0 },
  google_news: { x: 25, y: 9 },
  gemini: { x: 13, y: 24 },
};

const LAMP_SIZE = 5;

/** Whether an outcome lights a lamp: the ones worth a second look, and a call still running. */
const lit = (outcome: TouchOutcome | null): outcome is TouchOutcome =>
  outcome !== null && (outcome === "open" || ATTENTION_OUTCOMES.includes(outcome));

/**
 * A station's warning lamp, lit in the outcome's ink for what `lampColour` singles out — an
 * attention outcome (a refusal, a 429, a lock held elsewhere) or a call still open — with a
 * glint in its top-left corner. It stays lit, not blinking: it reports the machine's latest
 * answer until another replaces it, and a flashing light is motion the reader did not ask
 * for. Everything else leaves the machine's own painted light showing: a hit and a miss are
 * not alarms (`palette.ts`), and the bubble and the step list already say which it was.
 */
function lampOps(at: Point, outcome: TouchOutcome | null, ink: Ink): DrawOp[] {
  if (!lit(outcome)) return [];
  return [
    rect(at.x, at.y, LAMP_SIZE, LAMP_SIZE, ART.outline),
    rect(at.x + 1, at.y + 1, LAMP_SIZE - 2, LAMP_SIZE - 2, lampColour(outcome, ink)),
    rect(at.x + 1, at.y + 1, 1, 1, ART.white),
  ];
}

/** A roller shutter pulled down over a machine that is switched off. */
function shutterOps(r: Rect): DrawOp[] {
  const ops: DrawOp[] = [rect(r.x + 1, r.y + 2, r.w - 2, r.h - 3, ART.outline)];
  for (let y = r.y + 3; y < r.y + r.h - 2; y += 2) {
    ops.push(rect(r.x + 2, y, r.w - 4, 1, ART.steelDark));
  }
  ops.push(rect(r.x + 2, r.y + 3, r.w - 4, 1, ART.steel));
  ops.push(rect(r.x + Math.floor(r.w / 2) - 2, r.y + r.h - 4, 4, 1, ART.yellow));
  return ops;
}

/** Radio waves off a transmitting mast or kiosk: two arcs each side, pulsing outward. */
function wavesOps(origin: Point, t: number, stage: Rect): DrawOp[] {
  const pulse = Math.floor(t / 180) % 3;
  const points: Point[] = [];
  for (const side of [-1, 1] as const) {
    for (let ring = 0; ring < 2; ring += 1) {
      const r = 4 + (ring + pulse) * 3;
      for (let dy = -2; dy <= 2; dy += 1) {
        const x = origin.x + side * (r - Math.abs(dy));
        points.push({ x, y: origin.y + dy });
      }
    }
  }
  const inside = points.filter(
    (p) => p.x >= stage.x && p.x < stage.x + stage.w && p.y >= stage.y && p.y < stage.y + stage.h,
  );
  return inside.length > 0 ? [{ op: "dots", points: inside, colour: ART.aqua }] : [];
}

/**
 * Lights a machine's own art already has, which twinkle while it is busy: the vault's three
 * drawer LEDs (a statement running), the hatch's signal (a job going through). Positions are
 * relative to the sprite's top-left, read off `sprites.ts`.
 */
const BUSY_LIGHTS: Readonly<Partial<Record<Station, readonly Point[]>>> = {
  postgres: [13, 22, 31].flatMap((y) => [43, 45, 47].map((x) => ({ x, y }))),
  queue: [
    { x: 7, y: 3 },
    { x: 8, y: 3 },
  ],
};

function busyLightOps(station: Station, r: Rect, t: number): DrawOp[] {
  const lights = BUSY_LIGHTS[station];
  if (!lights) return [];
  const beat = Math.floor(t / 110);
  const on = lights.filter((_, i) => (beat + i * 5) % 3 === 0);
  const off = lights.filter((_, i) => (beat + i * 5) % 3 !== 0);
  const at = (points: readonly Point[]) => points.map((p) => ({ x: r.x + p.x, y: r.y + p.y }));
  return [
    ...(on.length > 0 ? [{ op: "dots" as const, points: at(on), colour: ART.white }] : []),
    ...(off.length > 0 ? [{ op: "dots" as const, points: at(off), colour: ART.lime }] : []),
  ];
}

/** Which frame a station's sprite shows. */
function stationFrame(station: Station, frame: FrameState): number {
  const state = frame.stations[station];
  switch (station) {
    case "rate_limit":
      if (state.lamp === "limited" && (state.busy || frame.banner === "429")) return 2;
      return state.busy ? 1 : 0;
    case "gemini": {
      // The oracle breathes 0,1,2,1 — quicker while it is being asked something.
      const beat = state.busy ? 160 : 420;
      return [0, 1, 2, 1][Math.floor(frame.t / beat) % 4] ?? 0;
    }
    default:
      return 0;
  }
}

/** The rows of the rack sprite its bins' faces occupy (the cubbies, below the top beam). */
const RACK_BIN_BAND = { top: 6, rows: 14 } as const;
/** Where a padlock hangs on its bin: over the label, clear of the head of a robot below. */
const PADLOCK_ROW = 8;

/**
 * The rack's bins: a lock bin shows a padlock while its lock is acquired or held (and loses it
 * on release), and a bin whose latest answer is worth a second look — no connection, a lock
 * lost, a call still open — has its label lit in that outcome's ink. A plain hit or miss
 * changes nothing on the bin: the bubble said it, and ten lit labels would say nothing.
 */
function binOps(layout: FloorLayout, frame: FrameState, ink: Ink): DrawOp[] {
  const rack = stationRect(layout, "redis");
  const ops: DrawOp[] = [];
  RACK_BIN_ORDER.forEach((key: RedisKeyClass, i) => {
    const outcome = frame.bins[key];
    if (outcome === undefined) return;
    const centre = rack.x + RACK_FRAME_WIDTH + RACK_BIN_WIDTH * i + 6;
    if (outcome === "acquired" || outcome === "held") {
      ops.push(sprite("padlock", 0, centre - 2, rack.y + PADLOCK_ROW));
      return;
    }
    if (!lit(outcome)) return;
    ops.push(rect(centre - 3, rack.y + 10, 7, 5, ART.outline));
    ops.push(rect(centre - 2, rack.y + 11, 5, 3, lampColour(outcome, ink)));
  });
  return ops;
}

// ── the belt and crates ──────────────────────────────────────────────────────

const BELT_TILE = 8;

/** The belt's tiles from the hatch to the bay, running while any crate rides it. */
function beltOps(layout: FloorLayout, frame: FrameState): DrawOp[] {
  const [start, end] = layout.conveyor;
  const x0 = start.x - 4;
  const x1 = end.x + 6;
  const y = start.y - 2;
  const phase = frame.crates.some((c) => c.riding) ? Math.floor(frame.t / 70) % 4 : 0;
  const ops: DrawOp[] = [];
  // Where the hatch stands clear of the belt (the tall plan's hatch is in the partition, the
  // belt below it in the back room), a steel chute carries the crates down through the gap.
  const hatch = stationRect(layout, "queue");
  const gap = y - (hatch.y + hatch.h);
  if (gap > 0) {
    const cx = start.x - 5;
    ops.push(rect(cx, hatch.y + hatch.h, 10, gap + 1, ART.outline));
    ops.push(rect(cx + 1, hatch.y + hatch.h, 8, gap, ART.steelDark));
    ops.push(rect(cx + 1, hatch.y + hatch.h, 1, gap, ART.steel));
    for (let yy = hatch.y + hatch.h + 1; yy < y; yy += 3)
      ops.push(rect(cx + 2, yy, 6, 1, ART.slate));
  }
  for (let x = x0; x < x1; x += BELT_TILE)
    ops.push(sprite("belt", phase, Math.min(x, x1 - BELT_TILE), y));
  // Legs under the belt, every other tile.
  for (let x = x0 + 2; x < x1; x += BELT_TILE * 2) ops.push(rect(x, y + 6, 2, 2, ART.outline));
  return ops;
}

// ── robots ───────────────────────────────────────────────────────────────────

const ROBOT_H = 16;

/** How far below a robot's head top its cargo rests (the runner's antenna hides under it). */
const CARRY_REST: Readonly<Record<ActorPose["role"], number>> = { runner: 3, worker: 2, helper: 0 };

function robotFrame(actor: ActorPose): number {
  return actor.walking ? 1 + actor.walkFrame : 0;
}

/** One robot and what it holds: its sprite, dust at its heels, its cargo, the gear, a stamp. */
function actorOps(actor: ActorPose, t: number, stage: Rect): DrawOp[] {
  const ops: DrawOp[] = [];
  const flip = actor.facing === -1;
  if (actor.role === "helper") {
    ops.push(anchored("helper", Math.floor(t / 90) % 2, actor.at, flip));
    return ops;
  }
  const frame = robotFrame(actor);
  // A puff behind the feet as each foot lands.
  if (actor.walking && (actor.walkFrame === 1 || actor.walkFrame === 3)) {
    const puff = { x: actor.at.x - actor.facing * 7, y: actor.at.y };
    const dust = SPRITES.dust;
    const box = { x: puff.x - dust.anchor.x, y: puff.y - dust.h, w: dust.w, h: dust.h };
    if (clip(box, stage)?.w === dust.w)
      ops.push(anchored("dust", actor.walkFrame === 1 ? 0 : 1, puff));
  }
  ops.push(anchored(actor.role, frame, actor.at, flip));
  const head = actor.at.y - ROBOT_H + (WALK_BOB[frame] ?? 0) + CARRY_REST[actor.role];
  if (actor.carrying) {
    const cargo = SPRITES[actor.carrying];
    const bottom = Math.max(head, stage.y + cargo.h);
    ops.push(anchored(actor.carrying, 0, { x: actor.at.x, y: bottom }));
  }
  if (actor.thinking) {
    const spin = Math.floor(t / 150) % 2 === 1;
    ops.push(sprite("gear", 0, actor.at.x + 3, Math.max(stage.y, head - 9), spin));
  }
  if (actor.stamp) {
    const id = actor.stamp === "ok" ? "stamp_ok" : "stamp_fail";
    ops.push(sprite(id, 0, actor.at.x - 3, Math.max(stage.y, actor.at.y - ROBOT_H - 9)));
  }
  return ops;
}

// ── signs, bubbles, the HUD ──────────────────────────────────────────────────

/**
 * Where a station's lettering starts: its plate point, pulled left just far enough that the
 * lettering's backing stays on the stage (the tall plan's CURRENTS plate ends on its last
 * column, and a backing past it would be a clipped half-pixel of sign).
 */
function signAt(
  layout: FloorLayout,
  station: Station,
  state: FrameState["stations"][Station],
): Point {
  const { plate } = layout.stations[station];
  const widest = Math.max(textWidth(state.plate), state.tag ? textWidth(state.tag) : 0);
  return { x: Math.min(plate.x, layout.width - widest - 1), y: plate.y };
}

/** A station's sign: its plate line and, under it, its tag line, outlined 2 px out. */
function signBox(
  layout: FloorLayout,
  station: Station,
  state: FrameState["stations"][Station],
): Rect {
  const plate = signAt(layout, station, state);
  const widest = Math.max(textWidth(state.plate), state.tag ? textWidth(state.tag) : 0);
  return {
    x: plate.x - 2,
    y: plate.y - 2,
    w: widest + 4,
    h: GLYPH_H + 4 + (state.tag ? LINE_H : 0),
  };
}

function signBoxes(layout: FloorLayout, frame: FrameState): Rect[] {
  return (Object.keys(layout.stations) as Station[]).map((s) =>
    signBox(layout, s, frame.stations[s]),
  );
}

/** Station plates, and the tag line under each: ink on an ink sign, outlined in the art's dark. */
function signOps(layout: FloorLayout, frame: FrameState, ink: Ink): DrawOp[] {
  const stage = stageOf(layout);
  const ops: DrawOp[] = [];
  for (const station of Object.keys(layout.stations) as Station[]) {
    const state = frame.stations[station];
    const plate = signAt(layout, station, state);
    const box = signBox(layout, station, state);
    ops.push(...clippedRect(box, stage, ART.outline));
    ops.push(
      ...clippedRect(
        { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 },
        stage,
        ink.surface,
      ),
    );
    ops.push(text(state.plate, plate.x, plate.y, ink.fg, ink.surface));
    if (state.tag) ops.push(text(state.tag, plate.x, plate.y + LINE_H, ink.muted, ink.surface));
  }
  return ops;
}

/** Sideways nudges a bubble tries, nearest first, before it tries a higher row. */
const BUBBLE_NUDGES = [0, -8, 8, -16, 16, -24, 24];

/** The top of what a robot shows: its head, or the cargo held over it. */
function crownOf(actor: ActorPose): number {
  if (actor.role === "helper") return actor.at.y - SPRITES.helper.h;
  const frame = robotFrame(actor);
  const head = actor.at.y - ROBOT_H + (WALK_BOB[frame] ?? 0) + CARRY_REST[actor.role];
  return actor.carrying ? head - SPRITES[actor.carrying].h : actor.at.y - ROBOT_H;
}

/**
 * Speech bubbles, each just over its robot's crown with a tail pointing down at it: kept on
 * the stage and under the HUD, and moved — sideways first, then beside the head, then up a
 * row — off any sign and any bubble already placed, so two robots at one machine never talk
 * over each other or over the machine's name. When nothing is clear the bubble takes its
 * first place and covers what it must: what a robot is saying now matters more than a plate
 * that will be back in a moment.
 */
function bubbleOps(layout: FloorLayout, frame: FrameState, ink: Ink): DrawOp[] {
  const ops: DrawOp[] = [];
  // The rack's row of bins is kept clear too: it is where a padlock or a bin's tell-tale
  // says what the robot in front of it just did, which is the picture the bubble captions.
  const rack = stationRect(layout, "redis");
  const taken: Rect[] = [
    ...signBoxes(layout, frame),
    { x: rack.x, y: rack.y + RACK_BIN_BAND.top, w: rack.w, h: RACK_BIN_BAND.rows },
  ];
  const minY = layout.hudHeight + 3;
  const maxY = layout.height - GLYPH_H - 3;
  for (const actor of frame.actors) {
    if (actor.bubble === null) continue;
    const value = normaliseForFont(actor.bubble);
    const w = textWidth(value);
    const speaker = Math.round(actor.at.x);
    // Text top such that the bubble's outline ends 2 px over the crown, room for the tail.
    const overY = crownOf(actor) - GLYPH_H - 4;
    const clamp = (p: Point): Point => ({
      x: Math.min(layout.width - w - 3, Math.max(3, p.x)),
      y: Math.min(maxY, Math.max(minY, p.y)),
    });
    const candidates: { at: Point; tail: boolean }[] = [];
    for (const dx of BUBBLE_NUDGES) {
      candidates.push({ at: clamp({ x: speaker - Math.floor(w / 2) + dx, y: overY }), tail: true });
    }
    const beside = actor.at.y - ROBOT_H + 2;
    candidates.push({ at: clamp({ x: speaker + 9, y: beside }), tail: false });
    candidates.push({ at: clamp({ x: speaker - 9 - w, y: beside }), tail: false });
    for (let row = 1; row <= 2; row += 1) {
      for (const dx of BUBBLE_NUDGES) {
        const y = overY - row * (GLYPH_H + 5);
        candidates.push({ at: clamp({ x: speaker - Math.floor(w / 2) + dx, y }), tail: false });
      }
    }
    const boxOf = (p: Point): Rect => ({ x: p.x - 2, y: p.y - 2, w: w + 4, h: GLYPH_H + 4 });
    const chosen =
      candidates.find((c) => !taken.some((r) => overlaps(r, boxOf(c.at)))) ?? candidates[0]!;
    const outer = boxOf(chosen.at);
    taken.push(outer);
    ops.push(rect(outer.x, outer.y, outer.w, outer.h, ART.outline));
    // The tail, when the bubble sits right over its speaker.
    const tailX = Math.min(outer.x + outer.w - 4, Math.max(outer.x + 1, speaker - 1));
    if (chosen.tail && outer.y + outer.h + 2 <= actor.at.y - 4) {
      ops.push(rect(tailX, outer.y + outer.h, 3, 1, ART.outline));
      ops.push(rect(tailX + 1, outer.y + outer.h + 1, 1, 1, ART.outline));
    }
    ops.push(text(value, chosen.at.x, chosen.at.y, toneColour(actor.tone, ink), ink.surface));
  }
  return ops;
}

/** Banners that warn rather than narrate. */
const ATTENTION_BANNERS = ["429", "COLD START", "REDIS CONNECTING"];

/**
 * The HUD band: the clock on the left, the banner on the right as an inverted chip — or,
 * where the tall plan has no room for both on one line, as a chip floating just under it.
 */
function hudOps(layout: FloorLayout, frame: FrameState, ink: Ink): DrawOp[] {
  const hud = layout.hudHeight;
  const ops: DrawOp[] = [
    rect(0, 0, layout.width, hud, ink.surface),
    rect(0, hud - 1, layout.width, 1, ink.border),
  ];
  const clock = normaliseForFont(frame.clock);
  ops.push(text(clock, 2, 1, ink.fg, null));
  if (frame.banner !== null) {
    const banner = normaliseForFont(frame.banner);
    const w = textWidth(banner);
    const chip = ATTENTION_BANNERS.includes(banner) ? ink.attention : ink.activity;
    const fits = 2 + textWidth(clock) + 6 + w + 2 <= layout.width;
    if (fits) {
      ops.push(text(banner, layout.width - w - 2, 1, ink.surface, chip));
    } else {
      const x = Math.round((layout.width - w) / 2);
      ops.push(rect(x - 2, hud + 1, w + 4, GLYPH_H + 4, ART.outline));
      ops.push(text(banner, x, hud + 3, ink.surface, chip));
    }
  }
  return ops;
}

// ── composition ──────────────────────────────────────────────────────────────

interface Layered {
  /** The anchor y the painter sorts on. */
  depth: number;
  ops: DrawOp[];
}

function machineLayers(layout: FloorLayout, frame: FrameState, ink: Ink): Layered[] {
  const stage = stageOf(layout);
  const layers: Layered[] = [];
  for (const station of Object.keys(layout.stations) as Station[]) {
    const slot = layout.stations[station];
    const state = frame.stations[station];
    const r = stationRect(layout, station);
    const ops: DrawOp[] = [sprite(STATION_SPRITE[station], stationFrame(station, frame), r.x, r.y)];
    if (station === "redis") ops.push(...binOps(layout, frame, ink));
    if (state.busy) ops.push(...busyLightOps(station, r, frame.t));
    if (state.shutter) ops.push(...shutterOps(r));
    const lamp = LAMP_AT[station];
    ops.push(...lampOps({ x: r.x + lamp.x, y: r.y + lamp.y }, state.lamp, ink));
    if (state.busy && (station === "currents" || station === "google_news")) {
      ops.push(...wavesOps({ x: r.x + Math.floor(r.w / 2), y: r.y + 3 }, frame.t, stage));
    }
    layers.push({ depth: slot.sprite.y, ops });
  }
  layers.push({
    depth: layout.doorSprite.y,
    ops: [anchored("door", frame.doorOpen ? 1 : 0, layout.doorSprite)],
  });
  return layers;
}

/**
 * Every draw op of one frame on one plan, in painting order: the static floor, the belt, then
 * machines, crates and robots by depth, then signs, bubbles and the HUD over the top.
 */
export function sceneOps(layout: FloorLayout, frame: FrameState, ink: Ink): DrawOp[] {
  const stage = stageOf(layout);
  const ops: DrawOp[] = [...staticOps(layout), ...beltOps(layout, frame)];
  const layers = machineLayers(layout, frame, ink);
  for (const crate of frame.crates) {
    layers.push({ depth: crate.at.y - 0.5, ops: [anchored("crate", 0, crate.at)] });
  }
  for (const actor of frame.actors) {
    layers.push({ depth: actor.at.y + 0.25, ops: actorOps(actor, frame.t, stage) });
  }
  layers.sort((a, b) => a.depth - b.depth);
  for (const layer of layers) ops.push(...layer.ops);
  ops.push(...signOps(layout, frame, ink));
  ops.push(...bubbleOps(layout, frame, ink));
  ops.push(...hudOps(layout, frame, ink));
  return ops;
}

// ── the overview ─────────────────────────────────────────────────────────────

/** The route colour of each kind of robot: its own body colour, so a route reads as its walk. */
const ROUTE_COLOUR: Readonly<Record<ActorPose["role"], string>> = {
  runner: ART.sky,
  helper: ART.lime,
  worker: ART.yellow,
};

/** How wide a badge's line of step numbers may run: eleven glyphs, four two-digit numbers. */
const BADGE_WIDTH = 65;

/** The directions a displaced badge tries, round its place: up and sideways before down. */
const BADGE_DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, -1],
  [-1, -1],
  [0, 1],
  [1, 1],
  [-1, 1],
];

/**
 * Step numbers as a badge says them: ascending, with a run of three or more consecutive
 * steps written as a range ("5 9 10 34-41"), so a place forty steps visit stays a badge.
 */
export function stepRanges(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    if (j - i >= 2) out.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k += 1) out.push(String(sorted[k]));
    i = j + 1;
  }
  return out.join(" ");
}

/** Where each step happens: its actor's feet, read off a reduced-motion frame at its start. */
function stepSpots(timeline: Timeline, layout: FloorLayout): (Point | null)[] {
  return timeline.steps.map((step: Step) => {
    const frame = frameAt(timeline, layout, step.t0, "reduced");
    return frame.actors.find((a) => a.id === step.actor)?.at ?? null;
  });
}

/**
 * The static fallback (reduced motion, before Play): the floor and its machines at rest, the
 * route each robot walks as dots in its own colour, and a numbered badge at every place a
 * step happens — the numbers are the step list's, so the picture and the list index together.
 * Steps that share a place share a badge ("3 7 12"); badges are placed round their spot so
 * that none covers another or a sign.
 */
export function overviewOps(layout: FloorLayout, timeline: Timeline, ink: Ink): DrawOp[] {
  const stage = stageOf(layout);
  const rest = frameAt(timeline, layout, 0, "reduced");
  const still: FrameState = {
    ...rest,
    t: 0,
    actors: [],
    crates: [],
    banner: null,
    doorOpen: false,
    bins: {},
    stations: Object.fromEntries(
      (Object.keys(rest.stations) as Station[]).map((s) => [
        s,
        { ...rest.stations[s], busy: false, lamp: null },
      ]),
    ) as FrameState["stations"],
  };
  const ops: DrawOp[] = [...staticOps(layout), ...beltOps(layout, still)];
  const layers = machineLayers(layout, still, ink);
  layers.sort((a, b) => a.depth - b.depth);
  for (const layer of layers) ops.push(...layer.ops);

  // Routes: each actor's spots in order, walked.
  const spots = stepSpots(timeline, layout);
  const byActor = new Map<string, { role: ActorPose["role"]; points: Point[] }>();
  timeline.steps.forEach((step, i) => {
    const at = spots[i];
    if (!at) return;
    const role: ActorPose["role"] =
      step.actor === "runner" ? "runner" : step.actor.startsWith("helper") ? "helper" : "worker";
    const entry = byActor.get(step.actor) ?? { role, points: [] };
    const last = entry.points.at(-1);
    if (!last || last.x !== at.x || last.y !== at.y) entry.points.push(at);
    byActor.set(step.actor, entry);
  });
  for (const { role, points } of byActor.values()) {
    const dots: Point[] = [];
    for (let k = 1; k < points.length; k += 1) {
      const path = walkPath(layout, points[k - 1]!, points[k]!);
      for (let s = 1; s < path.length; s += 1) {
        const a = path[s - 1]!;
        const b = path[s]!;
        const n = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
        for (let d = 0; d <= n; d += 3) {
          dots.push({ x: a.x + Math.sign(b.x - a.x) * d, y: a.y + Math.sign(b.y - a.y) * d - 1 });
        }
      }
    }
    const inside = dots.filter(
      (p) => p.x >= 0 && p.x < stage.w && p.y >= layout.hudHeight && p.y < stage.h,
    );
    if (inside.length > 0) ops.push({ op: "dots", points: inside, colour: ROUTE_COLOUR[role] });
  }

  // Badges: one per place, listing every step that happened there.
  const groups = new Map<string, { at: Point; numbers: number[] }>();
  timeline.steps.forEach((_, i) => {
    const at = spots[i] ?? layout.door;
    const key = `${at.x},${at.y}`;
    const group = groups.get(key) ?? { at, numbers: [] };
    group.numbers.push(i + 1);
    groups.set(key, group);
  });
  const signs = signBoxes(layout, still);
  const machines = (Object.keys(layout.stations) as Station[]).map((s) => stationRect(layout, s));
  const placed: Rect[] = [];
  const badgeOps: DrawOp[] = [];
  const leaderOps: DrawOp[] = [];
  for (const { at, numbers } of groups.values()) {
    const lines = wrapText(stepRanges(numbers), BADGE_WIDTH);
    const w = Math.max(...lines.map(textWidth));
    const h = lines.length * LINE_H - (LINE_H - GLYPH_H);
    const home: Point = { x: at.x - Math.floor(w / 2), y: at.y - ROBOT_H - h - 3 };
    const boxOf = (p: Point): Rect => ({ x: p.x - 2, y: p.y - 2, w: w + 4, h: h + 4 });
    const inStage = (b: Rect) =>
      b.x >= 0 &&
      b.y >= layout.hudHeight &&
      b.x + b.w <= layout.width &&
      b.y + b.h <= layout.height;
    // Nearest free place first: over the spot, then outward in rings. A badge may cover a
    // machine only when every place clear of machines is taken; it never covers a sign or
    // another badge unless the stage has no room left at all.
    const rings: Point[] = [home];
    for (let r = 6; r <= 96; r += 6) {
      for (const [dx, dy] of BADGE_DIRECTIONS)
        rings.push({ x: home.x + dx * r, y: home.y + dy * r });
    }
    const free = (p: Point, avoid: readonly Rect[]) =>
      inStage(boxOf(p)) && !avoid.some((r) => overlaps(r, boxOf(p)));
    // Past the rings, anywhere on the stage clear of signs and badges, nearest first.
    const anywhere = (): Point | undefined => {
      let best: Point | undefined;
      let bestDistance = Infinity;
      for (let y = layout.hudHeight + 2; y + h + 2 <= layout.height; y += 3) {
        for (let x = 2; x + w + 2 <= layout.width; x += 3) {
          const d = Math.abs(x - home.x) + Math.abs(y - home.y);
          if (d < bestDistance && free({ x, y }, [...signs, ...placed])) {
            best = { x, y };
            bestDistance = d;
          }
        }
      }
      return best;
    };
    const chosen =
      rings.find((p) => free(p, [...signs, ...placed, ...machines])) ??
      rings.find((p) => free(p, [...signs, ...placed])) ??
      anywhere() ??
      rings.find((p) => inStage(boxOf(p))) ??
      home;
    const box = boxOf(chosen);
    placed.push(box);
    // A badge pushed away from its place keeps a dotted leader back to it, in two tones so it
    // reads on the pale front floor and the dark back one alike.
    if (Math.abs(chosen.x - home.x) + Math.abs(chosen.y - home.y) > 10) {
      const leader: Point[] = [];
      const from = {
        x: box.x + Math.floor(box.w / 2),
        y: at.y < box.y ? box.y - 1 : box.y + box.h,
      };
      const n = Math.max(Math.abs(at.x - from.x), Math.abs(at.y - 8 - from.y));
      for (let k = 0; k <= n; k += 2) {
        const x = Math.round(from.x + ((at.x - from.x) * k) / Math.max(1, n));
        const y = Math.round(from.y + ((at.y - 8 - from.y) * k) / Math.max(1, n));
        if (x >= 0 && x < layout.width && y >= layout.hudHeight && y < layout.height) {
          leader.push({ x, y });
        }
      }
      const light = leader.filter((_, k) => k % 2 === 0);
      const dark = leader.filter((_, k) => k % 2 === 1);
      if (light.length > 0) leaderOps.push({ op: "dots", points: light, colour: ART.white });
      if (dark.length > 0) leaderOps.push({ op: "dots", points: dark, colour: ART.outline });
    }
    badgeOps.push(rect(box.x, box.y, box.w, box.h, ART.outline));
    badgeOps.push(rect(box.x + 1, box.y + 1, box.w - 2, box.h - 2, ink.surface));
    lines.forEach((line, k) => {
      badgeOps.push(text(line, chosen.x, chosen.y + k * LINE_H, ink.fg, ink.surface));
    });
  }
  ops.push(...leaderOps);
  ops.push(...signOps(layout, still, ink));
  ops.push(...badgeOps);
  ops.push(
    rect(0, 0, layout.width, layout.hudHeight, ink.surface),
    rect(0, layout.hudHeight - 1, layout.width, 1, ink.border),
    text("OVERVIEW - PRESS PLAY", 2, 1, ink.fg, null),
  );
  return ops;
}
