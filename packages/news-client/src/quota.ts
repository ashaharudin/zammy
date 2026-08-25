import { NewsQuotaError } from "./errors.js";

/**
 * Quota governance (ARCHITECTURE 5.4).
 *
 * Two limits with different shapes, so the governor tracks both, and one budget
 * per provider — each has its own key, its own tier, and its own reset:
 *
 *   burst — a short window. 60/60s on Currents; 1/s on GNews Free, where
 *           exceeding it earns a 429 rather than a stall.
 *   daily — resets midnight UTC. 1000 on Currents Free, 100 on GNews Free. The
 *           strategic budget, split into an interactive reserve and a background
 *           allowance so a queued backfill can never starve a live user search.
 *
 * Every call is pre-flight checked and refused locally when exhausted — cheaper
 * and kinder than earning a real 429, which costs a request to learn something we
 * already knew.
 *
 * Where the numbers come from differs by provider, which is why observation is
 * optional rather than assumed. Currents reports `x-ratelimit-*` on every
 * response, so its budget is *observed*. GNews reports nothing and answers an
 * exhausted day with a 403, so its budget is *counted* locally and corrected the
 * moment that 403 arrives. The governor treats a missing observation as "no new
 * information", never as "no limit".
 */

/** A provider's rate-limit state at a moment, however we learned it. */
export interface QuotaSnapshot {
  limit: number;
  remaining: number;
  burstLimit: number;
  burstRemaining: number;
  /** When the daily window resets. Null when the provider did not say. */
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
   * Pre-flight check. Throws `NewsQuotaError` when the call must not be made,
   * and records the spend when it may. Async so a shared, out-of-process
   * implementation can satisfy this interface without changing any caller —
   * see `InProcessQuotaGovernor` for why one is still wanted.
   */
  reserve(priority: CallPriority): Promise<void>;
  /** Fold an observation back in, however the adapter obtained it. */
  observe(snapshot: QuotaSnapshot): Promise<void>;
  /** Current best knowledge, for `/readyz`, metrics, and `meta.degraded`. */
  peek(): Promise<QuotaView>;
}

/**
 * Upstream's burst window. 60s, verified (PROBE-FINDINGS 1).
 *
 * Exported because a second governor now has to agree with this one about the
 * window's LENGTH or the two disagree about what "60 calls" bounds — and a
 * shared window sized differently from the in-process one it falls open to
 * would enforce two different ceilings depending on whether Redis was up.
 * GNews sets its own (`GNEWS_BURST_WINDOW_MS`, a second rather than a minute);
 * Currents has no knob because there has never been a second value for it.
 */
export const DEFAULT_BURST_WINDOW_MS = 60_000;

export interface InProcessQuotaOptions extends QuotaBounds {
  /** Upstream's burst window. Defaults to `DEFAULT_BURST_WINDOW_MS`. */
  burstWindowMs?: number;
  now?: () => number;
}

/**
 * Single-process quota governor.
 *
 * Correct for local development and for a single task that stays up. It is not
 * merely a stub: it enforces the reserve and the burst window, and it folds in
 * observations, which account for spend by *any* client sharing the key.
 *
 * It holds its count in memory, though, and that has two consequences worth
 * knowing before trusting the numbers it reports:
 *
 *   **Replicas do not share it.** Two tasks share the upstream budget but not
 *   this state, so each believes it has the whole allowance.
 *
 *   **A restart forgets the day's spend.** Every process starts at the full
 *   limit, and with hot reload in development the count barely accumulates.
 *
 * How badly that bites depends on the provider, which is the part that is easy
 * to miss. A provider that reports its budget in headers self-corrects on the
 * very next response — Currents restarts optimistic and is right again one call
 * later. A provider that reports nothing cannot: GNews sends no rate-limit
 * headers, so an in-memory count that restarts is simply wrong until the day's
 * budget runs out and a 403 arrives, which is precisely the outcome pre-flight
 * refusal exists to avoid.
 *
 * ARCHITECTURE 5.4 describes the fix — a Redis-held snapshot shared by the API
 * and worker, keyed per provider. **Its burst half is now built**, in
 * `apps/api`'s `RedisQuotaGovernor` (VERCEL-ALL-IN-SCOPE §3.4, Phase 3): a
 * sliding window in a sorted set that every instance shares, plus the observed
 * snapshot written where any of them can read it. This class is what that one
 * FALLS OPEN TO when Redis is unreachable, and what it delegates the daily
 * budget and the interactive reserve to — so neither of the two consequences
 * above has gone away, they have been narrowed to the day-rolling ledger. That
 * ledger stays unbuilt on purpose: its only customer is a headerless provider,
 * and enabling GNews requires building it first.
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
    this.burstWindowMs = options.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
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
      throw new NewsQuotaError(
        `background call refused: ${daily} daily calls remain, at or below the ` +
          `interactive reserve of ${this.bounds.interactiveReserve}`,
        this.nextDailyReset(now),
      );
    }

    if (daily <= 0) {
      throw new NewsQuotaError(
        "daily quota exhausted; refusing locally rather than earning a 429",
        this.nextDailyReset(now),
      );
    }

    if (burst <= 0) {
      const oldest = this.burstCalls[0] ?? now;
      throw new NewsQuotaError(
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

/**
 * The UTC day a moment falls in. Exported so a shared governor rolls the daily
 * budget on exactly the same boundary this one does; two implementations
 * disagreeing about when midnight is would show up as a budget that resets
 * twice, or not at all, depending on which one was asked.
 */
export function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
