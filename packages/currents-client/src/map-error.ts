import {
  CurrentsAuthError,
  CurrentsBlockedError,
  CurrentsError,
  CurrentsInvalidQueryError,
  CurrentsQuotaError,
  CurrentsUpstreamError,
} from "./errors.js";

/**
 * HTTP failure → typed error (ARCHITECTURE 5.3).
 *
 * A pure function, deliberately: it is the single highest-value test target in
 * the client, and every branch below is bound to a real captured response body in
 * `fixtures/error-and-reference-bodies.json`. Neither the 400 nor the 401 shape
 * matches the OpenAPI spec's `ApiResponse` definition, so the spec cannot be used
 * to derive this mapping — only the recorded bodies can.
 */

export interface ErrorResponseInput {
  status: number;
  bodyText: string;
  headers?: Headers;
}

/** Cloudflare's block page names its own error code; the body is HTML, not JSON. */
const CLOUDFLARE_MARKERS = [/error code:\s*1010/i, /cloudflare/i, /<!doctype html/i];

export function mapErrorResponse(input: ErrorResponseInput): CurrentsError {
  const { status, bodyText, headers } = input;
  const body = parseJson(bodyText);

  if (status === 401) {
    return new CurrentsAuthError(
      `upstream rejected the API key (401): ${messageOf(body) ?? "Invalid token"}`,
    );
  }

  if (status === 403) {
    // The probe lost its first 11 calls to this: Cloudflare 403s default library
    // User-Agents, and diagnosing that as an auth failure sends you looking at
    // the key instead of at the request headers. A non-JSON 403 is therefore
    // *always* a block, never an auth error (PROBE-FINDINGS 2).
    if (body === null || CLOUDFLARE_MARKERS.some((marker) => marker.test(bodyText))) {
      return new CurrentsBlockedError(
        "blocked before reaching the API (403, non-JSON body) — almost certainly " +
          "the User-Agent. Check CURRENTS_USER_AGENT is set and non-empty; this is " +
          "NOT an authentication failure.",
      );
    }
    return new CurrentsAuthError(
      `upstream refused the request (403): ${messageOf(body) ?? "forbidden"}`,
    );
  }

  if (status === 429) {
    return new CurrentsQuotaError(
      `upstream rate limit hit (429): ${messageOf(body) ?? "too many requests"}`,
      resetAtFrom(headers),
    );
  }

  if (status === 400) {
    const fieldErrors = fieldErrorsOf(body);
    const detail = Object.entries(fieldErrors)
      .map(([field, message]) => `${field}: ${message}`)
      .join("; ");
    // `details.errors` names the exact violated limit — e.g.
    // { page_size: "Max page_size for Free tier is 20" }. Surfacing it verbatim
    // turns a tier-limit mistake into a one-line diagnosis instead of a hunt.
    return new CurrentsInvalidQueryError(
      `upstream rejected our query (400): ${detail || messageOf(body) || "bad request"}`,
      fieldErrors,
    );
  }

  if (status >= 500) {
    return new CurrentsUpstreamError(
      `upstream error (${status}): ${messageOf(body) ?? truncate(bodyText)}`,
      status,
    );
  }

  // Any other 4xx is our bug, not a transient fault, so it must never be retried —
  // each retry costs a quota token to learn the same thing twice.
  return new CurrentsInvalidQueryError(
    `unexpected upstream status ${status}: ${messageOf(body) ?? truncate(bodyText)}`,
  );
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

/** Upstream uses `msg` in some bodies and `message` in others; both appear in one 400. */
function messageOf(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  for (const key of ["msg", "message", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function fieldErrorsOf(body: Record<string, unknown> | null): Record<string, string> {
  const details = body?.["details"];
  if (typeof details !== "object" || details === null) return {};
  const errors = (details as Record<string, unknown>)["errors"];
  if (typeof errors !== "object" || errors === null) return {};

  const result: Record<string, string> = {};
  for (const [field, message] of Object.entries(errors as Record<string, unknown>)) {
    result[field] = typeof message === "string" ? message : JSON.stringify(message);
  }
  return result;
}

/**
 * When the daily window reopens. `x-ratelimit-reset-time` is a normal ISO-8601
 * timestamp; `Retry-After` is seconds. Either beats guessing, because a caller
 * that knows the reset time can stop asking until then.
 */
function resetAtFrom(headers: Headers | undefined): Date | null {
  if (!headers) return null;

  const resetTime = headers.get("x-ratelimit-reset-time");
  if (resetTime) {
    const parsed = new Date(resetTime.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter.trim(), 10);
    if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
  }

  return null;
}

function truncate(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
