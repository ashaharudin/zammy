import {
  canonicalizeUrl,
  collapseWhitespace,
  deriveDedupKey,
  deriveSightingId,
  finalizeSighting,
  normalizeBatch,
  sourceDomain,
  type NormalizationStats,
  type NormalizeOutcome,
  type Sighting,
} from "@zammy/news-client";
import { parsePublished, type RawGoogleNewsItem } from "./raw.js";

/**
 * The provider id, stored on every sighting as `sightings.provider`.
 *
 * Not `"gnews"` — that name is taken by an unrelated commercial API
 * (`gnews.io`) which this codebase already has an adapter for, and two
 * providers sharing a name would make per-provider coverage and per-provider
 * yield, the two numbers `sightings.provider` exists for, both meaningless.
 */
export const PROVIDER = "google-news";

/**
 * Google News RSS → `Sighting` (ARCHITECTURE 5.2).
 *
 * Three fields depart from what the other two adapters do. The first is the one
 * that matters most, and all three are consequences of the same fact: the
 * `<link>` is not the article.
 */
export function normalizeSightings(
  raw: readonly RawGoogleNewsItem[],
  feed: { language?: string | null | undefined } = {},
): { sightings: Sighting[]; stats: NormalizationStats } {
  return normalizeBatch(raw, (item) => normalizeSighting(item, feed));
}

export function normalizeSighting(
  raw: RawGoogleNewsItem,
  feed: { language?: string | null | undefined } = {},
): NormalizeOutcome {
  // Stored EXACTLY as received, trailing " - Outlet" suffix included.
  //
  // 100 of 101 items carry one, and it does real damage: "| Globalnews.ca"
  // alone pre-loaded 19.6 of the 20-point link-mass floor in `story_tokens`
  // (RESEARCH-FREE-NEWS-SOURCES §6b), and at 100% of items it would make link
  // mass mean nothing at all. Stripping it here would be the wrong place
  // twice over — the tokenizer is shared, so the strip belongs to G0 and costs
  // a TOKENIZER_VERSION bump plus a repair run, and G1's `alt_key` fold needs
  // its own strip regardless. An adapter quietly editing a headline would also
  // make the stored title disagree with what the provider said it was, which
  // `sightings.raw` exists to prevent.
  const title = collapseWhitespace(raw.title);
  if (!title) return { ok: false, reason: "no_title", detail: raw.guid ?? "(no guid)" };

  // The `CBM…` redirect, and it stays that way. Probed: it does not HTTP
  // redirect — it answers with a ~602KB JavaScript interstitial titled "Google
  // News" in which the publisher's own name appears zero times. Resolving it
  // needs a headless browser or the reverse-engineered `batchexecute` RPC, per
  // article, at 100 articles a slice (DESIGN-DISCOVERY-AND-DEEPENING §2a). So
  // this is a link that works in a browser and is not an identity, and the
  // design accommodates that through `alt_key` (G1) rather than here.
  const rawUrl = collapseWhitespace(raw.link);
  if (!rawUrl) return { ok: false, reason: "no_url", detail: raw.guid ?? "(no guid)" };

  const url = canonicalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: "bad_url", detail: rawUrl };

  const publishedMs = parsePublished(raw.pubDate);
  if (Number.isNaN(publishedMs)) {
    return { ok: false, reason: "bad_published", detail: raw.pubDate ?? "(absent)" };
  }

  // `<guid isPermaLink="false">` is the same `CBM…` id as the link without its
  // `?oc=5`, and it is stable per story: identical on 100/100 shared titles
  // across a repeated query, 51/53 across two different queries, 70/71 across
  // two locales (RESEARCH-FREE-NEWS-SOURCES §6a). Stable enough to key a
  // sighting on, which is all this is — overlapping windows re-fetch the same
  // items constantly and each must collide rather than accumulate.
  const providerSightingId = collapseWhitespace(raw.guid) || url;

  return finalizeSighting({
    id: deriveSightingId(PROVIDER, providerSightingId),
    provider: PROVIDER,
    providerSightingId,
    url,
    // sha256 of the redirect, so it will never collide with the same story's
    // real URL arriving from Currents. That is not a bug to fix here: it is why
    // G1 adds `alt_key` as a FALLBACK identity, and until G1 lands nothing
    // ingests this provider (the flag is off, see `factory.ts`).
    dedupKey: deriveDedupKey(url),
    title,

    // DEPARTURE 1 of 2: null, not derived from the RSS `<description>`.
    //
    // The field is not prose. It arrives as an entity-escaped `<a href>` blob
    // wrapping the same opaque redirect, with the outlet name in a `<font>`
    // tag after it — i.e. the title and the link again, marked up. Stripping
    // the tags would yield the headline a second time; synthesising a summary
    // from the title would put a sentence nobody wrote into the archive. Null
    // is the honest answer and the UI already renders it as no description.
    description: null,

    // No journalist in the feed, and no image either — unlike both other
    // adapters, which get at least one of them.
    author: null,
    imageUrl: null,

    // Items carry no language of their own; this is the channel's `<language>`,
    // reduced to its primary subtag because `Sighting.language` holds a
    // language and the feed reports a locale (`en-CA`). It describes what we
    // ASKED for rather than a per-article detection — honest, and the same
    // value `group.language` groups on elsewhere.
    language: primaryLanguageSubtag(feed.language) ?? null,

    categories: [],
    sourceCategories: [],

    // DEPARTURE 2 of 2: the publisher, from `<source url="…">` — NOT
    // `sourceDomain(url)`, which is what both other adapters do.
    //
    // `url` here is the Google redirect, so following the convention would
    // attribute every article in the archive to `news.google.com`. That is not
    // merely wrong on a source chip: `trending-storylines.ts` gates the cloud on
    // `count(distinct a.source_domain) >= 2`, so one outlet's story plus its
    // Google News copy would read as two newsrooms and clear a gate that exists
    // to ask whether several newsrooms are covering something. Manufactured
    // breadth, on every story Google reports
    // (RESEARCH-FREE-NEWS-SOURCES §6a, DESIGN-DISCOVERY-AND-DEEPENING §3b).
    //
    // **This is the first row shape in the schema where
    // `sourceDomain(article.url) !== article.source_domain`.** Anything that
    // recomputes a domain from a stored URL — a backfill, a repair, a chore —
    // will disagree with these rows, and it is the recomputation that is wrong.
    sourceDomain: publisherDomain(raw.sourceUrl),

    published: new Date(publishedMs).toISOString(),
    raw,
  });
}

/**
 * `<source url>` → registrable domain, or null.
 *
 * Null rather than falling back to `sourceDomain(url)`, which would reintroduce
 * exactly the `news.google.com` attribution the field exists to avoid. A null
 * `source_domain` is excluded from `count(distinct …)` in Postgres, so an item
 * whose publisher we could not read contributes nothing to the two-newsroom
 * gate — which is the correct contribution from an article we cannot attribute.
 * All 120 items across the capture probes carried a usable `<source url>`, so
 * this is a rare path rather than a routine one.
 */
export function publisherDomain(sourceUrl: string | null | undefined): string | null {
  const trimmed = collapseWhitespace(sourceUrl);
  if (!trimmed) return null;
  const canonical = canonicalizeUrl(trimmed);
  return canonical ? sourceDomain(canonical) : null;
}

/** `en-CA` → `en`. Null in, null out. */
export function primaryLanguageSubtag(value: string | null | undefined): string | null {
  const trimmed = collapseWhitespace(value).toLowerCase();
  if (!trimmed) return null;
  return trimmed.split(/[-_]/)[0] || null;
}
