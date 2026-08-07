import { CurrentsCircuitOpenError } from "./errors.js";

/**
 * Circuit breaker (ARCHITECTURE 5.3).
 *
 * After N consecutive failures, open for a cooldown and fail fast. While open,
 * the Query Service serves stale data rather than making users wait for a call we
 * expect to fail — which matters most in exactly the situation where it trips,
 * since a struggling upstream is also a slow one.
 *
 * Only genuine upstream unhealthiness counts: 5xx, timeouts, network faults. A
 * 401 or a 400 means upstream is up and answering, and opening the circuit on
 * those would replace a precise diagnosis ("the key is wrong") with a vague one
 * ("upstream is down"), while suppressing the very calls that would prove it.
 */
export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. */
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /** Throws when the circuit is open. Call before spending anything on a request. */
  assertClosed(): void {
    if (this.state !== "open") {
      // Half-open lets exactly one request through as a probe. Letting a flood
      // through the instant the cooldown expires would re-hammer an upstream that
      // is very likely still recovering.
      this.probing = this.state === "half_open";
      return;
    }

    const retryAt = new Date((this.openedAt ?? this.now()) + this.cooldownMs);
    throw new CurrentsCircuitOpenError(
      `circuit open after ${this.consecutiveFailures} consecutive upstream failures; ` +
        `not retrying until ${retryAt.toISOString()}`,
      retryAt,
    );
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    // A failed probe restarts the cooldown rather than immediately reopening the
    // gate on the next request.
    if (this.probing || this.consecutiveFailures >= this.threshold) {
      this.openedAt = this.now();
      this.probing = false;
    }
  }
}
