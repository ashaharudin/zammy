import {
  collapseWhitespace,
  deriveArticleIdentity,
  deriveSightingId,
  finalizeSighting,
  normalizeBatch,
  publisherLinkDomain,
  type NormalizationStats,
  type NormalizeOutcome,
  type Sighting,
} from "@zammy/news-client";
import { isDateOnlyStamp, parsePublished, type RawGoogleNewsItem } from "./raw.js";

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
 * Five things depart from what the other two adapters do — marked `DEPARTURE`
 * below, in the order the code reaches them: **identity**, the **drop** on a
 * missing one, **description**, **attribution**, and the two **claims** this
 * adapter makes about its own sighting (ADR-0021). Every one is a consequence of
 * the same fact: **the `<link>` is not the article.** It is an opaque `CBM…`
 * redirect, so it cannot carry identity, cannot name the publisher, and cannot
 * be resolved without a headless browser (DESIGN-DISCOVERY-AND-DEEPENING §2a).
 *
 * That makes `alt_key` (ADR-0018) load-bearing here in a way it is not for the
 * other two adapters, and the difference is worth stating before reading on:
 * for them the fallback is a bonus that catches duplicates the URL missed, and
 * a null one just means "identified by URL alone" — which was every row's state
 * before ADR-0018 and is perfectly safe, because their URL is real. Here the
 * fallback is the ONLY thing that can ever fold a Google item onto the Currents
 * article for the same story, and a null one leaves nothing dependable at all.
 * See `normalizeSighting` for what this adapter does about that.
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

  const publishedMs = parsePublished(raw.pubDate);
  const published = Number.isNaN(publishedMs)
    ? null
    : new Date(publishedMs).toISOString();

  // DEPARTURE — IDENTITY, and the one the whole design leans on.
  //
  // Both other adapters call `deriveArticleIdentity` with no `publisherLink`,
  // which reads the source domain out of the article's own link. This one names
  // it, and that one parameter is the whole departure: the domain — stored, and
  // hashed into `altKey` — comes from `<source url="…">` rather than from the
  // redirect's host. Keyed on the redirect, every Google item in the archive
  // would fold under `google.com`, which is not a newsroom, and the Currents
  // article for the same story sits under the publisher's — so nothing would
  // EVER fold.
  //
  // Naming it here rather than substituting a different derivation is the
  // point. It used to be a `publisherDomain(raw.sourceUrl)` where the others
  // wrote `sourceDomain(url)` — the same shape of expression with a different
  // meaning, which is exactly the invisible break `altKeyProbeIsConsistent` was
  // written to catch at runtime. A parameter is a departure a reader can see.
  //
  // Asked BEFORE the timestamp is reported on, because that is the order these
  // steps ran in when they were open-coded here: an item malformed in both ways
  // counts as `bad_url`, and which counter a drop lands in is a metric.
  const identity = deriveArticleIdentity({
    link: rawUrl,
    title,
    published,
    publisherLink: raw.sourceUrl,
  });
  if (!identity.ok) return identity;

  if (published === null) {
    return { ok: false, reason: "bad_published", detail: raw.pubDate ?? "(absent)" };
  }

  const { altKey, sourceDomain: domain } = identity.identity;

  // `<guid isPermaLink="false">` is the same `CBM…` id as the link without its
  // `?oc=5`, and it is stable per story: identical on 100/100 shared titles
  // across a repeated query, 51/53 across two different queries, 70/71 across
  // two locales (RESEARCH-FREE-NEWS-SOURCES §6a). Stable enough to key a
  // sighting on, which is all this is — overlapping windows re-fetch the same
  // items constantly and each must collide rather than accumulate.
  const providerSightingId = collapseWhitespace(raw.guid) || identity.identity.url;

  // DEPARTURE — a null fallback key is a DROP here, where it is a normal
  // outcome for the other two adapters.
  //
  // For them, null means "identified by URL alone" — the pre-ADR-0018 state,
  // and safe, because their URL is the article. Here it means identified by
  // nothing dependable. The redirect is *nearly* an identity: the `CBM…` id
  // held on 100/100 titles across a repeated query but only 51/53 across two
  // different queries and 70/71 across two locales, so 2–4% of stories carry a
  // different id depending on how they were asked for
  // (RESEARCH-FREE-NEWS-SOURCES §6a). For most callers that tail would be
  // negligible; for the deepening plane it is the modal path, because
  // subdividing one arc's span issues many overlapping queries by construction
  // and each is a fresh chance to mint the same story twice.
  //
  // So a keyless row here is a duplicate generator, and minting one is exactly
  // the state `GOOGLE_NEWS_ENABLED=false` exists to prevent until G1 landed
  // (`factory.ts`). Dropping is counted and visible in `NormalizationStats`,
  // which is the degradation ARCHITECTURE 11 asks for; a silently duplicating
  // row is not.
  //
  // Measured on the committed fixtures: 0 of 120 items take this path. The
  // guard costs nothing today and is cheap insurance against a feed that stops
  // sending `<source url>`, which is the only realistic way to reach it — the
  // other two refusals (`deriveAltKey` on a source-truncated title, or a title
  // that folds to nothing) were also 0 of 120.
  if (!altKey) {
    return {
      ok: false,
      reason: "no_identity",
      detail: domain
        ? `no alt key for "${title.slice(0, 80)}" on ${domain}`
        : `no publisher domain (<source url> was "${raw.sourceUrl ?? "absent"}")`,
    };
  }

  return finalizeSighting({
    id: deriveSightingId(PROVIDER, providerSightingId),
    provider: PROVIDER,
    providerSightingId,
    // `url`, `dedupKey`, `altKey` and `sourceDomain`, spread whole so no field
    // of the identity can be replaced without the others — and so this
    // provider's `sourceDomain` cannot drift from the `altKey` derived from it.
    //
    // `dedupKey` here is the sha256 of the REDIRECT, so it will never collide
    // with the same story's real URL arriving from Currents. That is not a bug
    // to fix here: it is why G1 adds `alt_key` as a FALLBACK identity, and
    // until G1 lands nothing ingests this provider (the flag is off, see
    // `factory.ts`).
    ...identity.identity,
    // Narrowed from `string | null` by the `no_identity` drop above, which is
    // this provider's whole reason for making that drop.
    altKey,
    title,

    // DEPARTURE — DESCRIPTION: null, not derived from the RSS `<description>`.
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

    // DEPARTURE — ATTRIBUTION: `sourceDomain` arrives in the spread above, and
    // it is the publisher's, from `<source url="…">` — NOT the article link's
    // host, which is what both other adapters get.
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
    // `alt_key` above is derived from this same value — by the same call, which
    // is why they are one spread — so a recomputation would disagree with the
    // identity too, not merely with the source chip.

    published,

    // DEPARTURE — the two claims this adapter makes about its OWN fields, both
    // of them warnings to the storage layer's display-field handover (ADR-0002)
    // and neither of them expressible by any other adapter.
    //
    // The first is unconditional and follows from the same fact the whole
    // header is about: the `<link>` is not the article. Of the nine display
    // columns it gates, SEVEN can only ever lose information when handed to a
    // row Currents minted — the redirect `url`, the chromed `title`, and the
    // five fields written as unconditional literals above. The other two,
    // `language` and `sourceDomain`, are real values, and `sourceDomain` is the
    // newsroom's own domain this adapter works to get right; they are refused
    // with the rest anyway and it costs nothing, because a fold onto an existing
    // article is only reachable through an `alt_key` derived from
    // `sourceDomain`, so the domains already agree by the time it runs.
    //
    // The refusal holds even when the earlier-emission claim driving the
    // handover is perfectly true — being first is not being first-hand.
    //
    // The second is per-item, because the degradation is: this provider times
    // recent items properly and stops timing older ones. `isDateOnlyStamp`
    // carries the measurement and the reason it is Pacific rather than a
    // constant.
    isAggregatorCopy: true,
    publishedIsDateOnly: isDateOnlyStamp(publishedMs),

    raw,
  });
}

/**
 * `<source url>` → registrable domain, or null.
 *
 * Null rather than falling back to `sourceDomain(url)`, which would reintroduce
 * exactly the `news.google.com` attribution the field exists to avoid.
 *
 * **A null never reaches the archive**, though, and that is a consequence of
 * ADR-0018 rather than of this function: the same value keys `alt_key`, and
 * `deriveAltKey` refuses a null domain, so `normalizeSighting` drops the item
 * before it can be stored. So `source_domain` on this provider's rows is always
 * a real newsroom — a stronger guarantee than either other adapter offers, and
 * one nothing should be built on lightly, since it holds only while the drop
 * above does. All 120 items across the capture probes carried a usable
 * `<source url>`, so the path is a guard rather than a routine one.
 *
 * **The derivation itself is not here.** It is `publisherLinkDomain` in
 * `@zammy/news-client`, which is what `deriveArticleIdentity` calls when this
 * adapter names `publisherLink` — so the domain the fixture store filters on and
 * the domain `alt_key` is scoped to are the same function rather than two
 * spellings of one, and the identity cannot drift from the corpus that tests it.
 * This name stays because it is what this provider calls the concept.
 */
export function publisherDomain(sourceUrl: string | null | undefined): string | null {
  return publisherLinkDomain(sourceUrl);
}

/** `en-CA` → `en`. Null in, null out. */
export function primaryLanguageSubtag(value: string | null | undefined): string | null {
  const trimmed = collapseWhitespace(value).toLowerCase();
  if (!trimmed) return null;
  return trimmed.split(/[-_]/)[0] || null;
}
