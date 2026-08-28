import { Redis } from "ioredis";
import { QueueClient } from "@vercel/queue";
import { isNewsError } from "@zammy/news-client";
import {
  PendingSet,
  STALE_PENDING_MS,
  ingestJobId,
  pendingIdOf,
  type IngestHandler,
  type IngestJob,
  type DeepenJob,
  type IngestQueue,
  type SampleJob,
  type SegmentJob,
} from "./ingest-queue.js";

/**
 * The queue as Vercel runs it (VERCEL-ALL-IN-SCOPE §3.2): a hosted topic in
 * push mode, whose consumer is `api/queues/ingest.ts` — a function with no
 * public URL, reached only by the platform. That air gap is why there is no
 * auth code here: the alternative shape, a signed webhook, would need some.
 *
 * What this class is NOT is a consumer. Publishing and draining are separate
 * deployables now, and the one thing this file must never grow is a way to
 * start a worker in a request instance — the failure the whole plan is arranged
 * to avoid. `startConsumer` therefore throws rather than no-ops, because a
 * silent no-op is a topic that reads as perpetually warming.
 *
 * Two properties observed on the spike rather than read, both load-bearing:
 *
 *   - **Dedup deduplicates DELIVERY, not publish.** Publishing twice with the
 *     same `idempotencyKey` returns two different message ids and does not
 *     throw, but only one consumer invocation follows. That is the property
 *     that matters, since BullMQ's `jobId` also prevents duplicate *processing*
 *     rather than duplicate enqueueing — so a repeat publish is not an error
 *     here and must not be treated as one.
 *   - **Topics are partitioned by deployment id.** A deploy mid-flight leaves
 *     the old deployment draining its own messages. Better than BullMQ jobs
 *     outliving the code that wrote them, but a different failure mode: work
 *     published by a deployment that is then rolled back is consumed by a
 *     deployment nobody is serving from. The pending set is what still reports
 *     it as owed.
 */

/**
 * Attempts before a message is acknowledged away. Three, to match the BullMQ
 * driver's `attempts: 3` — the retry budget is a property of the work (an
 * upstream blip, a contended segment lock) rather than of the transport, and
 * two transports disagreeing about it would make "how hard do we try" depend on
 * where the code happens to be running.
 *
 * There is no dead-letter queue. A message past its budget is dropped, and the
 * segment it named is re-planned by the next reader who finds the gap still
 * unfilled — which is the same recovery BullMQ's `removeOnFail: true` left us.
 */
export const MAX_INGEST_DELIVERIES = 3;

/**
 * The push dispatcher's observed latency to a first redelivery, in seconds.
 *
 * This is a MEASURED PLATFORM CONSTANT, not a preference, and the retention
 * below is derived from it. A failed delivery comes back when its visibility
 * lease expires, and that lease is assigned by the queue service — it arrives
 * in the `ce-vqsvisibilitydeadline` header before any of our code runs, at
 * exactly 300 s past `ce-vqscreatedat`. Measured 2026-08-25 across five topics
 * and two deployments; every first redelivery landed at +305 s.
 *
 * Nothing on our side shortens it, which is the point of recording it here:
 *
 *   - **`retryAfterSeconds` in `vercel.json` is inert.** It is a documented
 *     `queue/v2beta` trigger option (default 60 s), but a topic declared with
 *     `retryAfterSeconds: 20` redelivered at +305 s and +305 s, identically to
 *     one that omitted it. So the repo's earlier "Nitro-only" note was wrong
 *     about the option existing and right about its effect here.
 *   - **The SDK's `visibilityTimeoutSeconds` governs lease EXTENSION**, not the
 *     first lease, so it cannot shorten the initial window either.
 *
 * Vercel's docs still say the visibility timeout defaults to 60 s. It does not,
 * in push mode, on this account — which is why this is measured and dated
 * rather than cited.
 *
 * **And it moves.** On 2026-08-22 the same probe, on the same project and the
 * same unmodified deployment, measured a first redelivery at ~10 s. Three days
 * later it was 305 s. That 30× change is what silently broke redelivery here
 * (see `INGEST_RETENTION_SECONDS`), and there is nothing stopping it moving
 * again — so this constant is a snapshot, not a contract, and the retention
 * derived from it is a margin rather than a guarantee. The tripwire is
 * `deliveryCount` never exceeding 1 in the consumer's logs; VERCEL-ALL-IN-SCOPE
 * §3.2 says to check it after any Queues change.
 */
export const OBSERVED_REDELIVERY_LEASE_SECONDS = 300;

/**
 * How long a published message stays alive, in seconds.
 *
 * **This must exceed `OBSERVED_REDELIVERY_LEASE_SECONDS`, and that is the whole
 * reason it is not `STALE_PENDING_MS / 1000` any more.** §0 set the TTL to
 * `STALE_PENDING_MS` (300 s) so the dedup window would match the pending-set
 * semantics, and that was a sound choice when it was made: the redelivery
 * latency of the day was ~10 s, so it had a 30× margin. When the latency grew
 * to 305 s the margin went negative and the message began being deleted five
 * seconds before its first redelivery was due — the platform deletes on TTL
 * "regardless of processing state" — leaving a retry window of exactly zero.
 * VERCEL-ALL-IN-SCOPE §10 question 0 was that, and nothing more exotic: a
 * platform number moving under a constant that never re-measured it.
 *
 * 900 s is `MAX_INGEST_DELIVERIES` × the lease, which buys the full three-
 * attempt budget for a job that fails FAST (attempts land at +0, +305, +610,
 * with ~290 s of slack). A job that fails SLOWLY spends its lease extending
 * rather than expiring, so its attempts are pushed out and the budget can be
 * truncated by the TTL instead of by `shouldRetryDelivery`. That is a real
 * bound, not a rounding error, and what catches the truncated case is the same
 * thing that caught the whole gap before: the pending entry is not settled, so
 * `meta.ingest` keeps reporting the work owed and the next reader re-plans it.
 *
 * The cost of the change is a wider dedup window — 900 s rather than 300 s —
 * so a job that exhausts its budget cannot be re-enqueued under the same
 * content key for up to 15 minutes. That is a deliberate trade: it makes the
 * PRIMARY path at-least-once (a §4.1 deployment requirement) at the price of
 * slowing the fallback path, and the fallback is the one the pending set already
 * covers.
 *
 * `STALE_PENDING_MS` was then raised to this same 900 s, so the dedup window and
 * the pending window agree again — but each derived from the measured platform
 * budget rather than from the other, which is the direction §0 had backwards.
 * The ledger now outlives the message it names instead of expiring mid-retry;
 * that inequality is the invariant, and the test below is what holds it.
 */
export const INGEST_RETENTION_SECONDS =
  MAX_INGEST_DELIVERIES * OBSERVED_REDELIVERY_LEASE_SECONDS;

/**
 * Whether a failed delivery is worth another, as a pure function of the count
 * so the consumer's decision is testable without a platform.
 *
 * `deliveryCount` starts at 1 on the first delivery, and the count is the half
 * of the spike's observation that always held — the DELAY never did, so nothing
 * here depends on it. What the delay governs is only whether the retention
 * above outlives the budget; see `INGEST_RETENTION_SECONDS`.
 */
export function shouldRetryDelivery(deliveryCount: number): boolean {
  return deliveryCount < MAX_INGEST_DELIVERIES;
}

/**
 * Failure kinds no redelivery and no re-plan can fix, so the retry budget above
 * should not be spent on them.
 *
 * Deliberately a KIND LIST rather than the taxonomy's own `retryable` flag.
 * `retryable` answers "should the HTTP transport try again immediately", on a
 * 30s breaker cooldown and a 2s backoff — a different question from "is this
 * worth another delivery 305s from now". `NewsCircuitOpenError` is where the two
 * answers diverge: `retryable: false`, because an immediate retry is known to be
 * pointless, yet a redelivery lands long after the cooldown has elapsed and is
 * one of the retries the budget is FOR. Reading the flag would drop exactly the
 * work most likely to succeed on the next attempt.
 *
 * The bar is high, because dropping is not as cheap as it looks. The give-up
 * path's "the next reader re-plans the gap" recovery does not apply for the
 * whole `INGEST_RETENTION_SECONDS` window: `enqueueSegment` publishes under a
 * content-derived idempotency key, so a re-plan inside that window is
 * deduplicated against this very message and never sees a delivery — it only
 * re-adds the pending entry, and the topic reads `in_progress` against work
 * nothing will perform. Dropping early therefore BUYS nothing unless no
 * attempt could have helped.
 *
 * Two kinds clear that bar, both mapped from a specific status rather than
 * inferred. The statuses below are CURRENTS' mapping — mapping is per-adapter
 * by design (see the taxonomy in `errors.ts`), and GNews for instance reads 403
 * as a spent daily budget and never emits `blocked` at all. It is the KINDS
 * that are the contract here; the statuses are named only to show that neither
 * is a catch-all:
 *
 *   - `auth` — Currents' 401, or a JSON 403. The key is missing, wrong, or
 *     revoked, and an operator fixes that on a timescale no retry budget here
 *     reaches.
 *   - `blocked` — Currents' non-JSON 403, i.e. a Cloudflare fingerprint ban on
 *     our User-Agent. Same remedy, same timescale.
 *
 * **`invalid_query` is deliberately NOT here**, and the production 400 of
 * 2026-08-26 is the reason rather than a counter-example. Two things rule it
 * out. First, it is the 4xx CATCH-ALL — `mapErrorResponse` returns it for any
 * status it does not otherwise recognise, so a 408 from an intermediary, a 409,
 * a 425 or a 451 all arrive wearing this kind, and those are precisely the
 * transient faults the budget exists for. Second, even the real thing can heal:
 * `clampSearchParams` runs per request against a fresh `now`, so the lookback
 * violation observed in production genuinely succeeded on its second delivery.
 * Dropping it on the first would have converted a self-healing retry into
 * permanent loss. What that 400 cost is fixed by not GENERATING it — see
 * `LOOKBACK_PLAN_SLACK_MS` and the fetch-time clamp in `processSegmentJob` —
 * not by discarding the message that reports it.
 *
 * Structural check via `isNewsError`, not `instanceof`: these errors cross a
 * package boundary, and a duplicated `@zammy/news-client` in the graph would
 * make `instanceof` quietly false.
 */
const PERMANENT_FAILURE_KINDS: ReadonlySet<string> = new Set(["auth", "blocked"]);

export function isPermanentIngestFailure(
  error: unknown,
): error is Error & { kind: string; provider: string } {
  return isNewsError(error) && PERMANENT_FAILURE_KINDS.has(error.kind);
}

/** The publish half of the SDK, narrowed to what this needs so it can be faked. */
export type PublishMessage = (
  topic: string,
  payload: IngestJob,
  options: { idempotencyKey: string; retentionSeconds: number },
) => Promise<{ messageId: string | null }>;

/** The narrow logger this needs, satisfied by Fastify's and by a CLI's own. */
export interface QueueLogger {
  warn(fields: object, message: string): void;
}

export interface VercelIngestQueueOptions {
  /** Doubles as the Vercel Queues topic name; `vercel.json`'s trigger must match. */
  queueName?: string;
  publish?: PublishMessage;
  log?: QueueLogger;
  /**
   * Injected only so the unrecorded-enqueue window below is testable without
   * fake timers, which ioredis does not survive. Same seam `DrainOptions` uses.
   */
  now?: () => number;
}

export class VercelIngestQueue implements IngestQueue {
  private readonly redis: Redis;
  private readonly pending: PendingSet;
  private readonly topic: string;
  private readonly publish: PublishMessage;
  private readonly log: QueueLogger | undefined;
  private readonly now: () => number;
  /**
   * Enqueues whose LEDGER WRITE was lost, per pending id then job id, holding
   * the time of the attempt. The local stand-in for a `ZADD` that never landed.
   *
   * It exists because the two halves of an enqueue do not fail together. The
   * publish is durable and throws (`enqueueSegment`); the ledger write is
   * best-effort and is swallowed (`ledger`). A Redis blip lasting one command
   * therefore leaves work genuinely owed with nothing recording it — and the
   * damage is not the missing spinner, it is that `pendingCount` then returns a
   * clean 0 from a HEALTHY Redis, `timeline-service` reads `complete`, and its
   * cache gate writes a page missing the segment this job is about to fetch.
   * Up to 24 h on the historical freshness tier, with nothing in `degraded` to
   * say why. The blip is over long before the page is cached, so there is no
   * outage left for a reader to notice.
   *
   * In-memory, which is exactly as durable as it can be: the reason we are here
   * is that the durable store refused a write. What makes that worth having
   * anyway is that the read which caches is USUALLY the read which enqueued —
   * `timeline-service` plans gaps, enqueues, counts and caches in one request —
   * so the instance holding this map is the instance about to make the mistake.
   *
   * What it cannot cover: another instance serving that read. Nothing local can,
   * and there is no cheap durable answer, since Redis is the thing that failed.
   * The residual is one under-reported topic until `STALE_PENDING_MS`, which is
   * the pre-existing behaviour rather than a new hole.
   *
   * What it costs when it DOES fire: the note outlives the job. `settle` runs in
   * the consumer function, not here (see `settle`), so nothing clears the note
   * on this instance and the topic reads `in_progress` for the full
   * `STALE_PENDING_MS` even after the fill lands seconds later. Over-counting is
   * the direction to be wrong in, but this is where the fifteen-minute window
   * gets spent for real.
   */
  private readonly unrecorded = new Map<string, Map<string, number>>();

  constructor(redisUrl: string, options: VercelIngestQueueOptions = {}) {
    this.topic = options.queueName ?? "ingest";
    this.log = options.log;
    this.now = options.now ?? Date.now;
    // `maxRetriesPerRequest: 2` so a genuinely unreachable Redis fails fast
    // rather than hanging a request behind a reconnect storm — but the OFFLINE
    // QUEUE stays on, unlike `server.ts`'s cache client. A cold instance boots
    // and serves its first request in well under the ~800 ms an Upstash
    // handshake takes (measured, Phase 1), so with commands rejected until the
    // socket is up the very first enqueue of every cold start would lose its
    // ledger entry. Queue them instead; they are bounded by the retry count.
    //
    // An `error` listener is not optional: ioredis makes an unhandled one
    // fatal, and a queue that kills the instance on a blip is worse than one
    // that miscounts.
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    this.redis.on("error", (error: unknown) =>
      this.log?.warn({ err: error }, "ingest queue redis error"),
    );
    this.pending = new PendingSet(this.redis, this.topic);
    // Bound here rather than at module scope: the client resolves its region
    // from VERCEL_REGION on first use, and a module-scope instance would warn
    // about the fallback in every process that merely imports this file.
    this.publish = options.publish ?? new QueueClient().send;
  }

  async enqueueSegment(job: SegmentJob): Promise<void> {
    // Publish FIRST and let it throw: the message is the durable half, and a
    // caller told the enqueue succeeded when it did not would leave a gap
    // nothing is going to fill.
    await this.send(job);
    await this.record(job);
  }

  async enqueueDeepen(job: DeepenJob): Promise<void> {
    await this.send(job);
    await this.record(job);
  }

  async enqueueSample(job: SampleJob): Promise<void> {
    await this.send(job);
    await this.record(job);
  }

  async pendingCount(pendingId: string): Promise<number> {
    const counted = await this.ledger(() => this.pending.count(pendingId), 0, "count");
    // Plus what this instance knows it failed to write down. Added rather than
    // maxed: two lost enqueues for one topic are two outstanding jobs, and the
    // ledger cannot be holding either of them.
    //
    // It can over-count — a `ZADD` whose reply was lost but whose write landed
    // is counted twice — and that is the direction to be wrong in. An
    // over-count suppresses a cache write and holds `in_progress`; an
    // under-count caches a page with a hole in it. Same asymmetry
    // `STALE_PENDING_MS` is sized for, and it clears itself either way.
    return counted + this.unrecordedFor(pendingId);
  }

  async settle(job: IngestJob): Promise<void> {
    // Before the Redis call, and unconditionally: a settled job is not owed, so
    // a stand-in for its missing ledger entry is not owed either.
    //
    // **Under this driver it almost never fires, and that is worth stating
    // rather than discovering.** `settle` is called from the consumer
    // (`vercel-queue.ts`) and the drain (`drain.ts`), both of which are separate
    // FUNCTIONS from the request path that did the enqueueing — separate
    // instances, each with its own empty `unrecorded`. The note lives on the
    // instance that failed the `ZADD`, and nothing on that instance settles the
    // job. So expiry, not settlement, is what actually clears it: a lost `ZADD`
    // holds its topic at `in_progress` on that one instance for the full
    // `STALE_PENDING_MS`, even though the job itself finished in seconds.
    //
    // That is the safe direction — an over-count suppresses a cache write and
    // costs re-queries, where an under-count persists a page with a hole in it —
    // but it is a bigger residual than "cleared by settle" suggests, and it is
    // the second reason (after the poll loop) that this window's size is a real
    // cost rather than a formality. The line stays because it is correct for any
    // same-instance topology, BullMQ's included.
    this.forget(job);
    await this.ledger(() => this.pending.remove(job), undefined, "remove");
  }

  startConsumer(_handler: IngestHandler, _options?: { concurrency?: number }): never {
    throw new Error(
      "the Vercel Queues consumer is its own deployable (api/queues/ingest.ts); " +
        "this driver cannot start one in-process",
    );
  }

  /**
   * The pending set only. A hosted topic's messages are not ours to drop, and
   * they expire on their own within `INGEST_RETENTION_SECONDS` — fifteen
   * minutes now, not the five §0's TTL gave. So a test that obliterates the
   * ledger and re-enqueues the same content key inside that window is
   * deduplicated against the previous run's message and never sees a delivery.
   * `ingest-queue-vercel.test.ts` fakes the transport and so never meets this; a
   * real-topic test would have to vary the fingerprint per run.
   */
  async obliterate(): Promise<void> {
    this.unrecorded.clear();
    await this.pending.purge();
  }

  get name(): string {
    return this.topic;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * A pending-set operation, degraded to best-effort.
   *
   * This is the one posture the BullMQ driver could not have: there, Redis WAS
   * the queue, so a Redis outage failed the enqueue and there was nothing finer
   * to say. Here the message is already safe in a hosted topic and the pending
   * set is a progress hint — so failing a timeline read because the hint could
   * not be written would trade a working page for an accurate one.
   *
   * What it costs is `meta.ingest` under-reporting: a swallowed `count` returns
   * 0, so a topic with work outstanding reads `complete`. What that does NOT do
   * is cut a poll loop short — `INGEST_POLL_MAX` stops the client after ~60 s
   * whatever we report. What it reaches is `timeline-service`'s cache gate,
   * which writes only a `complete` page, and the two failures land differently
   * there:
   *
   *   - **A swallowed `count` is safe, and safe by accident.** The gate's write
   *     goes to Redis too, and `writeCachedPage` swallows its own failure, so
   *     while Redis is down nothing is persisted and the next healthy read goes
   *     back to Postgres. Note it is only the FULL-outage case that is covered
   *     this way: the cache client sets `enableOfflineQueue: false` and this one
   *     does not (see the constructor), so the two fail independently per
   *     command and one can lose a count while the other caches happily.
   *   - **A swallowed `add` was not safe, and is now compensated rather than
   *     tolerated.** The publish above it has already succeeded — deliberately
   *     outside this wrapper, since the message is the durable half — so the
   *     work is genuinely owed with nothing in the ledger saying so, and a later
   *     read would get a truthful-looking 0 from a healthy client and cache an
   *     incomplete page as settled. `unrecorded` is what closes that: the loss
   *     is remembered in memory and added back to every count, so the read that
   *     enqueued cannot then conclude the topic is finished. See that field for
   *     what it deliberately does not cover.
   *
   * So the fail-open posture stands for reads and no longer for writes, which is
   * the distinction that was missing. Reads degrade the way §3.4's quota
   * governor and §3.5's rate limit do — answer with less, Redis is not on the
   * critical path of answering. A lost write is different in kind: it would
   * degrade toward PERSISTING something untrue, which no amount of "the cache is
   * not correctness" makes recoverable inside the TTL. Same asymmetry
   * `STALE_PENDING_MS` is sized for.
   */
  private async ledger<T>(op: () => Promise<T>, fallback: T, what: string): Promise<T> {
    try {
      return await op();
    } catch (error) {
      this.warn(what, error);
      return fallback;
    }
  }

  /**
   * The ledger half of an enqueue: write it down, or remember that we could not.
   *
   * Split out of `ledger` because its recovery is specific — a fallback value is
   * the wrong shape for a write, and what a lost write needs is a note, not a
   * default.
   */
  private async record(job: IngestJob): Promise<void> {
    const pendingId = pendingIdOf(job);
    try {
      await this.pending.add(job);
      // A retry that lands clears the note it left: the ledger is authoritative
      // again for this job, and leaving the note would double-count it.
      this.forget(job);
    } catch (error) {
      this.warn("add", error);
      const entries = this.unrecorded.get(pendingId) ?? new Map<string, number>();
      // NOT overwritten if present, for the same reason `PendingSet.add` uses
      // `ZADD NX`: a job re-requested on every poll would keep refreshing its
      // own timestamp and never age out.
      if (!entries.has(ingestJobId(job))) entries.set(ingestJobId(job), this.now());
      this.unrecorded.set(pendingId, entries);
    }
  }

  /** Drop the stand-in for a job's ledger entry, if this instance holds one. */
  private forget(job: IngestJob): void {
    const pendingId = pendingIdOf(job);
    const entries = this.unrecorded.get(pendingId);
    if (!entries) return;
    entries.delete(ingestJobId(job));
    if (entries.size === 0) this.unrecorded.delete(pendingId);
  }

  /**
   * Unrecorded enqueues for one topic, expiring the whole map on the way past.
   *
   * The expiry is `STALE_PENDING_MS`, the same clock the ledger entry would have
   * been pruned on, because that is what these notes stand in for — a note that
   * outlived the entry it substitutes for would hold a topic at `in_progress`
   * for the life of the instance. Sweeping every topic rather than the queried
   * one keeps the map bounded by "topics whose enqueue failed recently" instead
   * of "topics whose enqueue failed, ever"; it costs nothing, because in the
   * healthy case there is nothing to sweep.
   */
  private unrecordedFor(pendingId: string): number {
    const cutoff = this.now() - STALE_PENDING_MS;
    for (const [id, entries] of this.unrecorded) {
      for (const [jobId, at] of entries) if (at <= cutoff) entries.delete(jobId);
      if (entries.size === 0) this.unrecorded.delete(id);
    }
    return this.unrecorded.get(pendingId)?.size ?? 0;
  }

  private warn(what: string, error: unknown): void {
    this.log?.warn(
      { op: what, err: error instanceof Error ? error.message : String(error) },
      "ingest pending set unavailable; meta.ingest will under-report",
    );
  }

  private async send(job: IngestJob): Promise<void> {
    await this.publish(this.topic, job, {
      idempotencyKey: ingestJobId(job),
      // Not the 24-hour default (§0), and no longer `STALE_PENDING_MS / 1000`
      // either — that equalled the redelivery lease and closed the retry window
      // to zero. See `INGEST_RETENTION_SECONDS`. Billed at 2x the operation,
      // which is the price of dedup.
      retentionSeconds: INGEST_RETENTION_SECONDS,
    });
  }
}
