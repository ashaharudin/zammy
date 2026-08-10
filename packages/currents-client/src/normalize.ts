import { createHash } from "node:crypto";
import { Sighting } from "./sighting.js";
import type { RawSighting } from "./raw.js";

/**
 * Normalization — the client's most important job (ARCHITECTURE 5.2).
 *
 * Every upstream quirk is absorbed here, once, at the boundary, so that nothing
 * downstream ever sees a raw Currents payload. The list is not hypothetical;
 * every entry was observed live (PROBE-FINDINGS 1):
 *
 *   - `published` is "2026-08-04 20:45:56 +0000" — NOT ISO-8601.
 *   - `image` is the literal string "None" in 47 of 180 recorded sightings.
 *   - the link field is `url` in responses and `urls` in the spec; tolerate both.
 *   - `category` needs lowercasing; `source_category` is undocumented and kept verbatim.
 *
 * Normalization is deliberately fallible: a malformed sighting is dropped and
 * counted rather than repaired with a guess (ARCHITECTURE 11). The one case that
 * matters most is a bad timestamp — the timeline axis is the product's core
 * promise, so defaulting it to "now" would silently corrupt the thing users came for.
 */

/** Why a sighting was dropped. Each is a counter, so a rising rate is visible. */
export type DropReason =
  | "no_title"
  | "no_url"
  | "bad_url"
  | "bad_published"
  | "schema";

export interface NormalizationStats {
  received: number;
  kept: number;
  dropped: Record<DropReason, number>;
}

export type NormalizeOutcome =
  | { ok: true; sighting: Sighting }
  | { ok: false; reason: DropReason; detail: string };

export function emptyStats(): NormalizationStats {
  return {
    received: 0,
    kept: 0,
    dropped: {
      no_title: 0,
      no_url: 0,
      bad_url: 0,
      bad_published: 0,
      schema: 0,
    },
  };
}

/**
 * Normalize a batch, keeping what is usable and counting what is not.
 *
 * The caller must NOT use `sightings.length` as an end-of-results signal: drops
 * change the count, and `sightings.length < pageSize` would then read as "last
 * page" when it only means "one sighting was malformed". The raw count is the
 * only valid page-boundary signal — see `SearchResult.isLastPage`.
 */
export function normalizeSightings(raw: readonly RawSighting[]): {
  sightings: Sighting[];
  stats: NormalizationStats;
} {
  const stats = emptyStats();
  const sightings: Sighting[] = [];

  for (const item of raw) {
    stats.received += 1;
    const outcome = normalizeSighting(item);
    if (outcome.ok) {
      sightings.push(outcome.sighting);
      stats.kept += 1;
    } else {
      stats.dropped[outcome.reason] += 1;
    }
  }

  return { sightings, stats };
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

  const candidate = {
    id: raw.id,
    url,
    dedupKey: deriveDedupKey(url),
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
    sourceDomain: sourceDomain(url),
    published: new Date(publishedMs).toISOString(),
  };

  // Validate against the shared contract rather than trusting our own mapping.
  // This is the last gate before a sighting reaches the rest of the system, and
  // it is cheap; a `schema` drop means upstream sent something the contract does
  // not describe, which is a fact worth a metric rather than a crash.
  const parsed = Sighting.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

  return { ok: true, sighting: parsed.data };
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

/** Query parameters that identify a referral, never a document. */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "msclkid", "igshid", "mc_eid"]);

/**
 * Canonical form of a sighting's link, used BOTH as the stored `url` and as the
 * input to `dedupKey` (ARCHITECTURE 7.4). One function, so the link a user
 * clicks and the key that collapses duplicates can never disagree.
 *
 * Lowercases scheme and host (`new URL` does this), strips the fragment, removes
 * tracking parameters, and trims the trailing slash. Verified against probe data:
 * 42 unique raw URLs → 42 unique canonical URLs, so it neither over- nor
 * under-collapses on real input.
 *
 * Parameter order is deliberately NOT normalized. Sorting would collapse a
 * slightly wider set of duplicates, but the probe found no evidence upstream
 * reorders parameters, and over-collapsing merges genuinely distinct stories —
 * a worse failure than leaving one duplicate uncollapsed.
 */
export function canonicalizeUrl(raw: string): string | null {
  const withScheme = raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw.trim();

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }

  let href = url.toString();
  if (href.endsWith("?")) href = href.slice(0, -1);
  if (href.endsWith("/") && !href.endsWith("//")) href = href.slice(0, -1);
  return href;
}

/**
 * sha256 of the canonical URL, hex. Sightings sharing this are the same article
 * re-emitted under a new UUID — upstream sent one link-roundup page 50 times in
 * 100 results (PROBE-FINDINGS 4).
 */
export function deriveDedupKey(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex");
}

/**
 * ccTLD registries that sell at the third level, so `example.co.uk` is one
 * registrable domain rather than two labels of `co.uk`.
 *
 * Not the full Public Suffix List: pulling in a PSL dependency (and its periodic
 * data updates) buys accuracy we do not need, because this value is used for a
 * source chip in the UI and for the wordcloud's distinct-domain gate
 * (ARCHITECTURE 10.3). An error here slightly mis-groups one outlet; it cannot
 * corrupt stored data. Covers the suffixes present in probe data plus the common
 * remainder.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "net.uk", "org.uk",
  "com.au", "edu.au", "gov.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "co.nz", "co.za", "co.in", "co.il", "co.kr", "co.id", "co.th", "co.ke",
  "com.ar", "com.bd", "com.br", "com.cn", "com.co", "com.eg", "com.hk",
  "com.mx", "com.my", "com.ng", "com.pe", "com.ph", "com.pk", "com.sa",
  "com.sg", "com.tr", "com.tw", "com.ua", "com.vn",
]);

/**
 * Registrable domain of a sighting's link, for display as a source chip and as
 * the grouping key behind `df_domains` (ARCHITECTURE 10.3). Strips a leading
 * `www.`, which the dedup key deliberately does not — mis-grouping a source is
 * cosmetic, whereas over-collapsing dedup keys merges distinct articles.
 */
export function sourceDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  const labels = host.replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".") || null;

  const lastTwo = labels.slice(-2).join(".");
  const take = SECOND_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * `image` → `string | null`. Upstream sends the literal string "None" rather
 * than null or an omitted field in roughly a quarter of sightings, and a UI that
 * renders that as a src attribute shows a broken-image icon on every fourth card.
 */
export function normalizeImage(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") return null;
  return canonicalizeUrl(trimmed);
}

function collapseWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
