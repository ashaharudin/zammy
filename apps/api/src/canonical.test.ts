import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, type ReferenceCodes } from "./canonical.js";

/**
 * The canonicalizer (ARCHITECTURE 6.2) — the single easiest and highest-value
 * unit-test target in the system. Every equivalence it declares becomes a shared
 * cache entry and a shared accumulating topic, and every equivalence it misses
 * is quota spent re-learning something we already knew.
 */

const reference: ReferenceCodes = {
  languages: new Set(["en", "de", "fr"]),
  regions: new Set(["us", "gb", "ca"]),
  categories: new Set(["technology", "politics", "crap"]),
};

const NOW = new Date("2026-08-10T14:07:33.000Z");

const options = {
  reference,
  defaultLanguage: "en",
  lookbackDays: 30,
  now: NOW,
};

function goodQuery(q: string, extra: Record<string, unknown> = {}) {
  const result = canonicalize({ q, ...extra }, options);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.query;
}

describe("keyword normalization converges trivially-different requests", () => {
  it("ignores case, surrounding space, ordering, and repetition", () => {
    // "  Climate   POLICY " and "policy climate" must reuse one topic (§6.2).
    const a = goodQuery("  Climate   POLICY ");
    const b = goodQuery("policy climate");
    const c = goodQuery("climate policy policy");

    expect(a.keywords).toEqual(["climate", "policy"]);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).toBe(a.fingerprint);
  });

  it("applies NFKC so visually-identical input is one topic", () => {
    // Fullwidth forms arrive from IME users; without NFKC they mint a
    // parallel topic that shares no cache and re-spends quota.
    expect(goodQuery("ｃｌｉｍａｔｅ").fingerprint).toBe(goodQuery("climate").fingerprint);
  });

  it("rejects input that normalizes to nothing", () => {
    const result = canonicalize({ q: "   " }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.q).toBeDefined();
  });

  it("rejects rather than truncates when there are too many terms", () => {
    // Silently dropping terms would fingerprint a DIFFERENT query than the
    // user typed — two users' distinct searches colliding on one topic.
    const result = canonicalize({ q: "a b c d e f g h i" }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.q).toMatch(/term/i);
  });
});

describe("filter validation against the reference lists", () => {
  it("catches a bad language locally instead of spending quota on a 400", () => {
    const result = canonicalize({ q: "climate", language: "xx" }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.language).toBeDefined();
  });

  it("defaults language rather than letting 'unset' mean 'all mixed together'", () => {
    // Omitting language upstream returns every language mixed — "all" must be
    // an explicit choice, never the accident of leaving a field unset (§6.1).
    expect(goodQuery("climate").language).toBe("en");
    expect(goodQuery("climate", { language: "all" }).language).toBeNull();
    expect(goodQuery("climate").fingerprint).toBe(
      goodQuery("climate", { language: "en" }).fingerprint,
    );
    expect(goodQuery("climate", { language: "all" }).fingerprint).not.toBe(
      goodQuery("climate").fingerprint,
    );
  });

  it("validates country and category the same way", () => {
    const badCountry = canonicalize({ q: "x", country: "zz" }, options);
    const badCategory = canonicalize({ q: "x", category: "nope" }, options);
    expect(badCountry.ok).toBe(false);
    expect(badCategory.ok).toBe(false);
    if (!badCountry.ok) expect(badCountry.errors.country).toBeDefined();
    if (!badCategory.ok) expect(badCategory.errors.category).toBeDefined();

    expect(goodQuery("x", { country: "us", category: "technology" }).country).toBe("us");
  });
});

describe("the window is a view, never part of the identity", () => {
  it("excludes from/to from the fingerprint", () => {
    // A topic is a durable entity; the window is a view onto it. This is what
    // lets an older request and a newer one feed one accumulating timeline (§6.2).
    const a = goodQuery("climate", { from: new Date("2026-08-01T00:00:00Z") });
    const b = goodQuery("climate", { to: new Date("2026-08-05T00:00:00Z") });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("snaps the window OUTWARD to the 15-minute grid", () => {
    // Unsnapped `to = now` makes every request a unique cache key and defeats
    // caching entirely (§6.2). Outward, so the snap never narrows the ask.
    const query = goodQuery("climate", {
      from: new Date("2026-08-08T10:07:00.000Z"),
      to: new Date("2026-08-09T10:07:00.000Z"),
    });
    expect(query.window.from.toISOString()).toBe("2026-08-08T10:00:00.000Z");
    expect(query.window.to.toISOString()).toBe("2026-08-09T10:15:00.000Z");
  });

  it("leaves an already-aligned window untouched", () => {
    const query = goodQuery("climate", {
      from: new Date("2026-08-08T10:00:00.000Z"),
      to: new Date("2026-08-09T10:15:00.000Z"),
    });
    expect(query.window.from.toISOString()).toBe("2026-08-08T10:00:00.000Z");
    expect(query.window.to.toISOString()).toBe("2026-08-09T10:15:00.000Z");
  });

  it("defaults to the full lookback ending now, snapped", () => {
    const query = goodQuery("climate");
    // to: NOW (14:07:33) ceiled to 14:15; from: 30 days earlier, floored.
    expect(query.window.to.toISOString()).toBe("2026-08-10T14:15:00.000Z");
    expect(query.window.from.toISOString()).toBe("2026-07-11T14:00:00.000Z");
  });

  it("rejects an inverted window", () => {
    const result = canonicalize(
      {
        q: "climate",
        from: new Date("2026-08-09T00:00:00Z"),
        to: new Date("2026-08-08T00:00:00Z"),
      },
      options,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.from).toBeDefined();
  });
});

describe("the fingerprint is a stable, documented serialization", () => {
  it("hashes the canonical JSON of {category, country, keywords, language}", () => {
    // Pinned on purpose: the serialization IS the topic identity, shared by
    // every replica. An innocent key reorder or field addition silently
    // orphans every stored topic, so drift must fail a test, not a user.
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          category: null,
          country: null,
          keywords: ["climate"],
          language: "en",
        }),
      )
      .digest("hex");

    expect(goodQuery("climate").fingerprint).toBe(expected);
  });
});
