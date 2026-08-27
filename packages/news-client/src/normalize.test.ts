import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  deriveDedupKey,
  deriveSightingId,
  normalizeImage,
  sourceDomain,
} from "./normalize.js";

/**
 * The half of normalization that is the same whoever sent the article
 * (ARCHITECTURE 5.2). Each provider's own mapping is tested in its own adapter,
 * against that provider's recorded payloads.
 *
 * These rules decide what collapses onto one article, which makes them the most
 * consequential code in the client: over-collapsing merges genuinely distinct
 * stories, and under-collapsing leaves the same story in the timeline twice.
 */

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

  it("collapses a feed's ?cmp= link onto the same article as the bare URL", () => {
    // Every CBC feed link carries `?cmp=rss`, so without this one outlet's whole
    // output would land as two articles per story — one from the feed, one from
    // Currents. The Guardian spells the same parameter `CMP`, hence both cases.
    const bare = canonicalizeUrl("https://www.cbc.ca/news/world/story-9.7322947")!;
    expect(canonicalizeUrl("https://www.cbc.ca/news/world/story-9.7322947?cmp=rss")).toBe(
      bare,
    );
    expect(
      canonicalizeUrl("https://www.cbc.ca/news/world/story-9.7322947?CMP=share_btn_url"),
    ).toBe(bare);
    expect(deriveDedupKey(canonicalizeUrl("https://x.test/a?cmp=rss")!)).toBe(
      deriveDedupKey(canonicalizeUrl("https://x.test/a")!),
    );
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

  it("gives two providers reporting one URL the same dedup key", () => {
    // The property that makes fan-out cheap: the same story arriving from two
    // upstreams collapses onto one article rather than duplicating the timeline.
    const fromOne = canonicalizeUrl("https://example.com/story?utm_campaign=a#top")!;
    const fromTwo = canonicalizeUrl("https://example.com/story/")!;
    expect(deriveDedupKey(fromOne)).toBe(deriveDedupKey(fromTwo));
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

describe("deriveSightingId", () => {
  it("is stable, so re-fetching an emission stays idempotent", () => {
    // The whole ingest fold rests on this: `ON CONFLICT (id) DO NOTHING` only
    // deduplicates a re-fetch if the id is a function of the emission.
    expect(deriveSightingId("gnews", "abc123")).toBe(deriveSightingId("gnews", "abc123"));
  });

  it("is a well-formed v5 UUID, because sightings.id is a uuid column", () => {
    expect(deriveSightingId("gnews", "abc123")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("namespaces by provider, so a shared id from two providers cannot collide", () => {
    expect(deriveSightingId("gnews", "abc123")).not.toBe(
      deriveSightingId("elsewhere", "abc123"),
    );
  });

  it("separates distinct ids from one provider", () => {
    expect(deriveSightingId("gnews", "a")).not.toBe(deriveSightingId("gnews", "b"));
  });
});
