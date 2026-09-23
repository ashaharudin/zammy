import { describe, expect, it } from "vitest";
import {
  RedisKeyClass,
  Station,
  type TraceEnvironment,
} from "@zammy/shared/request-trace";
import {
  HUD_HEIGHT,
  STATION_FOOTPRINT,
  TALL,
  WIDE,
  chooseLayout,
  pathLength,
  pointAlong,
  spotFor,
  stationRect,
  walkPath,
  type FloorLayout,
  type Point,
  type Rect,
} from "./layout.js";
import { stationPlate } from "./stepText.js";

/**
 * The depot's floor plans (ADR-0029).
 *
 * Nothing here is visible to a unit test of the page — a robot that walks
 * through a wall, a plate that runs off the stage, a bin that is not under its
 * slot on the rack all render without an error. So the plans are checked as
 * geometry: in bounds and below the HUD, machines apart, every route orthogonal
 * and clear of walls and machines, every plate on the stage and uncovered.
 */

const LAYOUTS: readonly FloorLayout[] = [WIDE, TALL];
const ACTOR = { w: 12, h: 16 };
/**
 * The pixel font's metrics (`pixelFont.ts`), repeated rather than imported, so a plate that
 * would overflow fails here on the plan's own terms even if the font's numbers change too.
 */
const ADVANCE = 6;
const GLYPH_H = 7;
const LINE_H = 9;
const textWidth = (text: string) => (text.length === 0 ? 0 : text.length * ADVANCE - 1);
/** Every tag `frame.ts` can hang under each station's plate. */
const TAGS: Readonly<Partial<Record<Station, readonly string[]>>> = {
  currents: ["FIXTURE", "+GNEWS"],
  queue: ["BULLMQ", "VQS"],
  google_news: ["OFF", "FIXTURE"],
  gemini: ["OFF"],
};

function environments(): TraceEnvironment[] {
  const out: TraceEnvironment[] = [];
  for (const queue of ["bullmq", "vercel"] as const)
    for (const currents of ["live", "fixture"] as const)
      for (const gnews of [false, true])
        for (const googleNews of ["live", "fixture", "off"] as const)
          for (const summaries of [false, true])
            for (const labeler of [false, true])
              out.push({ queue, currents, gnews, googleNews, summaries, labeler });
  return out;
}

/** Every point an actor can stand on. */
function spots(layout: FloorLayout): { name: string; at: Point }[] {
  return [
    ...Station.options
      .filter((s) => s !== "redis")
      .map((s) => ({ name: s, at: spotFor(layout, s, null) })),
    ...RedisKeyClass.options.map((k) => ({ name: `bin:${k}`, at: layout.bins[k] })),
    { name: "door", at: layout.door },
    { name: "bay", at: layout.bay },
    ...layout.homes.map((at, i) => ({ name: `home:${i + 1}`, at })),
  ];
}

const actorBox = (p: Point): Rect => ({
  x: p.x - ACTOR.w / 2,
  y: p.y - ACTOR.h,
  w: ACTOR.w,
  h: ACTOR.h,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const pixelIn = (r: Rect, x: number, y: number) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Every integer pixel an orthogonal path's feet pass over. */
function pixels(path: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let t = 0; t <= n; t += 1) {
      out.push({ x: a.x + Math.sign(b.x - a.x) * t, y: a.y + Math.sign(b.y - a.y) * t });
    }
  }
  return out;
}

describe("chooseLayout", () => {
  it("gives a 375px phone (343px of column) the tall plan at a clean 2×", () => {
    const choice = chooseLayout(343, 3);
    expect(choice.layout.name).toBe("tall");
    expect(choice.scale).toBe(2);
    expect(choice.backingScale).toBe(6);
    expect([choice.cssWidth, choice.cssHeight]).toEqual([320, 480]);
  });

  it("falls to 1× on a narrow container, and stays tall right up to 639px", () => {
    expect(chooseLayout(300, 1)).toMatchObject({ scale: 1, layout: { name: "tall" } });
    expect(chooseLayout(639, 1)).toMatchObject({ scale: 3, layout: { name: "tall" } });
  });

  it("switches to the wide plan at 640px, and caps it at 3×", () => {
    const wide = { layout: { name: "wide" } };
    expect(chooseLayout(640, 2)).toMatchObject({ ...wide, scale: 2, backingScale: 4 });
    expect(chooseLayout(1400, 1)).toMatchObject({ ...wide, scale: 3, backingScale: 3 });
  });

  it("never makes the stage wider than its container, for any container of 160px or more", () => {
    for (let width = 160; width <= 2000; width += 1) {
      const choice = chooseLayout(width, 2);
      expect(choice.cssWidth).toBeLessThanOrEqual(width);
      expect(Number.isInteger(choice.scale)).toBe(true);
    }
  });

  it("treats a missing or odd device pixel ratio as 1", () => {
    expect(chooseLayout(343, Number.NaN).backingScale).toBe(2);
    expect(chooseLayout(343, 0).backingScale).toBe(2);
    expect(chooseLayout(343, 1.4).backingScale).toBe(2);
  });
});

describe("STATION_FOOTPRINT", () => {
  it("is the station sprites' sizes (`drawList.test.ts` checks them against `SPRITES`)", () => {
    expect(STATION_FOOTPRINT).toEqual({
      edge: { w: 32, h: 24 },
      rate_limit: { w: 16, h: 24 },
      redis: { w: 124, h: 30 },
      postgres: { w: 56, h: 40 },
      queue: { w: 16, h: 24 },
      currents: { w: 32, h: 48 },
      google_news: { w: 32, h: 32 },
      gemini: { w: 32, h: 40 },
    });
  });
});

for (const layout of LAYOUTS) {
  describe(`the ${layout.name} plan`, () => {
    it("is 320×180 wide or 160×240 tall (a clean 2× on a 375 px phone), under a 10 px HUD", () => {
      expect([layout.width, layout.height]).toEqual(
        layout.name === "wide" ? [320, 180] : [160, 240],
      );
      expect(layout.hudHeight).toBe(HUD_HEIGHT);
    });

    it("keeps every spot, and the actor standing on it, on the stage and below the HUD", () => {
      for (const { name, at } of spots(layout)) {
        const box = actorBox(at);
        expect(Number.isInteger(at.x) && Number.isInteger(at.y), name).toBe(true);
        expect(box.x, name).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w, name).toBeLessThanOrEqual(layout.width);
        expect(box.y, name).toBeGreaterThanOrEqual(layout.hudHeight);
        expect(at.y, name).toBeLessThan(layout.height);
      }
    });

    it("keeps every machine on the stage, below the HUD, and apart from every other", () => {
      const rects = Station.options.map((s) => ({ s, r: stationRect(layout, s) }));
      for (const { s, r } of rects) {
        expect(r.x, s).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, s).toBeLessThanOrEqual(layout.width);
        expect(r.y, s).toBeGreaterThanOrEqual(layout.hudHeight);
        expect(r.y + r.h, s).toBeLessThanOrEqual(layout.height);
      }
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          expect(overlaps(rects[i]!.r, rects[j]!.r), `${rects[i]!.s} × ${rects[j]!.s}`).toBe(false);
        }
      }
    });

    it("never stands an actor inside a machine or a wall", () => {
      const solid = [
        ...layout.walls,
        ...Station.options.filter((s) => s !== "rate_limit").map((s) => stationRect(layout, s)),
      ];
      for (const { name, at } of spots(layout)) {
        for (const r of solid) expect(pixelIn(r, at.x, at.y), name).toBe(false);
      }
    });

    it("puts each station's spot in the room the station belongs to", () => {
      for (const s of Station.options) {
        const slot = layout.stations[s];
        const room = layout.rooms[slot.room];
        const at = spotFor(layout, s, null);
        expect(pixelIn(room, at.x, at.y), s).toBe(true);
      }
      expect(layout.stations.edge.room).toBe("outside");
      for (const s of ["google_news", "gemini"] as const) {
        expect(layout.stations[s].room).toBe("back");
      }
      for (const home of layout.homes) {
        expect(pixelIn(layout.rooms.back, home.x, home.y)).toBe(true);
      }
      expect(pixelIn(layout.rooms.back, layout.bay.x, layout.bay.y)).toBe(true);
    });

    it("puts each key class's bin under its own slot on the rack, in RedisKeyClass order", () => {
      const rack = stationRect(layout, "redis");
      RedisKeyClass.options.forEach((key, i) => {
        const bin = layout.bins[key];
        expect(bin.x).toBe(rack.x + 8 + 12 * i);
        // In front of the rack, not behind or inside it.
        expect(bin.y).toBeGreaterThan(rack.y + rack.h - 1);
      });
    });

    it("runs the conveyor straight, from the hatch side into the back room", () => {
      const [start, end] = layout.conveyor;
      expect(start.y).toBe(end.y);
      expect(start.x).toBeLessThan(end.x);
      expect(pixelIn(layout.rooms.back, end.x, end.y - 1)).toBe(true);
    });

    it("sends spotFor(redis) to the key's bin, and to the other bin for an unknown key", () => {
      expect(spotFor(layout, "redis", "page_cache")).toEqual(layout.bins.page_cache);
      expect(spotFor(layout, "redis", null)).toEqual(layout.bins.other);
      expect(spotFor(layout, "postgres", "page_cache")).toEqual(layout.stations.postgres.service);
    });

    it("walks every pair of spots orthogonally, through no wall and behind no machine", () => {
      const all = spots(layout);
      const machines = Station.options
        .filter((s) => s !== "rate_limit")
        .map((s) => ({ s, r: stationRect(layout, s) }));
      for (const a of all) {
        for (const b of all) {
          const path = walkPath(layout, a.at, b.at);
          const label = `${a.name} → ${b.name}`;
          expect(path[0], label).toEqual(a.at);
          expect(path.at(-1), label).toEqual(b.at);
          for (let i = 1; i < path.length; i += 1) {
            const p = path[i - 1]!;
            const q = path[i]!;
            expect(p.x === q.x || p.y === q.y, label).toBe(true);
          }
          // One assertion per route: a per-pixel expect would cost more than the routing.
          const crossed = pixels(path).flatMap((px) => [
            ...layout.walls
              .filter((wall) => pixelIn(wall, px.x, px.y))
              .map(() => `a wall at ${px.x},${px.y}`),
            ...machines
              .filter(({ r }) => pixelIn(r, px.x, px.y))
              .map(({ s }) => `${s} at ${px.x},${px.y}`),
          ]);
          expect(crossed, label).toEqual([]);
        }
      }
    });

    it("walks in from the door through the turnstile, on the way to anything inside", () => {
      const turnstile = stationRect(layout, "rate_limit");
      const path = walkPath(layout, layout.door, spotFor(layout, "postgres", null));
      expect(pixels(path).some((p) => pixelIn(turnstile, p.x, p.y))).toBe(true);
    });

    it("keeps every plate, and the tag line below it, on the stage for every environment", () => {
      for (const env of [null, ...environments()]) {
        for (const s of Station.options) {
          const { plate } = layout.stations[s];
          const text = stationPlate(s, env);
          expect(text.length).toBeLessThanOrEqual(8);
          expect(textWidth(text), `${s} ${text}`).toBeLessThanOrEqual(layout.width - plate.x);
          expect(plate.x).toBeGreaterThanOrEqual(0);
          expect(plate.y).toBeGreaterThanOrEqual(layout.hudHeight);
          expect(plate.y + LINE_H + GLYPH_H).toBeLessThanOrEqual(layout.height);
        }
      }
      for (const s of Station.options) {
        for (const tag of TAGS[s] ?? []) {
          const room = layout.width - layout.stations[s].plate.x;
          expect(textWidth(tag), `${s} ${tag}`).toBeLessThanOrEqual(room);
        }
      }
    });

    it("never lets one plate cover another, or an actor standing anywhere cover a plate", () => {
      // A plate with its 1px backing, and the tag line below it when the station has tags.
      const box = (s: Station): Rect => {
        const { plate } = layout.stations[s];
        const tags = TAGS[s] ?? [];
        const widest = Math.max(textWidth(stationPlate(s, null)), ...tags.map(textWidth));
        const lines = tags.length > 0 ? LINE_H + GLYPH_H : GLYPH_H;
        return { x: plate.x - 1, y: plate.y - 1, w: widest + 2, h: lines + 2 };
      };
      for (let i = 0; i < Station.options.length; i += 1) {
        for (let j = i + 1; j < Station.options.length; j += 1) {
          const a = Station.options[i]!;
          const b = Station.options[j]!;
          expect(overlaps(box(a), box(b)), `${a} × ${b}`).toBe(false);
        }
      }
      for (const s of Station.options) {
        for (const { name, at } of spots(layout)) {
          expect(overlaps(box(s), actorBox(at)), `${s} plate under ${name}`).toBe(false);
        }
      }
    });
  });
}

describe("walkPath", () => {
  it("is deterministic, and hands out copies a caller cannot corrupt", () => {
    const a = walkPath(WIDE, WIDE.door, WIDE.bay);
    const b = walkPath(WIDE, WIDE.door, WIDE.bay);
    expect(a).toEqual(b);
    a[0]!.x = -99;
    expect(walkPath(WIDE, WIDE.door, WIDE.bay)[0]).toEqual(WIDE.door);
  });

  it("stands still for a walk to where the actor already is", () => {
    expect(walkPath(TALL, TALL.bay, TALL.bay)).toEqual([TALL.bay]);
  });

  it("reaches the grid from a point that lies on no aisle or connector", () => {
    const off = { x: 140, y: 130 };
    const path = walkPath(WIDE, off, WIDE.door);
    expect(path[0]).toEqual(off);
    expect(path.at(-1)).toEqual(WIDE.door);
    for (let i = 1; i < path.length; i += 1) {
      expect(path[i - 1]!.x === path[i]!.x || path[i - 1]!.y === path[i]!.y).toBe(true);
    }
  });

  it("prefers an L to a staircase of the same length", () => {
    // The door and the vault differ in x and y; the route should turn as few
    // times as the walls allow, not zig-zag through every connector.
    const path = walkPath(WIDE, WIDE.door, spotFor(WIDE, "postgres", null));
    expect(path.length).toBeLessThanOrEqual(4);
  });
});

describe("pathLength and pointAlong", () => {
  const path: Point[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 20 },
    { x: 4, y: 20 },
  ];

  it("measures an orthogonal path by its legs", () => {
    expect(pathLength(path)).toBe(36);
    expect(pathLength([])).toBe(0);
  });

  it("starts at the first point, ends at the last, and clamps a fraction outside [0, 1]", () => {
    expect(pointAlong(path, 0).at).toEqual({ x: 0, y: 0 });
    expect(pointAlong(path, 1).at).toEqual({ x: 4, y: 20 });
    expect(pointAlong(path, -3).at).toEqual({ x: 0, y: 0 });
    expect(pointAlong(path, 7).at).toEqual({ x: 4, y: 20 });
    expect(pointAlong(path, Number.NaN).at).toEqual({ x: 0, y: 0 });
  });

  it("interpolates by distance, not by segment count", () => {
    expect(pointAlong(path, 0.5).at).toEqual({ x: 10, y: 8 });
  });

  it("faces the way the actor last moved sideways, or the way it is about to", () => {
    expect(pointAlong(path, 0.1).facing).toBe(1);
    expect(pointAlong(path, 0.5).facing).toBe(1); // on the vertical leg, after moving right
    expect(pointAlong(path, 0.95).facing).toBe(-1);
    const upThenLeft: Point[] = [
      { x: 5, y: 10 },
      { x: 5, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(pointAlong(upThenLeft, 0.1).facing).toBe(-1);
  });

  it("copes with a path of one point", () => {
    expect(pointAlong([{ x: 3, y: 4 }], 0.5)).toEqual({ at: { x: 3, y: 4 }, facing: 1 });
  });
});
