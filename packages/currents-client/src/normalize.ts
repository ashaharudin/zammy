import {
  canonicalizeUrl,
  collapseWhitespace,
  dedupeStrings,
  deriveAltKey,
  deriveDedupKey,
  finalizeSighting,
  firstNonEmpty,
  normalizeBatch,
  normalizeImage,
  sourceDomain,
  type NormalizationStats,
  type NormalizeOutcome,
  type Sighting,
} from "@zammy/news-client";
import type { RawSighting } from "./raw.js";

export const PROVIDER = "currents";

/**
 * Currents → `Sighting` (ARCHITECTURE 5.2).
 *
 * The provider-agnostic half of normalization — URL canonicalization, the dedup
 * key, the registrable domain, the drop accounting — lives in
 * `@zammy/news-client`. What is here is only what is true of *Currents*, and
 * none of it is hypothetical; every entry was observed live (PROBE-FINDINGS 1):
 *
 *   - `published` is "2026-08-04 20:45:56 +0000" — NOT ISO-8601.
 *   - `image` is the literal string "None" in 47 of 180 recorded sightings.
 *   - the link field is `url` in responses and `urls` in the spec; tolerate both.
 *   - `category` needs lowercasing; `source_category` is undocumented and kept verbatim.
 *
 * A malformed sighting is dropped and counted rather than repaired with a guess
 * (ARCHITECTURE 11). The one case that matters most is a bad timestamp — the
 * timeline axis is the product's core promise, so defaulting it to "now" would
 * silently corrupt the thing users came for.
 */
export function normalizeSightings(raw: readonly RawSighting[]): {
  sightings: Sighting[];
  stats: NormalizationStats;
} {
  return normalizeBatch(raw, normalizeSighting);
}

export function normalizeSighting(raw: RawSighting): NormalizeOutcome {
  const title = collapseWhitespace(raw.title);
  if (!title) return { ok: false, reason: "no_title", detail: raw.id };

  // The spec names the link field `urls`; every observed response used `url`.
  const rawUrl = firstNonEmpty(raw.url, raw.urls);
  if (!rawUrl) return { ok: false, reason: "no_url", detail: raw.id };

  const url = canonicalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: "bad_url", detail: rawUrl };

  const publishedMs = parsePublished(raw.published);
  if (Number.isNaN(publishedMs)) {
    return { ok: false, reason: "bad_published", detail: raw.published };
  }

  // Both derived here, from the same values that are about to be stored, so the
  // identity and the thing it identifies cannot disagree (ADR-0018).
  const domain = sourceDomain(url);
  const published = new Date(publishedMs).toISOString();

  return finalizeSighting({
    // Currents emits real UUIDs, so they are used verbatim rather than derived.
    // Every `sightings` row predating the second provider carries one of these,
    // and re-keying them would re-ingest the entire archive as new emissions.
    id: raw.id,
    provider: PROVIDER,
    providerSightingId: raw.id,
    url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(domain, title, published),
    title,
    description: collapseWhitespace(raw.description) || null,
    author: collapseWhitespace(raw.author) || null,
    imageUrl: normalizeImage(raw.image),
    language: collapseWhitespace(raw.language) || null,
    categories: dedupeStrings(
      (raw.category ?? []).map((c) => collapseWhitespace(c).toLowerCase()),
    ),
    // Undocumented upstream field, kept verbatim — we do not yet know what its
    // values mean, so lowercasing it would be destroying information we cannot
    // recover without re-fetching (PROBE-FINDINGS 1).
    sourceCategories: dedupeStrings((raw.source_category ?? []).map(collapseWhitespace)),
    sourceDomain: domain,
    published,
    raw,
  });
}

/**
 * Parse `"2026-08-04 20:45:56 +0000"`.
 *
 * `new Date()` handles this inconsistently across runtimes, and a wrong
 * timestamp silently corrupts the timeline — the one thing the product promises.
 * Returns NaN rather than guessing, so the caller drops and counts.
 */
export function parsePublished(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})?$/
    .exec(value.trim());
  if (!match) return Number.NaN;

  const [, year, month, day, hour, minute, second, tzHour, tzMinute = "00"] = match;
  const offsetMinutes =
    Number(tzHour) * 60 + Math.sign(Number(tzHour) || 1) * Number(tzMinute);

  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) - offsetMinutes * 60_000;
}
