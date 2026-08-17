import {
  NewsCallerAbortedError,
  NewsError,
  NewsQuotaError,
  NewsSchemaError,
  NewsTimeoutError,
  NewsUpstreamError,
  isNewsError,
  tagProvider,
} from "./errors.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./breaker.js";
import type { QuotaGovernor, QuotaSnapshot } from "./quota.js";
import type { CallOpts } from "./client.js";

/**
 * The reliability machinery every HTTP adapter needs (ARCHITECTURE 5.3).
 *
 * Everything here is a response to something the Currents probe measured, not a
 * general reliability wishlist — and none of it is Currents-specific, which is
 * why it sits in the core rather than being written twice:
 *
 *   - An explicit User-Agent on every request. Cloudflare 403s default library
 *     UAs, and that cost the probe its first 11 calls (PROBE-FINDINGS 2).
 *   - Retries only on quota, 5xx and network faults. Other 4xx are our bug, and
 *     a retry spends a second quota token to learn the same thing twice.
 *   - Quota is pre-flight checked, so exhaustion is refused locally rather than
 *     earned as a real 429.
 *   - Every dependency that would otherwise make this untestable — clock, sleep,
 *     jitter, fetch — is injectable, so the retry and breaker behaviour is tested
 *     deterministically and offline.
 *
 * What the transport does NOT know is what any given status code means. A 403 is
 * a fingerprint ban on Currents and a spent daily quota on GNews, so mapping is
 * the adapter's job and arrives through `mapError`.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  debug?(fields: Record<string, unknown>, message: string): void;
}

export interface ErrorResponseInput {
  status: number;
  bodyText: string;
  headers?: Headers;
}

export interface RawResponse {
  json: unknown;
  quota: QuotaSnapshot | null;
  requestedAt: Date;
}

export interface HttpTransportOptions {
  provider: string;
  /** Secrets to strip from anything destined for a log line or error message. */
  secrets?: readonly string[];
  /** Headers sent on every request, including auth. */
  headers: () => Record<string, string>;
  /** Status + body → typed error. Per-provider; see the note above. */
  mapError: (input: ErrorResponseInput) => NewsError;
  /** Read whatever rate-limit state the provider exposes. Null when it exposes none. */
  parseQuota?: (headers: Headers, requestedAt: Date) => QuotaSnapshot | null;
  quota: QuotaGovernor;
  /** Per-request deadline. Observed Currents p50 was ~700ms, so 8s is generous. */
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

export class HttpTransport {
  readonly provider: string;
  private readonly secrets: readonly string[];
  private readonly headers: () => Record<string, string>;
  private readonly mapError: (input: ErrorResponseInput) => NewsError;
  private readonly parseQuota:
    | ((headers: Headers, requestedAt: Date) => QuotaSnapshot | null)
    | undefined;
  private readonly governor: QuotaGovernor;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: FetchLike;
  private readonly nowFn: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  readonly logger: ClientLogger | undefined;

  constructor(options: HttpTransportOptions) {
    this.provider = options.provider;
    this.secrets = (options.secrets ?? []).filter((secret) => secret.trim().length > 0);
    this.headers = options.headers;
    this.mapError = options.mapError;
    this.parseQuota = options.parseQuota;
    this.governor = options.quota;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffBaseMs = options.backoffBaseMs ?? 200;
    this.backoffMaxMs = options.backoffMaxMs ?? 2_000;
    this.breaker = new CircuitBreaker(options.breaker ?? {});
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.nowFn = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
  }

  now(): number {
    return this.nowFn();
  }

  async quota() {
    return this.governor.peek();
  }

  async request(url: string, opts: CallOpts): Promise<RawResponse> {
    try {
      return await this.attempt(url, opts);
    } catch (error) {
      throw tagProvider(error, this.provider);
    }
  }

  private async attempt(url: string, opts: CallOpts): Promise<RawResponse> {
    this.breaker.assertClosed();

    const priority = opts.priority ?? "interactive";
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    let attempt = 0;
    for (;;) {
      // Reserved per attempt, because every attempt is a real upstream call and
      // spends a real quota token. Local refusal propagates immediately — it is
      // not a fault to retry, it is a budget decision already made.
      await this.governor.reserve(priority);

      const requestedAt = new Date(this.nowFn());
      let error: unknown;

      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: this.headers(),
          signal: this.buildSignal(timeoutMs, opts.signal),
        });

        const snapshot = this.parseQuota?.(response.headers, requestedAt) ?? null;
        // Observe before anything can throw: the call has already been spent, and
        // a 4xx response carries the same rate-limit headers as a 2xx one.
        if (snapshot) await this.governor.observe(snapshot);

        const bodyText = await response.text();

        if (!response.ok) {
          // Redaction applies to the text that becomes an error message, never to
          // the text we parse. Substring-replacing inside a payload we are about
          // to JSON.parse would let a short key silently corrupt real values.
          const mapped = this.mapError({
            status: response.status,
            bodyText: this.redact(bodyText),
            headers: response.headers,
          });
          // A provider that reports exhaustion in its response rather than in
          // headers (GNews 403) must still teach the governor, or the next call
          // sails through pre-flight and earns the same refusal.
          //
          // Only on an explicit signal from the mapper, never on any 429: a
          // burst 429 means "too fast" and is retried a moment later, so
          // treating it as an empty budget would ground the whole day's work
          // over one blip.
          if (mapped instanceof NewsQuotaError && mapped.exhaustsDailyBudget) {
            await this.observeExhausted(mapped.resetAt, requestedAt);
          }
          throw mapped;
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
        { attempt: attempt + 1, delay, url: this.redact(url), err: describe(error) },
        "retrying upstream call",
      );
      await this.sleep(delay);
      attempt += 1;
    }
  }

  /**
   * Teach the governor that the budget is gone when the provider said so in a
   * response body rather than a header.
   *
   * `observe` only ever raises our idea of usage, so a synthetic
   * `remaining: 0` cannot loosen anything — it can only stop us spending calls
   * to be told the same thing again until the window resets.
   */
  private async observeExhausted(resetAt: Date | null, observedAt: Date): Promise<void> {
    const view = await this.governor.peek();
    const limit = Math.max(1, view.dailyRemaining);
    await this.governor.observe({
      limit,
      remaining: 0,
      burstLimit: Math.max(1, view.burstRemaining),
      burstRemaining: 0,
      resetTime: resetAt,
      observedAt,
    });
  }

  /**
   * The caller's deadline and ours, whichever fires first. A caller running the
   * 1200ms synchronous fill budget (ARCHITECTURE 6.3) must be able to walk away
   * from a call this transport would happily wait 8s for.
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
    if (isNewsError(caught)) return caught;

    // A caller-aborted call is not a fault and must not be retried: the caller has
    // already decided it no longer wants the answer.
    if (callerSignal?.aborted) {
      return new NewsCallerAbortedError(
        "call aborted by the caller before completion",
      );
    }

    if (
      caught instanceof Error &&
      (caught.name === "TimeoutError" || caught.name === "AbortError")
    ) {
      return new NewsTimeoutError(`upstream call exceeded ${timeoutMs}ms`);
    }

    return new NewsUpstreamError(
      `network failure calling upstream: ${describe(caught)}`,
      0,
    );
  }

  private shouldRetry(error: unknown, attemptsLeft: number, delayMs: number): boolean {
    if (attemptsLeft <= 0) return false;
    if (!isNewsError(error) || !error.retryable) return false;

    // A quota refusal whose reset is hours away is not a transient fault.
    // Retrying it burns quota to be told the same thing, and on a Free tier the
    // daily window can be most of a day out.
    if (error.kind === "quota") {
      const resetAt = (error as { resetAt?: Date | null }).resetAt ?? null;
      if (resetAt && resetAt.getTime() - this.nowFn() > delayMs) return false;
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
  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  parseOrThrow<T>(
    schema: {
      safeParse: (
        value: unknown,
      ) =>
        | { success: true; data: T }
        | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
    },
    value: unknown,
    path: string,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw tagProvider(
      new NewsSchemaError(
        `unexpected response shape from ${path}: ` +
          result.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; "),
      ),
      this.provider,
    );
  }
}

/** Only transport-level trouble counts against the breaker — see breaker.ts. */
function isUpstreamUnhealthy(error: unknown): boolean {
  return isNewsError(error) && (error.kind === "upstream" || error.kind === "timeout");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new NewsSchemaError(
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
