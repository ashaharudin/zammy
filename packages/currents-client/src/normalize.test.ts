import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  deriveDedupKey,
  normalizeSighting,
  normalizeSightings,
  normalizeImage,
  parsePublished,
  sourceDomain,
} from "./normalize.js";
import { RawSighting } from "./raw.js";
import { FIXTURES_DIR, rawSighting } from "./test-support.js";

/**
 * Normalization, tested against the recorded payloads (ARCHITECTURE 5.2).
 *
 * Synthetic sightings are exactly what would hide these bugs: a hand-written
 * fixture has a valid ISO timestamp, a real image URL and no duplicates, so it
 * exercises none of the three things this code exists to absorb.
 */

function loadRaw(file: string, extract: (data: never) => unknown[]): RawSighting[] {
  const data = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as never;
  return extract(data).map((item) => RawSighting.parse(item));
}

const duplicates = loadRaw("search-climate-duplicates.json", (data: never) =>
  (data as { pages: Array<{ news: unknown[] }> }).pages.flatMap((page) => page.news),
);
const sample = loadRaw("search-keywordless-category-sample.json", (data: never) =>
  (data as { calls: Array<{ news: unknown[] }> }).calls.flatMap((call) => call.news),
);
const allRaw = [...duplicates, ...sample];

describe("recorded payloads normalize cleanly", () => {
  it("keeps every sighting upstream actually sent", () => {
    // A drop here means the normalizer and the shared contract disagree about
    // real data — the timeline would silently thin, with no error anywhere.
    const { sightings, stats } = normalizeSightings(allRaw);

    expect(stats.received).toBe(180);
    expect(stats.kept).toBe(180);
    expect(sightings).toHaveLength(180);
    expect(stats.dropped).toEqual({
      no_title: 0,
      no_url: 0,
      bad_url: 0,
      bad_published: 0,
      schema: 0,
    });
  });

  it("turns the literal string \"None\" into null", () => {
    // 47 of the 180 recorded sightings carry image: "None". Rendered as a src
    // attribute that is a broken-image icon on every fourth card.
    const noneCount = allRaw.filter((sighting) => sighting.image === "None").length;
    expect(noneCount).toBeGreaterThan(0);

    const { sightings } = normalizeSightings(allRaw);
    expect(sightings.filter((sighting) => sighting.imageUrl === null)).toHaveLength(
      noneCount,
    );
    expect(sightings.every((sighting) => sighting.imageUrl !== "None")).toBe(true);
  });

  it("emits ISO-8601 timestamps from the upstream's non-ISO format", () => {
    const { sightings } = normalizeSightings(allRaw);
    for (const sighting of sightings) {
      expect(sighting.published).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});

describe("the original payload travels with the sighting", () => {
  it("carries the raw upstream item verbatim, unknown fields included", () => {
    // Storage keeps the original payload (sightings.raw, ARCHITECTURE 7.2) so a
    // widened canonicalization rule can re-normalize history without refetching —
    // upstream only reaches back 30 days, so a refetch is often impossible. That
    // only works if normalization never strips fields it doesn't recognize.
    const { sightings } = normalizeSightings(allRaw);

    for (const [index, sighting] of sightings.entries()) {
      expect(sighting.raw).toEqual(allRaw[index]);
    }

    // The undocumented field the spec omits must survive into `raw` too.
    const withSourceCategory = sightings.find(
      (sighting) => (sighting.raw as RawSighting).source_category?.length,
    );
    expect(withSourceCategory).toBeDefined();
  });
});

describe("dedup keys over the duplication fixture", () => {
  // The headline probe finding: 100 sightings, 100 unique ids, 42 unique URLs,
  // one link-roundup page appearing 50 times (PROBE-FINDINGS 4). The
  // sighting→article collapse itself is Phase 2, but the key it groups
  // sightings by is produced here, so it is tested here.
  const { sightings } = normalizeSightings(duplicates);

  it("collapses 100 sightings onto 42 keys", () => {
    expect(sightings).toHaveLength(100);
    expect(new Set(sightings.map((sighting) => sighting.id)).size).toBe(100);
    expect(new Set(sightings.map((sighting) => sighting.dedupKey)).size).toBe(42);
  });

  it("neither over- nor under-collapses: 42 raw URLs → 42 keys", () => {
    const rawUrls = new Set(duplicates.map((sighting) => sighting.url));
    expect(rawUrls.size).toBe(42);
    expect(new Set(sightings.map((sighting) => sighting.dedupKey)).size).toBe(rawUrls.size);
  });

  it("finds the post that occupies half the retrievable depth", () => {
    const counts = new Map<string, number>();
    for (const sighting of sightings) {
      counts.set(sighting.dedupKey, (counts.get(sighting.dedupKey) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBe(50);
  });

  it("gives identical keys to sightings sharing a URL under different ids", () => {
    const byKey = new Map<string, Set<string>>();
    for (const sighting of sightings) {
      const ids = byKey.get(sighting.dedupKey) ?? new Set();
      ids.add(sighting.id);
      byKey.set(sighting.dedupKey, ids);
    }
    const biggest = [...byKey.values()].sort((a, b) => b.size - a.size)[0]!;
    expect(biggest.size).toBe(50);
  });
});

describe("canonicalizeUrl", () => {
  it("is the exact input to the dedup key", () => {
    const url = canonicalizeUrl("https://example.com/story")!;
    expect(deriveDedupKey(url)).toBe(
      createHash("sha256").update(url).digest("hex"),
    );
  });

  it("strips the fragment", () => {
    expect(canonicalizeUrl("https://example.com/story#comments")).toBe(
      "https://example.com/story",
    );
  });

  it("strips tracking parameters but keeps meaningful ones", () => {
    expect(
      canonicalizeUrl("https://example.com/story?utm_source=x&id=7&fbclid=abc"),
    ).toBe("https://example.com/story?id=7");
  });

  it("drops a dangling question mark once the last tracking param goes", () => {
    expect(canonicalizeUrl("https://example.com/story?utm_source=x")).toBe(
      "https://example.com/story",
    );
  });

  it("trims the trailing slash so /story and /story/ are one article", () => {
    expect(canonicalizeUrl("https://example.com/story/")).toBe(
      canonicalizeUrl("https://example.com/story"),
    );
  });

  it("lowercases scheme and host but not the path", () => {
    // Paths are case-sensitive on most servers; hosts never are.
    expect(canonicalizeUrl("HTTPS://Example.COM/Story")).toBe(
      "https://example.com/Story",
    );
  });

  it("accepts protocol-relative URLs", () => {
    expect(canonicalizeUrl("//example.com/story")).toBe("https://example.com/story");
  });

  it("rejects anything that is not http(s)", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("ftp://example.com/x")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("")).toBeNull();
  });

  it("does NOT strip www, because over-collapsing destroys sightings", () => {
    expect(canonicalizeUrl("https://www.example.com/story")).not.toBe(
      canonicalizeUrl("https://example.com/story"),
    );
  });
});

describe("sourceDomain", () => {
  it("strips www, unlike the dedup key", () => {
    expect(sourceDomain("https://www.news24.com/x")).toBe("news24.com");
  });

  it("keeps three labels for registries that sell at the third level", () => {
    expect(sourceDomain("https://www.perthnow.com.au/x")).toBe("perthnow.com.au");
    expect(sourceDomain("https://news.bbc.co.uk/x")).toBe("bbc.co.uk");
  });

  it("takes two labels otherwise, collapsing subdomains onto one source", () => {
    expect(sourceDomain("https://timesofindia.indiatimes.com/x")).toBe(
      "indiatimes.com",
    );
    expect(sourceDomain("https://news.rthk.hk/x")).toBe("rthk.hk");
    expect(sourceDomain("https://www.cbc.ca/x")).toBe("cbc.ca");
  });

  it("resolves every recorded sighting to a domain", () => {
    const { sightings } = normalizeSightings(allRaw);
    expect(sightings.every((sighting) => sighting.sourceDomain !== null)).toBe(true);
  });
});

describe("normalizeImage", () => {
  it("nulls the values upstream uses for absence", () => {
    expect(normalizeImage("None")).toBeNull();
    expect(normalizeImage("none")).toBeNull();
    expect(normalizeImage("null")).toBeNull();
    expect(normalizeImage("")).toBeNull();
    expect(normalizeImage("   ")).toBeNull();
    expect(normalizeImage(null)).toBeNull();
    expect(normalizeImage(undefined)).toBeNull();
  });

  it("https-prefixes protocol-relative image URLs", () => {
    expect(normalizeImage("//cdn.example.com/a.jpg")).toBe(
      "https://cdn.example.com/a.jpg",
    );
  });

  it("nulls an unparseable value rather than passing it through", () => {
    expect(normalizeImage("not-a-url")).toBeNull();
  });
});

describe("drop rules", () => {
  const drop = (overrides: Record<string, unknown>): string => {
    const outcome = normalizeSighting(RawSighting.parse(rawSighting(overrides)));
    if (outcome.ok) throw new Error("expected the sighting to be dropped");
    return outcome.reason;
  };

  it("drops an sighting with no usable title", () => {
    expect(drop({ title: "   " })).toBe("no_title");
    expect(drop({ title: null })).toBe("no_title");
  });

  it("drops an sighting with no link", () => {
    expect(drop({ url: null })).toBe("no_url");
  });

  it("drops an sighting whose link cannot be parsed", () => {
    expect(drop({ url: "not a url" })).toBe("bad_url");
  });

  it("drops an unparseable timestamp rather than defaulting it to now", () => {
    // The one case where a guess would be worse than a loss: a wrong timestamp
    // silently corrupts the timeline, which is the product's core promise.
    expect(drop({ published: "yesterday" })).toBe("bad_published");
    expect(drop({ published: "" })).toBe("bad_published");
  });

  it("drops an id that is not a UUID, as the shared contract requires", () => {
    // Upstream sends UUID strings despite the spec declaring `integer`, and all
    // 180 recorded sightings comply. Something else would mean the contract and
    // reality have diverged — a fact worth a metric, not a silent coercion.
    expect(drop({ id: "42" })).toBe("schema");
  });

  it("keeps the rest of the batch when one sighting is malformed", () => {
    const { sightings, stats } = normalizeSightings([
      RawSighting.parse(rawSighting()),
      RawSighting.parse(
        rawSighting({ id: "6f1e2d3c-4b5a-4968-8877-665544332211", published: "nonsense" }),
      ),
      RawSighting.parse(
        rawSighting({
          id: "11223344-5566-4778-899a-bbccddeeff00",
          url: "https://example.com/other",
        }),
      ),
    ]);

    expect(sightings).toHaveLength(2);
    expect(stats.received).toBe(3);
    expect(stats.dropped.bad_published).toBe(1);
  });
});

describe("field normalization", () => {
  const normalize = (overrides: Record<string, unknown> = {}) => {
    const outcome = normalizeSighting(RawSighting.parse(rawSighting(overrides)));
    if (!outcome.ok) throw new Error(`unexpectedly dropped: ${outcome.reason}`);
    return outcome.sighting;
  };

  it("collapses whitespace in title and description", () => {
    const sighting = normalize({
      title: "  A   headline\nwith  breaks ",
      description: "\tspaced   out\n",
    });
    expect(sighting.title).toBe("A headline with breaks");
    expect(sighting.description).toBe("spaced out");
  });

  it("turns empty description and author into null, not empty strings", () => {
    const sighting = normalize({ description: "  ", author: null });
    expect(sighting.description).toBeNull();
    expect(sighting.author).toBeNull();
  });

  it("lowercases and de-duplicates categories", () => {
    const sighting = normalize({ category: ["News", "news", "WORLD"] });
    expect(sighting.categories).toEqual(["news", "world"]);
  });

  it("keeps source_category verbatim, since we do not know what it means", () => {
    const sighting = normalize({ source_category: ["Tech", "CS"] });
    expect(sighting.sourceCategories).toEqual(["Tech", "CS"]);
  });

  it("prefers `url` but accepts the spec's `urls`", () => {
    expect(normalize({ url: null, urls: "https://example.com/via-urls" }).url).toBe(
      "https://example.com/via-urls",
    );
  });
});

describe("parsePublished", () => {
  it("parses the upstream's format", () => {
    expect(parsePublished("2026-08-04 20:45:56 +0000")).toBe(
      Date.UTC(2026, 7, 4, 20, 45, 56),
    );
  });

  it("applies a positive offset by subtracting it", () => {
    expect(parsePublished("2026-08-04 20:45:56 +0200")).toBe(
      Date.UTC(2026, 7, 4, 18, 45, 56),
    );
  });

  it("applies a negative offset", () => {
    expect(parsePublished("2026-08-04 20:45:56 -0500")).toBe(
      Date.UTC(2026, 7, 5, 1, 45, 56),
    );
  });

  it("handles a colon-separated offset and a T separator", () => {
    expect(parsePublished("2026-08-04T20:45:56 +05:30")).toBe(
      Date.UTC(2026, 7, 4, 15, 15, 56),
    );
  });

  it("returns NaN rather than guessing", () => {
    expect(Number.isNaN(parsePublished("not a date"))).toBe(true);
    expect(Number.isNaN(parsePublished(""))).toBe(true);
    expect(Number.isNaN(parsePublished("2026-08-04"))).toBe(true);
  });
});
