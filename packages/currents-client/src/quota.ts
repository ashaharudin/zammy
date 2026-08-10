import { CurrentsQuotaError } from "./errors.js";

/**
 * Quota governance — header-driven (ARCHITECTURE 5.4).
 *
 * The probe found `x-ratelimit-*` on every response, so quota can be *observed*
 * rather than guessed. Two limits with different shapes, so two governors:
 *
 *   burst — 60 requests / 60s. Exceeding it stalls everything for up to a minute.
 *   daily — 1000 requests, resets midnight UTC. The strategic budget, split into
 *           an interactive reserve and a background allowance so a queued backfill
 *           can never starve a live user search.
 *
 * Every call is pre-flight checked and refused locally when exhausted — cheaper
 * and kinder than earning a real 429, which costs a request to learn something we
 * already knew.
 */

/** What a response's `x-ratelimit-*` headers said, and when. */
export interface QuotaSnapshot {
  limit: number;
  remaining: number;
  burstLimit: number;
  burstRemaining: number;
  /** When the daily window resets. Null when upstream omitted the header. */
  resetTime: Date | null;
  observedAt: Date;
}

/**
 * Background work draws from the same budget as user requests, so it needs a
 * different answer when the budget runs low (ARCHITECTURE 5.4, 9.4).
 */
export type CallPriority = "interactive" | "background";

export interface QuotaBounds {
  /** Config ceiling on the daily limit; a missing header must never mean "unlimited". */
  dailyLimit: number;
  burstLimit: number;
  /** Daily calls held back for interactive use. Background calls stop above this floor. */
  interactiveReserve: number;
}

export interface QuotaView {
  dailyRemaining: number;
  burstRemaining: number;
  resetAt: Date | null;
  /** The last thing upstream actually told us. Null before the first response. */
  observed: QuotaSnapshot | null;
}

export interface QuotaGovernor {
  /**
   * Pre-flight check. Throws `CurrentsQuotaError` when the call must not be made,
   * and records the spend when it may. Async because the Redis-backed
   * implementation that replaces this one in Phase 3 must be.
   */
  reserve(priority: CallPriority): Promise<void>;
  /** Fold a response's observed headers back in. */
  observe(snapshot: QuotaSnapshot): Promise<void>;
  /** Current best knowledge, for `/readyz`, metrics, and `meta.degraded`. */
  peek(): Promise<QuotaView>;
}

const HEADER = {
  limit: "x-ratelimit-limit",
  remaining: "x-ratelimit-remaining",
  burstLimit: "x-ratelimit-burst-limit",
  burstRemaining: "x-ratelimit-burst-remaining",
  resetTime: "x-ratelimit-reset-time",
} as const;

/**
 * Parse `x-ratelimit-*` into a snapshot, bounded by config.
 *
 * Returns null when the headers are absent or unusable, which the governor treats
 * as "no new information" rather than as "no limit" — the difference between a
 * degraded observation path and a quota overrun.
 *
 * `resetTime` is a normal ISO-8601 timestamp with an offset, so `new Date()` is
 * correct here. That is NOT true of sighting `published` values, which use a
 * different format entirely — see `parsePublished`.
 */
export function parseQuotaHeaders(
  headers: Headers,
  bounds: Pick<QuotaBounds, "dailyLimit" | "burstLimit">,
  observedAt: Date = new Date(),
): QuotaSnapshot | null {
  const limit = readInt(headers, HEADER.limit);
  const remaining = readInt(headers, HEADER.remaining);
  if (limit === null && remaining === null) return null;

  const burstLimit = readInt(headers, HEADER.burstLimit);
  const burstRemaining = readInt(headers, HEADER.burstRemaining);

  // Config bounds the observed limit rather than the reverse: a plan upgrade is a
  // config change, and a header claiming a limit we have not budgeted for must
  // not silently raise our spend.
  const effectiveLimit = Math.min(limit ?? bounds.dailyLimit, bounds.dailyLimit);
  const effectiveBurstLimit = Math.min(
    burstLimit ?? bounds.burstLimit,
    bounds.burstLimit,
  );

  return {
    limit: effectiveLimit,
    remaining: clamp(remaining ?? effectiveLimit, 0, effectiveLimit),
    burstLimit: effectiveBurstLimit,
    burstRemaining: clamp(burstRemaining ?? effectiveBurstLimit, 0, effectiveBurstLimit),
    resetTime: readDate(headers, HEADER.resetTime),
    observedAt,
  };
}

export interface InProcessQuotaOptions extends QuotaBounds {
  /** Upstream's burst window. 60s, verified (PROBE-FINDINGS 1). */
  burstWindowMs?: number;
  now?: () => number;
}

/**
 * Single-process quota governor.
 *
 * Correct for local development and for a single Fargate task. Two or more tasks
 * share the upstream budget but not this state, so Phase 3 replaces it with a
 * Redis-backed implementation of the same interface (ARCHITECTURE 5.4) — the
 * client does not change, because the client must not know about our cache.
 *
 * Until then this is not merely a stub: it enforces the reserve and the burst
 * window, and it folds in observed headers, which account for spend by *any*
 * client sharing the key. That makes it safe, just less precise under fan-out.
 */
export class InProcessQuotaGovernor implements QuotaGovernor {
  private readonly bounds: QuotaBounds;
  private readonly burstWindowMs: number;
  private readonly now: () => number;

  private dayKey: string;
  private dailyUsed = 0;
  /**
   * Timestamps of recent calls, for an exact sliding window. A tumbling counter
   * would admit up to 2x the burst limit across a window boundary, and the
   * penalty for breaching a 60/60s limit is a stall of up to a minute — too
   * expensive for an approximation that saves an array of at most 60 numbers.
   */
  private burstCalls: number[] = [];
  private observed: QuotaSnapshot | null = null;
  private callsSinceObserved = 0;

  constructor(options: InProcessQuotaOptions) {
    this.bounds = options;
    this.burstWindowMs = options.burstWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.dayKey = utcDayKey(this.now());
  }

  async reserve(priority: CallPriority): Promise<void> {
    const now = this.now();
    this.rollDay(now);
    this.expireBurst(now);

    const daily = this.dailyRemaining();
    const burst = this.burstRemaining();

    // The reserve exists so background backfill can never starve a live search —
    // the failure mode that would otherwise appear only on the busiest day.
    if (priority === "background" && daily <= this.bounds.interactiveReserve) {
      throw new CurrentsQuotaError(
        `background call refused: ${daily} daily calls remain, at or below the ` +
          `interactive reserve of ${this.bounds.interactiveReserve}`,
        this.nextDailyReset(now),
      );
    }

    if (daily <= 0) {
      throw new CurrentsQuotaError(
        "daily quota exhausted; refusing locally rather than earning a 429",
        this.nextDailyReset(now),
      );
    }

    if (burst <= 0) {
      const oldest = this.burstCalls[0] ?? now;
      throw new CurrentsQuotaError(
        `burst limit of ${this.bounds.burstLimit} calls per ` +
          `${this.burstWindowMs}ms reached`,
        new Date(oldest + this.burstWindowMs),
      );
    }

    this.dailyUsed += 1;
    this.callsSinceObserved += 1;
    this.burstCalls.push(now);
  }

  async observe(snapshot: QuotaSnapshot): Promise<void> {
    this.rollDay(this.now());

    // Headers are authoritative and account for spend by other processes sharing
    // the key, so they can only ever raise our idea of usage, never lower it.
    this.dailyUsed = Math.max(this.dailyUsed, snapshot.limit - snapshot.remaining);
    this.observed = snapshot;
    this.callsSinceObserved = 0;
  }

  async peek(): Promise<QuotaView> {
    const now = this.now();
    this.rollDay(now);
    this.expireBurst(now);
    return {
      dailyRemaining: this.dailyRemaining(),
      burstRemaining: this.burstRemaining(),
      resetAt: this.observed?.resetTime ?? this.nextDailyReset(now),
      observed: this.observed,
    };
  }

  /**
   * The lower of what we counted locally and what upstream last reported, minus
   * calls dispatched since that report. Concurrent dispatch therefore cannot
   * overshoot in the gap between two observations.
   */
  private dailyRemaining(): number {
    const local = this.bounds.dailyLimit - this.dailyUsed;
    if (!this.observed) return Math.max(0, local);
    return Math.max(0, Math.min(local, this.observed.remaining - this.callsSinceObserved));
  }

  private burstRemaining(): number {
    const local = this.bounds.burstLimit - this.burstCalls.length;
    if (!this.observed) return Math.max(0, local);
    return Math.max(
      0,
      Math.min(local, this.observed.burstRemaining - this.callsSinceObserved),
    );
  }

  private rollDay(now: number): void {
    const key = utcDayKey(now);
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.dailyUsed = 0;
    // A snapshot's `remaining` describes yesterday's budget; carrying it over
    // would keep refusing calls for a day that has already reset.
    this.observed = null;
    this.callsSinceObserved = 0;
  }

  private expireBurst(now: number): void {
    const cutoff = now - this.burstWindowMs;
    if (this.burstCalls.length && this.burstCalls[0]! <= cutoff) {
      this.burstCalls = this.burstCalls.filter((at) => at > cutoff);
    }
  }

  private nextDailyReset(now: number): Date {
    const date = new Date(now);
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
    );
  }
}

/** Never refuses. For fixture mode, where no upstream call is ever made. */
export class UnmeteredQuotaGovernor implements QuotaGovernor {
  constructor(private readonly bounds: Pick<QuotaBounds, "dailyLimit" | "burstLimit">) {}

  async reserve(): Promise<void> {}
  async observe(): Promise<void> {}
  async peek(): Promise<QuotaView> {
    return {
      dailyRemaining: this.bounds.dailyLimit,
      burstRemaining: this.bounds.burstLimit,
      resetAt: null,
      observed: null,
    };
  }
}

function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function readInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function readDate(headers: Headers, name: string): Date | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = new Date(raw.trim());
  return Number.isNaN(value.getTime()) ? null : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
