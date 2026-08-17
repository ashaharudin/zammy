import { createHash } from "node:crypto";
import { Sighting } from "./sighting.js";

/**
 * Normalization — the client's most important job (ARCHITECTURE 5.2).
 *
 * Every upstream quirk is absorbed at the boundary, once, so nothing downstream
 * ever sees a raw provider payload. What lives *here* is the part that is the
 * same whoever sent the article: URL canonicalization, the dedup key, the
 * registrable domain, image placeholders, and the drop accounting.
 *
 * What does NOT live here is the mapping from a provider's wire shape onto
 * `Sighting`. That is per-provider by nature — Currents sends
 * `"2026-08-04 20:45:56 +0000"` and GNews sends ISO-8601 — so each adapter owns
 * its own `normalizeSighting` and hands the result to `finalizeSighting` below.
 *
 * Normalization is deliberately fallible: a malformed sighting is dropped and
 * counted rather than repaired with a guess (ARCHITECTURE 11). The one case that
 * matters most is a bad timestamp — the timeline axis is the product's core
 * promise, so defaulting it to "now" would silently corrupt the thing users came
 * for.
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

/** Fold one batch's stats into a running total, e.g. across pages or providers. */
export function accumulateStats(
  target: NormalizationStats,
  source: NormalizationStats,
): NormalizationStats {
  target.received += source.received;
  target.kept += source.kept;
  for (const [reason, count] of Object.entries(source.dropped)) {
    target.dropped[reason as DropReason] += count;
  }
  return target;
}

/**
 * Run a provider's per-item mapper over a batch, keeping what is usable and
 * counting what is not.
 *
 * The caller must NOT use `sightings.length` as an end-of-results signal: drops
 * change the count, and `sightings.length < pageSize` would then read as "last
 * page" when it only means "one sighting was malformed". The raw count is the
 * only valid page-boundary signal — see `SearchResult.isLastPage`.
 */
export function normalizeBatch<T>(
  raw: readonly T[],
  normalizeOne: (item: T) => NormalizeOutcome,
): { sightings: Sighting[]; stats: NormalizationStats } {
  const stats = emptyStats();
  const sightings: Sighting[] = [];

  for (const item of raw) {
    stats.received += 1;
    const outcome = normalizeOne(item);
    if (outcome.ok) {
      sightings.push(outcome.sighting);
      stats.kept += 1;
    } else {
      stats.dropped[outcome.reason] += 1;
    }
  }

  return { sightings, stats };
}

/**
 * Validate an adapter's mapping against the shared contract rather than trusting
 * it. This is the last gate before a sighting reaches the rest of the system, and
 * it is cheap; a `schema` drop means a provider sent something the contract does
 * not describe, which is a fact worth a metric rather than a crash.
 */
export function finalizeSighting(candidate: unknown): NormalizeOutcome {
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
 * The UUIDv5 namespace sightings are derived in (RFC 4122 §4.3), generated once
 * and fixed forever: changing it would re-key every derived sighting and
 * re-ingest history as new.
 */
const SIGHTING_NAMESPACE = "6f0d1c62-2f14-5a3f-9b3a-4a0f6a2d1e77";

/**
 * A stable UUID for a provider whose own ids are not UUIDs (GNews sends opaque
 * strings).
 *
 * Deterministic, so re-fetching the same emission collides on
 * `sightings.id` and `ON CONFLICT DO NOTHING` keeps the ingest idempotent —
 * the property the whole fold depends on. Namespaced by provider, so two
 * providers cannot collide on a shared id, and so this can never collide with
 * the random v4 UUIDs Currents supplies and uses verbatim.
 *
 * A UUIDv5 rather than a raw hash because `sightings.id` is a `uuid` column:
 * deriving one avoids widening the primary key of a table that already holds
 * every emission we have ever seen.
 */
export function deriveSightingId(provider: string, providerSightingId: string): string {
  const namespace = Buffer.from(SIGHTING_NAMESPACE.replace(/-/g, ""), "hex");
  const name = Buffer.from(`${provider}:${providerSightingId}`, "utf8");
  const hash = createHash("sha1").update(namespace).update(name).digest();

  // Version 5 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Query parameters that identify a referral, never a document. */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "msclkid", "igshid", "mc_eid"]);

/**
 * Canonical form of a sighting's link, used BOTH as the stored `url` and as the
 * input to `dedupKey` (ARCHITECTURE 7.4). One function, so the link a user
 * clicks and the key that collapses duplicates can never disagree — and one
 * function across providers, so the same story from two upstreams collapses onto
 * one article instead of two.
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
 * — re-emitted under a new id by one provider (upstream sent one link-roundup
 * page 50 times in 100 results, PROBE-FINDINGS 4) or reported by two.
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
 * the grouping key behind `df_domains` (ARCHITECTURE 10.3).
 *
 * Derived from the URL even when a provider names the outlet itself (GNews sends
 * `source.name` and `source.url`): the URL is the one field every provider
 * agrees on, and deriving from it is what lets the same story from two upstreams
 * present as one source rather than two spellings of one.
 *
 * Strips a leading `www.`, which the dedup key deliberately does not —
 * mis-grouping a source is cosmetic, whereas over-collapsing dedup keys merges
 * distinct articles.
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
 * `image` → `string | null`. Currents sends the literal string "None" rather
 * than null or an omitted field in roughly a quarter of sightings, and a UI that
 * renders that as a src attribute shows a broken-image icon on every fourth card.
 */
export function normalizeImage(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") return null;
  return canonicalizeUrl(trimmed);
}

export function collapseWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
