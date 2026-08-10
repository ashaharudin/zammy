import { z } from "zod";

/**
 * A **sighting**: one emission of an article by the upstream API, normalized
 * (ARCHITECTURE 5.2, ADR-0002).
 *
 * Upstream re-emits the same story under fresh UUIDs — one link-roundup page
 * arrived 50 times in 100 results — so this is an observation, not a story. The
 * story is an `Article`, which the storage layer creates by collapsing sightings
 * that share a `dedupKey`.
 *
 * This type lives here rather than in `@zammy/shared` deliberately: `shared`
 * carries only what ships to the browser, and the browser has no use for
 * `dedupKey` (ADR-0004).
 */
export const Sighting = z.object({
  /** Upstream UUID. Unique per sighting, and NOT an identity for the story. */
  id: z.uuid(),
  url: z.url(),
  /**
   * sha256 of the canonical URL, hex. Sightings sharing this are the same story;
   * it is the key the storage layer groups on. Server-side only.
   */
  dedupKey: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1),
  description: z.string().nullable(),
  author: z.string().nullable(),
  /** Null when upstream sent the literal string "None", which it often does. */
  imageUrl: z.url().nullable(),
  language: z.string().nullable(),
  categories: z.array(z.string()),
  /** Undocumented upstream field, kept verbatim (PROBE-FINDINGS 1). */
  sourceCategories: z.array(z.string()),
  sourceDomain: z.string().nullable(),
  /** ISO-8601. Upstream sends "2026-08-04 20:45:56 +0000", which `new Date()` mis-parses. */
  published: z.iso.datetime(),
});
export type Sighting = z.infer<typeof Sighting>;
