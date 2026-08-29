import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  altKeyProbe,
  altKeyProbeIsConsistent,
  canonicalizeUrl,
  deriveAltKey,
  deriveDedupKey,
  deriveSightingId,
  normalizeImage,
  sourceDomain,
} from "./normalize.js";
import { Sighting } from "./sighting.js";

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

  it("folds a display name that NAMES the domain without spelling it", () => {
    // The G5 widening, one case per rule, and every string below is a real
    // (domain, display name) pair from `fixtures/google-news-source-names.tsv`.
    // That property is the whole point: the table this replaced was reasoned
    // from mastheads rather than read off the wire, and four of its entries were
    // wrong in the same direction (PR #174).
    const folds = (domain: string, name: string): boolean =>
      deriveAltKey(domain, `Ferry service suspended - ${name}`, DAY) ===
      deriveAltKey(domain, "Ferry service suspended", DAY);

    // 1. EXACT — the rule that already shipped.
    expect(folds("theguardian.com", "The Guardian")).toBe(true);
    // 2. AFFIX — the domain stem is one end of the name. 317 of 756 held-out
    //    failures, more than the other three rules together.
    expect(folds("thestar.com", "Toronto Star")).toBe(true);
    expect(folds("yahoo.com", "Yahoo Sports")).toBe(true);
    expect(folds("time.com", "Time Magazine")).toBe(true);
    // 3. INITIALISM — content words only, because a domain does not spell "on".
    expect(folds("scmp.com", "South China Morning Post")).toBe(true);
    expect(folds("cfr.org", "Council on Foreign Relations")).toBe(true);
    // 4. INITIALS PLUS TAIL — a place name abbreviates, a common noun does not.
    expect(folds("latimes.com", "Los Angeles Times")).toBe(true);
    expect(folds("nypost.com", "New York Post")).toBe(true);
    expect(folds("sfchronicle.com", "San Francisco Chronicle")).toBe(true);
    // 5. AFFIX REVERSED — the name is one end of the domain stem.
    expect(folds("wionews.com", "WION")).toBe(true);
    // A domain cannot carry "&" and a display name can.
    expect(folds("skyandtelescope.org", "Sky & Telescope")).toBe(true);
  });

  it("still refuses a display name with no lexical claim on the domain", () => {
    // The 6.9% these rules do not reach, and they are refusals rather than
    // misses: nothing here NAMES the domain, so stripping would be a guess.
    // Two populations, both from the harvested corpus — a masthead in another
    // script, and a name with no relation at all.
    const folds = (domain: string, name: string): boolean =>
      deriveAltKey(domain, `Ferry service suspended - ${name}`, DAY) ===
      deriveAltKey(domain, "Ferry service suspended", DAY);

    expect(folds("chosun.com", "조선일보")).toBe(false);
    expect(folds("umn.edu", "CIDRAP")).toBe(false);
    expect(folds("channelnewsasia.com", "CNA")).toBe(false);
  });

  it("does not let the widened rules eat a headline's own tail", () => {
    // The cost side, and the one that decides whether the widening was worth
    // taking. Measured by replaying the whole fold over the dev archive (32,279
    // articles): the four rules cost exactly ONE additional merge — `cbc.ca`
    // filed "How will the new tariffs hit Canada's economy? | CBC Radio" and the
    // same headline without it, which is a real duplicate — against a positional
    // strip's 347.
    //
    // No real over-strip could be found on 32,279 articles to pin here, so the
    // three cases below are the shapes that would have to break first rather
    // than regressions caught in the wild — said plainly, because a test whose
    // provenance is "invented" should not be read as one whose provenance is
    // "measured".
    //
    // The third is the reverse-affix rule's length floor, and it is the one to
    // watch: "Sun" on `thesun.co.uk` folds and always did — `sun` IS that
    // domain's stem — so the floor has to be demonstrated on a domain the tail
    // merely PREFIXES. Below four characters the rule declines, which is what
    // keeps a common short word out of it.
    expect(deriveAltKey("bbc.co.uk", "Manitoba floods - live updates", DAY)).not.toBe(
      deriveAltKey("bbc.co.uk", "Manitoba floods - what we know", DAY),
    );
    expect(
      deriveAltKey("frontiersin.org", "Frontiers | Glucosamine for knee osteoarthritis", DAY),
    ).not.toBe(deriveAltKey("frontiersin.org", "Frontiers | Benthic life stages", DAY));
    expect(deriveAltKey("sunlife.com", "Blackout hits the coast - Sun", DAY)).not.toBe(
      deriveAltKey("sunlife.com", "Blackout hits the coast", DAY),
    );
    // And the same tail one character longer DOES fold, so the assertion above
    // is the floor doing the work rather than the rule failing to fire at all.
    expect(deriveAltKey("sunlife.com", "Blackout hits the coast - Sunl", DAY)).toBe(
      deriveAltKey("sunlife.com", "Blackout hits the coast", DAY),
    );
  });

  it("is 64 lowercase hex characters, the shape the Sighting contract demands", () => {
    expect(deriveAltKey("bbc.co.uk", "Ferry service suspended", DAY)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

/**
 * `altKeyProbe` — the keys a sighting may be MATCHED on, which is the same one
 * key `deriveAltKey` gave it unless the provider sent a bare date (ADR-0022).
 *
 * The distinction these assertions exist to hold is that the fold did not
 * change. A neighbour is never stored, never indexed, and never derived for a
 * sighting that carries a real time.
 */
describe("altKeyProbe", () => {
  const DAY = "2026-08-27T09:00:00.000Z";
  const sighting = (over: Record<string, unknown>): Sighting =>
    Sighting.parse({
      id: "00000000-0000-4000-8000-000000000001",
      provider: "currents",
      providerSightingId: "x",
      url: "https://example.com/a",
      dedupKey: deriveDedupKey("https://example.com/a"),
      altKey: deriveAltKey("example.com", "Ferry service suspended", DAY),
      title: "Ferry service suspended",
      description: null,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: "example.com",
      published: DAY,
      raw: {},
      ...over,
    });

  it("hands back the one stored key for a sighting that carries a real time", () => {
    const one = sighting({});
    expect(altKeyProbe(one)).toEqual([one.altKey]);
  });

  it("adds the day either side when the provider sent a bare date", () => {
    // Both sides, because the archive's twin sits a day EARLIER as often as it
    // sits a day later: over the 150 bare-date Google News sightings on the dev
    // archive that have a same-domain, same-folded-title Currents twin, the
    // day-bucket delta is -1 for 12 and +1 for 11 (ADR-0022).
    const bare = sighting({ published: "2026-08-27T07:00:00.000Z", publishedIsDateOnly: true });
    const keys = altKeyProbe(bare);
    expect(keys).toEqual([
      bare.altKey,
      deriveAltKey("example.com", "Ferry service suspended", "2026-08-26T07:00:00.000Z"),
      deriveAltKey("example.com", "Ferry service suspended", "2026-08-28T07:00:00.000Z"),
    ]);
    // The sighting's own key comes FIRST, which is what `findArticle`'s
    // precedence reads: the provider's own assertion beats this system's
    // allowance for the fact that the assertion is a date.
    expect(keys[0]).toBe(bare.altKey);
  });

  it("always leads with the stored key, whichever path it returns by", () => {
    // Load-bearing beyond the precedence: `resolveArticle`'s savepoint fence
    // re-resolves a lost insert race through the SAME match set, and a 23505 on
    // `articles_alt_key_idx` can only name the value that was inserted — which
    // is `altKey`. If any path here ever returned a set not led by it, the fence
    // could fail to find the row that beat it and would raise instead.
    for (const over of [
      {},
      { published: "2026-08-27T07:00:00.000Z", publishedIsDateOnly: true },
      { published: "2026-08-27T07:00:00.000Z", publishedIsDateOnly: true, sourceDomain: "other.example" },
    ]) {
      const one = sighting(over);
      expect(altKeyProbe(one)[0]).toBe(one.altKey);
    }
  });

  it("hands back nothing at all when the sighting has no key", () => {
    // Not `[null]` and not a throw: an unkeyable article takes the
    // pre-ADR-0018 path in full, identified by its URL alone, and an empty set
    // is what `findArticle` reads as "do not consult the fallback".
    expect(altKeyProbe(sighting({ altKey: null, publishedIsDateOnly: true }))).toEqual([]);
  });

  it("re-derives every adapter's key from the fields that adapter stored", () => {
    // The invariant the neighbours rest on. All three adapters write
    // `altKey: deriveAltKey(domain, title, published)` beside
    // `sourceDomain: domain`, so the sighting's own stored fields reproduce its
    // key — including Google News, where `domain` is the PUBLISHER's and not
    // the redirect's host.
    expect(altKeyProbeIsConsistent(sighting({}))).toBe(true);
    expect(
      altKeyProbeIsConsistent(
        sighting({ published: "2026-08-27T07:00:00.000Z", publishedIsDateOnly: true }),
      ),
    ).toBe(true);
    // And it is false the moment they disagree, which is the only way it earns
    // its place in the adapters' own fixture tests.
    expect(altKeyProbeIsConsistent(sighting({ sourceDomain: "other.example" }))).toBe(false);
  });

  it("falls back to the single stored key when that invariant is broken", () => {
    // The failure this exists for is invisible, not loud: an adapter keying on
    // a domain it did not store would send both neighbours into another
    // newsroom's key space, where a folded title can reach an unrelated
    // article. Narrowing to the stored key is exactly the behaviour before this
    // function existed, so a broken invariant costs the widening and nothing
    // else.
    const broken = sighting({
      published: "2026-08-27T07:00:00.000Z",
      publishedIsDateOnly: true,
      sourceDomain: "other.example",
    });
    expect(altKeyProbeIsConsistent(broken)).toBe(false);
    expect(altKeyProbe(broken)).toEqual([broken.altKey]);
  });
});
