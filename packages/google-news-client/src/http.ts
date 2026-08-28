import {
  HttpTransport,
  clampSearchParams,
  tagProvider,
  type CallOpts,
  type CircuitBreakerOptions,
  type ClientLimits,
  type ClientLogger,
  type FetchLike,
  type QuotaGovernor,
  type QuotaView,
  type RawResponse,
  type SearchParams,
  type SearchResult,
} from "@zammy/news-client";
import { mapErrorResponse } from "./map-error.js";
import { PROVIDER, normalizeSightings } from "./normalize.js";
import { parseRssFeed } from "./rss.js";
import {
  ITEMS_PER_QUERY,
  RawGoogleNewsFeed,
  toQueryParams,
  type QueryLocale,
} from "./raw.js";
import type { GoogleNewsClient } from "./client.js";

/**
 * The live Google News RSS client (ARCHITECTURE 5.3).
 *
 * Retries, the breaker, deadlines, quota pre-flight and redaction come from
 * `HttpTransport`. What is Google-News-shaped, and therefore here:
 *
 *   - **No key, and nothing to redact.** The URL and the User-Agent are the
 *     whole request. `secrets` is empty because there is no secret.
 *   - **An RSS body**, read through the transport's `parseBody` hook rather
 *     than by reimplementing the retry and breaker machinery around a second
 *     fetch. `Accept` asks for XML and the parser does not care what arrives.
 *   - **No rate-limit headers, and no published ceiling.** `parseQuota` is
 *     absent rather than returning a fabricated snapshot, and `quota` on the
 *     result is null. Unlike GNews there is not even a documented number to
 *     count down from, so the budget in config is our own invention and the
 *     governor gets no correction from upstream at all — ever. See `factory.ts`.
 *   - **A 100-item wall with no cursor.** `isLastPage` is `rawCount <
 *     ITEMS_PER_QUERY`, and a full 100 means the caller must subdivide the
 *     window rather than ask for a second page. There is no second page.
 */

export interface HttpGoogleNewsClientOptions {
  baseUrl: string;
  /**
   * Mandatory, and the single most load-bearing header here. PROBE-FINDINGS 2:
   * Cloudflare 403'd the first 11 Currents probes over a default library
   * User-Agent, and on an endpoint with no key there is no other way to tell a
   * block from a refusal. Every capture probe sent one explicitly.
   */
  userAgent: string;
  /** Default `hl`/`gl`/`ceid` triple, overridable per search. */
  locale: QueryLocale;
  limits: ClientLimits;
  quota: QuotaGovernor;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  breaker?: CircuitBreakerOptions;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: ClientLogger;
}

export class HttpGoogleNewsClient implements GoogleNewsClient {
  readonly provider = PROVIDER;
  /**
   * Its own, and only ever its own.
   *
   * Under ADR-0019 that is no longer a lesser status: coverage is
   * `(subject, provider, span)`, no provider is privileged, and each records
   * only the spans it actually walked. This client's `isLastPage` therefore
   * ends *this provider's* walk over a window and makes no claim about anyone
   * else's — which is the whole of what the field means now.
   *
   * The one thing that must not be misread is a full page: `rawCount == 100`
   * says "the cap cut us off, subdivide", never "this span is finished". See
   * `isLastPage` below.
   */
  readonly coverageProvider = PROVIDER;
  readonly limits: ClientLimits;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly locale: QueryLocale;
  private readonly transport: HttpTransport;

  constructor(options: HttpGoogleNewsClientOptions) {
    if (!options.userAgent.trim()) {
      throw new Error("GOOGLE_NEWS_USER_AGENT must be non-empty.");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.userAgent = options.userAgent.trim();
    this.locale = options.locale;
    this.limits = options.limits;

    this.transport = new HttpTransport({
      provider: PROVIDER,
      // No `secrets`: there is no key to leak into a log line.
      headers: () => ({
        "User-Agent": this.userAgent,
        Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      }),
      mapError: mapErrorResponse,
      parseBody: parseRssFeed,
      // Deliberately omitted: the endpoint sends no rate-limit headers, and a
      // parser returning a made-up snapshot would read as "plenty left" forever.
      quota: options.quota,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.backoffBaseMs !== undefined
        ? { backoffBaseMs: options.backoffBaseMs }
        : {}),
      ...(options.backoffMaxMs !== undefined ? { backoffMaxMs: options.backoffMaxMs } : {}),
      ...(options.breaker ? { breaker: options.breaker } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  async search(params: SearchParams, opts: CallOpts = {}): Promise<SearchResult> {
    // The clamp is inside the tagging block for the reason the other adapters
    // give: its refusals belong to this provider as much as the ones
    // `toQueryParams` raises, and left outside they reach log lines, metrics and
    // `meta.degraded` as `provider: "unknown"`.
    let clamped: SearchParams;
    let adjustments: string[];
    let query: URLSearchParams;
    try {
      ({ params: clamped, adjustments } = clampSearchParams(
        params,
        this.limits,
        new Date(this.transport.now()),
      ));
      query = toQueryParams(clamped, this.locale);
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    if (adjustments.length) {
      this.transport.logger?.warn({ adjustments }, "clamped search params to tier limits");
    }

    const response = await this.transport.request(`${this.baseUrl}/search?${query}`, opts);
    return this.toSearchResult(response, clamped.pageSize, adjustments);
  }

  async quota(): Promise<QuotaView> {
    return this.transport.quota();
  }

  async close(): Promise<void> {
    // Nothing to release: `fetch` uses the global agent. Present so callers can
    // treat live and fixture clients identically.
  }

  private toSearchResult(
    response: RawResponse,
    requestedPageSize: number | undefined,
    adjustments: string[],
  ): SearchResult {
    const feed = this.transport.parseOrThrow(RawGoogleNewsFeed, response.json, "/search");
    const raw = feed.items ?? [];
    const { sightings, stats } = normalizeSightings(raw, { language: feed.language });

    if (stats.received !== stats.kept) {
      // The drop rate is a real metric (ARCHITECTURE 12): a rise means the feed
      // changed shape — plausible here, since nothing about it is contractual —
      // and the timeline quietly thins until someone notices.
      this.transport.logger?.warn(
        { received: stats.received, kept: stats.kept, dropped: stats.dropped },
        "dropped malformed sightings during normalization",
      );
    }

    return {
      sightings,
      requestedAt: response.requestedAt,
      // Deliberately the RAW count: a normalization drop must never masquerade
      // as the end of a topic's history. At exactly ITEMS_PER_QUERY that would
      // be worse than usual — one malformed item would turn "the cap cut us
      // off, subdivide" into "the window is finished", and the rest of the
      // window would be recorded as covered and never asked about again.
      rawCount: raw.length,
      isLastPage: isLastPage(raw.length),
      // The page size that actually applied, which is the wall and not what the
      // caller asked for — there is no page-size parameter to send. Reporting
      // the request instead would make `isLastPage` uninterpretable, since
      // `SearchResult.pageSize` is documented as the number needed to read it.
      pageSize: ITEMS_PER_QUERY,
      normalization: stats,
      // No headers to read and no published ceiling. Null is the honest answer:
      // a fabricated "plenty left" is the one thing that must never be reported,
      // because the governor's local count is all that stands between us and an
      // unpublished limit.
      quota: null,
      adjustments: pageSizeAdjustment(requestedPageSize, adjustments),
    };
  }
}

/**
 * A short feed is the end of this window; a full one means the cap cut us off.
 *
 * There is no `totalArticles` here, no `pages` count and no cursor — the count
 * of items in the body is the whole signal. Measured: `after:2026-08-20
 * before:2026-08-22` returned exactly 100 and a two-day window in February 2025
 * returned 20, and five weekly slices of one arc yielded 433 items where the
 * unsliced query yielded 92. So a full 100 is never "finished"; it is
 * "subdivide", and the caller already speaks that (ARCHITECTURE 6.3).
 */
export function isLastPage(rawCount: number): boolean {
  return rawCount < ITEMS_PER_QUERY;
}

/**
 * Say so when the caller asked for a smaller page than the endpoint can give.
 *
 * Every other clamp in this system narrows a request; this one widens it, which
 * is unusual enough to be worth surfacing rather than absorbing. It is not a
 * refusal because the extra items are real articles the caller is better off
 * having — but a caller doing arithmetic against the size it asked for needs to
 * know it did not get it.
 */
export function pageSizeAdjustment(
  requestedPageSize: number | undefined,
  adjustments: string[],
): string[] {
  if (requestedPageSize === undefined || requestedPageSize >= ITEMS_PER_QUERY) {
    return adjustments;
  }
  return [
    ...adjustments,
    `pageSize ${requestedPageSize} → ${ITEMS_PER_QUERY} ` +
      "(Google News RSS has no page-size parameter; every query returns up to " +
      `${ITEMS_PER_QUERY} items)`,
  ];
}
