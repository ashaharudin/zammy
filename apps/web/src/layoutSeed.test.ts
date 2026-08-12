import { describe, expect, it } from "vitest";
import { layoutSeed } from "./layoutSeed.js";

/**
 * The cloud's layout must be a function of WHAT is in it, never of when it was
 * counted (§10.5). The seed used to key on `(day, language)`, and a day held
 * still for hours; a rolling window changes `windowEnd` on every single
 * response (ADR-0008), so seeding on anything derived from it would reshuffle
 * the whole board under the front end's poll.
 */

interface CloudResponse {
  windowStart: string;
  windowEnd: string;
  language: string;
}

const response = (over: Partial<CloudResponse> = {}): CloudResponse => ({
  windowStart: "2026-08-11T05:00:00.000Z",
  windowEnd: "2026-08-12T05:00:00.000Z",
  language: "en",
  ...over,
});

describe("layoutSeed (§10.5)", () => {
  it("is unchanged when only the window moves — the poll must not reshuffle", () => {
    const first = layoutSeed(response());
    const twoMinutesLater = layoutSeed(
      response({
        windowStart: "2026-08-11T05:02:00.000Z",
        windowEnd: "2026-08-12T05:02:00.000Z",
      }),
    );
    expect(twoMinutesLater).toBe(first);
  });

  it("separates languages, which are separate clouds", () => {
    expect(layoutSeed(response({ language: "de" }))).not.toBe(layoutSeed(response()));
  });
});
