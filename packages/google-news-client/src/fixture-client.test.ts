import { describe, expect, it } from "vitest";
import { NewsInvalidQueryError, deriveAltKey, sourceDomain } from "@zammy/news-client";
import { FixtureGoogleNewsClient } from "./fixture-client.js";
import { GoogleNewsFixtureStore } from "./fixture-store.js";
import { ITEMS_PER_QUERY } from "./raw.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * The recorded feeds, read end to end through the same parser and the same
 * mapping the live client uses.
 *
 * These are genuine live captures, so this file is where the claims made about
 * the endpoint stop being comments and become assertions against real bytes:
 * the cap, the depth, the suffix on every title, the publisher hidden in
 * `<source url>`, and the fields that are simply not there.
 *
 * Fixture mode also matters more here than for either other adapter. This
 * provider has no key, no published ceiling and no rate-limit header, so there
 * is no number that would tell us when we had asked too often — every call a
 * developer does not make against it is a cost we would otherwise be unable to
 * measure.
 */

/**
 * The real caps, and a deliberately unreachable horizon.
 *
 * `FixtureGoogleNewsClient` clamps against the wall clock and takes no injected
 * one, so a realistic 730 here would quietly start pulling the Feb-2025 window
 * forward in early 2027 and these assertions would fail on a date rather than
 * on a change. What this file is testing is the parsing, the cap and the
 * mapping; the lookback clamp is tested against a pinned clock in http.test.ts.
 */
const limits = {
  maxPageSize: ITEMS_PER_QUERY,
  maxRetrievableResults: ITEMS_PER_QUERY,
  maxLookbackDays: 36_500,
  maxRangeDays: 36_500,
};

/** The two windows the fixtures were captured over. */
const CAPPED_WINDOW = {
  startDate: new Date("2026-08-19T00:00:00.000Z"),
  endDate: new Date("2026-08-23T00:00:00.000Z"),
};
const DEEP_WINDOW = {
  startDate: new Date("2025-01-31T00:00:00.000Z"),
  endDate: new Date("2025-02-04T00:00:00.000Z"),
};

async function client(): Promise<FixtureGoogleNewsClient> {
  const store = new GoogleNewsFixtureStore(FIXTURES_DIR);
  await store.load();
  return new FixtureGoogleNewsClient(store, limits, { dailyLimit: 200, burstLimit: 5 });
}

describe("the recorded feeds", () => {
  it("parse and normalize with nothing dropped", async () => {
    const result = await (await client()).search({ keywords: ["bank", "of", "canada"] });

    expect(result.sightings.length).toBeGreaterThan(0);
    expect(result.normalization.kept).toBe(result.normalization.received);
  });

  it("tag every sighting as google-news, with a derived uuid", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(sighting.provider).toBe("google-news");
      expect(sighting.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("refuse to load from a directory with no fixture", async () => {
    await expect(new GoogleNewsFixtureStore("/nonexistent").load()).rejects.toThrow(
      /google-news-search-capped\.xml/,
    );
  });
});

describe("the 100-item cap, against the real capture", () => {
  it("returns exactly the cap for the window that hit it, and says subdivide", async () => {
    // The capture is what a capped window looks like: `"bank of canada"
    // after:2026-08-20 before:2026-08-22` returned 100 items with no offset
    // parameter to get past them.
    const result = await (await client()).search({ keywords: ["x"], ...CAPPED_WINDOW });

    expect(result.rawCount).toBe(ITEMS_PER_QUERY);
    expect(result.isLastPage).toBe(false);
  });

  it("ends the window for the capture that came back short", async () => {
    const result = await (await client()).search({ keywords: ["x"], ...DEEP_WINDOW });

    expect(result.rawCount).toBe(20);
    expect(result.isLastPage).toBe(true);
  });
});

describe("depth past Currents' horizon", () => {
  it("holds articles 18 months old, from many newsrooms at once", async () => {
    // 573 days before the capture date, which is ~19x Currents' verified
    // 30-day lookback — and the breadth is the point as much as the depth.
    const result = await (await client()).search({ keywords: ["x"], ...DEEP_WINDOW });
    const domains = new Set(result.sightings.map((s) => s.sourceDomain));

    for (const sighting of result.sightings) {
      expect(new Date(sighting.published).getUTCFullYear()).toBe(2025);
    }
    expect(domains.size).toBeGreaterThanOrEqual(15);
  });
});

describe("what every real item carries", () => {
  it("has the trailing ' - Outlet' suffix on essentially all of them", async () => {
    // 100 of 101 in the survey. Measured here on the capture rather than
    // asserted from the doc — and asserted to be PRESENT, because stripping it
    // is G0's job and an adapter doing it early would hide the damage G0 exists
    // to fix.
    const result = await (await client()).search({ keywords: ["x"] });
    const suffixed = result.sightings.filter((s) => / - .+$/.test(s.title));

    expect(result.sightings.length).toBeGreaterThan(50);
    expect(suffixed.length / result.sightings.length).toBeGreaterThan(0.95);
  });

  it("attributes to the publisher, never to Google", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(sighting.url).toContain("news.google.com");
      expect(sighting.sourceDomain).not.toBeNull();
      expect(sighting.sourceDomain).not.toBe("google.com");
      // The departure, on real data: the stored domain disagrees with the one
      // the stored URL would produce, on every single row.
      expect(sighting.sourceDomain).not.toBe(sourceDomain(sighting.url));
    }
  });

  it("names real newsrooms, enough of them to be worth the call", async () => {
    const result = await (await client()).search({ keywords: ["x"], ...CAPPED_WINDOW });
    const domains = new Set(result.sightings.map((s) => s.sourceDomain));

    expect(domains.size).toBeGreaterThanOrEqual(25);
    expect(domains).toContain("theglobeandmail.com");
  });

  it("has no description, no author and no image on any of them", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(sighting.description).toBeNull();
      expect(sighting.author).toBeNull();
      expect(sighting.imageUrl).toBeNull();
    }
  });

  it("carries a real publication time on every one", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(Number.isNaN(Date.parse(sighting.published))).toBe(false);
    }
  });
});

describe("how often the fold actually works, measured on the captures", () => {
  /**
   * The number G5 and G6 need, and nobody else is positioned to measure it.
   *
   * ADR-0018 records the hole: `deriveAltKey` peels a trailing ` - Outlet` only
   * when the outlet's display name collapses to its domain stem, and **Google
   * News writes the display name** where Currents ships the outlet's own
   * `<title>` tag. For every outlet where those differ, a Google item and its
   * Currents twin fold to different keys and mint two rows. ADR-0018 deferred
   * the fix — a display-name-to-domain map — to the phase that first has a
   * corpus of Google titles. This is that corpus; building the map is still out
   * of scope, but measuring the hole is not.
   *
   * **Read the number with its caveat, which is larger than the number.** These
   * captures are one query — `"bank of canada"` — so the corpus is dominated by
   * market-data and PR outlets whose display name IS their domain stem
   * (`marketbeat.com` "MarketBeat", `tradingview.com` "TradingView": 47 of 120
   * items between them). It is a floor from a favourable sample.
   *
   * ## The numbers G5 and G6 should actually plan against
   *
   * Four measurements, all against `deriveAltKey` as shipped. They disagree,
   * and the disagreement is the finding rather than noise:
   *
   * ```
   *  8.3%  fail   item-weighted, this fixture corpus        10 / 120 items
   * 30.7%  fail   item-weighted, two general-news queries   62 / 202 items
   * 34.6%  fail   outlet-weighted, pairs observed here      56 / 162 outlets
   * 34.6%  fail   outlet-weighted, a 561-outlet harvest    194 / 561 outlets
   * ```
   *
   * The last is a separate, larger harvest run during review; the third is this
   * session's own, from the fixture captures plus two general-news probes. Two
   * independent samples landing on the same figure to one decimal is worth more
   * than either alone.
   *
   * **Plan against ~35% at outlet level, ~31% at item level.** The item-weighted
   * rate is better than the outlet-weighted one because high-volume outlets
   * disproportionately self-name, and this fixture's 8.3% is better again only
   * because a finance query is nearly all such outlets. Which of the two a
   * caller wants depends on whether it is counting articles or newsrooms; the
   * gap between 8.3% and 30.7% is how much a single query's subject can move it.
   *
   * A third of the deepening plane's articles failing to fold onto their
   * Currents twin is the accepted cost ADR-0018 named, now with a size on it.
   * The fix is a display-name-to-domain map and it is still out of scope here.
   */
  it("folds for 110 of 120 items here — the floor, not the planning number", async () => {
    // Both windows, because one search cannot see all 120: the cap truncates
    // at 100, which is itself the behaviour asserted two blocks down.
    const gn = await client();
    const pages = [
      await gn.search({ keywords: ["x"], ...CAPPED_WINDOW }),
      await gn.search({ keywords: ["x"], ...DEEP_WINDOW }),
    ];
    const sightings = pages.flatMap((page) => page.sightings);

    let folds = 0;
    for (const sighting of sightings) {
      // What the same story would key as if it arrived with a clean headline —
      // i.e. from Currents, for an outlet that does not append its own name.
      const bare = /^(.*\S)\s+[|\-\u2013\u2014]\s+\S.*$/u.exec(sighting.title)?.[1];
      const twin = deriveAltKey(sighting.sourceDomain, bare ?? sighting.title, sighting.published);
      if (sighting.altKey === twin) folds += 1;
    }

    expect(sightings).toHaveLength(120);
    expect(folds).toBe(110);
    for (const page of pages) expect(page.normalization.dropped.no_identity).toBe(0);
  });

  /**
   * **Every display name below is one Google was OBSERVED emitting**, read out
   * of `<source>` elements in live feeds (2026-08-28, two general-news
   * queries). That property is the whole point of this test: an invented name
   * asserts the fold against a string no provider sends, which is a test of
   * nothing.
   *
   * It is also how the earlier version of this test was wrong. It borrowed
   * ADR-0018's masthead spellings, and Google abbreviates mastheads:
   *
   *     ADR-0018 assumed        Google actually emits
   *     "BBC News"              "BBC"         → folds
   *     "CBC News"              "CBC"         → folds
   *     "The Wall Street Journal"  "WSJ"      → folds
   *     "Al Jazeera English"    "Al Jazeera"  → folds
   *     "The New York Times"    "The New York Times"   → still does not
   *
   * Four of the seven supposed failures fold on real data. `indiatimes.com` is
   * dropped from the probe rather than corrected, because its real display name
   * was never observed and guessing one is the mistake being fixed.
   *
   * The corrected picture is roughly the INVERSE of what the invented names
   * implied: major outlets mostly fold, and the failures are the long tail
   * whose display name is a full organisation name rather than a masthead.
   */
  it("9 of 13 observed outlets strip, and the failures are the long tail", () => {
    const published = "2026-08-20T12:00:00.000Z";
    const strips = (domain: string, display: string) =>
      deriveAltKey(domain, `Some headline - ${display}`, published) ===
      deriveAltKey(domain, "Some headline", published);

    // The display name collapses to the domain stem, loosely compared.
    for (const [domain, display] of [
      ["theguardian.com", "The Guardian"],
      ["reuters.com", "Reuters"],
      ["theglobeandmail.com", "The Globe and Mail"],
      ["npr.org", "NPR"],
      ["cnn.com", "CNN"],
      ["bbc.co.uk", "BBC"],
      ["cbc.ca", "CBC"],
      ["wsj.com", "WSJ"],
      ["aljazeera.com", "Al Jazeera"],
    ] as const) {
      expect(strips(domain, display), `${domain} should strip`).toBe(true);
    }

    // It expands the stem, or is a full organisation name. Each of these is an
    // outlet whose Google item mints a second article rather than folding onto
    // the Currents one.
    for (const [domain, display] of [
      ["nytimes.com", "The New York Times"],
      ["ft.com", "Financial Times"],
      ["abcnews.com", "ABC News - Breaking News, Latest News and Videos"],
      ["ecfr.eu", "European Council on Foreign Relations"],
    ] as const) {
      expect(strips(domain, display), `${domain} should NOT strip`).toBe(false);
    }
  });
});

describe("domain scoping, which this adapter answers rather than refuses", () => {
  it("narrows to one publisher, subdomains folded in", async () => {
    // `site:` works upstream (measured: `q=housing site:cbc.ca` → 100 items, 2
    // domains, against 75 for the control), and it matches subdomains. Both
    // fold to the registrable domain, so every row a scoped fetch produces is
    // attributed to the domain that was asked for.
    const result = await (await client()).search({
      keywords: ["x"],
      domain: "theglobeandmail.com",
    });

    expect(result.sightings.length).toBeGreaterThan(0);
    for (const sighting of result.sightings) {
      expect(sighting.sourceDomain).toBe("theglobeandmail.com");
    }
  });

  it("returns an empty, finished window for a publisher not in the capture", async () => {
    const result = await (await client()).search({ keywords: ["x"], domain: "example.com" });

    expect(result.rawCount).toBe(0);
    expect(result.isLastPage).toBe(true);
  });
});

describe("it refuses what the live client refuses", () => {
  it("rejects a second page, tagged with the provider", async () => {
    await expect(
      (await client()).search({ keywords: ["x"], pageNumber: 2 }),
    ).rejects.toMatchObject({ provider: "google-news" });
  });

  it("rejects a category, which upstream silently discards", async () => {
    await expect(
      (await client()).search({ keywords: ["x"], category: "business" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });

  it("rejects a domain that is not a hostname", async () => {
    await expect(
      (await client()).search({ keywords: ["x"], domain: "cbc.ca OR bbc.co.uk" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });

  it("rejects a keyword-less sweep", async () => {
    await expect((await client()).search({})).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });
});

describe("quota", () => {
  it("is null, as it would be live", async () => {
    // Unlike every other adapter, this is not merely "no call was made" — a
    // live call would report nothing either.
    const result = await (await client()).search({ keywords: ["x"] });

    expect(result.quota).toBeNull();
  });
});
