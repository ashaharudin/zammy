import { z } from "zod";

/**
 * A **sighting**: one emission of an article by an upstream API, normalized
 * (ARCHITECTURE 5.2, ADR-0002).
 *
 * Upstream re-emits the same story under fresh identifiers — one link-roundup
 * page arrived 50 times in 100 Currents results — so this is an observation, not
 * a story. The story is an `Article`, which the storage layer creates by
 * collapsing sightings that share a `dedupKey`.
 *
 * The shape is deliberately provider-agnostic: two providers emitting the same
 * URL produce two sightings of one article, which is the same relationship one
 * provider re-emitting a story produces. Nothing above this package needs a
 * second concept for it.
 *
 * This type lives here rather than in `@zammy/shared` deliberately: `shared`
 * carries only what ships to the browser, and the browser has no use for
 * `dedupKey` (ADR-0004).
 */
export const Sighting = z.object({
  /**
   * Sighting identity, unique across ALL providers and NOT an identity for the
   * story.
   *
   * Currents emits real UUIDs and they are used verbatim, so ids already in
   * `sightings` keep their value and a re-fetch stays idempotent. Providers whose
   * ids are not UUIDs derive one deterministically from a per-provider namespace
   * — see `deriveSightingId` — which buys the same idempotency without widening
   * the `sightings.id uuid` primary key.
   */
  id: z.uuid(),
  /** Which upstream emitted this. Stored, so per-provider yield is measurable. */
  provider: z.string().min(1),
  /**
   * The provider's own identifier for this emission, verbatim. Kept because a
   * derived `id` is one-way: without this, a sighting cannot be traced back to
   * the row the provider would recognise.
   */
  providerSightingId: z.string().min(1),
  url: z.url(),
  /**
   * sha256 of the canonical URL, hex. Sightings sharing this are the same article
   * — including across providers, which is exactly what makes fan-out cheap. It
   * is the key the storage layer groups on. Server-side only.
   */
  dedupKey: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The FALLBACK identity: sha256 of `(source domain, folded title, UTC day)`,
   * hex — or null when the inputs cannot carry one (`deriveAltKey`, ADR-0018).
   * Ingest consults it only when `dedupKey` matches nothing, so a URL seen
   * before behaves exactly as it did before this field existed. Server-side
   * only, for the same reason `dedupKey` is (ADR-0004).
   *
   * Nullable but NOT optional: an adapter that forgets it fails the schema gate
   * in `finalizeSighting` and drops loudly, rather than quietly minting articles
   * that can never fold.
   */
  altKey: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  title: z.string().min(1),
  description: z.string().nullable(),
  author: z.string().nullable(),
  /** Null when the provider sent a placeholder — Currents sends "None" often. */
  imageUrl: z.url().nullable(),
  language: z.string().nullable(),
  categories: z.array(z.string()),
  /** Undocumented Currents field, kept verbatim (PROBE-FINDINGS 1). Empty for
   * providers that have no equivalent. */
  sourceCategories: z.array(z.string()),
  sourceDomain: z.string().nullable(),
  /** ISO-8601, normalized by the adapter from whatever the provider sends. */
  published: z.iso.datetime(),
  /**
   * **This sighting is an AGGREGATOR'S COPY of somebody else's article**: its
   * `url` is a redirect it cannot resolve, and its display fields are the
   * aggregator's rendering rather than the newsroom's record. Set only by an
   * adapter that knows this of itself.
   *
   * Google News is the case that exists. Two facts about it, both checkable in
   * `@zammy/google-news-client`'s own normalizer rather than inferred:
   *
   *  - its `<link>` is an opaque `CBM…` hop through `news.google.com`, which
   *    `DropReason.no_identity` already names in as many words; and
   *  - it writes `description`, `author` and `imageUrl` as `null` and both
   *    category arrays as `[]` **as unconditional literals**, not as fallbacks,
   *    so no input can populate them — though only `description` has a DEPARTURE
   *    note arguing it, and the empty category arrays are argued nowhere — while
   *    its `title` carries a ` - Outlet` suffix the newsroom did not write.
   *
   * So of the fields such a sighting could hand to an article the newsroom's own
   * provider already minted, five are empty, the `title` is chromed and the
   * `url` is a redirect. Two are NOT — `language` and `sourceDomain` are real
   * values, and `sourceDomain` is the newsroom's own domain, which the adapter
   * works to get right. They are refused with the rest anyway, and it costs
   * nothing: a fold onto an existing article can only be reached through
   * `alt_key`, which is derived from `sourceDomain`, so the two domains are
   * equal by the time this runs.
   * ADR-0002 gives the display fields to the earliest emission; ADR-0021 gives
   * them to the earliest FIRST-HAND emission, and this flag is what separates
   * the two. Measured (plan §G6, dev archive 2026-08-29): 116 of 169 absorbed
   * articles lost their outlet URL this way, and **9 of the 12 in the
   * leading-edge run were cases where the earlier-emission claim was TRUE.**
   * Being right about which emission came first does not make an aggregator's
   * rendering the better record.
   *
   * What such a sighting is still trusted for is that it SAW the article, and
   * WHEN — so it still folds `published`/`latest_seen` and still hands over
   * `provider`, which is a fact about the emission rather than a rendering of
   * the article. And a newly minted article keeps everything, redirect
   * included: there is no other record of it, and the alternative is not
   * storing it.
   *
   * Absent means "a first-hand record", which is what every adapter but one
   * sends and what every row predating this field carries.
   */
  isAggregatorCopy: z.boolean().optional(),
  /**
   * **The provider sent a DATE and this timestamp's clock is the provider's own
   * convention, not the article's publication time.**
   *
   * Google News stops reporting a time for items past about eight days and
   * sends midnight US Pacific instead — measured over 3,087 sightings (plan
   * §G6): 1.7% degraded at eight days or fresher, 89.4% beyond that. The
   * timestamp still parses, still sorts, and is still wrong by up to a day.
   *
   * It is a flag rather than a null `published` because the date is real
   * information — it puts the article in the right day slot, which is the axis
   * the product is about. What it must not be allowed to do is REDEFINE an
   * article the discovery plane already timed properly: `published = LEAST(...)`
   * would drag a 12:09 article back to 07:00, and being then the "earliest
   * emission" it would take the display fields with it.
   *
   * **Nothing here can enforce that an adapter sets it.** `finalizeSighting`
   * takes `unknown`, so an object literal gets no compile-time push, and a
   * provider that changes its convention silently stops matching whatever rule
   * detects this. That is why `zammy_sightings_stamped_total` exists and is
   * labelled by provider: the metric is the enforcement, and a fall in the
   * `date_only` share to zero should be read as "the detector broke", not as
   * "the provider improved".
   */
  publishedIsDateOnly: z.boolean().optional(),
  /**
   * The upstream item exactly as received, unknown fields included. Stored in
   * `sightings.raw` (ARCHITECTURE 7.2) so a widened canonicalization rule can
   * re-normalize history without refetching — often impossible anyway, since
   * providers reach back 30 days on the tiers we run.
   */
  raw: z.looseObject({}),
});
export type Sighting = z.infer<typeof Sighting>;
