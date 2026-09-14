import { describe, expect, it } from "vitest";
import { enterDelayMs, ENTER_MAX_STEPS, ENTER_STEP_MS } from "./articleEnter.js";

describe("enterDelayMs", () => {
  it("lets the first card of a run start immediately", () => {
    expect(enterDelayMs(0)).toBe(0);
  });

  it("steps one beat per card", () => {
    expect(enterDelayMs(1)).toBe(ENTER_STEP_MS);
    expect(enterDelayMs(2)).toBe(2 * ENTER_STEP_MS);
  });

  it("stops stepping at the cap, so a long day never holds a card back for seconds", () => {
    const capped = ENTER_MAX_STEPS * ENTER_STEP_MS;
    expect(enterDelayMs(ENTER_MAX_STEPS)).toBe(capped);
    expect(enterDelayMs(ENTER_MAX_STEPS + 1)).toBe(capped);
    expect(enterDelayMs(500)).toBe(capped);
    // The whole cascade is over well inside a second, whatever the run's length.
    expect(capped).toBeLessThan(500);
  });

  it("never asks a card to wait on a nonsense index", () => {
    // Nothing produces these today — the index is an array position — but the
    // delay is written into a style, and a NaN there is a card that never
    // arrives rather than a card that arrives wrong.
    expect(enterDelayMs(-1)).toBe(0);
    expect(enterDelayMs(Number.NaN)).toBe(0);
    expect(enterDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
