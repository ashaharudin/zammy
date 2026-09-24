import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EdgeOutcome,
  PostgresOutcome,
  QueueOutcome,
  RateLimitOutcome,
  RedisOutcome,
  UpstreamOutcome,
  type TouchOutcome,
} from "@zammy/shared/request-trace";
import {
  ATTENTION_OUTCOMES,
  INK_FALLBACK,
  INK_TOKENS,
  PALETTE,
  PALETTE_KEYS,
  lampColour,
  readInk,
  toneColour,
  type Ink,
} from "./palette.js";

/**
 * The two colour systems of the playback canvas (ADR-0029). The regressions this
 * catches: a palette that drifts from the sixteen the art was drawn in (every sprite would
 * recolour silently); an ink token renamed in `index.css` without this file following, which
 * would leave canvas text on the fallback forever with nothing failing; a palette colour that
 * happens to equal an ink value, which would make `drawList.test.ts`'s "text is never a
 * palette colour" rule unable to tell the two apart; and a lamp that goes amber for a miss.
 */

const CSS = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** The custom properties declared in one CSS block, by its selector's first occurrence. */
function declarations(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector);
  expect(start, `index.css has no ${selector} block`).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const ALL_OUTCOMES: readonly TouchOutcome[] = [
  ...new Set<TouchOutcome>([
    ...RedisOutcome.options,
    ...PostgresOutcome.options,
    ...UpstreamOutcome.options,
    ...QueueOutcome.options,
    ...RateLimitOutcome.options,
    ...EdgeOutcome.options,
  ]),
];

const INK: Ink = {
  fg: "fg",
  muted: "muted",
  faint: "faint",
  bg: "bg",
  surface: "surface",
  border: "border",
  rail: "rail",
  chip: "chip",
  attention: "attention",
  activity: "activity",
};

describe("PALETTE", () => {
  it("is exactly the sixteen hues the sprites were drawn in, in index order", () => {
    expect(PALETTE).toEqual([
      "#1a1c2c",
      "#5d275d",
      "#b13e53",
      "#ef7d57",
      "#ffcd75",
      "#a7f070",
      "#38b764",
      "#257179",
      "#29366f",
      "#3b5dc9",
      "#41a6f6",
      "#73eff7",
      "#f4f4f4",
      "#94b0c2",
      "#566c86",
      "#333c57",
    ]);
    for (const hex of PALETTE) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("is addressed by sixteen distinct keys, none of them the transparent dot", () => {
    expect(PALETTE_KEYS).toHaveLength(PALETTE.length);
    expect(new Set(PALETTE_KEYS).size).toBe(PALETTE.length);
    expect(PALETTE_KEYS).not.toContain(".");
  });

  it("shares no colour with either theme's ink, so a text op can always be told from art", () => {
    const inks = [...declarations(":root {").values(), ...declarations(':root[data-theme="dark"]').values()];
    for (const hex of PALETTE) expect(inks.map((v) => v.toLowerCase())).not.toContain(hex);
  });
});

describe("INK_TOKENS", () => {
  it("names a custom property that both themes declare, for every ink", () => {
    const light = declarations(":root {");
    const dark = declarations(':root[data-theme="dark"]');
    for (const token of Object.values(INK_TOKENS)) {
      expect(light.has(token), `${token} in :root`).toBe(true);
      expect(dark.has(token), `${token} in the dark theme`).toBe(true);
    }
  });

  it("falls back to exactly the light theme's values", () => {
    const light = declarations(":root {");
    for (const [key, token] of Object.entries(INK_TOKENS)) {
      expect(INK_FALLBACK[key as keyof Ink]).toBe(light.get(token));
    }
  });
});

describe("readInk", () => {
  it("reads every token through the getter and trims what comes back", () => {
    const asked: string[] = [];
    const ink = readInk((token) => {
      asked.push(token);
      return `  #${token.length.toString(16).padStart(6, "0")} `;
    });
    expect(asked.sort()).toEqual(Object.values(INK_TOKENS).sort());
    expect(ink.fg).toBe("#000004");
    expect(ink.attention).toBe("#000007");
  });

  it("falls back per token, so one missing value never blanks the rest", () => {
    const ink = readInk((token) => (token === "--fg" ? "#ececec" : "  "));
    expect(ink).toEqual({ ...INK_FALLBACK, fg: "#ececec" });
  });

  it("is the whole fallback when nothing is readable (no stylesheet yet, no document)", () => {
    expect(readInk(() => "")).toEqual(INK_FALLBACK);
  });
});

describe("lampColour", () => {
  it("marks exactly the outcomes worth a second look as attention", () => {
    for (const outcome of ALL_OUTCOMES) {
      const expected = ATTENTION_OUTCOMES.includes(outcome)
        ? "attention"
        : outcome === "open"
          ? "activity"
          : "fg";
      expect(lampColour(outcome, INK), outcome).toBe(expected);
    }
  });

  it("does not call a cache miss, a hit or a counted request a problem", () => {
    for (const outcome of ["miss", "hit", "stale", "counted", "ok"] as const) {
      expect(lampColour(outcome, INK)).toBe("fg");
    }
  });

  it("draws a lamp with no touch yet in plain fg", () => {
    expect(lampColour(null, INK)).toBe("fg");
  });

  it("names only outcomes that exist", () => {
    for (const outcome of ATTENTION_OUTCOMES) expect(ALL_OUTCOMES).toContain(outcome);
  });
});

describe("toneColour", () => {
  it("maps each tone onto its ink", () => {
    expect(toneColour("normal", INK)).toBe("fg");
    expect(toneColour("attention", INK)).toBe("attention");
    expect(toneColour("activity", INK)).toBe("activity");
  });
});
