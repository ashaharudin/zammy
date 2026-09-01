import { z } from "zod";

/**
 * An **article**: one real-world news story (ADR-0002).
 *
 * This is the unit users see, the unit the timeline pages over, and the unit
 * anything countable counts. It is produced by the storage layer, which collapses
 * every upstream **sighting** sharing a canonical URL into a single article —
 * upstream sent one link-roundup page 50 times in 100 results, so without that
 * collapse over half a typical timeline is one repeated post.
 *
 * The sighting shape is deliberately absent from this package: it carries a
 * `dedupKey` that only the server needs (ADR-0004).
 */
export const Article = z.object({
  /**
   * Surrogate identity, as a decimal string.
   *
   * A string rather than a number because the column is a Postgres `bigint` and
   * JSON cannot carry those beyond 2^53 without silently losing precision.
   * Surrogate rather than the canonical-URL hash because URL canonicalization is
   * a rule we keep changing, and the timeline cursor is built from this id — so a
   * natural key would re-key live cursors every time the rule widened (ADR-0002).
   */
  id: z.string().regex(/^\d+$/),
  /**
   * The **group** this article belongs to — one story as several outlets ran
   * it (CONTEXT.md, Group). A decimal string for the same reason `id` is one:
   * it IS an article id, the seed's.
   *
   * Here because the browser needs it, which is ADR-0004's whole test. The rail
   * cuts a slot into the parts of the day its coverage reached and must not
   * draw one piece twice when its copies straddle a boundary, so it has to know
   * which articles are one piece. Sending the members flat and letting the
   * browser infer that made it infer from exact title equality, which cannot
   * tell two "Live updates" apart (`apps/web/src/format.ts`, `railSlots`).
   *
   * On the article rather than around it: `articles.group_id` is NOT NULL and
   * self-seeded, so every article is in a group whether or not anyone else ran
   * the story (migration 0003). Nesting the wire's `moreCoverage` by group
   * instead would have made the disclosure's rows group-major, where §14.3 has
   * them newest-first.
   */
  groupId: z.string().regex(/^\d+$/),
  url: z.url(),
  title: z.string().min(1),
  description: z.string().nullable(),
  author: z.string().nullable(),
  /** Null when upstream sent the literal string "None", which it often does. */
  imageUrl: z.url().nullable(),
  language: z.string().nullable(),
  categories: z.array(z.string()),
  /** Undocumented upstream field, kept verbatim (PROBE-FINDINGS 1). */
  sourceCategories: z.array(z.string()),
  /** Registrable domain of the source outlet. Rendered as a chip. */
  sourceDomain: z.string().nullable(),
  /**
   * ISO-8601, from the article's EARLIEST sighting.
   *
   * A chronology places a story when it appeared. The cost is deliberate: a
   * continuously-updated story sinks down the timeline and never resurfaces.
   * Ordering by the latest sighting was rejected because it lets the noisiest
   * sources permanently hold the top of the feed (ADR-0002).
   */
  published: z.iso.datetime(),
  /** Upstream emissions collapsed into this article. 1 for most; 50 for the worst. */
  sightingCount: z.int().min(1),
  /** The most recent sighting. Rendered as "updated <relative>" when count > 1. */
  latestSeen: z.iso.datetime(),
});
export type Article = z.infer<typeof Article>;
