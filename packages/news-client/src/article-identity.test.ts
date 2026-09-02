import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  deriveAltKey,
  deriveArticleIdentity,
  deriveDedupKey,
  publisherLinkDomain,
  sourceDomain,
} from "./index.js";

/**
 * `deriveArticleIdentity` — the four fields, derived together.
 *
 * The derivations themselves are `normalize.test.ts`'s subject and are not
 * re-litigated here; what this file asserts is the part that used to be an
 * unwritten protocol between three adapters. Every case below is about
 * AGREEMENT: that the key and the field it was scoped to leave as one value,
 * that the override changes which link the domain is read from and nothing
 * else, and that the refusals land in the order the adapters reported them in.
 */

const PUBLISHED = "2026-08-27T09:00:00.000Z";
const TITLE = "Ferry service suspended";

describe("deriveArticleIdentity", () => {
  it("derives all four fields from the article's own link", () => {
    const outcome = deriveArticleIdentity({
      link: "https://www.example.com/story/?utm_source=x#top",
      title: TITLE,
      published: PUBLISHED,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const url = canonicalizeUrl("https://www.example.com/story/?utm_source=x#top")!;
    expect(outcome.identity).toEqual({
      url,
      dedupKey: deriveDedupKey(url),
      altKey: deriveAltKey("example.com", TITLE, PUBLISHED),
      sourceDomain: "example.com",
    });
  });

  it("scopes the alt key to the domain it returns, which is the whole point", () => {
    // The invariant `altKeyProbe` re-derives at runtime, here made structural:
    // the key and the domain come out of one call, so a caller cannot hold one
    // and derive the other from something else.
    const outcome = deriveArticleIdentity({
      link: "https://news.example.co.uk/a",
      title: TITLE,
      published: PUBLISHED,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.identity.altKey).toBe(
      deriveAltKey(outcome.identity.sourceDomain, TITLE, PUBLISHED),
    );
  });

  it("refuses a link that will not canonicalize, as `bad_url` carrying the link", () => {
    const outcome = deriveArticleIdentity({
      link: "not a url",
      title: TITLE,
      published: PUBLISHED,
    });

    expect(outcome).toEqual({ ok: false, reason: "bad_url", detail: "not a url" });
  });

  it("refuses the link BEFORE it looks at the timestamp", () => {
    // Order, not preference. All three adapters canonicalized the link before
    // they parsed the stamp, so a sighting malformed in both ways counted as
    // `bad_url` — and which counter a drop lands in is a metric, so a reason
    // that quietly moved would make a rise in either unreadable.
    const outcome = deriveArticleIdentity({
      link: "not a url",
      title: TITLE,
      published: null,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "bad_url" });
  });

  it("hands back a keyless identity when the timestamp did not parse", () => {
    // `published: null` is how an adapter says "the stamp is unusable" without
    // giving up the `bad_url` ordering above. It drops the sighting as
    // `bad_published` on the next line; what matters here is that no key is
    // minted from a timestamp nobody could read.
    const outcome = deriveArticleIdentity({
      link: "https://example.com/a",
      title: TITLE,
      published: null,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.identity.altKey).toBeNull();
    expect(outcome.identity.sourceDomain).toBe("example.com");
    expect(outcome.identity.dedupKey).toBe(deriveDedupKey("https://example.com/a"));
  });
});

/**
 * The publisher-domain override — Google News' IDENTITY departure, expressed as
 * a parameter rather than as a different derivation somewhere else.
 */
describe("the publisher-link override", () => {
  const REDIRECT = "https://news.google.com/rss/articles/CBMiWkFVX3lxTE...?oc=5";

  it("reads the domain out of the publisher's link instead of the article's", () => {
    const outcome = deriveArticleIdentity({
      link: REDIRECT,
      title: TITLE,
      published: PUBLISHED,
      publisherLink: "https://www.cbc.ca/news/canada/ferry-1.123",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The domain moves...
    expect(outcome.identity.sourceDomain).toBe("cbc.ca");
    // ...and takes the key with it, which is the fold working at all: keyed on
    // the redirect every item would sit in one `google.com` key space
    // shared by every publisher on the wire.
    expect(outcome.identity.altKey).toBe(deriveAltKey("cbc.ca", TITLE, PUBLISHED));
    // The URL and its key do NOT move. `dedupKey` is still the redirect's, which
    // is why the fallback identity exists for this provider at all.
    expect(outcome.identity.url).toBe(canonicalizeUrl(REDIRECT));
    expect(outcome.identity.sourceDomain).not.toBe(sourceDomain(outcome.identity.url));
  });

  it("yields no domain at all when the publisher link is absent or unusable", () => {
    // NOT a fall back to the article link's host. Falling back is exactly the
    // `news.google.com` attribution the override exists to avoid, and a null
    // domain means `deriveAltKey` refuses — which the Google News adapter turns
    // into its `no_identity` drop rather than storing a keyless row.
    for (const publisherLink of [undefined, null, "", "   ", "not a url"]) {
      const outcome = deriveArticleIdentity({
        link: REDIRECT,
        title: TITLE,
        published: PUBLISHED,
        publisherLink,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.identity.sourceDomain).toBeNull();
      expect(outcome.identity.altKey).toBeNull();
    }
  });

  it("is decided by the property's PRESENCE, not by its value", () => {
    // `<source url>` is nullish on the wire, so `publisherLink: raw.sourceUrl`
    // has to keep meaning "the publisher's, and there isn't one" when the
    // element is missing. Omitting the property is the only way to ask for the
    // article link's own host.
    const named = deriveArticleIdentity({
      link: REDIRECT,
      title: TITLE,
      published: PUBLISHED,
      publisherLink: undefined,
    });
    const omitted = deriveArticleIdentity({
      link: REDIRECT,
      title: TITLE,
      published: PUBLISHED,
    });

    expect(named.ok && named.identity.sourceDomain).toBeNull();
    expect(omitted.ok && omitted.identity.sourceDomain).toBe("google.com");
  });
});

describe("publisherLinkDomain", () => {
  it("canonicalizes before taking the registrable domain", () => {
    expect(publisherLinkDomain("  https://WWW.Theguardian.com/uk?utm_source=x  ")).toBe(
      "theguardian.com",
    );
    expect(publisherLinkDomain("https://news.cbc.ca/x")).toBe("cbc.ca");
    expect(publisherLinkDomain("https://example.co.uk/x")).toBe("example.co.uk");
  });

  it("is null for anything that is not a usable link", () => {
    for (const value of [null, undefined, "", "  ", "not a url", "ftp://x.example/a"]) {
      expect(publisherLinkDomain(value)).toBeNull();
    }
  });
});
