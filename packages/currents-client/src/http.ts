import {
  CurrentsCallerAbortedError,
  CurrentsInvalidQueryError,
  CurrentsSchemaError,
  CurrentsTimeoutError,
  CurrentsUpstreamError,
} from "./errors.js";
import { mapErrorResponse } from "./map-error.js";
import { normalizeSightings } from "./normalize.js";
import {
  RawCategories,
  RawLanguages,
  RawRegions,
  RawSearchResponse,
  clampSearchParams,
  toQueryParams,
  type SearchParams,
} from "./raw.js";
import { parseQuotaHeaders, type QuotaGovernor, type QuotaSnapshot, type QuotaView } from "./quota.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./breaker.js";
import {
  V2_CATEGORIES,
  type CallOpts,
  type ClientLimits,
  type CurrentsClient,
  type LatestNewsParams,
  type SearchResult,
} from "./client.js";

/**
 * The live HTTP client (ARCHITECTURE 5.3).
 *
 * Everything here is a response to something the probe measured, not a general
 * reliability wishlist:
 *
 *   - An explicit User-Agent on every request. Cloudflare 403s default library
 *     UAs, and that cost the probe its first 11 calls (PROBE-FINDINGS 2).
 *   - Retries only on 429, 5xx and network faults. Other 4xx are our bug, and a
 *     retry spends a second quota token to learn the same thing twice.
 *   - Quota is pre-flight checked from observed headers, so exhaustion is refused
 *     locally rather than earned as a real 429.
 *   - Every dependency that would otherwise make this untestable — clock, sleep,
 *     jitter, fetch — is injectable, so the retry and breaker behaviour is tested
 *     deterministically and offline.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const V2_CATEGORY_SET: ReadonlySet<string> = new Set(V2_CATEGORIES);

export interface ClientLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  debug?(fields: Record<string, unknown>, message: string): void;
}

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
  breaker?: CircuitBreakerOptions;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source, in [0, 1). Injected so backoff is deterministic in tests. */
  random?: () => number;
  logger?: ClientLogger;
}

interface RawResponse {
  json: unknown;
  quota: QuotaSnapshot | null;
  requestedAt: Date;
}

export class HttpCurrentsClient implements CurrentsClient {
  readonly limits: ClientLimits;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly governor: QuotaGovernor;
  private readonly quotaBounds: { dailyLimit: number; burstLimit: number };
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: ClientLogger | undefined;

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
    this.governor = options.quota;
    this.quotaBounds = options.quotaBounds;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffBaseMs = options.backoffBaseMs ?? 200;
    this.backoffMaxMs = options.backoffMaxMs ?? 2_000;
    this.breaker = new CircuitBreaker(options.breaker ?? {});
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
  }

  async search(params: SearchParams, opts: CallOpts = {}): Promise<SearchResult> {
    const { params: clamped, adjustments } = clampSearchParams(
      params,
      this.limits,
      new Date(this.now()),
    );
    if (adjustments.length) {
      this.logger?.warn({ adjustments }, "clamped search params to tier limits");
    }

    const query = toQueryParams(clamped, { maxPageSize: this.limits.maxPageSize });
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
        throw new CurrentsInvalidQueryError(
          `invalid /v2/latest-news categories: ${invalid.join(", ")} ` +
            "(v2 uses its own taxonomy; v1 names and /available/categories values do not apply)",
          { category: `invalid v2 category value(s): ${invalid.join(", ")}` },
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
    return this.parseOrThrow(RawLanguages, response.json, "/available/languages").languages;
  }

  async availableRegions(opts: CallOpts = {}): Promise<Record<string, string>> {
    const response = await this.request("/available/regions", new URLSearchParams(), opts);
    return this.parseOrThrow(RawRegions, response.json, "/available/regions").regions;
  }

  async availableCategories(opts: CallOpts = {}): Promise<string[]> {
    const response = await this.request(
      "/available/categories",
      new URLSearchParams(),
      opts,
    );
    return this.parseOrThrow(RawCategories, response.json, "/available/categories").categories;
  }

  async quota(): Promise<QuotaView> {
    return this.governor.peek();
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
    const parsed = this.parseOrThrow(RawSearchResponse, response.json, "/search");

    // `status: "error"` under HTTP 200 is a failure that no status code reports.
    if (parsed.status !== "ok") {
      throw new CurrentsSchemaError(
        `upstream returned status "${parsed.status}" under HTTP 200`,
      );
    }

    const raw = parsed.news ?? [];
    const { sightings, stats } = normalizeSightings(raw);

    if (stats.received !== stats.kept) {
      // The drop rate is a real metric (ARCHITECTURE 12): a rise means upstream
      // changed a field shape, and the timeline quietly thins until someone notices.
      this.logger?.warn(
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
    this.breaker.assertClosed();

    const priority = opts.priority ?? "interactive";
    const base = version ? this.versionedBase(version) : this.baseUrl;
    const url = query.size ? `${base}${path}?${query}` : `${base}${path}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    let attempt = 0;
    for (;;) {
      // Reserved per attempt, because every attempt is a real upstream call and
      // spends a real quota token. Local refusal propagates immediately — it is
      // not a fault to retry, it is a budget decision already made.
      await this.governor.reserve(priority);

      const requestedAt = new Date(this.now());
      let error: unknown;

      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            // Header auth, not `?apiKey=`: both work, but a key in a query string
            // ends up in access logs and proxy caches.
            Authorization: this.apiKey,
            "User-Agent": this.userAgent,
            Accept: "application/json",
          },
          signal: this.buildSignal(timeoutMs, opts.signal),
        });

        const snapshot = parseQuotaHeaders(response.headers, this.quotaBounds, requestedAt);
        // Observe before anything can throw: the call has already been spent, and
        // a 4xx response carries the same rate-limit headers as a 2xx one.
        if (snapshot) await this.governor.observe(snapshot);

        const bodyText = await response.text();

        if (!response.ok) {
          // Redaction applies to the text that becomes an error message, never to
          // the text we parse. Substring-replacing inside a payload we are about
          // to JSON.parse would let a short key silently corrupt real values.
          throw mapErrorResponse({
            status: response.status,
            bodyText: this.redact(bodyText),
            headers: response.headers,
          });
        }

        // Upstream is answering, whatever it answered. A 401 does not mean the
        // service is unhealthy, so only transport-level faults trip the breaker.
        this.breaker.recordSuccess();

        return { json: safeJson(bodyText), quota: snapshot, requestedAt };
      } catch (caught) {
        error = this.classify(caught, opts.signal, timeoutMs);
      }

      if (isUpstreamUnhealthy(error)) this.breaker.recordFailure();

      const attemptsLeft = this.maxRetries - attempt;
      const delay = this.backoffDelay(attempt);
      if (!this.shouldRetry(error, attemptsLeft, delay)) throw error;

      this.logger?.debug?.(
        { attempt: attempt + 1, delay, path, err: describe(error) },
        "retrying upstream call",
      );
      await this.sleep(delay);
      attempt += 1;
    }
  }

  /**
   * The caller's deadline and ours, whichever fires first. A caller running the
   * 1200ms synchronous fill budget (ARCHITECTURE 6.3) must be able to walk away
   * from a call this client would happily wait 8s for.
   */
  private buildSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  }

  private classify(
    caught: unknown,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): unknown {
    if (isCurrentsError(caught)) return caught;

    // A caller-aborted call is not a fault and must not be retried: the caller has
    // already decided it no longer wants the answer.
    if (callerSignal?.aborted) {
      return new CurrentsCallerAbortedError(
        "call aborted by the caller before completion",
      );
    }

    if (caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError")) {
      return new CurrentsTimeoutError(`upstream call exceeded ${timeoutMs}ms`);
    }

    return new CurrentsUpstreamError(
      `network failure calling upstream: ${describe(caught)}`,
      0,
    );
  }

  private shouldRetry(error: unknown, attemptsLeft: number, delayMs: number): boolean {
    if (attemptsLeft <= 0) return false;
    if (!isCurrentsError(error) || !error.retryable) return false;

    // A 429 whose reset is hours away is not a transient fault. Retrying it burns
    // quota to be told the same thing, and on the Free tier the daily window can
    // be most of a day out.
    if (error.kind === "quota") {
      const resetAt = (error as { resetAt?: Date | null }).resetAt ?? null;
      if (resetAt && resetAt.getTime() - this.now() > delayMs) return false;
    }

    return true;
  }

  /** Exponential backoff with full jitter: uniform in [0, base * 2^attempt]. */
  private backoffDelay(attempt: number): number {
    const ceiling = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
    return Math.round(this.random() * ceiling);
  }

  /**
   * The key must never appear in a log line or an error message
   * (ARCHITECTURE 5.5). Only ever applied to text destined for a message — see
   * the call site for why it must not touch a body we are about to parse.
   */
  private redact(text: string): string {
    return text.includes(this.apiKey) ? text.split(this.apiKey).join("[redacted]") : text;
  }

  private parseOrThrow<T>(
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
    value: unknown,
    path: string,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new CurrentsSchemaError(
      `unexpected response shape from ${path}: ` +
        result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
    );
  }
}

function isCurrentsError(
  value: unknown,
): value is { kind: string; retryable: boolean } & Error {
  return (
    value instanceof Error &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { retryable?: unknown }).retryable === "boolean"
  );
}

/** Only transport-level trouble counts against the breaker — see breaker.ts. */
function isUpstreamUnhealthy(error: unknown): boolean {
  return isCurrentsError(error) && (error.kind === "upstream" || error.kind === "timeout");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CurrentsSchemaError(
      "upstream returned a 200 with a body that is not JSON; " +
        "this is usually an intercepting proxy or a block page",
    );
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return [error.message, code].filter(Boolean).join(" ") || error.name;
  }
  return String(error);
}
