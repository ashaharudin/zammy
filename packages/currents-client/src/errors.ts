/**
 * Error taxonomy for the Currents client (ARCHITECTURE 5.3).
 *
 * Each maps to a distinct degradation behaviour in ARCHITECTURE 11. A single
 * generic Error would make that impossible — and the probe demonstrated why:
 * a Cloudflare 403 looks like an auth failure until you read the body, and
 * eleven calls were misdiagnosed that way.
 */
export abstract class CurrentsError extends Error {
  abstract readonly kind: string;
  /** True when a retry could plausibly succeed. Never retry the others. */
  abstract readonly retryable: boolean;
}

/** 401. An operator problem — the key is missing, wrong, or revoked. */
export class CurrentsAuthError extends CurrentsError {
  override readonly name = "CurrentsAuthError";
  readonly kind = "auth" as const;
  readonly retryable = false;
}

/**
 * 403 with a non-JSON body — Cloudflare error 1010, a client-fingerprint ban.
 * Almost always a missing or default User-Agent. Explicitly NOT an auth error:
 * the remedy is completely different and the diagnosis time is what it costs.
 */
export class CurrentsBlockedError extends CurrentsError {
  override readonly name = "CurrentsBlockedError";
  readonly kind = "blocked" as const;
  readonly retryable = false;
}

/**
 * 400. A bug in OUR query construction, never a transient fault.
 * `fieldErrors` comes from the response's `details.errors` map, which names the
 * exact violated limit, e.g. { page_size: "Max page_size for Free tier is 20" }.
 */
export class CurrentsInvalidQueryError extends CurrentsError {
  override readonly name = "CurrentsInvalidQueryError";
  readonly kind = "invalid_query" as const;
  readonly retryable = false;
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** 429, or a local pre-flight refusal when the quota snapshot is exhausted. */
export class CurrentsQuotaError extends CurrentsError {
  override readonly name = "CurrentsQuotaError";
  readonly kind = "quota" as const;
  readonly retryable = true;
  constructor(
    message: string,
    readonly resetAt: Date | null = null,
  ) {
    super(message);
  }
}

/**
 * 5xx, and network faults where no status was ever received (`status: 0`).
 *
 * The three members are typed wider than the literals they hold because
 * `CurrentsCircuitOpenError` below narrows them — see the reasoning there.
 */
export class CurrentsUpstreamError extends CurrentsError {
  override readonly name: string = "CurrentsUpstreamError";
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
 * Deliberately a subclass of `CurrentsUpstreamError`, because callers should
 * degrade identically — serve stale with `meta.degraded = "upstream"`. The
 * distinct `kind` exists so metrics can tell "upstream is failing" from
 * "we stopped asking", which are different operational stories.
 *
 * Not retryable: the whole point of an open circuit is that an immediate retry
 * is known to be pointless.
 */
export class CurrentsCircuitOpenError extends CurrentsUpstreamError {
  override readonly name = "CurrentsCircuitOpenError";
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
export class CurrentsTimeoutError extends CurrentsError {
  override readonly name = "CurrentsTimeoutError";
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
export class CurrentsCallerAbortedError extends CurrentsError {
  override readonly name = "CurrentsCallerAbortedError";
  readonly kind = "caller_aborted" as const;
  readonly retryable = false;
}

/** Response did not match the expected shape, or `status: "error"` under HTTP 200. */
export class CurrentsSchemaError extends CurrentsError {
  override readonly name = "CurrentsSchemaError";
  readonly kind = "schema" as const;
  readonly retryable = false;
}
