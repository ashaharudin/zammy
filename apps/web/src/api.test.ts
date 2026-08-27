import { describe, expect, it } from "vitest";
import { storylineRefreshPath } from "./api.js";

/**
 * The background refresh a storyline click asks for (ADR-0017).
 *
 * What is worth pinning is an ABSENCE: the path carries a UUID and nothing
 * else. Keywords and filter chips would both be the wrong ask — the arc's own
 * coverage decides its keywords and its language, server-side, and the reader's
 * chips can name a language the arc is not in (the cloud is English-only,
 * §10.1). A future edit that starts appending `?lang=` here is the thing this
 * test exists to catch.
 */

describe("storylineRefreshPath", () => {
  it("asks by UUID alone", () => {
    expect(storylineRefreshPath("1b671a64-40d5-491e-99b0-da01ff1f3341")).toBe(
      "/api/v1/storylines/1b671a64-40d5-491e-99b0-da01ff1f3341/refresh",
    );
  });

  it("escapes the id rather than trusting it into the path", () => {
    // The server rejects anything that is not a UUID (ADR-0011), so this is
    // about never building the request that asks the question.
    expect(storylineRefreshPath("../../chores")).toBe(
      "/api/v1/storylines/..%2F..%2Fchores/refresh",
    );
  });
});
