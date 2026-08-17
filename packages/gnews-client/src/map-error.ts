import {
  NewsAuthError,
  NewsError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsUpstreamError,
  type ErrorResponseInput,
} from "@zammy/news-client";

/**
 * HTTP failure → typed error, GNews edition (https://docs.gnews.io/error-handling).
 *
 * The single most important line in this file is the 403. On Currents a 403 is a
 * Cloudflare fingerprint ban and the remedy is the User-Agent; on GNews a 403 is
 * *"you have reached your daily quota limit, the next reset is at 00:00 UTC"*.
 * Mapping it as a block would leave the day's budget looking intact and every
 * subsequent call earning the same 403; mapping it as auth would send someone to
 * check a key that is perfectly fine.
 *
 * This is exactly why error mapping is per-adapter rather than shared, and why
 * nothing downstream may branch on a status code.
 *
 * Two body shapes, both documented:
 *
 *     { "errors": ["<message>"] }                  general
 *     { "errors": { "<attribute>": "<message>" } } invalid parameter
 */
export function mapErrorResponse(input: ErrorResponseInput): NewsError {
  const { status, bodyText } = input;
  const body = parseJson(bodyText);
  const messages = messagesOf(body);
  const fieldErrors = fieldErrorsOf(body);
  const detail = messages.join("; ") || truncate(bodyText);

  if (status === 401) {
    return new NewsAuthError(
      `GNews rejected the API key (401): ${detail || "no API key provided or key is invalid"}`,
    );
  }

  if (status === 403) {
    // Documented verbatim as the daily quota limit, NOT a block and NOT an auth
    // failure. `exhaustsDailyBudget` is what stops us spending the rest of the
    // day's calls rediscovering this — GNews sends no rate-limit headers, so
    // this response is the only signal the governor will ever get.
    return new NewsQuotaError(
      `GNews daily quota exhausted (403): ${detail || "next reset is at 00:00 UTC"}`,
      nextUtcMidnight(),
      true,
    );
  }

  if (status === 429) {
    // "Too many requests were sent in a short time period" — a pacing signal,
    // not an empty budget. Left retryable with no exhaustion flag so a moment's
    // backoff clears it, rather than grounding the provider until midnight.
    return new NewsQuotaError(
      `GNews rate limit hit (429): ${detail || "too many requests in a short period"}`,
      retryAfterFrom(input.headers),
    );
  }

  if (status === 400) {
    const named = Object.entries(fieldErrors)
      .map(([field, message]) => `${field}: ${message}`)
      .join("; ");
    return new NewsInvalidQueryError(
      `GNews rejected our query (400): ${named || detail || "bad request"}`,
      fieldErrors,
    );
  }

  if (status >= 500) {
    return new NewsUpstreamError(`GNews error (${status}): ${detail}`, status);
  }

  // Any other 4xx is our bug, not a transient fault, so it must never be retried —
  // each retry costs a quota token to learn the same thing twice.
  return new NewsInvalidQueryError(`unexpected GNews status ${status}: ${detail}`);
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `errors` is an array in the general case and a map in the parameter case. */
function messagesOf(body: Record<string, unknown> | null): string[] {
  const errors = body?.["errors"];
  if (Array.isArray(errors)) {
    return errors.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  }
  if (typeof errors === "object" && errors !== null) {
    return Object.values(errors as Record<string, unknown>).map((value) =>
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  if (typeof errors === "string") return [errors];

  // Not a documented shape, but a proxy or gateway in front of GNews may answer
  // with its own envelope, and its message is still the best diagnosis we have.
  for (const key of ["message", "error", "msg"]) {
    const value = body?.[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

function fieldErrorsOf(body: Record<string, unknown> | null): Record<string, string> {
  const errors = body?.["errors"];
  if (typeof errors !== "object" || errors === null || Array.isArray(errors)) return {};

  const result: Record<string, string> = {};
  for (const [field, message] of Object.entries(errors as Record<string, unknown>)) {
    result[field] = typeof message === "string" ? message : JSON.stringify(message);
  }
  return result;
}

/**
 * The daily counter "resets to zero daily at 00:00 UTC" (docs), so the reset is
 * computable rather than reported. Knowing it is what lets a caller stop asking
 * instead of retrying into a wall for the rest of the day.
 */
function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

/** GNews documents no rate-limit headers, but honour `Retry-After` if one appears. */
function retryAfterFrom(headers: Headers | undefined): Date | null {
  const retryAfter = headers?.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number.parseInt(retryAfter.trim(), 10);
  return Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000) : null;
}

function truncate(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
