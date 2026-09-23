import { describe, expect, it } from "vitest";
import { RedisKeyClass, Station } from "@zammy/shared/request-trace";
import { PALETTE, PALETTE_KEYS } from "./palette.js";
import {
  RACK_BIN_ORDER,
  RACK_BIN_WIDTH,
  RACK_FRAME_WIDTH,
  SPRITES,
  STATION_SPRITE,
  WALK_BOB,
  decodeFrame,
  frameRGBA,
  type Sprite,
  type SpriteId,
} from "./sprites.js";

/**
 * The floor's art (ADR-0029). The regressions this catches: a sprite redrawn at a size other
 * than `PINNED` (`layout.ts` places stations by those numbers, so the machine would overlap
 * its neighbour or float off its spot); a ragged row or a stray
 * character (a wrong pixel, or a throw inside the atlas at page load); a solid object that
 * lost its dark outline (it vanishes on the light floor); a walk cycle that stopped moving or
 * stopped bobbing; the runner and the worker drifting into the same robot; a turnstile that
 * looks blocked when it is not; an oracle that no longer brightens; a belt that jumps; and a
 * Redis bin that no longer sits where `layout.ts` says key class i lives.
 */

/**
 * The sprite geometry, and the one home of it: width, height, frame count. `layout.ts`'s
 * `STATION_FOOTPRINT` repeats the stations' sizes without importing `sprites.ts`, so a change
 * here is a change there too.
 */
const PINNED: Readonly<Record<SpriteId, readonly [w: number, h: number, frames: number]>> = {
  runner: [12, 16, 5],
  helper: [10, 12, 2],
  worker: [12, 16, 5],
  ticket: [6, 5, 1],
  parcel: [8, 7, 1],
  crate: [8, 8, 1],
  padlock: [5, 7, 1],
  door: [16, 28, 2],
  awning: [32, 24, 1],
  turnstile: [16, 24, 3],
  rack: [124, 30, 1],
  vault: [56, 40, 1],
  mast: [32, 48, 1],
  hatch: [16, 24, 1],
  kiosk: [32, 32, 1],
  oracle: [32, 40, 3],
  belt: [8, 6, 4],
  stamp_ok: [7, 7, 1],
  stamp_fail: [7, 7, 1],
  dust: [4, 4, 2],
  gear: [7, 7, 1],
};

/**
 * Solid objects, which must be ringed by the outline colour wherever they meet transparency.
 * The rest are light or motion, which has no edge: the oracle's glow, dust, the helper's rotor
 * blur and floor shadow, the thinking gear's icon, and the belt, a tile whose sides are seams.
 */
const SOLID: readonly SpriteId[] = [
  "runner",
  "worker",
  "ticket",
  "parcel",
  "crate",
  "padlock",
  "door",
  "awning",
  "turnstile",
  "rack",
  "vault",
  "mast",
  "hatch",
  "kiosk",
  "stamp_ok",
  "stamp_fail",
];

const IDS = Object.keys(PINNED) as SpriteId[];

function frames(id: SpriteId): readonly (readonly string[])[] {
  return SPRITES[id].frames;
}

/** How many pixels of a frame use any of `keys`. */
function count(rows: readonly string[], keys: string): number {
  return rows.join("").split("").filter((ch) => keys.includes(ch)).length;
}

/** Index of the first row with any opaque pixel. */
function firstOpaqueRow(rows: readonly string[]): number {
  return rows.findIndex((row) => /[^.]/.test(row));
}

describe("SPRITES", () => {
  it("draws every sprite at exactly its pinned size and frame count", () => {
    expect(Object.keys(SPRITES).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const [w, h, n] = PINNED[id];
      expect([SPRITES[id].w, SPRITES[id].h, frames(id).length], id).toEqual([w, h, n]);
    }
  });

  it("anchors every sprite at its bottom centre, where it stands on the floor", () => {
    for (const id of IDS) {
      const { w, h, anchor } = SPRITES[id];
      expect(anchor, id).toEqual({ x: Math.floor(w / 2), y: h });
    }
  });

  it("gives every frame h rows of w palette keys or dots", () => {
    const cell = new RegExp(`^[.${PALETTE_KEYS}]+$`);
    for (const id of IDS) {
      for (const [f, rows] of frames(id).entries()) {
        expect(rows, `${id}/${f}`).toHaveLength(SPRITES[id].h);
        for (const row of rows) {
          expect(row, `${id}/${f}`).toHaveLength(SPRITES[id].w);
          expect(row, `${id}/${f}`).toMatch(cell);
        }
        expect(() => decodeFrame(SPRITES[id], f)).not.toThrow();
      }
    }
  });

  it("stands every frame on its anchor row, so nothing floats above its spot", () => {
    for (const id of IDS) {
      for (const [f, rows] of frames(id).entries()) {
        expect(rows[rows.length - 1], `${id}/${f}`).toMatch(/[^.]/);
      }
    }
  });

  it("rings every solid object in the outline colour wherever it meets transparency", () => {
    for (const id of SOLID) {
      const { w, h } = SPRITES[id];
      for (const [f, rows] of frames(id).entries()) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const ch = rows[y]![x]!;
            if (ch === "." || ch === "0") continue;
            const exposed = [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ].some(([dx, dy]) => (rows[y + dy!]?.[x + dx!] ?? ".") === ".");
            expect(exposed, `${id}/${f} has an unoutlined edge at ${x},${y}`).toBe(false);
          }
        }
      }
    }
  });

  it("draws every frame of an animation differently from the one before it", () => {
    for (const id of IDS) {
      const all = frames(id);
      for (let f = 1; f < all.length; f++) {
        // The walk cycle repeats its "both feet down" pose at 2 and 4; neighbours still differ.
        expect(all[f], `${id} ${f - 1}→${f}`).not.toEqual(all[f - 1]);
      }
    }
  });
});

describe("the robots", () => {
  it("drop the body by WALK_BOB in each frame, and bob on the planted-feet frames", () => {
    for (const id of ["runner", "worker"] as const) {
      const standing = firstOpaqueRow(frames(id)[0]!);
      const bob = frames(id).map((rows) => firstOpaqueRow(rows) - standing);
      expect(bob, id).toEqual(WALK_BOB);
    }
    expect(WALK_BOB.slice(1)).toContain(1);
    expect(WALK_BOB.slice(1)).toContain(0);
  });

  it("lift the left foot and then the right, not the same one twice", () => {
    for (const id of ["runner", "worker"] as const) {
      const [, leftUp, , rightUp] = frames(id);
      expect(leftUp!.slice(-3), id).not.toEqual(rightUp!.slice(-3));
    }
  });

  it("are two different robots: a blue runner and an orange worker", () => {
    const blue = "89a";
    const orange = "234";
    const runner = frames("runner")[0]!;
    const worker = frames("worker")[0]!;
    expect(count(runner, blue)).toBeGreaterThan(2 * count(runner, orange));
    expect(count(worker, orange)).toBeGreaterThan(2 * count(worker, blue));
    const silhouette = (rows: readonly string[]) => rows.map((r) => r.replace(/[^.]/g, "#"));
    expect(silhouette(runner)).not.toEqual(silhouette(worker));
  });
});

describe("the animated machines", () => {
  it("shows red on the turnstile only when it is blocking", () => {
    const [idle, turning, blocked] = frames("turnstile");
    expect(count(idle!, "12")).toBe(0);
    expect(count(turning!, "12")).toBe(0);
    expect(count(blocked!, "2")).toBeGreaterThan(10);
  });

  it("brightens the oracle across its three frames", () => {
    const glow = frames("oracle").map((rows) => count(rows, "bc5"));
    expect(glow[0]!).toBeLessThan(glow[1]!);
    expect(glow[1]!).toBeLessThan(glow[2]!);
  });

  it("runs the belt one pixel right per frame, and the tile joins itself seamlessly", () => {
    const all = frames("belt");
    const rotateRight = (row: string) => row.slice(-1) + row.slice(0, -1);
    for (let f = 0; f < all.length; f++) {
      const next = all[(f + 1) % all.length]!;
      expect(all[f]!.map(rotateRight), `${f}→${f + 1}`).toEqual(next);
      // A 4-px period divides the 8-px tile, so tiles laid end to end show no seam.
      for (const row of all[f]!) expect(row.slice(4) + row.slice(0, 4)).toBe(row);
    }
  });

  it("opens the door onto daylight", () => {
    const [closed, open] = frames("door");
    expect(count(open!, "b")).toBeGreaterThan(count(closed!, "b"));
  });
});

describe("STATION_SPRITE", () => {
  it("gives every station its machine", () => {
    expect(Object.keys(STATION_SPRITE).sort()).toEqual([...Station.options].sort());
    expect(STATION_SPRITE).toEqual({
      edge: "awning",
      rate_limit: "turnstile",
      redis: "rack",
      postgres: "vault",
      queue: "hatch",
      currents: "mast",
      google_news: "kiosk",
      gemini: "oracle",
    });
  });
});

describe("the Redis rack", () => {
  const rack = frames("rack")[0]!;
  /** Rows of the bin band (below the beam, above the base). */
  const BAND = { from: 6, to: 24 };
  const LABEL_ROW = 11;
  const FACE_ROW = 15;

  it("puts the bins in RedisKeyClass order, the order layout.ts places their spots in", () => {
    expect(RACK_BIN_ORDER).toEqual(RedisKeyClass.options);
    expect(SPRITES.rack.w).toBe(2 * RACK_FRAME_WIDTH + RACK_BIN_ORDER.length * RACK_BIN_WIDTH);
  });

  it("starts bin i at x = 2 + 12i with a divider, and centres its label at 8 + 12i", () => {
    RACK_BIN_ORDER.forEach((key, i) => {
      const left = RACK_FRAME_WIDTH + RACK_BIN_WIDTH * i;
      for (let y = BAND.from; y <= BAND.to; y++) expect(rack[y]![left], `${key} divider`).toBe("0");
      expect(rack[LABEL_ROW]![left + 6], `${key} label`).toBe("c");
      // The bin's face is symmetric about its centre column.
      const face = rack[FACE_ROW]!.slice(left + 3, left + 10);
      expect(face.slice(1, 6), key).toMatch(/^(.)\1{4}$/);
    });
  });

  it("colours the four single-flight locks alike and every other class apart from them", () => {
    const faceOf = (key: RedisKeyClass) =>
      rack[FACE_ROW]![RACK_FRAME_WIDTH + RACK_BIN_WIDTH * RACK_BIN_ORDER.indexOf(key) + 6];
    const locks = (["sample_lock", "fill_lock", "deepen_lock", "summarize_lock"] as const).map(faceOf);
    expect(new Set(locks).size).toBe(1);
    for (const key of ["reference", "page_cache", "trending_cache", "topic_budget", "other"] as const) {
      expect(faceOf(key), key).not.toBe(locks[0]);
    }
  });
});

describe("decodeFrame", () => {
  const tiny: Sprite = { w: 3, h: 2, anchor: { x: 1, y: 2 }, frames: [["0.f", "9a."]] };

  it("maps dots to 0 and palette key i to i + 1, row-major", () => {
    expect([...decodeFrame(tiny, 0)]).toEqual([1, 0, 16, 10, 11, 0]);
  });

  it("refuses a frame that does not exist", () => {
    expect(() => decodeFrame(tiny, 1)).toThrow(/no frame 1/);
  });

  it("refuses a ragged row, a short frame, and a character outside the palette", () => {
    expect(() => decodeFrame({ ...tiny, frames: [["0.f", "9a"]] }, 0)).toThrow(/wide/);
    expect(() => decodeFrame({ ...tiny, frames: [["0.f"]] }, 0)).toThrow(/rows/);
    expect(() => decodeFrame({ ...tiny, frames: [["0.g", "9a."]] }, 0)).toThrow(/palette key/);
    expect(() => decodeFrame({ ...tiny, frames: [["0 f", "9a."]] }, 0)).toThrow(/palette key/);
  });
});

describe("frameRGBA", () => {
  const tiny: Sprite = { w: 2, h: 1, anchor: { x: 1, y: 1 }, frames: [[".9"]] };

  it("is w·h·4 bytes: transparent pixels all zero, the rest their palette colour, opaque", () => {
    expect([...frameRGBA(tiny, 0)]).toEqual([0, 0, 0, 0, 0x3b, 0x5d, 0xc9, 255]);
    for (const id of IDS) {
      const s = SPRITES[id];
      expect(frameRGBA(s, 0), id).toHaveLength(s.w * s.h * 4);
    }
  });

  it("takes an injected palette", () => {
    const grey = PALETTE.map(() => "#808080");
    expect([...frameRGBA(tiny, 0, grey)]).toEqual([0, 0, 0, 0, 128, 128, 128, 255]);
  });
});
