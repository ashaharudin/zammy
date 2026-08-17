import {
  HttpTransport,
  clampSearchParams,
  tagProvider,
  type CallOpts,
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
import {
  RawGnewsResponse,
  toQueryParams,
  toTopHeadlinesQuery,
  type TopHeadlinesParams,
} from "./raw.js";
import type { GnewsClient } from "./client.js";

/**
 * The live GNews HTTP client (ARCHITECTURE 5.3).
 *
 * Retries, the breaker, deadlines, quota pre-flight and key redaction come from
 * `HttpTransport`. What is GNews-shaped, and therefore here:
 *
 *   - **`X-Api-Key`, never `?apikey=`.** Both work; a key in a query string ends
 *     up in access logs and proxy caches.
 *   - **No rate-limit headers at all.** The governor counts locally against the
 *     configured tier, and the 403 mapped in `map-error.ts` is the only
 *     correction it will ever receive. `parseQuota` is therefore absent rather
 *     than returning a fabricated snapshot.
 *   - **`totalArticles`.** A real total, so the last page is *known* rather than
 *     inferred from a short page — the one place GNews tells us more than
 *     Currents does.
 */

export interface HttpGnewsClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Not a documented requirement, but the Currents probe cost 11 calls to a
   * default library UA and there is no reason to find out twice. */
  userAgent: string;
  limits: ClientLimits;
  quota: QuotaGovernor;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  breaker?: { failureThreshold?: number; cooldownMs?: number };
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: ClientLogger;
}

export class HttpGnewsClient implements GnewsClient {
  readonly provider = PROVIDER;
  readonly limits: ClientLimits;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly transport: HttpTransport;

  constructor(options: HttpGnewsClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("GNEWS_API_KEY is required for GNEWS_MODE=live.");
    }
    if (!options.userAgent.trim()) {
      throw new Error("GNEWS_USER_AGENT must be non-empty.");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.userAgent = options.userAgent.trim();
    this.limits = options.limits;

    this.transport = new HttpTransport({
      provider: PROVIDER,
      secrets: [this.apiKey],
      headers: () => ({
        "X-Api-Key": this.apiKey,
        "User-Agent": this.userAgent,
        Accept: "application/json",
      }),
      mapError: mapErrorResponse,
      // Deliberately omitted: GNews sends no rate-limit headers, and a parser
      // returning a made-up snapshot would read as "plenty left" forever.
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
    const { params: clamped, adjustments } = clampSearchParams(
      params,
      this.limits,
      new Date(this.transport.now()),
    );
    if (adjustments.length) {
      this.transport.logger?.warn({ adjustments }, "clamped search params to tier limits");
    }

    // Throws before any call is spent when the query names something GNews
    // cannot filter on — see `unservableReason`.
    let query: URLSearchParams;
    try {
      query = toQueryParams(clamped, { maxPageSize: this.limits.maxPageSize });
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    const pageSize = clamped.pageSize ?? this.limits.maxPageSize;
    const response = await this.transport.request(`${this.baseUrl}/search?${query}`, opts);
    return this.toSearchResult(response, pageSize, clamped.pageNumber ?? 1, adjustments);
  }

  async topHeadlines(
    params: TopHeadlinesParams = {},
    opts: CallOpts = {},
  ): Promise<SearchResult> {
    let query: URLSearchParams;
    try {
      query = toTopHeadlinesQuery(params, { maxPageSize: this.limits.maxPageSize });
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    const pageSize = Math.min(
      params.pageSize ?? this.limits.maxPageSize,
      this.limits.maxPageSize,
    );
    const response = await this.transport.request(
      `${this.baseUrl}/top-headlines?${query}`,
      opts,
    );
    return this.toSearchResult(response, pageSize, params.pageNumber ?? 1, []);
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
    pageSize: number,
    pageNumber: number,
    adjustments: string[],
  ): SearchResult {
    const parsed = this.transport.parseOrThrow(RawGnewsResponse, response.json, "/search");
    const raw = parsed.articles ?? [];
    const { sightings, stats } = normalizeSightings(raw);

    if (stats.received !== stats.kept) {
      // The drop rate is a real metric (ARCHITECTURE 12): a rise means upstream
      // changed a field shape, and the timeline quietly thins until someone notices.
      this.transport.logger?.warn(
        { received: stats.received, kept: stats.kept, dropped: stats.dropped },
        "dropped malformed sightings during normalization",
      );
    }

    return {
      sightings,
      requestedAt: response.requestedAt,
      // Deliberately the RAW count: a normalization drop must never masquerade as
      // the end of a topic's history.
      rawCount: raw.length,
      isLastPage: isLastPage(raw.length, pageSize, pageNumber, parsed.totalArticles),
      pageSize,
      normalization: stats,
      // No headers to read; the governor's local count is the whole picture
      // until a 403 corrects it.
      quota: null,
      adjustments,
    };
  }
}

/**
 * A short page is the usual end-of-results signal, and `totalArticles` is a
 * second, stronger one GNews gives us for free.
 *
 * Both are checked because either alone can be wrong: a provider that returns a
 * full final page would look unfinished on the short-page test, and a
 * `totalArticles` that lags its own index would end the walk early. Requiring a
 * short page OR an exhausted total ends the walk only when at least one of them
 * is certain.
 */
export function isLastPage(
  rawCount: number,
  pageSize: number,
  pageNumber: number,
  totalArticles: number | null | undefined,
): boolean {
  if (rawCount < pageSize) return true;
  if (typeof totalArticles === "number" && Number.isFinite(totalArticles)) {
    return pageNumber * pageSize >= totalArticles;
  }
  return false;
}
