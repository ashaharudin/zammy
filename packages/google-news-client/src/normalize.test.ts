import { describe, expect, it } from "vitest";
import { deriveAltKey, deriveDedupKey, sourceDomain } from "@zammy/news-client";
import { PROVIDER, normalizeSighting, normalizeSightings } from "./normalize.js";
import { parseRssFeed } from "./rss.js";
import { feed, item, parseFeed } from "./test-support.js";

/**
 * The mapping onto `Sighting`, where this adapter departs from both others.
 *
 * Every departure below is load-bearing rather than stylistic, so each has a
 * test naming the damage it prevents.
 */

function one(overrides: Parameters<typeof item>[0] = {}, language = "en-CA") {
  const parsed = parseFeed(feed([item(overrides)], language));
  const outcome = normalizeSighting(parsed.items[0]!, { language: parsed.feed.language });
  if (!outcome.ok) throw new Error(`expected a sighting, got a ${outcome.reason} drop`);
  return outcome.sighting;
}

describe("attribution comes from <source url>, not from the URL", () => {
  it("names the publisher, never news.google.com", () => {
    // The whole point. `sourceDomain(url)` would say "news.google.com" for every
    // article in the archive.
    const sighting = one({ sourceUrl: "https://www.theguardian.com" });

    expect(sighting.sourceDomain).toBe("theguardian.com");
  });

  it("is the first row shape where sourceDomain(url) !== source_domain", () => {
    // Stated as an assertion because anything that recomputes a domain from a
    // stored URL — a backfill, a repair, a chore — will disagree with these
    // rows, and it is the recomputation that is wrong.
    const sighting = one({ sourceUrl: "https://www.bbc.co.uk" });

    // `google.com`, not even `news.google.com` — `sourceDomain` returns the
    // registrable domain, so following the convention would file these rows
    // under the same source as any other Google property.
    expect(sourceDomain(sighting.url)).toBe("google.com");
    expect(sighting.sourceDomain).toBe("bbc.co.uk");
  });

  it("keeps one outlet's story and its Google copy on ONE distinct domain", () => {
    // `trending-storylines.ts` gates the cloud on
    // `count(distinct a.source_domain) >= 2`, asking whether several newsrooms
    // are covering something. Attributing to news.google.com would make one
    // newsroom read as two — manufactured breadth on every story Google
    // reports (RESEARCH-FREE-NEWS-SOURCES §6a).
    const viaGoogle = one({
      link: "https://news.google.com/rss/articles/CBMxyz?oc=5",
      guid: "CBMxyz",
      sourceUrl: "https://www.theguardian.com",
    });
    const viaCurrents = sourceDomain("https://www.theguardian.com/world/2026/aug/20/x");

    expect(new Set([viaGoogle.sourceDomain, viaCurrents]).size).toBe(1);
  });

  it("never falls back to the redirect's domain when <source url> is unusable", () => {
    // It does not fall back to null either, any more — a sighting that reaches
    // the archive always names a publisher, because the SAME value keys
    // `alt_key` and `deriveAltKey` refuses a null domain, so the item is
    // dropped before it can be stored (see the alt_key block below). Asserted
    // here as well as there because the property being protected is different:
    // there it is identity, here it is that nothing is ever attributed to
    // Google.
    for (const sourceUrl of ["", "not a url"]) {
      const parsed = parseFeed(feed([item({ sourceUrl })]));
      const { sightings, stats } = normalizeSightings(parsed.items);

      expect(sightings).toHaveLength(0);
      expect(stats.dropped.no_identity).toBe(1);
    }
  });
});

describe("description is null", () => {
  it("discards the anchor blob rather than storing it", () => {
    // The RSS field is an entity-escaped `<a href>` blob wrapping the same
    // redirect, with the outlet name in a <font> tag — the title and the link
    // again, marked up. There is no prose in it to keep.
    const parsed = parseRssFeed(feed());
    expect(parsed.items[0]!.description).toContain("<a href=");

    expect(one().description).toBeNull();
  });

  it("does not synthesise one from the title", () => {
    const sighting = one({ title: "A very specific headline - Example News" });

    expect(sighting.description).toBeNull();
  });

  it("is null even when the blob happens to contain readable words", () => {
    const sighting = one({ description: "Some words that look like prose" });

    expect(sighting.description).toBeNull();
  });
});

describe("the title arrives intact", () => {
  it("keeps the trailing ' - Outlet' suffix, which belongs to G0 and not here", () => {
    // 100 of 101 items carry one. Stripping it is a shared-tokenizer change
    // costing a TOKENIZER_VERSION bump and a repair run, and an adapter
    // quietly editing a headline would make the stored title disagree with
    // `sightings.raw`.
    expect(one({ title: "Bank of Canada holds rate - The Globe and Mail" }).title).toBe(
      "Bank of Canada holds rate - The Globe and Mail",
    );
  });

  it("collapses whitespace but changes nothing else", () => {
    expect(one({ title: "  Spaced   out  - Example News " }).title).toBe(
      "Spaced out - Example News",
    );
  });
});

describe("identity, such as it is", () => {
  it("keys the sighting on the stable CBM guid", () => {
    // Identical on 100/100 shared titles across a repeated query, so
    // overlapping windows collide rather than accumulate.
    expect(one({ guid: "CBMabc" }).providerSightingId).toBe("CBMabc");
  });

  it("derives a uuid, since the guid is not one", () => {
    expect(one().id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to the canonical url when an item carries no guid", () => {
    const sighting = one({ guid: null });

    expect(sighting.providerSightingId).toBe(sighting.url);
  });

  it("keeps the redirect as the url, and dedupes on it — which G1 exists to fix", () => {
    // The `CBM…` link does not HTTP redirect; it returns a JavaScript
    // interstitial. So `dedup_key` here can never collide with the same story's
    // real URL from Currents, and that is why nothing ingests this provider
    // until `alt_key` lands.
    const sighting = one();

    expect(sighting.url).toContain("news.google.com/rss/articles/CBM");
    expect(sighting.dedupKey).toBe(deriveDedupKey(sighting.url));
  });

  it("tags every sighting with the provider id downstream constants depend on", () => {
    expect(one().provider).toBe("google-news");
    expect(PROVIDER).toBe("google-news");
  });
});

describe("alt_key, which is the only identity this provider can have", () => {
  it("keys on the PUBLISHER's domain, not the redirect's", () => {
    // Keyed on `sourceDomain(url)` every Google item would fold under
    // `google.com`, and the Currents article for the same story is under the
    // publisher's — so nothing would ever fold. This is the difference between
    // the fallback working and never firing.
    const sighting = one({
      title: "Rate hold - The Guardian",
      sourceUrl: "https://www.theguardian.com",
      pubDate: "Thu, 20 Aug 2026 17:09:53 GMT",
    });

    expect(sighting.altKey).toBe(
      deriveAltKey("theguardian.com", "Rate hold - The Guardian", sighting.published),
    );
    expect(sighting.altKey).not.toBe(
      deriveAltKey("google.com", "Rate hold - The Guardian", sighting.published),
    );
  });

  it("folds onto a Currents twin for an outlet in the stripping class", () => {
    // THE property the whole design rests on (ADR-0018, design §2a). Currents
    // ships the outlet's own `<title>` tag; Google writes the outlet's display
    // name. When the display name collapses to the domain stem, `deriveAltKey`
    // peels both and the two spellings of one story reach the same key — so the
    // Google item lands as a SIGHTING of the article Currents already has,
    // rather than as a second row.
    const viaGoogle = one({
      title: "Bank of Canada holds its policy rate - The Guardian",
      sourceUrl: "https://www.theguardian.com",
      pubDate: "Thu, 20 Aug 2026 17:09:53 GMT",
    });
    // What Currents would carry for the same story, same domain, same UTC day.
    const viaCurrents = deriveAltKey(
      "theguardian.com",
      "Bank of Canada holds its policy rate",
      "2026-08-20T09:15:00.000Z",
    );

    expect(viaGoogle.altKey).toBe(viaCurrents);
  });

  it("does NOT fold when the display name is not the domain stem — accepted, ADR-0018", () => {
    // The known hole, asserted rather than hoped about.
    //
    // The outlet here is `nytimes.com`, and the choice matters: ADR-0018's own
    // table reaches for "BBC News" and "The Wall Street Journal", but Google
    // OBSERVABLY emits "BBC" and "WSJ", both of which fold. Demonstrating the
    // hole with a name no provider sends would assert nothing. "The New York
    // Times" is a name Google was observed emitting and it expands the stem, so
    // the strip refuses and the outlet's name stays in the fold — the Google
    // item and its Currents twin then mint two rows.
    //
    // ADR-0018 records this as an accepted cost with the fix — a
    // display-name-to-domain map — deferred to the phase that has a corpus.
    // This adapter does not build that map; it measures the hole, in
    // `fixture-client.test.ts`, where the four measurements disagree
    // informatively.
    const viaGoogle = one({
      title: "Bank of Canada holds its policy rate - The New York Times",
      sourceUrl: "https://www.nytimes.com",
      pubDate: "Thu, 20 Aug 2026 17:09:53 GMT",
    });
    const viaCurrents = deriveAltKey(
      "nytimes.com",
      "Bank of Canada holds its policy rate",
      "2026-08-20T09:15:00.000Z",
    );

    expect(viaGoogle.altKey).not.toBe(viaCurrents);
  });

  it("drops a sighting with no publisher domain, rather than keying it on nothing", () => {
    // For the other two adapters a null alt key means "identified by URL
    // alone", which is safe because their URL is the article. Here the URL is a
    // redirect whose id shifts across queries (51/53, 70/71), and the deepening
    // plane issues overlapping queries by construction — so a keyless row is a
    // duplicate generator. Counted and visible, never minted.
    const parsed = parseFeed(feed([item({ sourceUrl: "", sourceName: "" })]));
    const { sightings, stats } = normalizeSightings(parsed.items);

    expect(sightings).toHaveLength(0);
    expect(stats.dropped.no_identity).toBe(1);
    // And specifically not counted as a bad URL: the link parsed fine, it just
    // is not an identity.
    expect(stats.dropped.bad_url).toBe(0);
  });

  it("drops a title the SOURCE truncated, which deriveAltKey refuses to key", () => {
    // Note the outlet has to be one the strip fires on, or the `...` is not at
    // the end of the headline `deriveAltKey` examines — it checks truncation
    // AFTER peeling the suffix, precisely so `[00232.HK] Disclosure of... -
    // HKEXnews` does not sail past the guard.
    const parsed = parseFeed(
      feed([
        item({
          title: "[00232.HK] Disclosure of... - HKEXnews",
          sourceUrl: "https://www.hkexnews.hk",
          sourceName: "HKEXnews",
        }),
      ]),
    );
    const { sightings, stats } = normalizeSightings(parsed.items);

    expect(sightings).toHaveLength(0);
    expect(stats.dropped.no_identity).toBe(1);
  });

  it("counts that drop separately from a schema drop", () => {
    // A schema drop means upstream sent something the contract does not
    // describe — worth investigating. This means upstream behaved perfectly and
    // the article still cannot be filed. Folding them together would make a
    // rise in either unreadable.
    const parsed = parseFeed(feed([item({ sourceUrl: "" }), item({ guid: "ok" })]));
    const { stats } = normalizeSightings(parsed.items);

    expect(stats.dropped.no_identity).toBe(1);
    expect(stats.dropped.schema).toBe(0);
  });
});

describe("the fields this feed simply does not have", () => {
  it("reports no author and no image rather than guessing", () => {
    const sighting = one();

    expect(sighting.author).toBeNull();
    expect(sighting.imageUrl).toBeNull();
    expect(sighting.categories).toEqual([]);
  });

  it("takes language from the channel, reduced to its primary subtag", () => {
    // Items carry none of their own. `en-CA` is a locale and
    // `Sighting.language` holds a language — `group.language` groups on `en`.
    expect(one({}, "en-CA").language).toBe("en");
    expect(one({}, "fr-CA").language).toBe("fr");
  });
});

describe("pubDate is a real publication time, and is validated", () => {
  it("parses the RFC 822 form every probed item used", () => {
    expect(one({ pubDate: "Thu, 20 Aug 2026 17:09:53 GMT" }).published).toBe(
      "2026-08-20T17:09:53.000Z",
    );
  });

  it("drops an unparseable timestamp instead of defaulting it to now", () => {
    // The timeline axis is the product's core promise, so a wrong timestamp is
    // worse than a missing article (ARCHITECTURE 11).
    const parsed = parseFeed(feed([item({ pubDate: "yesterday-ish" })]));
    const { sightings, stats } = normalizeSightings(parsed.items);

    expect(sightings).toHaveLength(0);
    expect(stats.dropped.bad_published).toBe(1);
  });

  it("drops a bare date, which some runtimes would parse and others would not", () => {
    const parsed = parseFeed(feed([item({ pubDate: "20 Aug 2026" })]));
    const { stats } = normalizeSightings(parsed.items);

    expect(stats.dropped.bad_published).toBe(1);
  });
});

describe("a malformed item is dropped and counted, never repaired", () => {
  it("counts each reason separately, keeping the rest of the batch", () => {
    const parsed = parseFeed(
      feed([
        item(),
        item({ title: null, guid: "CBM-no-title" }),
        item({ link: null, guid: "CBM-no-link" }),
        item({ link: "not-a-url", guid: "CBM-bad-link" }),
        item({ pubDate: "nonsense", guid: "CBM-bad-date" }),
      ]),
    );
    const { sightings, stats } = normalizeSightings(parsed.items);

    expect(stats.received).toBe(5);
    expect(sightings).toHaveLength(1);
    expect(stats.dropped).toMatchObject({
      no_title: 1,
      no_url: 1,
      bad_url: 1,
      bad_published: 1,
    });
  });
});
