/**
 * Error taxonomy for any news provider (ARCHITECTURE 5.3).
 *
 * Each maps to a distinct degradation behaviour in ARCHITECTURE 11. A single
 * generic Error would make that impossible — and the Currents probe demonstrated
 * why: a Cloudflare 403 looks like an auth failure until you read the body, and
 * eleven calls were misdiagnosed that way.
 *
 * The taxonomy is shared but the *mapping* is not: the same status code means
 * different things to different providers. A 403 is a client-fingerprint ban on
 * Currents and a spent daily quota on GNews, which is exactly why each adapter
 * owns its own `mapErrorResponse` and why callers must branch on `kind`, never
 * on a status code.
 *
 * `provider` is carried on every error so a log line, a metric, and a degraded
 * response can all say *which* upstream failed without the call site tracking it.
 */
export abstract class NewsError extends Error {
  abstract readonly kind: string;
  /** True when a retry could plausibly succeed. Never retry the others. */
  abstract readonly retryable: boolean;
  /** Which upstream produced this. Set by the adapter that threw it. */
  provider = "unknown";
}

/** 401. An operator problem — the key is missing, wrong, or revoked. */
export class NewsAuthError extends NewsError {
  override readonly name = "NewsAuthError";
  readonly kind = "auth" as const;
  readonly retryable = false;
}

/**
 * Blocked before reaching the API — a client-fingerprint ban rather than a
 * credential problem. On Currents this is Cloudflare error 1010 behind a 403
 * with an HTML body, almost always a missing or default User-Agent.
 *
 * Explicitly NOT an auth error: the remedy is completely different and the
 * diagnosis time is what it costs.
 */
export class NewsBlockedError extends NewsError {
  override readonly name = "NewsBlockedError";
  readonly kind = "blocked" as const;
  readonly retryable = false;
}

/**
 * 400. A bug in OUR query construction, never a transient fault.
 * `fieldErrors` names the exact violated limit where the provider reports one,
 * e.g. `{ page_size: "Max page_size for Free tier is 20" }`.
 */
export class NewsInvalidQueryError extends NewsError {
  override readonly name = "NewsInvalidQueryError";
  readonly kind = "invalid_query" as const;
  readonly retryable = false;
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * The provider's budget is spent, or a local pre-flight refusal said it is about
 * to be. Reached from a 429 everywhere, and additionally from a 403 on GNews,
 * which reports daily exhaustion with that status.
 */
export class NewsQuotaError extends NewsError {
  override readonly name = "NewsQuotaError";
  readonly kind = "quota" as const;
  readonly retryable = true;
  constructor(
    message: string,
    readonly resetAt: Date | null = null,
    /**
     * True only when the provider said the *daily* budget is gone, as opposed to
     * "you are going too fast".
     *
     * The distinction is the difference between pausing for a second and
     * stopping until midnight UTC, so it is never inferred from a status code. A
     * 429 is a rate signal on both providers and leaves the budget intact; GNews
     * reports genuine exhaustion as a 403, and only that sets this. When it is
     * set the transport folds a `remaining: 0` observation into the governor, so
     * the next call is refused locally instead of spending a request to be told
     * the same thing.
     */
    readonly exhaustsDailyBudget = false,
  ) {
    super(message);
  }
}

/**
 * 5xx, and network faults where no status was ever received (`status: 0`).
 *
 * The three members are typed wider than the literals they hold because
 * `NewsCircuitOpenError` below narrows them — see the reasoning there.
 */
export class NewsUpstreamError extends NewsError {
  override readonly name: string = "NewsUpstreamError";
  readonly kind: string = "upstream";
  readonly retryable: boolean = true;
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The circuit breaker is open: N consecutive failures, so we fail fast instead of
 * making users wait for a call we expect to fail (ARCHITECTURE 5.3).
 *
 * Deliberately a subclass of `NewsUpstreamError`, because callers should degrade
 * identically — serve stale with `meta.degraded = "upstream"`. The distinct
 * `kind` exists so metrics can tell "upstream is failing" from "we stopped
 * asking", which are different operational stories.
 *
 * Not retryable: the whole point of an open circuit is that an immediate retry
 * is known to be pointless.
 */
export class NewsCircuitOpenError extends NewsUpstreamError {
  override readonly name = "NewsCircuitOpenError";
  override readonly kind = "circuit_open" as const;
  override readonly retryable = false;
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super(message, 503);
  }
}

/** Our per-request deadline expired before upstream answered. */
export class NewsTimeoutError extends NewsError {
  override readonly name = "NewsTimeoutError";
  readonly kind = "timeout" as const;
  readonly retryable = true;
}

/**
 * The caller's own signal fired — e.g. the 1200ms synchronous fill budget of
 * ARCHITECTURE 6.3 running out.
 *
 * Deliberately NOT a timeout: our deadline expiring is a fact about upstream
 * latency and worth a metric, whereas this is the caller exercising a budget it
 * set for itself. Retrying it would defeat the budget's entire purpose.
 */
export class NewsCallerAbortedError extends NewsError {
  override readonly name = "NewsCallerAbortedError";
  readonly kind = "caller_aborted" as const;
  readonly retryable = false;
}

/** Response did not match the expected shape, or a body-level error status. */
export class NewsSchemaError extends NewsError {
  override readonly name = "NewsSchemaError";
  readonly kind = "schema" as const;
  readonly retryable = false;
}

/**
 * Stamp the provider onto an error on its way out of an adapter.
 *
 * Adapters throw from many places — pre-flight clamps, the governor, the error
 * mapper — and threading a provider name through every constructor would be
 * noise. Tagging once at the boundary keeps every error attributable.
 */
export function tagProvider<T>(error: T, provider: string): T {
  if (error instanceof NewsError && error.provider === "unknown") {
    error.provider = provider;
  }
  return error;
}

/** Structural check, so an error crossing a package boundary is still recognised. */
export function isNewsError(
  value: unknown,
): value is { kind: string; retryable: boolean; provider: string } & Error {
  return (
    value instanceof Error &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { retryable?: unknown }).retryable === "boolean" &&
    // Checked, not merely asserted. Every `NewsError` carries `provider` from
    // its field initializer, so this costs real errors nothing — but callers
    // read it straight off the narrowed type into log lines that are sometimes
    // the only diagnosis a failure gets, and an unchecked assertion logs
    // `undefined` at exactly that moment.
    typeof (value as { provider?: unknown }).provider === "string"
  );
}
