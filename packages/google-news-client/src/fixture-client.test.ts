import { describe, expect, it } from "vitest";
import {
  NewsInvalidQueryError,
  altKeyProbe,
  altKeyProbeIsConsistent,
  deriveAltKey,
  sourceDomain,
} from "@zammy/news-client";
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
   * ADR-0018 recorded the hole this block was written to size: `deriveAltKey`
   * peeled a trailing ` - Outlet` only when the outlet's display name collapsed
   * to its domain stem, and **Google News writes the display name** where
   * Currents ships the outlet's own `<title>` tag. For every outlet where those
   * differed, a Google item and its Currents twin folded to different keys and
   * minted two rows.
   *
   * **G5 closed most of it, and these assertions moved with it.** Four rules
   * replaced the exact stem match — the domain being one END of the display
   * name, an initialism of its content words, leading initials plus trailing
   * words, and the reverse affix — chosen on a held-out split of a purpose-built
   * corpus (`fixtures/google-news-source-names.tsv`, 6,008 items over 1,837
   * outlets). `stripOutletSuffix` carries the experiment; this file carries what
   * the change did to THESE captures, which is the only place the two numbers
   * can be compared on identical input.
   *
   * **Read the number with its caveat, which is larger than the number.** These
   * captures are one query — `"bank of canada"` — so the corpus is dominated by
   * market-data and PR outlets whose display name IS their domain stem
   * (`marketbeat.com` "MarketBeat", `tradingview.com` "TradingView": 47 of 120
   * items between them). It was a floor from a favourable sample before the
   * change and it still is; its value is the DELTA, not the level.
   *
   * ## The numbers G5 and G6 should actually plan against
   *
   * All against `deriveAltKey` as shipped, before the four rules and after:
   *
   * ```
   *                                                    before    after
   * item-weighted, this fixture corpus (120 items)       8.3%     4.2%
   * item-weighted, the G5 corpus (6,008 items)          24.4%     6.7%
   * item-weighted, held-out half of it (2,889 items)    26.2%     6.9%
   * pair-weighted, the G5 corpus (1,838 pairs)          30.8%    11.8%
   * ```
   *
   * The held-out row is the one to plan against: it is the only one measured on
   * queries the rules were not built from. **~7% of the deepening plane's items
   * still fail to fold onto their Currents twin**, down from a quarter, and what
   * is left is mastheads in another script and names with no lexical relation to
   * their domain at all — neither of which a rule can reach.
   *
   * Item-weighted beats pair-weighted throughout because high-volume outlets
   * disproportionately self-name. Which one a caller wants depends on whether it
   * is counting articles or newsrooms.
   */
  it("folds for 115 of 120 items here — the floor, not the planning number", async () => {
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
    // 110 before G5's four rules, 115 after: five of the ten failures on this
    // corpus were reachable by a rule. A small delta on a sample chosen for
    // being favourable — the honest read is the corpus-wide 24.4% -> 6.7%.
    expect(folds).toBe(115);
    for (const page of pages) expect(page.normalization.dropped.no_identity).toBe(0);
  });

  /**
   * The invariant `altKeyProbe`'s neighbours rest on (ADR-0022), asserted where
   * it is most likely to break: this is the one adapter whose key is NOT derived
   * from its own `url`, so `deriveAltKey(sourceDomain, title, published)` and
   * `altKey` agreeing here is a real claim rather than a tautology.
   */
  it("re-derives every item's alt key from the fields the item stored", async () => {
    const gn = await client();
    const pages = [
      await gn.search({ keywords: ["x"], ...CAPPED_WINDOW }),
      await gn.search({ keywords: ["x"], ...DEEP_WINDOW }),
    ];
    const sightings = pages.flatMap((page) => page.sightings);

    expect(sightings).toHaveLength(120);
    let widened = 0;
    for (const sighting of sightings) {
      expect(altKeyProbeIsConsistent(sighting)).toBe(true);
      // And the lookup widens only where the stamp says it may.
      expect(altKeyProbe(sighting)).toHaveLength(sighting.publishedIsDateOnly ? 3 : 1);
      if (sighting.publishedIsDateOnly) widened += 1;
    }

    // Counted, not assumed, because the conditional above is only a real
    // assertion if BOTH branches are taken — and a reader who believes these
    // captures predate the cliff would "simplify" it to `toHaveLength(1)` and
    // silence the only fixture-level guard the widening has. 29 of the 120
    // carry a midnight-Pacific stamp: all 20 of the deep window at 08:00:00 GMT
    // (a PST capture) and 9 of the capped window's 100 at 07:00:00 GMT.
    expect(widened).toBe(29);
  });

  /**
   * **Every display name below is one Google was OBSERVED emitting**, read out
   * of `<source>` elements in live feeds (2026-08-28). That property is the
   * whole point of this test: an invented name asserts the fold against a string
   * no provider sends, which is a test of nothing.
   *
   * It is also how an earlier version of this test was wrong. It borrowed
   * ADR-0018's masthead spellings, and Google abbreviates mastheads:
   *
   *     ADR-0018 assumed        Google actually emits
   *     "BBC News"              "BBC"         → folds
   *     "CBC News"              "CBC"         → folds
   *     "The Wall Street Journal"  "WSJ"      → folds
   *     "Al Jazeera English"    "Al Jazeera"  → folds
   *
   * **G5 then moved the line again**, and this test is where to see by how much.
   * Of the four outlets this block asserted did NOT fold, three now do — and
   * each by a different one of the new rules, which is why they are kept here
   * rather than deleted:
   *
   *     nytimes.com  "The New York Times"    initials + tail  (ny + times)
   *     ft.com       "Financial Times"       initialism       (f + t)
   *     ecfr.eu      "European Council on Foreign Relations"  initialism
   *
   * What still does not fold is the residue no rule reaches, and the four below
   * are one example of each shape it takes.
   */
  it("folds every observed masthead, and refuses the four shapes no rule reaches", () => {
    const published = "2026-08-20T12:00:00.000Z";
    const strips = (domain: string, display: string) =>
      deriveAltKey(domain, `Some headline - ${display}`, published) ===
      deriveAltKey(domain, "Some headline", published);

    for (const [domain, display] of [
      // The display name IS the domain stem — the rule that already shipped.
      ["theguardian.com", "The Guardian"],
      ["reuters.com", "Reuters"],
      ["theglobeandmail.com", "The Globe and Mail"],
      ["npr.org", "NPR"],
      ["cnn.com", "CNN"],
      ["bbc.co.uk", "BBC"],
      ["cbc.ca", "CBC"],
      ["wsj.com", "WSJ"],
      ["aljazeera.com", "Al Jazeera"],
      // The three G5 recovered, one per rule.
      ["nytimes.com", "The New York Times"],
      ["ft.com", "Financial Times"],
      ["ecfr.eu", "European Council on Foreign Relations"],
      // And two more from the harvested corpus, on the affix rule.
      ["apa.org", "American Psychological Association (APA)"],
      ["asia.nikkei.com", "Nikkei Asia"],
    ] as const) {
      expect(strips(domain, display), `${domain} should strip`).toBe(true);
    }

    // The residue, and each is a different reason no rule reaches it. These are
    // the outlets whose Google item still mints a second article rather than
    // folding onto the Currents one — ~7% of items on held-out data.
    for (const [domain, display] of [
      // A masthead in another script. Only a romanisation table connects these,
      // which is the one thing a display-name map would do better.
      ["chosun.com", "조선일보"],
      // A name with no lexical relation to the domain at all.
      ["umn.edu", "CIDRAP"],
      ["wave3.com", "WAVE News"],
      // The words are all there and in the wrong order: `indiatimes.com` spells
      // "The Times of India" backwards. A permutation rule was built for exactly
      // this and rejected — it earned 6 items on held-out data, against a
      // factorial search.
      ["indiatimes.com", "The Times of India"],
      // And a display name that is itself a sentence, so the last delimiter
      // segment is a fragment of prose rather than a name.
      ["abcnews.com", "ABC News - Breaking News, Latest News and Videos"],
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
