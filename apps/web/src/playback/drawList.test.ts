import { describe, expect, it } from "vitest";
import { Station, type TraceReadResponse } from "@zammy/shared/request-trace";
import { buildTimeline, type Pace, type Timeline } from "./choreography.js";
import { overviewOps, sceneOps, stepRanges, type DrawOp } from "./drawList.js";
import { EXAMPLE_TRACES, exampleBySlug } from "./exampleTraces.js";
import { frameAt, type FrameState, type Motion } from "./frame.js";
import {
  STATION_FOOTPRINT,
  TALL,
  WIDE,
  stationRect,
  type FloorLayout,
  type Rect,
} from "./layout.js";
import { INK_FALLBACK, PALETTE, type Ink } from "./palette.js";
import { GLYPH_H, normaliseForFont, textWidth } from "./pixelFont.js";
import { SPRITES, STATION_SPRITE, type SpriteId } from "./sprites.js";

/**
 * The display list (ADR-0029): what the stage paints, as data.
 *
 * The regressions this catches are the ones a reader would see and no other test can, because
 * the renderer only runs in a browser: a word drawn in a palette colour (legible in one theme,
 * gone in the other), a sprite id or frame the atlas does not have (a throw inside the frame
 * loop), anything painted off the stage or at a fractional pixel (clipped art, blurred art), a
 * word hidden under a robot, a robot standing behind the machine it is using, a padlock that
 * never hangs, a shutter that never comes down, a banner that collides with the clock on a
 * phone, and a static overview that loses or repeats a step number the step list shows.
 *
 * It also pins the sprite geometry from the art's side: `layout.ts` places machines by
 * `STATION_FOOTPRINT`, `sprites.ts` draws them at their own sizes, and the two were written in
 * parallel — a sprite redrawn one pixel taller would overlap its neighbour on the floor.
 */

/** The dark theme's tokens (index.css), so both inks are exercised. */
const DARK: Ink = {
  fg: "#ececec",
  muted: "#b0b0b0",
  faint: "#7a7a7a",
  bg: "#121212",
  surface: "#1c1c1c",
  border: "#2a2a2a",
  rail: "#3a3a3a",
  chip: "#262626",
  attention: "#caa53d",
  activity: "#56c4c6",
};
const INKS: readonly Ink[] = [INK_FALLBACK, DARK];
const LAYOUTS: readonly FloorLayout[] = [WIDE, TALL];
const PACES: readonly Pace[] = ["readable", "real"];
const MOTIONS: readonly Motion[] = ["full", "reduced"];

function response(slug: string): TraceReadResponse {
  const found = exampleBySlug(slug);
  if (!found) throw new Error(`no example ${slug}`);
  return found.response;
}

/** The coarse sweep: eleven instants, evenly spaced from 0 to the duration inclusive. */
const elevenInstants = (timeline: Timeline): number[] =>
  Array.from({ length: 11 }, (_, k) => (timeline.duration * k) / 10);

/** The pixels an op covers, as a rectangle (a text op's includes its 1 px plate backing). */
function boxOf(op: DrawOp): Rect {
  switch (op.op) {
    case "rect":
      return { x: op.x, y: op.y, w: op.w, h: op.h };
    case "sprite": {
      const s = SPRITES[op.id];
      return { x: op.x, y: op.y, w: s.w, h: s.h };
    }
    case "text": {
      const pad = op.plate === null ? 0 : 1;
      return {
        x: op.x - pad,
        y: op.y - pad,
        w: textWidth(op.text) + 2 * pad,
        h: GLYPH_H + 2 * pad,
      };
    }
    case "dots": {
      const xs = op.points.map((p) => p.x);
      const ys = op.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
    }
  }
}

const inside = (r: Rect, layout: FloorLayout) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= layout.width && r.y + r.h <= layout.height;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Every numeric field an op carries. */
function coordinates(op: DrawOp): number[] {
  switch (op.op) {
    case "rect":
      return [op.x, op.y, op.w, op.h];
    case "sprite":
      return [op.x, op.y, op.frame];
    case "text":
      return [op.x, op.y];
    case "dots":
      return op.points.flatMap((p) => [p.x, p.y]);
  }
}

/**
 * The contract every op list keeps, whatever it shows: returns a list of violations (empty
 * when clean), so one failing frame names every broken op at once.
 */
function violations(ops: readonly DrawOp[], layout: FloorLayout, ink: Ink): string[] {
  const inks = new Set(Object.values(ink));
  const palette = new Set(PALETTE);
  const out: string[] = [];
  ops.forEach((op, i) => {
    const at = `#${i} ${op.op}${op.op === "text" ? ` "${op.text}"` : op.op === "sprite" ? ` ${op.id}` : ""}`;
    if (coordinates(op).some((n) => !Number.isInteger(n))) out.push(`${at}: fractional pixel`);
    if (op.op === "dots" && op.points.length === 0) out.push(`${at}: no points`);
    else if (!inside(boxOf(op), layout))
      out.push(`${at}: off the stage ${JSON.stringify(boxOf(op))}`);
    if (op.op === "rect" && (op.w <= 0 || op.h <= 0)) out.push(`${at}: empty rect`);
    if (op.op === "sprite") {
      const sprite = SPRITES[op.id as SpriteId] as (typeof SPRITES)[SpriteId] | undefined;
      if (!sprite) out.push(`${at}: no such sprite`);
      else if (op.frame < 0 || op.frame >= sprite.frames.length)
        out.push(`${at}: no frame ${op.frame}`);
    }
    if (op.op === "text") {
      if (!inks.has(op.colour) || palette.has(op.colour)) out.push(`${at}: colour ${op.colour}`);
      if (op.plate !== null && (!inks.has(op.plate) || palette.has(op.plate))) {
        out.push(`${at}: plate ${op.plate}`);
      }
      if (normaliseForFont(op.text) !== op.text) out.push(`${at}: not normalised`);
      if (op.text.includes("?") && op.text !== "?") out.push(`${at}: a glyph the font lacks`);
    }
  });
  return out;
}

const spriteIndex = (ops: readonly DrawOp[], id: SpriteId) =>
  ops.findIndex((op) => op.op === "sprite" && op.id === id);

describe("STATION_SPRITE", () => {
  it("draws every station at exactly the footprint the floor plan reserves for it", () => {
    for (const station of Station.options) {
      const sprite = SPRITES[STATION_SPRITE[station]];
      expect({ w: sprite.w, h: sprite.h }, station).toEqual(STATION_FOOTPRINT[station]);
    }
  });
});

describe("sceneOps", () => {
  it("draws every example at eleven instants, on both plans, at both paces, in both motions, cleanly", () => {
    for (const example of EXAMPLE_TRACES) {
      for (const pace of PACES) {
        const timeline = buildTimeline(example.response, { pace });
        for (const layout of LAYOUTS) {
          for (const motion of MOTIONS) {
            for (const t of elevenInstants(timeline)) {
              const frame = frameAt(timeline, layout, t, motion);
              for (const ink of INKS) {
                const label = `${example.slug} ${pace} ${layout.name} ${motion} t=${t}`;
                expect(violations(sceneOps(layout, frame, ink), layout, ink), label).toEqual([]);
              }
            }
          }
        }
      }
    }
  });

  it("only ever asks for sprite frames the atlas has, however finely the playback is sampled", () => {
    // The t-driven cycles (the belt, the rotor, the oracle's breath) are periodic, so eleven
    // instants can miss a bad phase; a 35 ms sweep of the busiest example cannot.
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    for (const layout of LAYOUTS) {
      const bad = new Set<string>();
      for (let t = 0; t <= timeline.duration; t += 35) {
        for (const op of sceneOps(layout, frameAt(timeline, layout, t, "full"), INK_FALLBACK)) {
          if (op.op !== "sprite") continue;
          const frames = SPRITES[op.id].frames.length;
          if (!Number.isInteger(op.frame) || op.frame < 0 || op.frame >= frames) {
            bad.add(`${op.id} frame ${op.frame}`);
          }
        }
      }
      expect([...bad], layout.name).toEqual([]);
    }
  });

  it("runs the belt for the whole of every crate's ride, and holds it still otherwise", () => {
    // The regression: the belt used to guess "riding" from a crate's x, and a riding crate
    // snapped to whole pixels passes through every x a waiting crate stands at, so the belt
    // dropped to its still frame for a frame or two several times a ride. What rides is the
    // timeline's to say (a trip is under way), so this reads it from there, not from `frame.ts`.
    //
    // Sampled every 3 ms only where the answer can change — across each crate's ride and a
    // margin either side, which is where the old guess went wrong — and every 50 ms elsewhere.
    // A 3 ms sweep of the WHOLE timeline was tens of thousands of scenes: 1.8 s locally and
    // past vitest's 5 s budget on CI's arm64 runner, for no instant this sweep leaves out.
    for (const slug of ["cold-search", "storyline-open"]) {
      const timeline = buildTimeline(response(slug), { pace: "readable" });
      const riding = (t: number) => timeline.crates.some((c) => c.t0 <= t && t < c.t1);
      const instants = new Set<number>();
      for (let t = 0; t <= timeline.duration; t += 50) instants.add(t);
      for (const crate of timeline.crates) {
        const from = Math.max(0, Math.floor(crate.t0) - 30);
        for (let t = from; t <= crate.t1 + 30; t += 3) instants.add(t);
      }
      expect(timeline.crates.length, slug).toBeGreaterThan(0);
      for (const layout of LAYOUTS) {
        const wrong: string[] = [];
        for (const t of [...instants].sort((a, b) => a - b)) {
          for (const motion of MOTIONS) {
            const ops = sceneOps(layout, frameAt(timeline, layout, t, motion), INK_FALLBACK);
            const belt = ops.find((op) => op.op === "sprite" && op.id === "belt");
            const want = motion === "full" && riding(t) ? Math.floor(t / 70) % 4 : 0;
            const got = belt?.op === "sprite" ? belt.frame : "none";
            if (got !== want) wrong.push(`${motion} t=${t}: frame ${got}, not ${want}`);
          }
        }
        expect(wrong.slice(0, 5), `${slug} ${layout.name}`).toEqual([]);
      }
    }
  });

  it("paints every word after every piece of art, so no robot or machine ever hides one", () => {
    for (const example of EXAMPLE_TRACES) {
      const timeline = buildTimeline(example.response, { pace: "readable" });
      for (const layout of LAYOUTS) {
        for (const t of elevenInstants(timeline)) {
          const ops = sceneOps(layout, frameAt(timeline, layout, t, "full"), INK_FALLBACK);
          const lastSprite = ops.findLastIndex((op) => op.op === "sprite");
          const firstText = ops.findIndex((op) => op.op === "text");
          expect(firstText, `${example.slug} ${layout.name} t=${t}`).toBeGreaterThan(lastSprite);
        }
      }
    }
  });

  it("stands a robot using a machine in front of it: painted later, lower on the stage", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    const atRack = timeline.steps.find((s) => s.actor === "runner" && s.station === "redis")!;
    for (const layout of LAYOUTS) {
      const t = atRack.t0 + atRack.walk + (atRack.t1 - atRack.t0 - atRack.walk) / 2;
      const ops = sceneOps(layout, frameAt(timeline, layout, t, "full"), INK_FALLBACK);
      expect(spriteIndex(ops, "runner"), layout.name).toBeGreaterThan(spriteIndex(ops, "rack"));
    }
  });

  it("hangs a padlock on a lock's bin while the lock is held, and takes it down on release", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    const acquire = timeline.steps.find((s) => s.stop?.outcome === "acquired")!;
    const release = timeline.steps.find((s) => s.stop?.outcome === "released")!;
    for (const layout of LAYOUTS) {
      const rack = stationRect(layout, "redis");
      const bin = layout.bins[acquire.key!];
      const held = sceneOps(
        layout,
        frameAt(timeline, layout, acquire.t1 - 1, "full"),
        INK_FALLBACK,
      );
      const lock = held.find((op) => op.op === "sprite" && op.id === "padlock");
      expect(lock, layout.name).toBeDefined();
      const box = boxOf(lock!);
      expect(box.x <= bin.x && bin.x < box.x + box.w, layout.name).toBe(true);
      expect(overlaps(box, rack), layout.name).toBe(true);
      const freed = sceneOps(
        layout,
        frameAt(timeline, layout, release.t1 - 1, "full"),
        INK_FALLBACK,
      );
      expect(spriteIndex(freed, "padlock"), layout.name).toBe(-1);
    }
  });

  it("lights the turnstile's lamp in the attention ink, and shows its blocked frame, for a 429", () => {
    const timeline = buildTimeline(response("rate-limited"), { pace: "readable" });
    const limited = timeline.steps.find((s) => s.stop?.outcome === "limited")!;
    for (const layout of LAYOUTS) {
      for (const ink of INKS) {
        const frame = frameAt(timeline, layout, limited.t1 - 1, "full");
        const ops = sceneOps(layout, frame, ink);
        const gate = stationRect(layout, "rate_limit");
        const lamp = ops.find(
          (op) => op.op === "rect" && op.colour === ink.attention && overlaps(boxOf(op), gate),
        );
        expect(lamp, `${layout.name}`).toBeDefined();
        const turnstile = ops.find((op) => op.op === "sprite" && op.id === "turnstile");
        expect(turnstile?.op === "sprite" && turnstile.frame).toBe(2);
      }
    }
  });

  it("brings a shutter down over a machine the environment switched off", () => {
    const base = response("cold-search");
    const off: TraceReadResponse = {
      ...base,
      trace: {
        ...base.trace,
        origin: {
          ...base.trace.origin!,
          environment: { ...base.trace.origin!.environment, googleNews: "off" },
        },
      },
    };
    for (const layout of LAYOUTS) {
      const kiosk = stationRect(layout, "google_news");
      const covering = (r: TraceReadResponse) => {
        const timeline = buildTimeline(r, { pace: "readable" });
        const ops = sceneOps(layout, frameAt(timeline, layout, 0, "full"), INK_FALLBACK);
        const after = ops.slice(spriteIndex(ops, "kiosk") + 1);
        return after.filter((op) => {
          if (op.op !== "rect") return false;
          const b = boxOf(op);
          const within = b.x >= kiosk.x && b.y >= kiosk.y && b.x + b.w <= kiosk.x + kiosk.w;
          return within && b.w * b.h >= (kiosk.w * kiosk.h) / 2;
        });
      };
      expect(covering(off).length, layout.name).toBeGreaterThan(0);
      expect(covering(base), layout.name).toEqual([]);
    }
  });

  it("keeps the banner off the clock: on the HUD line when both fit, under the HUD when not", () => {
    const timeline = buildTimeline(response("cold-instance"), { pace: "readable" });
    for (const layout of LAYOUTS) {
      const frame: FrameState = {
        ...frameAt(timeline, layout, 0, "full"),
        clock: "JOB 2 T+1.4S",
        banner: "REDIS CONNECTING",
      };
      const ops = sceneOps(layout, frame, INK_FALLBACK);
      const clock = ops.find((op) => op.op === "text" && op.text === frame.clock)!;
      const banner = ops.find((op) => op.op === "text" && op.text === frame.banner)!;
      expect(overlaps(boxOf(clock), boxOf(banner)), layout.name).toBe(false);
      expect(inside(boxOf(banner), layout), layout.name).toBe(true);
      const onHud = boxOf(banner).y + boxOf(banner).h <= layout.hudHeight;
      expect(onHud, layout.name).toBe(layout.name === "wide");
    }
  });

  it("never lets two bubbles cover each other in any example", () => {
    for (const example of EXAMPLE_TRACES) {
      const timeline = buildTimeline(example.response, { pace: "readable" });
      for (const layout of LAYOUTS) {
        for (const t of elevenInstants(timeline)) {
          const frame = frameAt(timeline, layout, t, "full");
          const bubbles = new Set(frame.actors.flatMap((a) => (a.bubble ? [a.bubble] : [])));
          const boxes = sceneOps(layout, frame, INK_FALLBACK)
            .filter((op) => op.op === "text" && bubbles.has(op.text) && op.y >= layout.hudHeight)
            .map(boxOf);
          for (let i = 0; i < boxes.length; i += 1) {
            for (let j = i + 1; j < boxes.length; j += 1) {
              expect(overlaps(boxes[i]!, boxes[j]!), `${example.slug} ${layout.name} t=${t}`).toBe(
                false,
              );
            }
          }
        }
      }
    }
  });

  it("is a pure function of its arguments", () => {
    const timeline = buildTimeline(response("storyline-open"), { pace: "readable" });
    const frame = frameAt(timeline, WIDE, timeline.duration / 3, "full");
    expect(sceneOps(WIDE, frame, DARK)).toEqual(sceneOps(WIDE, frame, DARK));
  });
});

describe("overviewOps", () => {
  /** Every step number the overview's badges carry, ranges expanded; the HUD line excluded. */
  function numbersOn(ops: readonly DrawOp[], layout: FloorLayout): number[] {
    const out: number[] = [];
    for (const op of ops) {
      if (op.op !== "text" || op.y < layout.hudHeight) continue;
      for (const token of op.text.split(" ")) {
        const range = /^(\d+)-(\d+)$/.exec(token);
        if (range) {
          for (let n = Number(range[1]); n <= Number(range[2]); n += 1) out.push(n);
        } else if (/^\d+$/.test(token)) {
          out.push(Number(token));
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  it("numbers every step exactly once, for every example, on both plans", () => {
    for (const example of EXAMPLE_TRACES) {
      for (const pace of PACES) {
        const timeline = buildTimeline(example.response, { pace });
        const expected = timeline.steps.map((_, i) => i + 1);
        for (const layout of LAYOUTS) {
          const ops = overviewOps(layout, timeline, INK_FALLBACK);
          expect(numbersOn(ops, layout), `${example.slug} ${pace} ${layout.name}`).toEqual(
            expected,
          );
        }
      }
    }
  });

  it("keeps the same contract as a scene: on the stage, whole pixels, words in ink", () => {
    for (const example of EXAMPLE_TRACES) {
      const timeline = buildTimeline(example.response, { pace: "readable" });
      for (const layout of LAYOUTS) {
        for (const ink of INKS) {
          const ops = overviewOps(layout, timeline, ink);
          expect(violations(ops, layout, ink), `${example.slug} ${layout.name}`).toEqual([]);
        }
      }
    }
  });

  it("places no badge over another badge or over a station's sign", () => {
    for (const example of EXAMPLE_TRACES) {
      const timeline = buildTimeline(example.response, { pace: "readable" });
      for (const layout of LAYOUTS) {
        const ops = overviewOps(layout, timeline, INK_FALLBACK);
        const words = ops.filter((op) => op.op === "text" && op.y >= layout.hudHeight);
        const badges = words
          .filter((op) => op.op === "text" && /^[\d -]+$/.test(op.text))
          .map(boxOf);
        const signs = words
          .filter((op) => op.op === "text" && !/^[\d -]+$/.test(op.text))
          .map(boxOf);
        for (let i = 0; i < badges.length; i += 1) {
          for (const sign of signs) expect(overlaps(badges[i]!, sign), example.slug).toBe(false);
          for (let j = i + 1; j < badges.length; j += 1) {
            expect(overlaps(badges[i]!, badges[j]!), `${example.slug} ${layout.name}`).toBe(false);
          }
        }
      }
    }
  });

  it("draws each robot's route as dots, and no robot at all: the picture holds still", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    for (const layout of LAYOUTS) {
      const ops = overviewOps(layout, timeline, INK_FALLBACK);
      expect(ops.some((op) => op.op === "dots" && op.points.length > 20)).toBe(true);
      const robots = ops.filter(
        (op) => op.op === "sprite" && ["runner", "helper", "worker", "dust"].includes(op.id),
      );
      expect(robots).toEqual([]);
    }
  });
});

describe("stepRanges", () => {
  it("writes three or more consecutive steps as a range and anything shorter one by one", () => {
    expect(stepRanges([34, 5, 35, 9, 10, 36, 41, 37, 38, 39, 40])).toBe("5 9 10 34-41");
    expect(stepRanges([1])).toBe("1");
    expect(stepRanges([])).toBe("");
  });
});
