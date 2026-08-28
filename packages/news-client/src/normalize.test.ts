import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  deriveAltKey,
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

  it("collapses a share link's ?share_id= onto the bare article", () => {
    // Two production rows for one Common Dreams story differed only by this
    // parameter; the page declares the bare URL canonical either way.
    const shared = canonicalizeUrl(
      "https://www.commondreams.org/news/trump-belgium-ring-bribe?share_id=983848",
    )!;
    expect(shared).toBe(
      "https://www.commondreams.org/news/trump-belgium-ring-bribe",
    );
    // The identity that matters is the key, not the string it came from.
    expect(deriveDedupKey(shared)).toBe(
      deriveDedupKey(
        canonicalizeUrl("https://www.commondreams.org/news/trump-belgium-ring-bribe")!,
      ),
    );
  });

  it("strips ?share_id= whatever its casing", () => {
    expect(canonicalizeUrl("https://example.com/story?SHARE_ID=1&id=7")).toBe(
      "https://example.com/story?id=7",
    );
  });

  it("strips ?share_id= from a path that already ends in a slash", () => {
    // Both trims run in sequence, so the share link and the bare link converge.
    expect(canonicalizeUrl("https://example.com/story/?share_id=1")).toBe(
      canonicalizeUrl("https://example.com/story"),
    );
  });

  it("collapses a ?cmp= link onto the same article as the bare URL", () => {
    // Every CBC feed link carries `?cmp=rss`, so once feed ingestion lands, without
    // this one outlet's whole output would land as two articles per story — one from
    // the feed, one from Currents. The Guardian spells it `CMP`, hence both cases.
    // Asserted against the literal, not against `canonicalizeUrl` of the bare URL:
    // comparing the function to itself would also pass if it returned null for all
    // three.
    const bare = "https://www.cbc.ca/news/world/story-9.7322947";
    expect(canonicalizeUrl(bare)).toBe(bare);
    expect(canonicalizeUrl(`${bare}?cmp=rss`)).toBe(bare);
    expect(canonicalizeUrl(`${bare}?CMP=share_btn_url`)).toBe(bare);
  });

  it("does NOT strip names that merely resemble a tracking parameter", () => {
    // The set is exact-match by design: a near miss is far likelier to select
    // content than to track a referral, and over-collapsing is unrecoverable.
    // `cmp` needs this most — three letters, and the compound forms below are
    // exactly what a content selector would be called.
    for (const key of [
      "share-id",
      "shareid",
      "sharer_id",
      "share_id_v2",
      "cmpid",
      "cmp_id",
      "camp",
      "cmp2",
    ]) {
      expect(canonicalizeUrl(`https://example.com/story?${key}=1`)).toBe(
        `https://example.com/story?${key}=1`,
      );
    }
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

/**
 * The FALLBACK identity (ADR-0018). The most consequential rules in this file
 * after `canonicalizeUrl`, and they fail in the same two directions: a key that
 * is too eager merges two stories into one article, and a key that is too shy
 * leaves one story in the timeline twice. The asymmetry is the same too —
 * over-collapsing is the worse error, because a visible duplicate is a bug
 * report and a merge is silent.
 */
describe("deriveAltKey", () => {
  const DAY = "2026-08-27T09:00:00.000Z";

  it("is the same key whether or not the outlet named itself in the headline", () => {
    // Currents ships a title as the outlet wrote its own <title> tag,
    // attribution and all, and Google News appends " - Outlet" to 100 of 101
    // items. Two spellings of one headline must reach one key or the fallback
    // buys nothing on the very sources that need it.
    expect(deriveAltKey("reuters.com", "Bitcoin rises - Reuters", DAY)).toBe(
      deriveAltKey("reuters.com", "Bitcoin rises", DAY),
    );
    expect(
      deriveAltKey("theguardian.com", "Rosebank consultation closes | The Guardian", DAY),
    ).toBe(deriveAltKey("theguardian.com", "Rosebank consultation closes", DAY));
    // The domain's public suffix is optional in the headline, and an outlet
    // that spells it out still matches.
    expect(deriveAltKey("globalnews.ca", "Beekeepers feel the sting - Globalnews.ca", DAY))
      .toBe(deriveAltKey("globalnews.ca", "Beekeepers feel the sting", DAY));
  });

  it("leaves a trailing segment alone when it is not the outlet's own name", () => {
    // MEASURED, and the reason the strip consults `source_domain` at all. On the
    // dev archive (32,279 articles), a positional strip — peel whatever follows
    // the last " - " or " | " — merges 68 unrelated Frontiers research papers
    // into ONE article, because every one of them is titled
    // "Frontiers | <the actual title>" and the greedy split keeps the head.
    // Across the archive that rule merges 348 rows this one refuses.
    const a = deriveAltKey(
      "frontiersin.org",
      "Frontiers | Glucosamine for knee osteoarthritis: an umbrella review",
      DAY,
    );
    const b = deriveAltKey(
      "frontiersin.org",
      "Frontiers | Benthic life stages retain fjord-scale population structure",
      DAY,
    );
    expect(a).not.toBe(b);

    // And the same guard covers the shape a headline's own tail takes. A shape
    // rule ("short, verbless, reads like a name") would peel both of these and
    // merge two genuinely different same-day stories from one newsroom.
    expect(deriveAltKey("bbc.co.uk", "Manitoba floods - live updates", DAY)).not.toBe(
      deriveAltKey("bbc.co.uk", "Manitoba floods - what we know", DAY),
    );
  });

  it("refuses a key for a title the SOURCE already truncated", () => {
    // hkexnews.hk filed three distinct regulatory disclosures on one day under
    // titles it had itself cut to "[00232.HK] Disclosure of...", so three
    // filings fold to one key. Refusing costs a handful of genuine collapses —
    // 9 rows across the dev archive — and buys back the whole over-collapse
    // class, which is the right way round.
    expect(deriveAltKey("hkexnews.hk", "[00232.HK] Disclosure of...", DAY)).toBeNull();
    expect(deriveAltKey("hkexnews.hk", "[00232.HK] Disclosure of…", DAY)).toBeNull();
  });

  it("sees the truncation even when the outlet's name is written after it", () => {
    // wlox.com, from the dev archive: the source cut the headline mid-sentence
    // and THEN appended its own name, so a check made on the raw title reads the
    // last character as "X" and never fires.
    expect(
      deriveAltKey(
        "wlox.com",
        "Trump approves major disaster declaration for counties hit by Tropical Storm ... - WLOX",
        DAY,
      ),
    ).toBeNull();
  });

  it("keeps two genuinely different same-day stories from one domain apart", () => {
    expect(deriveAltKey("bbc.co.uk", "Ferry service suspended", DAY)).not.toBe(
      deriveAltKey("bbc.co.uk", "Rail service suspended", DAY),
    );
  });

  it("scopes the key to one newsroom, so a syndicated story stays several articles", () => {
    // ADR-0002: one story across six outlets is six articles, on purpose. The
    // cloud measures a term's breadth by counting distinct sources, so a key
    // that crossed domains would destroy the signal that feature depends on.
    expect(deriveAltKey("bbc.co.uk", "Ferry service suspended", DAY)).not.toBe(
      deriveAltKey("cbc.ca", "Ferry service suspended", DAY),
    );
  });

  it("buckets by UTC day, so a recurring column is not one article forever", () => {
    expect(deriveAltKey("ft.com", "Morning Briefing", "2026-08-27T09:00:00.000Z")).toBe(
      deriveAltKey("ft.com", "Morning Briefing", "2026-08-27T23:59:59.000Z"),
    );
    expect(deriveAltKey("ft.com", "Morning Briefing", "2026-08-27T23:59:59.000Z")).not.toBe(
      deriveAltKey("ft.com", "Morning Briefing", "2026-08-28T00:00:01.000Z"),
    );
  });

  it("ignores the case and punctuation an outlet re-styles a headline with", () => {
    // financialpost.com, from the dev archive: the same wire story filed twice,
    // once sentence-cased and once Title Cased.
    expect(
      deriveAltKey("financialpost.com", "Trump said to call Warsh in latest signal", DAY),
    ).toBe(
      deriveAltKey("financialpost.com", "Trump Said to Call Warsh In Latest Signal!", DAY),
    );
  });

  it("folds a Latin diacritic onto its base letter", () => {
    expect(deriveAltKey("elpais.com", "Núñez wins", DAY)).toBe(
      deriveAltKey("elpais.com", "Nunez wins", DAY),
    );
  });

  it("keeps a non-Latin headline whole rather than folding it to nothing", () => {
    // The trap an ASCII-only `[^a-z0-9]` fold would spring: every Arabic,
    // Chinese, Greek and Cyrillic headline folds to the empty string, and one
    // domain's whole day of them collapses onto a single article.
    const first = deriveAltKey("aljazeera.net", "غزة تحت القصف", DAY);
    const second = deriveAltKey("aljazeera.net", "مفاوضات في القاهرة", DAY);
    expect(first).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("refuses a key when the fold leaves nothing to identify by", () => {
    expect(deriveAltKey("example.com", "!!! ---", DAY)).toBeNull();
    // A headline that is ONLY the outlet's name is the same case: the peel
    // leaves nothing, and every such title on that domain and day would share
    // one key.
    expect(deriveAltKey("example.com", "?? - Example.com", DAY)).toBeNull();
  });

  it("refuses a key without a source domain, which is what scopes it", () => {
    expect(deriveAltKey(null, "Ferry service suspended", DAY)).toBeNull();
  });

  it("refuses a key rather than guessing at an unparseable timestamp", () => {
    expect(deriveAltKey("bbc.co.uk", "Ferry service suspended", "not a date")).toBeNull();
  });

  it("is 64 lowercase hex characters, the shape the Sighting contract demands", () => {
    expect(deriveAltKey("bbc.co.uk", "Ferry service suspended", DAY)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
