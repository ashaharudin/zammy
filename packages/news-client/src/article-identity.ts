import {
  canonicalizeUrl,
  collapseWhitespace,
  deriveAltKey,
  deriveDedupKey,
  sourceDomain,
  type DropReason,
} from "./normalize.js";

/**
 * Article identity — the four fields that decide WHICH ARTICLE a sighting is,
 * derived together so they cannot be derived apart.
 *
 * `normalize.ts` next door holds the steps: `canonicalizeUrl`,
 * `deriveDedupKey`, `deriveAltKey`, `sourceDomain`. Holding only the steps left
 * the ORDER unwritten, and every adapter had to know it — collapse the title,
 * pick the link field, canonicalize it, parse `published` to ISO, derive the
 * domain, hash the URL, hash the triple, and then store `sourceDomain: domain`
 * so the stored fields agree with the key. Eight steps, open-coded three times,
 * with nothing but a comment saying they had to agree.
 *
 * The proof that it was a protocol rather than an interface is
 * `altKeyProbeIsConsistent`: a RUNTIME re-derivation check that exists only
 * because the type system cannot express "the key you passed must come from the
 * fields you also passed". This module is that expression. An adapter asks for
 * an identity and spreads the answer; it cannot pass a key derived from a domain
 * it did not store, because it never names either one.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch the fold. Every derivation below is the one `normalize.ts`
 * already performed, called in the order the adapters already called it, and
 * that is a hard constraint rather than a preference: `dedup_key` and `alt_key`
 * are STORED columns under unique indexes on a live archive, so a re-expression
 * that changed one byte would stop matching the rows we already have and start
 * minting duplicates of articles we already hold — silently. ADR-0018 says it in
 * as many words: changing the fold is a migration, not an edit. The pinning is
 * `identity-differential.test.ts` in each adapter package, which re-derives the
 * four fields the pre-module way over every recorded fixture and asserts they
 * agree.
 *
 * It also does not pick the link field, collapse the title or parse `published`.
 * Those are per-provider by nature — Currents sends the link as `url` in
 * responses and `urls` in the spec, GNews sends ISO-8601 where Currents sends
 * `"2026-08-04 20:45:56 +0000"` — and each adapter's drop for a missing one
 * carries the provider's own identifier in `detail`. What crosses into here is
 * the three values the keys are actually made of.
 */

/**
 * The four fields that identify an article, derived from one set of inputs.
 *
 * Spread whole into `finalizeSighting`. Taking one and deriving its neighbour
 * elsewhere is the failure this type exists to prevent — `sourceDomain` is here
 * precisely because `altKey` was derived from it, and the two travelling
 * together is what `altKeyProbe` reads back out of a stored sighting.
 */
export interface ArticleIdentity {
  /** The canonical link, stored AND hashed into `dedupKey` (ARCHITECTURE 7.4). */
  url: string;
  dedupKey: string;
  /** Null when the inputs cannot carry a fallback identity (ADR-0018). */
  altKey: string | null;
  /** The registrable domain `altKey` was scoped to, and the one to store. */
  sourceDomain: string | null;
}

/**
 * An identity, or the drop that stands in for one.
 *
 * The failure arm is shaped like `NormalizeOutcome`'s, so an adapter returns it
 * unwrapped: `if (!identity.ok) return identity;`. One refusal reaches it today
 * — a link that will not canonicalize, which every adapter already dropped as
 * `bad_url` with the raw link as `detail`.
 */
export type ArticleIdentityOutcome =
  | { ok: true; identity: ArticleIdentity }
  | { ok: false; reason: DropReason; detail: string };

export interface ArticleIdentityInput {
  /** The provider's link for the article, already picked out of its wire shape. */
  link: string;
  /** The title as it will be STORED, whitespace already collapsed. */
  title: string;
  /**
   * `published` as it will be STORED: ISO-8601 — or **null when the provider's
   * timestamp did not parse**, which yields a keyless identity the adapter then
   * drops as `bad_published`.
   *
   * Tolerating the null is what keeps `bad_url` AHEAD of `bad_published`. All
   * three adapters canonicalized the link before they parsed the stamp, so a
   * sighting malformed in both ways counted as `bad_url`, and a drop reason is a
   * metric (`NormalizationStats`) rather than a detail — a reason that silently
   * changed which counter it lands in would make a rise in either unreadable.
   * The alternative, parsing the stamp first so this could take a plain string,
   * moves that count for no gain.
   */
  published: string | null;
  /**
   * Read the source domain out of THIS link rather than out of `link`, for a
   * provider whose own link is not the article (ADR-0018, and the Google News
   * adapter's IDENTITY departure).
   *
   * Google News' `<link>` is an opaque `CBM…` redirect through
   * `news.google.com`, which is not a newsroom; keyed on it, every one of its
   * items would fold into one shared key space and the Currents article for the
   * same story — under the publisher's own domain — would never be reached. So
   * that adapter passes its `<source url="…">` here.
   *
   * **Presence decides, not value.** Omitting the property reads the domain from
   * `link`; naming it reads the domain from the publisher link ALONE, and an
   * absent, empty or unparseable one yields a null domain rather than falling
   * back to `link`'s host — falling back is exactly the `news.google.com`
   * attribution the override exists to avoid. `<source url>` is `nullish` on the
   * wire, so `publisherLink: raw.sourceUrl` must keep meaning "the publisher's,
   * and there isn't one" when the element is missing.
   */
  publisherLink?: string | null | undefined;
}

/**
 * Derive an article's identity from the link, title and timestamp a sighting is
 * about to store.
 *
 * The one entry point: an adapter that calls this never names
 * `canonicalizeUrl`, `deriveDedupKey` or `deriveAltKey`, so it cannot call them
 * in another order or on other values.
 */
export function deriveArticleIdentity(input: ArticleIdentityInput): ArticleIdentityOutcome {
  const url = canonicalizeUrl(input.link);
  if (!url) return { ok: false, reason: "bad_url", detail: input.link };

  // `in` rather than a null check: see `publisherLink` above. A provider that
  // names the property is asking for the publisher's domain even when its feed
  // sent no publisher, and `undefined` is how a missing `<source url>` arrives.
  const domain =
    "publisherLink" in input
      ? publisherLinkDomain(input.publisherLink)
      : sourceDomain(url);

  return {
    ok: true,
    identity: {
      url,
      dedupKey: deriveDedupKey(url),
      // Derived from `domain` and returned beside it, which is the whole point:
      // the key and the field it was scoped to leave here as one value.
      altKey:
        input.published === null
          ? null
          : deriveAltKey(domain, input.title, input.published),
      sourceDomain: domain,
    },
  };
}

/**
 * A publisher link → its registrable domain, or null.
 *
 * The same two steps `sourceDomain` is given elsewhere — canonicalize, then take
 * the registrable domain — applied to a link that is not the article's own. It
 * is separate only because that link arrives raw rather than canonicalized, and
 * because a link that will not canonicalize is a null domain here rather than a
 * `bad_url` drop: the ARTICLE's link is what decides whether a sighting is
 * usable, and a provider naming an unusable publisher has said it does not know
 * the newsroom.
 *
 * Exported so `@zammy/google-news-client` can filter its fixture corpus by the
 * same value it keys on, rather than by a second spelling of it.
 */
export function publisherLinkDomain(link: string | null | undefined): string | null {
  const trimmed = collapseWhitespace(link);
  if (!trimmed) return null;
  const canonical = canonicalizeUrl(trimmed);
  return canonical ? sourceDomain(canonical) : null;
}
