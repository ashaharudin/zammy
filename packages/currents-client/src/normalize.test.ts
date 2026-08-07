import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  deriveDedupKey,
  normalizeArticle,
  normalizeArticles,
  normalizeImage,
  parsePublished,
  sourceDomain,
} from "./normalize.js";
import { RawArticle } from "./raw.js";
import { FIXTURES_DIR, rawArticle } from "./test-support.js";

/**
 * Normalization, tested against the recorded payloads (ARCHITECTURE 5.2).
 *
 * Synthetic articles are exactly what would hide these bugs: a hand-written
 * fixture has a valid ISO timestamp, a real image URL and no duplicates, so it
 * exercises none of the three things this code exists to absorb.
 */

function loadRaw(file: string, extract: (data: never) => unknown[]): RawArticle[] {
  const data = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as never;
  return extract(data).map((item) => RawArticle.parse(item));
}

const duplicates = loadRaw("search-climate-duplicates.json", (data: never) =>
  (data as { pages: Array<{ news: unknown[] }> }).pages.flatMap((page) => page.news),
);
const sample = loadRaw("search-keywordless-category-sample.json", (data: never) =>
  (data as { calls: Array<{ news: unknown[] }> }).calls.flatMap((call) => call.news),
);
const allRaw = [...duplicates, ...sample];

describe("recorded payloads normalize cleanly", () => {
  it("keeps every article upstream actually sent", () => {
    // A drop here means the normalizer and the shared contract disagree about
    // real data — the timeline would silently thin, with no error anywhere.
    const { articles, stats } = normalizeArticles(allRaw);

    expect(stats.received).toBe(180);
    expect(stats.kept).toBe(180);
    expect(articles).toHaveLength(180);
    expect(stats.dropped).toEqual({
      no_title: 0,
      no_url: 0,
      bad_url: 0,
      bad_published: 0,
      schema: 0,
    });
  });

  it("turns the literal string \"None\" into null", () => {
    // 47 of the 180 recorded articles carry image: "None". Rendered as a src
    // attribute that is a broken-image icon on every fourth card.
    const noneCount = allRaw.filter((article) => article.image === "None").length;
    expect(noneCount).toBeGreaterThan(0);

    const { articles } = normalizeArticles(allRaw);
    expect(articles.filter((article) => article.imageUrl === null)).toHaveLength(
      noneCount,
    );
    expect(articles.every((article) => article.imageUrl !== "None")).toBe(true);
  });

  it("emits ISO-8601 timestamps from the upstream's non-ISO format", () => {
    const { articles } = normalizeArticles(allRaw);
    for (const article of articles) {
      expect(article.published).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});

describe("dedup keys over the duplication fixture", () => {
  // The headline probe finding: 100 articles, 100 unique ids, 42 unique URLs, one
  // link-roundup post appearing 50 times (PROBE-FINDINGS 4). Clustering itself is
  // Phase 2, but the key it clusters on is produced here, so it is tested here.
  const { articles } = normalizeArticles(duplicates);

  it("collapses 100 articles onto 42 keys", () => {
    expect(articles).toHaveLength(100);
    expect(new Set(articles.map((article) => article.id)).size).toBe(100);
    expect(new Set(articles.map((article) => article.dedupKey)).size).toBe(42);
  });

  it("neither over- nor under-collapses: 42 raw URLs → 42 keys", () => {
    const rawUrls = new Set(duplicates.map((article) => article.url));
    expect(rawUrls.size).toBe(42);
    expect(new Set(articles.map((article) => article.dedupKey)).size).toBe(rawUrls.size);
  });

  it("finds the post that occupies half the retrievable depth", () => {
    const counts = new Map<string, number>();
    for (const article of articles) {
      counts.set(article.dedupKey, (counts.get(article.dedupKey) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBe(50);
  });

  it("gives identical keys to articles sharing a URL under different ids", () => {
    const byKey = new Map<string, Set<string>>();
    for (const article of articles) {
      const ids = byKey.get(article.dedupKey) ?? new Set();
      ids.add(article.id);
      byKey.set(article.dedupKey, ids);
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

  it("trims the trailing slash so /story and /story/ are one story", () => {
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

  it("does NOT strip www, because over-collapsing destroys articles", () => {
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

  it("resolves every recorded article to a domain", () => {
    const { articles } = normalizeArticles(allRaw);
    expect(articles.every((article) => article.sourceDomain !== null)).toBe(true);
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
    const outcome = normalizeArticle(RawArticle.parse(rawArticle(overrides)));
    if (outcome.ok) throw new Error("expected the article to be dropped");
    return outcome.reason;
  };

  it("drops an article with no usable title", () => {
    expect(drop({ title: "   " })).toBe("no_title");
    expect(drop({ title: null })).toBe("no_title");
  });

  it("drops an article with no link", () => {
    expect(drop({ url: null })).toBe("no_url");
  });

  it("drops an article whose link cannot be parsed", () => {
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
    // 180 recorded articles comply. Something else would mean the contract and
    // reality have diverged — a fact worth a metric, not a silent coercion.
    expect(drop({ id: "42" })).toBe("schema");
  });

  it("keeps the rest of the batch when one article is malformed", () => {
    const { articles, stats } = normalizeArticles([
      RawArticle.parse(rawArticle()),
      RawArticle.parse(
        rawArticle({ id: "6f1e2d3c-4b5a-4968-8877-665544332211", published: "nonsense" }),
      ),
      RawArticle.parse(
        rawArticle({
          id: "11223344-5566-4778-899a-bbccddeeff00",
          url: "https://example.com/other",
        }),
      ),
    ]);

    expect(articles).toHaveLength(2);
    expect(stats.received).toBe(3);
    expect(stats.dropped.bad_published).toBe(1);
  });
});

describe("field normalization", () => {
  const normalize = (overrides: Record<string, unknown> = {}) => {
    const outcome = normalizeArticle(RawArticle.parse(rawArticle(overrides)));
    if (!outcome.ok) throw new Error(`unexpectedly dropped: ${outcome.reason}`);
    return outcome.article;
  };

  it("collapses whitespace in title and description", () => {
    const article = normalize({
      title: "  A   headline\nwith  breaks ",
      description: "\tspaced   out\n",
    });
    expect(article.title).toBe("A headline with breaks");
    expect(article.description).toBe("spaced out");
  });

  it("turns empty description and author into null, not empty strings", () => {
    const article = normalize({ description: "  ", author: null });
    expect(article.description).toBeNull();
    expect(article.author).toBeNull();
  });

  it("lowercases and de-duplicates categories", () => {
    const article = normalize({ category: ["News", "news", "WORLD"] });
    expect(article.categories).toEqual(["news", "world"]);
  });

  it("keeps source_category verbatim, since we do not know what it means", () => {
    const article = normalize({ source_category: ["Tech", "CS"] });
    expect(article.sourceCategories).toEqual(["Tech", "CS"]);
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
