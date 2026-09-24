import type { Point } from "./layout.js";

/**
 * The playback canvas's lettering (ADR-0029): a 5×7 bitmap font defined in code.
 *
 * Why a bitmap font and not `ctx.fillText`: canvas text is anti-aliased at whatever size the
 * browser picks, and one smooth glyph on a pixel-art floor is the fastest way to make the
 * scene read as a diagram instead of a game. A glyph here is lit logical pixels, drawn with
 * the same integer `fillRect`s as everything else, so it scales by exactly the stage's
 * backing scale and stays crisp at 1×, 2× and 3×. It also keeps the page free of a web font
 * (no request, no licence, no layout shift) and makes text measurable in node, which is what
 * lets `layout.test.ts` prove every station plate fits before a browser ever draws one.
 *
 * The character set is deliberately SMALL — the uppercase plates, bubbles, banners and clocks
 * the scene actually draws (`FONT_CHARS`). Anything else becomes `?` through
 * `normaliseForFont`, and `frame.test.ts` pins that no bubble or banner ever hits that
 * fallback, so a `?` on the floor always means an open call's intended "?" rather than a
 * missing glyph. Text is only ever drawn in `Ink` colours (`palette.ts`); this module knows
 * nothing about colour, and it never draws — `renderer.ts` is the only canvas code.
 *
 * Deliberately not here: kerning, proportional widths, lowercase, and any scaling of glyphs.
 * Every glyph is 5 wide on a 6-pixel advance, so `textWidth` is arithmetic and a plate's
 * width is known from its length alone.
 */

/** Glyph box, in logical pixels. */
export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Pen advance per character: the glyph plus one column of spacing. */
export const ADVANCE = 6;
/** Baseline-to-baseline distance for wrapped lines: the glyph plus two rows of leading. */
export const LINE_H = 9;

/**
 * Every character the font can draw, in `GLYPHS` order. `×` is the multiplication sign of
 * "×83" and "×181 FAST-FORWARD"; `✓`/`✗` are the run stamps. No `…`: a caption that does not
 * fit is shortened by its author, never by the font.
 */
export const FONT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:!?-+/%×✓✗'()#><=_";

/**
 * The glyphs: 7 rows of 5 characters, `#` lit and `.` dark, top row first. Designed as a set
 * in the classic LCD-panel tradition — a 1-pixel stroke, square shoulders, a slashed zero so
 * "0" never reads as "O" in a clock, and a lowercase-height `×` so "×4" never reads as "X4".
 * The punctuation sits on the same baseline (row 6) as the letters.
 */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "/": [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
  "%": ["##...", "##..#", "...#.", "..#..", ".#...", "#..##", "...##"],
  "×": [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  "✓": [".....", "....#", "...##", "#..#.", "##.#.", ".##..", "..#.."],
  "✗": [".....", "#...#", "##.##", ".###.", "##.##", "#...#", "....."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  ">": [".#...", "..#..", "...#.", "....#", "...#.", "..#..", ".#..."],
  "<": ["...#.", "..#..", ".#...", "#....", ".#...", "..#..", "...#."],
  "=": [".....", ".....", "#####", ".....", "#####", ".....", "....."],
  _: [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
};

const FONT_SET: ReadonlySet<string> = new Set(FONT_CHARS);

/**
 * Each glyph's lit pixels, decoded once at load: `textPixels` runs for every text op on every
 * painted frame, and re-reading `#`s out of strings sixty times a second is waste.
 */
const GLYPH_PIXELS: ReadonlyMap<string, readonly Point[]> = new Map(
  Object.entries(GLYPHS).map(([ch, rows]) => [
    ch,
    rows.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === "#" ? [{ x, y }] : []))),
  ]),
);

/**
 * Text as the font can draw it: uppercased, any whitespace (a tab, a newline) turned into a
 * space, and every other character the font lacks turned into `?`. Idempotent, and each
 * output character is exactly one UTF-16 unit, so `.length` of the result is its glyph count.
 * Deliberately no transliteration (`é` → `E`): the strings the scene draws are ours, and a `?`
 * on the floor is a bug to fix at the source, which `frame.test.ts` is there to catch.
 */
export function normaliseForFont(text: string): string {
  let out = "";
  for (const ch of text.toUpperCase()) {
    if (FONT_SET.has(ch)) out += ch;
    else out += /\s/.test(ch) ? " " : "?";
  }
  return out;
}

/**
 * Drawn width in logical pixels: `n·ADVANCE − 1`, because the last glyph needs no spacing
 * column after it; 0 for the empty string. Measures the NORMALISED text, so it agrees with
 * what `textPixels` draws even for input that uppercasing lengthens ("ß" → "SS").
 */
export function textWidth(text: string): number {
  const n = normaliseForFont(text).length;
  return n === 0 ? 0 : n * ADVANCE - 1;
}

/**
 * Greedy word wrap to `maxWidth` logical pixels, returning normalised lines with no leading,
 * trailing or doubled spaces. A word longer than a line is broken mid-word rather than
 * overflowing — a plate has a hard edge, and a clipped glyph reads worse than a hyphenless
 * break. A width narrower than one glyph still yields one character per line, so the loop
 * always terminates; the empty string wraps to no lines at all.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const perLine = Math.max(1, Math.floor((maxWidth + 1) / ADVANCE));
  const lines: string[] = [];
  let line = "";
  for (let word of normaliseForFont(text).split(" ")) {
    if (word === "") continue;
    while (word.length > perLine) {
      if (line !== "") lines.push(line);
      lines.push(word.slice(0, perLine));
      line = "";
      word = word.slice(perLine);
    }
    if (word === "") continue;
    const joined = line === "" ? word : `${line} ${word}`;
    if (joined.length <= perLine) {
      line = joined;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The lit pixels of one line of text, relative to its top-left corner, in drawing order.
 * The text is normalised first (a no-op for the already-normalised strings `drawList` emits),
 * and spaces contribute nothing but their advance.
 */
export function textPixels(text: string): readonly Point[] {
  const out: Point[] = [];
  const normalised = normaliseForFont(text);
  for (let i = 0; i < normalised.length; i++) {
    const glyph = GLYPH_PIXELS.get(normalised[i]!) ?? [];
    const left = i * ADVANCE;
    for (const p of glyph) out.push({ x: left + p.x, y: p.y });
  }
  return out;
}
