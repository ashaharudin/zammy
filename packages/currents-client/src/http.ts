import {
  HttpTransport,
  NewsInvalidQueryError,
  NewsSchemaError,
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
import { parseQuotaHeaders } from "./quota-headers.js";
import {
  RawCategories,
  RawLanguages,
  RawRegions,
  RawSearchResponse,
  toQueryParams,
} from "./raw.js";
import {
  V2_CATEGORIES,
  type CurrentsClient,
  type LatestNewsParams,
} from "./client.js";

/**
 * The live Currents HTTP client (ARCHITECTURE 5.3).
 *
 * Retries, the circuit breaker, deadline composition, quota pre-flight and key
 * redaction are all `HttpTransport`'s, because none of them are Currents-shaped.
 * What is left here is the part that is: the endpoint layout, the two API
 * versions behind one configured base URL, header auth, the `{status, news[]}`
 * envelope, and the v2 category taxonomy that a v1 name would 400 against.
 */

export type { FetchLike, ClientLogger };

const V2_CATEGORY_SET: ReadonlySet<string> = new Set(V2_CATEGORIES);

export interface HttpCurrentsClientOptions {
  baseUrl: string;
  apiKey: string;
  /** MUST be non-empty. Cloudflare blocks default library User-Agents. */
  userAgent: string;
  limits: ClientLimits;
  quota: QuotaGovernor;
  /**
   * Ceilings for the observed `x-ratelimit-*` values. Config bounds what the
   * headers report, so a missing header never reads as "unlimited" and a header
   * claiming more than we budgeted for cannot raise our spend (ARCHITECTURE 5.4).
   */
  quotaBounds: { dailyLimit: number; burstLimit: number };
  /** Per-request deadline. Observed p50 was ~700ms, so 8s is generous. */
  timeoutMs?: number;
  /** Retries after the first attempt. 2 per ARCHITECTURE 5.3. */
  maxRetries?: number;
  /** Base and ceiling for exponential backoff with full jitter. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * Passed through to the transport's breaker verbatim, so it must be the
   * transport's own type. It was hand-narrowed here to
   * `{ failureThreshold?, cooldownMs? }` — a key `CircuitBreaker` does not read,
   * so anyone following the type would have set it and silently got the default
   * threshold of 5. Nothing in the app set it, and the tests passed the real
   * `threshold`, so no behaviour was ever wrong; the type was. Found by
   * type-checking the tests (§12).
   */
  breaker?: CircuitBreakerOptions;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source, in [0, 1). Injected so backoff is deterministic in tests. */
  random?: () => number;
  logger?: ClientLogger;
}

export class HttpCurrentsClient implements CurrentsClient {
  readonly provider = PROVIDER;
  readonly coverageProvider = PROVIDER;
  readonly limits: ClientLimits;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly quotaBounds: { dailyLimit: number; burstLimit: number };
  private readonly transport: HttpTransport;

  constructor(options: HttpCurrentsClientOptions) {
    // A default User-Agent is not a convenience here, it is a production outage
    // with a misleading error message. Refuse to construct without one.
    if (!options.userAgent.trim()) {
      throw new Error(
        "CURRENTS_USER_AGENT must be non-empty: Cloudflare returns 403 (error 1010) " +
          "to default library User-Agents, and reports it in a way that looks like " +
          "an auth failure.",
      );
    }
    if (!options.apiKey.trim()) {
      throw new Error("CURRENTS_API_KEY is required for CURRENTS_MODE=live.");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.userAgent = options.userAgent.trim();
    this.limits = options.limits;
    this.quotaBounds = options.quotaBounds;

    this.transport = new HttpTransport({
      provider: PROVIDER,
      secrets: [this.apiKey],
      headers: () => ({
        // Header auth, not `?apiKey=`: both work, but a key in a query string
        // ends up in access logs and proxy caches.
        Authorization: this.apiKey,
        "User-Agent": this.userAgent,
        Accept: "application/json",
      }),
      mapError: mapErrorResponse,
      parseQuota: (headers, requestedAt) =>
        parseQuotaHeaders(headers, this.quotaBounds, requestedAt),
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
    // The clamp is inside the tagging block: it refuses a pageNumber past the
    // retrievable cap and a range past the per-call ceiling, and those refusals
    // belong to this provider as much as any the query construction raises.
    // Left outside, they reach log lines, metrics and `meta.degraded` as
    // `provider: "unknown"` — see `tagProvider` in @zammy/news-client.
    let clamped: SearchParams;
    let adjustments: string[];
    let query: URLSearchParams;
    try {
      ({ params: clamped, adjustments } = clampSearchParams(
        params,
        this.limits,
        new Date(this.transport.now()),
      ));
      query = toQueryParams(clamped, { maxPageSize: this.limits.maxPageSize });
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    if (adjustments.length) {
      this.transport.logger?.warn({ adjustments }, "clamped search params to tier limits");
    }

    const response = await this.request("/search", query, opts);

    return this.toSearchResult(
      response,
      clamped.pageSize ?? this.limits.maxPageSize,
      adjustments,
    );
  }

  async latestNews(params: LatestNewsParams = {}, opts: CallOpts = {}): Promise<SearchResult> {
    const query = new URLSearchParams();
    if (params.language) query.set("language", params.language);
    if (params.categories?.length) {
      // Pre-flight against the recorded v2 taxonomy (PROBE-FINDINGS 6c): the
      // most likely mistake is a v1 name like "technology", which is a
      // verified 400 — refuse locally rather than spend a call to learn it.
      const invalid = params.categories.filter(
        (category) => !V2_CATEGORY_SET.has(category),
      );
      if (invalid.length) {
        throw tagProvider(
          new NewsInvalidQueryError(
            `invalid /v2/latest-news categories: ${invalid.join(", ")} ` +
              "(v2 uses its own taxonomy; v1 names and /available/categories values do not apply)",
            { category: `invalid v2 category value(s): ${invalid.join(", ")}` },
          ),
          PROVIDER,
        );
      }
      // Comma-separated is THE wire format; repeated params read first-only.
      query.set("category", params.categories.join(","));
    }
    if (params.pageNumber !== undefined) {
      query.set("page_number", String(params.pageNumber));
    }
    const response = await this.request("/latest-news", query, opts, "v2");
    // This endpoint takes no page size; upstream's default is 20, which is also
    // the tier maximum, so that is the right divisor for the end-of-page signal.
    return this.toSearchResult(response, this.limits.maxPageSize, []);
  }

  async availableLanguages(opts: CallOpts = {}): Promise<Record<string, string>> {
    const response = await this.request("/available/languages", new URLSearchParams(), opts);
    return this.transport.parseOrThrow(RawLanguages, response.json, "/available/languages")
      .languages;
  }

  async availableRegions(opts: CallOpts = {}): Promise<Record<string, string>> {
    const response = await this.request("/available/regions", new URLSearchParams(), opts);
    return this.transport.parseOrThrow(RawRegions, response.json, "/available/regions").regions;
  }

  async availableCategories(opts: CallOpts = {}): Promise<string[]> {
    const response = await this.request(
      "/available/categories",
      new URLSearchParams(),
      opts,
    );
    return this.transport.parseOrThrow(RawCategories, response.json, "/available/categories")
      .categories;
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
    adjustments: string[],
  ): SearchResult {
    const parsed = this.transport.parseOrThrow(RawSearchResponse, response.json, "/search");

    // `status: "error"` under HTTP 200 is a failure that no status code reports.
    if (parsed.status !== "ok") {
      throw tagProvider(
        new NewsSchemaError(
          `upstream returned status "${parsed.status}" under HTTP 200`,
        ),
        PROVIDER,
      );
    }

    const raw = parsed.news ?? [];
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
      rawCount: raw.length,
      // Deliberately the RAW count: a normalization drop must never masquerade as
      // the end of a topic's history.
      isLastPage: raw.length < pageSize,
      pageSize,
      normalization: stats,
      quota: response.quota,
      adjustments,
    };
  }

  /**
   * The configured base URL pins an API version (default `…/v1`); endpoints
   * living under another version swap the segment rather than carrying a
   * second base URL through config.
   */
  private versionedBase(version: "v1" | "v2"): string {
    const match = this.baseUrl.match(/^(.*)\/v\d+$/);
    return match ? `${match[1]}/${version}` : `${this.baseUrl}/${version}`;
  }

  private async request(
    path: string,
    query: URLSearchParams,
    opts: CallOpts,
    version?: "v2",
  ): Promise<RawResponse> {
    const base = version ? this.versionedBase(version) : this.baseUrl;
    const url = query.size ? `${base}${path}?${query}` : `${base}${path}`;
    return this.transport.request(url, opts);
  }
}
