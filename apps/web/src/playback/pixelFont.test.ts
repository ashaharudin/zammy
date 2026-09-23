import { describe, expect, it } from "vitest";
import {
  ADVANCE,
  FONT_CHARS,
  GLYPHS,
  GLYPH_H,
  GLYPH_W,
  normaliseForFont,
  textPixels,
  textWidth,
  wrapText,
} from "./pixelFont.js";

/**
 * The canvas's 5×7 lettering (ADR-0029). What this catches: a glyph drawn at the
 * wrong size (every string after it would shift), a character in `FONT_CHARS` with no glyph
 * (it would silently draw nothing), two characters that draw the same pixels (a clock where
 * "0" and "O", or "×4" and "X4", cannot be told apart), a width formula that disagrees with
 * what is drawn (plates overflow their edge), and a wrap that can loop or overflow.
 */

const CHARS = [...FONT_CHARS];

/** Strings the scene draws (plates, captions, banners, clock): none may hit the `?` fallback. */
const SCENE_STRINGS = [
  "EDGE",
  "LIMIT",
  "REDIS",
  "POSTGRES",
  "QUEUE",
  "CURRENTS",
  "GOOGLE",
  "GEMINI",
  "FIXTURE",
  "BULLMQ",
  "VQS",
  "+GNEWS",
  "OFF",
  "COLD START",
  "REDIS CONNECTING",
  "+305 S LATER",
  "×181 FAST-FORWARD",
  "429",
  "T+312MS",
  "JOB 2 T+1.4S",
  "HIT",
  "MISS",
  "ACQUIRED",
  "HELD",
  "×83",
  "OPEN",
  "NO CONN",
  "REFUSED",
  "✓",
  "✗",
  "GET /API/V1/TIMELINE",
];

describe("GLYPHS", () => {
  it("draws every glyph as 7 rows of 5 lit-or-dark cells", () => {
    for (const [ch, rows] of Object.entries(GLYPHS)) {
      expect(rows, ch).toHaveLength(GLYPH_H);
      for (const row of rows) expect(row, ch).toMatch(new RegExp(`^[#.]{${GLYPH_W}}$`));
    }
  });

  it("has a glyph for exactly the characters FONT_CHARS lists, each listed once", () => {
    expect(new Set(CHARS).size).toBe(CHARS.length);
    expect(Object.keys(GLYPHS).sort()).toEqual([...CHARS].sort());
  });

  it("covers exactly the character set the scene's strings need", () => {
    expect(FONT_CHARS).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:!?-+/%×✓✗'()#><=_");
  });

  it("lights at least one pixel for every character but the space", () => {
    for (const ch of CHARS) {
      const lit = GLYPHS[ch]!.join("").includes("#");
      expect(lit, JSON.stringify(ch)).toBe(ch !== " ");
    }
  });

  it("never draws two characters the same, so 0/O, 1/I, 5/S and ×/X stay distinct", () => {
    const seen = new Map<string, string>();
    for (const ch of CHARS) {
      const key = GLYPHS[ch]!.join("/");
      expect(seen.get(key), `${ch} draws like ${seen.get(key)}`).toBeUndefined();
      seen.set(key, ch);
    }
  });

  it("sits the punctuation on the letters' baseline, not below it", () => {
    // Row 6 is the baseline; a descender would collide with a wrapped line LINE_H below.
    for (const ch of [".", ",", "_", "!", "?"]) {
      expect(GLYPHS[ch]![GLYPH_H - 1], ch).toMatch(/#/);
    }
  });
});

describe("normaliseForFont", () => {
  it("uppercases, and turns anything the font lacks into ?", () => {
    expect(normaliseForFont("Hit")).toBe("HIT");
    expect(normaliseForFont("a·b")).toBe("A?B");
    expect(normaliseForFont("é")).toBe("?");
  });

  it("turns one emoji into one ?, not two", () => {
    expect(normaliseForFont("ok 👍")).toBe("OK ?");
  });

  it("turns tabs and newlines into spaces rather than question marks", () => {
    expect(normaliseForFont("a\tb\nc")).toBe("A B C");
  });

  it("is idempotent", () => {
    for (const text of ["Mixed Case ×4 ✓", "a·b", ...SCENE_STRINGS]) {
      expect(normaliseForFont(normaliseForFont(text))).toBe(normaliseForFont(text));
    }
  });

  it("keeps every string the scene is specified to draw intact", () => {
    for (const text of SCENE_STRINGS) expect(normaliseForFont(text)).toBe(text);
  });
});

describe("textWidth", () => {
  it("is n·ADVANCE − 1, and 0 for the empty string", () => {
    expect(textWidth("ABC")).toBe(17);
    expect(textWidth("A")).toBe(GLYPH_W);
    expect(textWidth("")).toBe(0);
  });

  it("measures the normalised text, so it agrees with what is drawn", () => {
    expect(textWidth("ß")).toBe(textWidth("SS"));
    expect(textWidth("hit")).toBe(textWidth("HIT"));
  });

  it("spans exactly the pixels textPixels lights, for a string that starts and ends lit", () => {
    for (const text of ["HIT", "T+312MS", "M", "W×W"]) {
      const xs = textPixels(text).map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs) + 1, text).toBeLessThanOrEqual(textWidth(text));
      expect(Math.max(...xs), text).toBeLessThan(textWidth(text));
    }
  });
});

describe("wrapText", () => {
  const SENTENCE = "Redis connecting while the page cache misses and Currents refuses the call";

  it("fits every line within the width, for every width at least one glyph wide", () => {
    for (let width = GLYPH_W; width <= 200; width++) {
      for (const line of wrapText(SENTENCE, width)) {
        expect(textWidth(line), `${line} in ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps the words in order when each word fits", () => {
    const lines = wrapText(SENTENCE, 60);
    expect(lines.join(" ")).toBe(normaliseForFont(SENTENCE));
    expect(lines.length).toBeGreaterThan(1);
  });

  it("breaks a word longer than a line rather than overflowing", () => {
    expect(wrapText("FASTFORWARD", 29)).toEqual(["FASTF", "ORWAR", "D"]);
  });

  it("collapses runs of spaces and trims the ends", () => {
    expect(wrapText("  HIT   MISS ", 200)).toEqual(["HIT MISS"]);
  });

  it("wraps nothing to no lines", () => {
    expect(wrapText("", 100)).toEqual([]);
    expect(wrapText("   ", 100)).toEqual([]);
  });

  it("terminates with one character per line when the width is narrower than a glyph", () => {
    expect(wrapText("AB C", 2)).toEqual(["A", "B", "C"]);
  });
});

describe("textPixels", () => {
  it("lights one point per # in the glyph, relative to the top-left corner", () => {
    const lit = GLYPHS.A!.join("").split("").filter((c) => c === "#").length;
    const points = textPixels("A");
    expect(points).toHaveLength(lit);
    for (const p of points) {
      expect(GLYPHS.A![p.y]![p.x]).toBe("#");
    }
  });

  it("advances each character by ADVANCE, and a space draws nothing", () => {
    const one = textPixels("I");
    const two = textPixels(" I");
    expect(two).toEqual(one.map((p) => ({ x: p.x + ADVANCE, y: p.y })));
    expect(textPixels("   ")).toEqual([]);
  });

  it("keeps every point inside the text's box", () => {
    for (const text of SCENE_STRINGS) {
      for (const p of textPixels(text)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(textWidth(text));
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(GLYPH_H);
      }
    }
  });

  it("draws an unknown character as the ? glyph", () => {
    expect(textPixels("·")).toEqual(textPixels("?"));
  });
});
