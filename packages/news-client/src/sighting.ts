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
   * The upstream item exactly as received, unknown fields included. Stored in
   * `sightings.raw` (ARCHITECTURE 7.2) so a widened canonicalization rule can
   * re-normalize history without refetching — often impossible anyway, since
   * providers reach back 30 days on the tiers we run.
   */
  raw: z.looseObject({}),
});
export type Sighting = z.infer<typeof Sighting>;
