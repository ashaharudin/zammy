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

/** 5xx. */
export class CurrentsUpstreamError extends CurrentsError {
  override readonly name = "CurrentsUpstreamError";
  readonly kind = "upstream" as const;
  readonly retryable = true;
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Request deadline exceeded. */
export class CurrentsTimeoutError extends CurrentsError {
  override readonly name = "CurrentsTimeoutError";
  readonly kind = "timeout" as const;
  readonly retryable = true;
}

/** Response did not match the expected shape, or `status: "error"` under HTTP 200. */
export class CurrentsSchemaError extends CurrentsError {
  override readonly name = "CurrentsSchemaError";
  readonly kind = "schema" as const;
  readonly retryable = false;
}
