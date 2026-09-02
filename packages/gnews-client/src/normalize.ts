import {
  collapseWhitespace,
  deriveArticleIdentity,
  deriveSightingId,
  finalizeSighting,
  normalizeBatch,
  normalizeImage,
  type NormalizationStats,
  type NormalizeOutcome,
  type Sighting,
} from "@zammy/news-client";
import type { RawGnewsArticle } from "./raw.js";

export const PROVIDER = "gnews";

/**
 * GNews → `Sighting` (ARCHITECTURE 5.2).
 *
 * Much shorter than the Currents mapping, because GNews sends fewer surprises:
 * real ISO-8601 timestamps, a single `url` field, and `null` where a value is
 * absent instead of the string "None". The interesting decisions are the three
 * places where GNews has *less* than Currents, and where guessing would be worse
 * than admitting it:
 *
 *   - **no categories.** `/search` neither returns nor filters on them, so
 *     `categories` is empty rather than back-filled from anything.
 *   - **no `source_category`.** Empty, being a Currents-only field.
 *   - **ids post-date the v4 launch.** When one is missing the canonical URL
 *     stands in, so a re-fetch of the same article still collides on
 *     `sightings.id` and the ingest stays idempotent.
 */
export function normalizeSightings(raw: readonly RawGnewsArticle[]): {
  sightings: Sighting[];
  stats: NormalizationStats;
} {
  return normalizeBatch(raw, normalizeSighting);
}

export function normalizeSighting(raw: RawGnewsArticle): NormalizeOutcome {
  const title = collapseWhitespace(raw.title);
  if (!title) return { ok: false, reason: "no_title", detail: raw.id ?? "(no id)" };

  const rawUrl = collapseWhitespace(raw.url);
  if (!rawUrl) return { ok: false, reason: "no_url", detail: raw.id ?? "(no id)" };

  const publishedMs = parsePublished(raw.publishedAt);
  const published = Number.isNaN(publishedMs)
    ? null
    : new Date(publishedMs).toISOString();

  // The canonical URL, both keys and the domain, derived together from the
  // values that are about to be stored — so the identity and the thing it
  // identifies cannot disagree (ADR-0018). No override: this provider's `url`
  // IS the article, so its own host names the newsroom.
  //
  // Asked BEFORE the timestamp is reported on, because that is the order these
  // steps ran in when they were open-coded here: a sighting malformed in both
  // ways counts as `bad_url`, and which counter a drop lands in is a metric.
  const identity = deriveArticleIdentity({ link: rawUrl, title, published });
  if (!identity.ok) return identity;

  if (published === null) {
    return { ok: false, reason: "bad_published", detail: raw.publishedAt ?? "(absent)" };
  }

  // The canonical URL, not the raw one, so the fallback identity is stable
  // across the tracking parameters that make one article arrive as two strings.
  const providerSightingId = collapseWhitespace(raw.id) || identity.identity.url;

  return finalizeSighting({
    // GNews ids are opaque strings, not UUIDs, so one is derived — see
    // `deriveSightingId` for why that keeps `sightings.id uuid` intact.
    id: deriveSightingId(PROVIDER, providerSightingId),
    provider: PROVIDER,
    providerSightingId,
    // `url`, `dedupKey`, `altKey` and `sourceDomain`, spread whole so no field
    // of the identity can be replaced without the others.
    ...identity.identity,
    title,
    description: collapseWhitespace(raw.description) || null,
    // GNews names the outlet but never the journalist. Null is the honest
    // answer; the source chip comes from `sourceDomain` either way.
    author: null,
    imageUrl: normalizeImage(raw.image),
    language: collapseWhitespace(raw.lang) || null,
    categories: [],
    sourceCategories: [],
    // `sourceDomain` arrives in the spread above, derived from the URL rather
    // than taken from `source.name`, so the same story reported by both
    // providers presents as one source rather than as "bbc.co.uk" and
    // "BBC News".
    published,
    raw,
  });
}

/**
 * Parse GNews's `publishedAt`.
 *
 * Real ISO-8601, so `Date.parse` is correct here — unlike the Currents format,
 * which `new Date()` mis-parses across runtimes. Still validated rather than
 * trusted: a wrong timestamp silently corrupts the timeline, which is the one
 * thing the product promises, so an unparseable value is dropped and counted
 * rather than defaulted to "now" (ARCHITECTURE 11).
 */
export function parsePublished(value: string | null | undefined): number {
  const trimmed = collapseWhitespace(value);
  if (!trimmed) return Number.NaN;
  // A bare date or a loose string would parse in some runtimes and not others.
  // Requiring the full timestamp keeps the drop deterministic.
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(trimmed)) return Number.NaN;
  return Date.parse(trimmed);
}
