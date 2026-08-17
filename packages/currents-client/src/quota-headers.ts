import { clamp, type QuotaBounds, type QuotaSnapshot } from "@zammy/news-client";

/**
 * Currents reports its budget in headers, so it can be *observed* rather than
 * guessed (ARCHITECTURE 5.4). The probe found `x-ratelimit-*` on every response,
 * including error responses — which is why the transport reads them before it
 * looks at the status code.
 *
 * Not every provider does this. GNews sends no rate-limit headers at all and
 * reports exhaustion as a 403, which is why parsing lives in the adapter and the
 * governor treats an absent observation as "no new information" rather than as
 * "no limit".
 */

const HEADER = {
  limit: "x-ratelimit-limit",
  remaining: "x-ratelimit-remaining",
  burstLimit: "x-ratelimit-burst-limit",
  burstRemaining: "x-ratelimit-burst-remaining",
  resetTime: "x-ratelimit-reset-time",
} as const;

/**
 * Parse `x-ratelimit-*` into a snapshot, bounded by config.
 *
 * Returns null when the headers are absent or unusable, which the governor treats
 * as "no new information" rather than as "no limit" — the difference between a
 * degraded observation path and a quota overrun.
 *
 * `resetTime` is a normal ISO-8601 timestamp with an offset, so `new Date()` is
 * correct here. That is NOT true of sighting `published` values, which use a
 * different format entirely — see `parsePublished`.
 */
export function parseQuotaHeaders(
  headers: Headers,
  bounds: Pick<QuotaBounds, "dailyLimit" | "burstLimit">,
  observedAt: Date = new Date(),
): QuotaSnapshot | null {
  const limit = readInt(headers, HEADER.limit);
  const remaining = readInt(headers, HEADER.remaining);
  if (limit === null && remaining === null) return null;

  const burstLimit = readInt(headers, HEADER.burstLimit);
  const burstRemaining = readInt(headers, HEADER.burstRemaining);

  // Config bounds the observed limit rather than the reverse: a plan upgrade is a
  // config change, and a header claiming a limit we have not budgeted for must
  // not silently raise our spend.
  const effectiveLimit = Math.min(limit ?? bounds.dailyLimit, bounds.dailyLimit);
  const effectiveBurstLimit = Math.min(
    burstLimit ?? bounds.burstLimit,
    bounds.burstLimit,
  );

  return {
    limit: effectiveLimit,
    remaining: clamp(remaining ?? effectiveLimit, 0, effectiveLimit),
    burstLimit: effectiveBurstLimit,
    burstRemaining: clamp(burstRemaining ?? effectiveBurstLimit, 0, effectiveBurstLimit),
    resetTime: readDate(headers, HEADER.resetTime),
    observedAt,
  };
}

function readInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function readDate(headers: Headers, name: string): Date | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = new Date(raw.trim());
  return Number.isNaN(value.getTime()) ? null : value;
}
