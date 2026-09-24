import type { TouchOutcome } from "@zammy/shared/request-trace";

/**
 * The two colour systems of the playback canvas (ADR-0029, "It is the one exception to
 * ARCHITECTURE §8.3's visual rules"), kept in one module so the line between them is visible
 * in one place.
 *
 * 1. **The palette** is the art's: sixteen fixed hues (Sweetie 16, by GrafxKid) that every
 *    sprite is drawn in. It is DECORATIVE and identical in both themes, which is the
 *    precedent `TrendingCloud.tsx` set with its recency ramp: the canvas is `aria-hidden`, the
 *    step list carries the same content, and a robot does not need to change colour when the
 *    reader switches to dark. A fixed sixteen is also what makes it read as a 16-bit game
 *    rather than a diagram: every sprite shares one outline colour, one light, and one shadow
 *    tone per material, which is only possible when the colours are chosen together.
 *
 * 2. **The ink** is the page's: the house tokens (`index.css`), read at runtime, so canvas
 *    TEXT — plates, bubbles, the clock, the banner — follows the theme exactly like DOM text
 *    does. The palette is NEVER used for text (ARCHITECTURE §8.3's exception is for the art,
 *    not the words): mid-palette hues like `#ffcd75` would fail body-text contrast on the light
 *    floor, and `drawList.test.ts` pins that every text op's colour is an `Ink` value.
 *
 * Deliberately not here: any per-theme variant of the palette, any colour arithmetic
 * (tints, alpha), and any reading of the DOM — `readInk` takes a getter, so the page decides
 * WHEN to read (after `ThemeProvider`'s layout effect has written `data-theme`, which is why
 * `PlaybackPage.tsx`'s `usePageInk` reads it in a passive effect) and tests need no document.
 */

/**
 * The sprite palette, index-addressed (`PALETTE_KEYS[i]` names `PALETTE[i]`). Roles, so a
 * reader of `sprites.ts` can decode the art without a colour picker:
 *
 * | key | hex | role |
 * |---|---|---|
 * | 0 | #1a1c2c | the outline around every solid sprite, and the darkest recesses |
 * | 1 | #5d275d | plum: red's shadow (the awning's scallops, the red bins, the ✗ stamp) |
 * | 2 | #b13e53 | red: the blocked turnstile, the lock bins, string, orange's shadow |
 * | 3 | #ef7d57 | orange: the worker, wood, the ticket stub; red's light |
 * | 4 | #ffcd75 | pale yellow: the hard hat, brass, lamps, gilt trim; orange's light |
 * | 5 | #a7f070 | lime: green's light, the ok lamp, the oracle's hottest spark |
 * | 6 | #38b764 | green: the helper drone, the ✓ stamp, disk status lights |
 * | 7 | #257179 | teal: green's shadow, the kiosk booth, the oracle's faint aura |
 * | 8 | #29366f | navy: blue metal's shadow |
 * | 9 | #3b5dc9 | blue: the runner, the door, the pedestal — blue metal's body |
 * | a | #41a6f6 | sky: blue metal's light, glass |
 * | b | #73eff7 | aqua: lenses, glints, the oracle's glow and daylight |
 * | c | #f4f4f4 | white: the brightest highlight, paper, labels |
 * | d | #94b0c2 | steel: grey metal's light |
 * | e | #566c86 | steel dark: grey metal's body |
 * | f | #333c57 | slate: grey metal's shadow, dark cubbies |
 */
export const PALETTE: readonly string[] = [
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
];

/**
 * A sprite row's alphabet: the character at index i paints `PALETTE[i]`, and `"."` (which is
 * deliberately NOT in this string) is transparent. Hex digits, so a row reads as the index it
 * paints and sixteen colours need exactly one character each.
 */
export const PALETTE_KEYS = "0123456789abcdef";

/**
 * The page's colours as the canvas needs them, one per house token. `attention` is `--amber`
 * and `activity` is `--activity`, the same two meanings they carry everywhere else in the app
 * (a refused upstream, a live job).
 */
export interface Ink {
  fg: string;
  muted: string;
  faint: string;
  bg: string;
  surface: string;
  border: string;
  rail: string;
  chip: string;
  attention: string;
  activity: string;
}

/** Which CSS custom property each ink comes from (`index.css`, `:root` and both dark blocks). */
export const INK_TOKENS: Readonly<Record<keyof Ink, string>> = {
  fg: "--fg",
  muted: "--fg-muted",
  faint: "--fg-faint",
  bg: "--bg",
  surface: "--surface",
  border: "--border",
  rail: "--rail",
  chip: "--chip-bg",
  attention: "--amber",
  activity: "--activity",
};

/**
 * The light theme's values, copied from `index.css`'s `:root`. Used per token when the getter
 * returns nothing — a stylesheet that has not loaded yet, a test with no document — so the
 * canvas always has a legible colour rather than an empty string, which a canvas silently
 * treats as "keep the previous fillStyle".
 */
export const INK_FALLBACK: Ink = {
  fg: "#1a1a1a",
  muted: "#555555",
  faint: "#999999",
  bg: "#fafafa",
  surface: "#ffffff",
  border: "#e5e5e5",
  rail: "#d9d9d9",
  chip: "#f0f0f0",
  attention: "#b58900",
  activity: "#0f8b8d",
};

/**
 * The current ink, read through `get` (in the page:
 * `getComputedStyle(document.documentElement).getPropertyValue`). Values are trimmed, because
 * `getPropertyValue` returns a custom property's text verbatim including the space after its
 * colon; an empty value falls back per token, so one missing token never blanks the rest.
 */
export function readInk(get: (token: string) => string): Ink {
  const ink = { ...INK_FALLBACK };
  for (const key of Object.keys(INK_TOKENS) as (keyof Ink)[]) {
    const value = get(INK_TOKENS[key]).trim();
    if (value !== "") ink[key] = value;
  }
  return ink;
}

/**
 * The outcomes a reader should look twice at — the same list `choreography.ts` marks with the
 * `attention` tone (its `ATTENTION` set, read by `toneOf`), so a lamp and the step it belongs
 * to always agree.
 */
export const ATTENTION_OUTCOMES: readonly TouchOutcome[] = [
  "failed",
  "not_ready",
  "limited",
  "refused",
  "lost",
  "held",
  "fail_open",
];

/**
 * A station lamp's colour for its latest outcome: attention for the outcomes above, activity
 * for a call still `open`, and plain `fg` for everything else — including a hit, a miss and
 * `null` (no touch yet). Deliberately not a green/red traffic light: a cache miss is not a
 * failure, and a lamp that shouted about every miss would teach the reader to ignore it.
 */
export function lampColour(outcome: TouchOutcome | null, ink: Ink): string {
  if (outcome === null) return ink.fg;
  if (outcome === "open") return ink.activity;
  if (ATTENTION_OUTCOMES.includes(outcome)) return ink.attention;
  return ink.fg;
}

/** A step's tone (`choreography.ts`'s `toneOf`) as ink: bubbles and the clock use it. */
export function toneColour(tone: "normal" | "attention" | "activity", ink: Ink): string {
  if (tone === "attention") return ink.attention;
  if (tone === "activity") return ink.activity;
  return ink.fg;
}
