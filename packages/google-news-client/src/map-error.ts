import {
  NewsBlockedError,
  NewsError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsUpstreamError,
  type ErrorResponseInput,
} from "@zammy/news-client";

/**
 * HTTP failure → typed error, Google News RSS edition.
 *
 * Per-adapter for the reason ADR-0012 gives and this provider illustrates
 * better than either of the others: **there is no key**, so a whole branch of
 * the taxonomy is unreachable here and the branch that replaces it means
 * something completely different.
 *
 *   - **401 is not an auth failure**, because there is nothing to authenticate.
 *     If one ever arrives it means something in front of Google is challenging
 *     us — a proxy, a captive portal, a corporate gateway — so it maps to
 *     `blocked`, whose remedy (look at the request, not at a credential) is the
 *     right place to send someone. `NewsAuthError` is deliberately not imported.
 *   - **403 with a non-JSON body is a block, never an auth failure.** This is
 *     PROBE-FINDINGS 2's lesson taken verbatim: the Currents probe lost its
 *     first 11 calls to a Cloudflare 403 earned by a default library
 *     User-Agent, and diagnosing that as a credential problem sends you looking
 *     at a key that is fine. Here every body is non-JSON — the endpoint speaks
 *     RSS — so a 403 is a block unconditionally, and the first thing to check
 *     is `GOOGLE_NEWS_USER_AGENT`.
 *   - **403 is NOT daily exhaustion**, unlike GNews. GNews documents that
 *     status as "you have reached your daily quota limit"; Google News
 *     documents nothing, publishes no ceiling and sends no rate-limit header,
 *     so reading a 403 as a spent budget would be an invention. The self-imposed
 *     budget in config is the only ceiling this adapter has, and it is enforced
 *     locally rather than learned (see `factory.ts`).
 *   - **429 is a pacing signal, retryable, and does not ground the day.** Same
 *     reasoning as the GNews adapter's 429: a moment's backoff clears it.
 *
 * What an unhappy keyless endpoint actually looks like is worth stating,
 * because none of the above will catch it: GDELT answered 1 of 6 probe calls,
 * and the five failures arrived as silent connection timeouts at 30–75s rather
 * than as any status code at all (RESEARCH-FREE-NEWS-SOURCES §1). That path
 * does not reach this function — it is the transport's `NewsTimeoutError`, and
 * it is the breaker, not this mapping, that stops us hammering a wall.
 */
export function mapErrorResponse(input: ErrorResponseInput): NewsError {
  const { status, bodyText } = input;
  const detail = truncate(bodyText);

  if (status === 401 || status === 403 || status === 451) {
    return new NewsBlockedError(
      `blocked before reaching Google News (${status}) — almost certainly the ` +
        "User-Agent or the egress IP. Check GOOGLE_NEWS_USER_AGENT is set and " +
        "non-empty; there is no API key here, so this is NOT an authentication " +
        `failure. Body: ${detail || "(empty)"}`,
    );
  }

  if (status === 429) {
    return new NewsQuotaError(
      `Google News rate limit hit (429): ${detail || "too many requests in a short period"}`,
      retryAfterFrom(input.headers),
      // Never sets exhaustsDailyBudget: there is no published daily ceiling to
      // be exhausted, and grounding the provider until midnight on a pacing
      // signal would throw away the rest of the day over one blip.
      false,
    );
  }

  if (status === 404) {
    // The search endpoint answers 200 with an empty channel for a query that
    // matches nothing, so a 404 means the URL itself is wrong — our bug, and
    // never worth a retry.
    return new NewsInvalidQueryError(
      `Google News returned 404 for the request URL; GOOGLE_NEWS_BASE_URL is ` +
        `probably wrong. Body: ${detail || "(empty)"}`,
    );
  }

  if (status >= 500) {
    return new NewsUpstreamError(`Google News error (${status}): ${detail}`, status);
  }

  // Any other 4xx is our bug, not a transient fault, so it must never be
  // retried — and on an endpoint with no published budget, a retry loop is the
  // fastest way to find out what the unpublished one is.
  return new NewsInvalidQueryError(`unexpected Google News status ${status}: ${detail}`);
}

/** No rate-limit headers are sent, but honour a `Retry-After` if one appears. */
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
