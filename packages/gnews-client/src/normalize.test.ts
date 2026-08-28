import { describe, expect, it } from "vitest";
import { deriveAltKey, deriveDedupKey, deriveSightingId } from "@zammy/news-client";
import { normalizeSighting, normalizeSightings, parsePublished } from "./normalize.js";
import { RawGnewsArticle } from "./raw.js";
import { rawArticle } from "./test-support.js";

/**
 * GNews → `Sighting`. The shared half of normalization is tested in
 * `@zammy/news-client`; what matters here is the mapping, and above all the
 * places where GNews has less than Currents and a guess would be worse than an
 * admission.
 */

function parse(overrides: Record<string, unknown> = {}): RawGnewsArticle {
  return RawGnewsArticle.parse(rawArticle(overrides));
}

function ok(overrides: Record<string, unknown> = {}) {
  const outcome = normalizeSighting(parse(overrides));
  if (!outcome.ok) throw new Error(`expected a kept sighting, got ${outcome.reason}`);
  return outcome.sighting;
}

describe("identity", () => {
  it("tags the provider, so per-provider yield is measurable", () => {
    expect(ok().provider).toBe("gnews");
  });

  it("derives a UUID from the opaque id, because sightings.id is a uuid column", () => {
    const sighting = ok({ id: "abc123" });

    expect(sighting.providerSightingId).toBe("abc123");
    expect(sighting.id).toBe(deriveSightingId("gnews", "abc123"));
    expect(sighting.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to the canonical URL when the article carries no id", () => {
    // `id` post-dates the v4 launch. Without a fallback these would be dropped,
    // and with an unstable one a re-fetch would insert the same emission twice.
    const withoutId = ok({ id: null, url: "https://example.com/story?utm_source=x" });

    expect(withoutId.providerSightingId).toBe("https://example.com/story");
    expect(withoutId.id).toBe(
      deriveSightingId("gnews", "https://example.com/story"),
    );
  });

  it("gives the same article the same id twice, keeping ingest idempotent", () => {
    expect(ok().id).toBe(ok().id);
  });

  it("shares a dedup key with any other provider reporting the same URL", () => {
    // This is what makes fan-out cheap: one story from two upstreams collapses
    // onto one article instead of duplicating the timeline.
    expect(ok().dedupKey).toBe(deriveDedupKey("https://example.com/story"));
  });

  it("carries a fallback key derived from the fields it stores", () => {
    // GNews is the adapter this matters most to under the discovery/deepening
    // design, because a provider whose link cannot serve as identity has only
    // this key to fold on. Derived from the STORED title and domain, so the
    // identity and the thing it identifies cannot disagree.
    const sighting = ok();
    expect(sighting.altKey).toBe(
      deriveAltKey(sighting.sourceDomain, sighting.title, sighting.published),
    );
    expect(sighting.altKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fields GNews does not have", () => {
  it("leaves categories empty rather than inventing them", () => {
    // /search neither returns nor filters on categories. Back-filling one would
    // put an article in a category nobody assigned it.
    expect(ok().categories).toEqual([]);
    expect(ok().sourceCategories).toEqual([]);
  });

  it("reports no author, because GNews names the outlet and never the journalist", () => {
    expect(ok().author).toBeNull();
  });

  it("derives the source domain from the URL, not from source.name", () => {
    // So one story reported by both providers presents as one source rather
    // than as "bbc.co.uk" and "BBC News".
    const sighting = ok({
      url: "https://www.bbc.co.uk/news/story",
      source: { name: "BBC News", url: "https://bbc.co.uk", id: "bbc", country: "gb" },
    });
    expect(sighting.sourceDomain).toBe("bbc.co.uk");
  });
});

describe("drop rules", () => {
  it("drops an article with no title", () => {
    const outcome = normalizeSighting(parse({ title: "   " }));
    expect(outcome).toMatchObject({ ok: false, reason: "no_title" });
  });

  it("drops an article with no url", () => {
    const outcome = normalizeSighting(parse({ url: null }));
    expect(outcome).toMatchObject({ ok: false, reason: "no_url" });
  });

  it("drops an unparseable url rather than storing an unclickable link", () => {
    const outcome = normalizeSighting(parse({ url: "not a url" }));
    expect(outcome).toMatchObject({ ok: false, reason: "bad_url" });
  });

  it("drops a bad timestamp rather than defaulting it to now", () => {
    // The timeline axis is the product's core promise; a wrong timestamp
    // corrupts it silently, which is worse than one missing article.
    for (const publishedAt of [null, "", "yesterday", "2026-08-04"]) {
      expect(normalizeSighting(parse({ publishedAt }))).toMatchObject({
        ok: false,
        reason: "bad_published",
      });
    }
  });

  it("counts drops instead of failing the batch", () => {
    const { sightings, stats } = normalizeSightings([
      parse(),
      parse({ id: "second", url: "https://example.com/other", title: "" }),
    ]);

    expect(sightings).toHaveLength(1);
    expect(stats.received).toBe(2);
    expect(stats.kept).toBe(1);
    expect(stats.dropped.no_title).toBe(1);
  });
});

describe("field normalization", () => {
  it("keeps the whole raw article, so a widened rule can re-normalize history", () => {
    expect(ok().raw).toMatchObject({ url: "https://example.com/story" });
  });

  it("collapses whitespace in title and description", () => {
    const sighting = ok({ title: "  A   headline \n", description: "A  description" });
    expect(sighting.title).toBe("A headline");
    expect(sighting.description).toBe("A description");
  });

  it("nulls an absent description rather than storing an empty string", () => {
    expect(ok({ description: null }).description).toBeNull();
  });

  it("nulls an absent image", () => {
    expect(ok({ image: null }).imageUrl).toBeNull();
  });

  it("normalizes published to ISO-8601 UTC", () => {
    expect(ok({ publishedAt: "2026-08-04T20:45:56.500Z" }).published).toBe(
      "2026-08-04T20:45:56.500Z",
    );
  });
});

describe("parsePublished", () => {
  it("accepts the documented ISO-8601 form", () => {
    expect(parsePublished("2025-07-18T21:32:58.500Z")).toBe(
      Date.parse("2025-07-18T21:32:58.500Z"),
    );
  });

  it("accepts a timestamp with an offset instead of Z", () => {
    expect(parsePublished("2025-07-18T21:32:58+02:00")).toBe(
      Date.parse("2025-07-18T21:32:58+02:00"),
    );
  });

  it("refuses anything short of a full timestamp", () => {
    // A bare date parses in some runtimes and not others; requiring the full
    // form keeps the drop deterministic rather than platform-dependent.
    expect(parsePublished("2025-07-18")).toBeNaN();
    expect(parsePublished("last Tuesday")).toBeNaN();
    expect(parsePublished(null)).toBeNaN();
  });
});
