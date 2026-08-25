import type { Redis } from "ioredis";

/**
 * The deferred-ingestion queue (ARCHITECTURE 9.1). Every job here traces back
 * to a user request — pages a deadline cut off, or halves of a truncated
 * segment (§6.3). At-least-once delivery is what §4.1 makes a deployment
 * requirement: instances are recycled on every deploy, and work held by a dying
 * consumer must be re-delivered, not lost.
 *
 * Idempotent ingestion (§7.4) and idempotent coverage recording are what make
 * at-least-once safe: a re-delivered segment re-fetches and re-upserts, and
 * nothing double-counts.
 *
 * This file is the CONTRACT and the parts that do not depend on a transport.
 * Two implementations satisfy it (VERCEL-ALL-IN-SCOPE §3.2):
 *
 *   - `ingest-queue-bullmq.ts` — Redis-held jobs and an in-process worker. The
 *     Compose shape, and still the one local development runs.
 *   - `ingest-queue-vercel.ts` — a push-mode Vercel Queues topic whose consumer
 *     is a separate deployable with no public URL.
 *
 * What does NOT vary between them is the pending set. `pendingCount` is what
 * `meta.ingest` reports and what the client polls against (§6.5), so keeping
 * that mechanism in Redis under both transports is what leaves the progressive-
 * delivery contract untouched by the swap — the smallest possible blast radius
 * for the riskiest change.
 */

export interface SegmentJob {
  fingerprint: string;
  /** ISO-8601 — job payloads cross a transport as JSON. */
  from: string;
  to: string;
  /** Resume point when a deadline cut a segment mid-paging. */
  startPage: number;
  /**
   * A §6.4 incremental top-up: [max(coverage.upper), now]. Deduplicated by its
   * leading edge alone, because every poll re-reads "now" — under the full
   * (from, to) identity each 1.5s poll would mint a fresh job and multiply
   * quota spend until the first one landed.
   */
  kind?: "topup";
}

/**
 * The §10.1 breadth sample, triggered by the first landing-page visitor after
 * the last snapshot staled. One per language: the Redis first-visitor lock
 * elects the enqueuer and the job identity dedups whatever slips past it. No
 * day key — the window rolls with the clock (ADR-0008), so consecutive samples
 * are the same job identity and the freshness lock is what spaces them.
 */
export interface SampleJob {
  kind: "sample";
  language: string;
}

export type IngestJob = SegmentJob | SampleJob;

export type IngestHandler = (job: IngestJob) => Promise<void>;

/** The pending-set identity a trending read polls (§10.4 meta.ingest). */
export function samplePendingId(job: Pick<SampleJob, "language">): string {
  return `sample_${job.language}`;
}

/**
 * The content address of a job, and the whole of its dedup story under both
 * transports: BullMQ takes it as `jobId`, Vercel Queues as `idempotencyKey`.
 * Exported because the pending set is keyed by it and because it is one of the
 * pure parts the tests can still assert directly once delivery semantics belong
 * to a platform (§3.2).
 */
export function ingestJobId(job: IngestJob): string {
  // Underscores, not colons — BullMQ reserves ':' as its key separator, and
  // Vercel Queues restricts topic names to [A-Za-z0-9_-] besides.
  if (job.kind === "sample") return samplePendingId(job);
  if (job.kind === "topup") return `topup_${job.fingerprint}_${Date.parse(job.from)}`;
  return `seg_${job.fingerprint}_${Date.parse(job.from)}_${Date.parse(job.to)}_p${job.startPage}`;
}

/**
 * The inverse of `ingestJobId` — a job reconstructed from its content address.
 *
 * This exists because the pending set stores job IDENTITIES, not payloads: the
 * ZSET member is `ingestJobId(job)` and nothing else, so the manual drain
 * (`drain.ts`) can only act on an outstanding entry if the identity is enough
 * to rebuild the job. For segments it is, exactly: `ingestJobId` writes the
 * fingerprint and both epoch-millisecond bounds, and a fingerprint contains no
 * underscore, so the encoding round-trips. That is luck rather than design, and
 * pinning it with a round-trip test is what keeps it true.
 *
 * `now` is only read for the ONE case that does not round-trip: a top-up's
 * identity omits its upper bound by design (§6.4 dedups it by the leading edge
 * alone, because every poll re-reads "now"), so the bound has to be supplied
 * again. Passing it in rather than calling the clock keeps this pure.
 *
 * Returns `null` for anything it does not recognise, which the drain treats the
 * same way the consumer treats an unparseable payload: drop it loudly. A member
 * this cannot read was written by a different version of `ingestJobId`, and it
 * will not become readable later.
 */
export function parseIngestJobId(id: string, now: Date): IngestJob | null {
  if (id.startsWith("sample_")) {
    // Not split on "_": a language subtag is allowed to contain one, and the
    // remainder after the prefix is the whole of it.
    const language = id.slice("sample_".length);
    return language.length > 0 ? { kind: "sample", language } : null;
  }

  const parts = id.split("_");
  const asIso = (ms: string): string | null => {
    if (!/^\d+$/.test(ms)) return null;
    const date = new Date(Number(ms));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };

  if (parts[0] === "topup" && parts.length === 3) {
    const [, fingerprint, fromMs] = parts;
    const from = asIso(fromMs!);
    if (!fingerprint || !from) return null;
    // `to` is "now" by the definition of a top-up, which is the whole reason
    // this identity can afford to omit it.
    return { fingerprint, from, to: now.toISOString(), startPage: 1, kind: "topup" };
  }

  if (parts[0] === "seg" && parts.length === 5) {
    const [, fingerprint, fromMs, toMs, page] = parts;
    const from = asIso(fromMs!);
    const to = asIso(toMs!);
    const startPage = /^p\d+$/.test(page ?? "") ? Number(page!.slice(1)) : NaN;
    if (!fingerprint || !from || !to || !Number.isInteger(startPage) || startPage < 1) {
      return null;
    }
    return { fingerprint, from, to, startPage };
  }

  return null;
}

/**
 * Which pending registry a job belongs to: a topic's fingerprint, or the
 * per-language sample slot. Segments and samples are counted separately because
 * they are polled separately — a timeline read asks about its own fingerprint,
 * a trending read asks about `sample_<language>`.
 */
export function pendingIdOf(job: IngestJob): string {
  return job.kind === "sample" ? samplePendingId(job) : job.fingerprint;
}

/**
 * A delivered payload, narrowed — or `null` if it is not a job at all.
 *
 * The in-process worker never needed this: BullMQ handed back the object this
 * process had put in. A hosted queue hands back whatever JSON is on the wire,
 * and the shapes that can arrive are real — a message published by an older
 * deployment whose payload has since changed, or a topic name collision. `null`
 * is what lets the consumer drop such a message deliberately instead of
 * throwing it into a redelivery loop that can only fail the same way.
 */
export function parseIngestJob(payload: unknown): IngestJob | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind === "sample") {
    return typeof candidate.language === "string" && candidate.language.length > 0
      ? { kind: "sample", language: candidate.language }
      : null;
  }
  if (
    typeof candidate.fingerprint !== "string" ||
    typeof candidate.from !== "string" ||
    typeof candidate.to !== "string" ||
    typeof candidate.startPage !== "number"
  ) {
    return null;
  }
  const job: SegmentJob = {
    fingerprint: candidate.fingerprint,
    from: candidate.from,
    to: candidate.to,
    startPage: candidate.startPage,
  };
  // Carried through explicitly: `kind` is what makes a top-up dedup by its
  // leading edge alone, and a top-up that arrives as a plain segment would mint
  // a fresh job identity on every poll.
  return candidate.kind === "topup" ? { ...job, kind: "topup" } : job;
}

/**
 * Entries older than this are presumed lost to a crashed consumer.
 *
 * **It is no longer the message TTL the Vercel driver publishes with (§0) — it
 * is the same fifteen minutes as that TTL, arrived at from the other end.** §0
 * derived the TTL from this window, which was backwards: this window knows
 * nothing about the platform, so pinning the TTL to it pinned the TTL to 300 s,
 * which is exactly the redelivery lease. A failed job was deleted five seconds
 * before it could come back and no hosted retry ever happened
 * (VERCEL-ALL-IN-SCOPE §10 question 0). Both numbers now descend from the
 * platform's measured retry budget instead: the driver derives
 * `INGEST_RETENTION_SECONDS` from the observed lease (`ingest-queue-vercel.ts`),
 * and this window is held at that value.
 *
 * **The invariant is that the ledger outlives the message:**
 * `STALE_PENDING_MS >= INGEST_RETENTION_SECONDS * 1000`. It cannot be written as
 * that expression — the driver imports this file, not the reverse — so
 * `ingest-queue-vercel.test.ts` is what holds the two together.
 *
 * At five minutes the invariant was violated, and the cost was not the one the
 * fail-open story would suggest. The prune fired at 300 s with the second
 * delivery still 5 s away, and the web client had stopped polling 240 s earlier
 * (`INGEST_POLL_MAX`, ~60 s), so no spinner was ever cut short. What saw it was
 * `timeline-service`'s cache gate, which writes only a `complete` page: a pruned
 * count reads complete, so an incomplete page was cached as settled — for up to
 * 24 hours on the historical freshness tier.
 *
 * So this constant errs in the OPPOSITE direction to the rest of the Redis
 * degradation story (§3.4's quota governor, §3.5's rate limit, and
 * `VercelIngestQueue.ledger`, which all fail open), and deliberately.
 * Over-reporting can only suppress a cache write and hold `in_progress` longer;
 * under-reporting persists a page with a hole in it. The price is that a
 * genuinely crashed consumer holds a topic at `in_progress` for fifteen minutes
 * rather than five — latency and quota spent on never caching a lie.
 *
 * Shared with the BullMQ driver, whose retry budget is ~600 ms (`attempts: 3`,
 * exponential from 200 ms), so fifteen minutes is far past anything it needs.
 * Left shared anyway: under that driver this window is pure crashed-consumer GC,
 * and what a crashed consumer costs is a function of deploy-recycle time, the
 * same wall clock under both transports. A per-driver window is the alternative,
 * and it buys a faster local-dev recovery and nothing else.
 */
export const STALE_PENDING_MS = 15 * 60 * 1000;

/**
 * The transport-independent surface the read path and the consumer share.
 *
 * An interface rather than the class it used to be, because there are now two
 * implementations — but the members are the same ones `timeline-service`,
 * `trending-service` and `server.ts` already used, plus `settle`. `settle` is
 * new and it is new for one reason: BullMQ could clear a pending entry from its
 * own worker events because the worker was in this process, and a push-mode
 * consumer is a different deployable that has to be told.
 */
export interface IngestQueue {
  /**
   * The queue this instance owns. Exposed because the trending keys are scoped
   * by it for the same reason the pending keys are: replicas share the "ingest"
   * queue and must elect ONE sampler, while a differently-named queue — every
   * test harness makes its own — must not touch the state a local dev server is
   * using through the same Redis.
   */
  readonly name: string;

  /**
   * Enqueue a segment, deduplicated by content: every reader who arrives while
   * a gap is unfilled plans the same segments, and without dedup a popular cold
   * topic would enqueue once per reader and multiply quota spend.
   */
  enqueueSegment(job: SegmentJob): Promise<void>;

  /** Enqueue the breadth sample (§10.1). One per language. */
  enqueueSample(job: SampleJob): Promise<void>;

  /**
   * Outstanding jobs for a topic — meta.ingest.pendingJobs (§6.1) — or for a
   * sample when given a samplePendingId.
   */
  pendingCount(pendingId: string): Promise<number>;

  /**
   * Mark a delivered job no longer outstanding. The counterpart to enqueue, and
   * the consumer's last act on the happy path — or its act on a poisoned
   * message it has decided to stop retrying, since a job nobody will attempt
   * again is not pending work.
   */
  settle(job: IngestJob): Promise<void>;

  /**
   * Start a consumer inside THIS process. Only the BullMQ driver can: under
   * Vercel Queues the consumer is its own function and this throws.
   */
  startConsumer(handler: IngestHandler, options?: { concurrency?: number }): void;

  /** Test hygiene: drop every trace of this queue that we own. */
  obliterate(): Promise<void>;

  close(): Promise<void>;
}

/** One outstanding ledger entry, as `listOutstanding` reports it. */
export interface PendingEntry {
  /** The registry it sits in: a topic fingerprint, or `sample_<language>`. */
  pendingId: string;
  /** Its content address — feed it to `parseIngestJobId` to get the job back. */
  jobId: string;
  enqueuedAt: Date;
}

/**
 * The Redis registry behind `meta.ingest.pendingJobs`, shared verbatim by both
 * transports.
 *
 * It is deliberately NOT the queue: a hosted queue will not tell us "how much
 * work is outstanding for this one topic", and the client's poll loop needs
 * exactly that. Keeping our own ledger also gives §3.2's named fallback
 * something to read if the beta trigger regresses — what is owed survives in
 * Redis whether or not anything is draining it.
 */
export class PendingSet {
  constructor(
    private readonly redis: Redis,
    private readonly queueName: string,
  ) {}

  async add(job: IngestJob): Promise<void> {
    // NX: re-enqueueing a duplicate must not refresh its timestamp, or a
    // permanently-re-requested job could never go stale.
    await this.redis.zadd(this.key(pendingIdOf(job)), "NX", Date.now(), ingestJobId(job));
  }

  async remove(job: IngestJob): Promise<void> {
    await this.redis.zrem(this.key(pendingIdOf(job)), ingestJobId(job));
  }

  /**
   * Remove by raw coordinates, for the one caller that HAS an entry but cannot
   * rebuild the job behind it: the drain, facing a member `parseIngestJobId`
   * does not recognise.
   *
   * `remove` cannot serve that case, because it derives both the key and the
   * member from a job. Without this the unreadable entry is immortal for
   * exactly the topics the drain exists for — a cold one never calls `count`,
   * so the stale prune that would otherwise collect it never runs.
   */
  async forget(pendingId: string, jobId: string): Promise<void> {
    await this.redis.zrem(this.key(pendingId), jobId);
  }

  /**
   * Entries older than STALE_PENDING_MS are pruned as crashed-consumer residue,
   * so a lost decrement degrades to "in_progress for fifteen minutes", never to
   * a topic that reads as perpetually warming. Fifteen rather than five because
   * the window has to outlive the hosted retry budget: a prune that beats a
   * redelivery returns 0 for work that is still owed, and a 0 here is what lets
   * `timeline-service` cache an unfinished page as settled.
   */
  async count(pendingId: string): Promise<number> {
    const key = this.key(pendingId);
    await this.redis.zremrangebyscore(key, 0, Date.now() - STALE_PENDING_MS);
    return this.redis.zcard(key);
  }

  /**
   * Every entry across every topic that has been outstanding longer than
   * `olderThanMs` — what the manual drain reads (`drain.ts`).
   *
   * **It deliberately does not prune, which is the opposite of `count`.** The
   * prune in `count` is the whole reason a drain is possible at all AND the
   * reason it is only possible for some topics, so the asymmetry is worth
   * stating: `count` deletes anything past `STALE_PENDING_MS` as crashed-
   * consumer residue, and it runs on every `meta.ingest` read. A topic with
   * traffic therefore erases its own ledger within fifteen minutes of a read —
   * which is fine, because that is exactly the topic whose next reader re-plans
   * the gap immediately (§6.3). A topic with no traffic never calls `count`, so
   * its entries persist here indefinitely, and that is the topic the drain is
   * for: nothing else is coming to notice.
   *
   * Since `STALE_PENDING_MS` was raised to match the message TTL, that prune
   * boundary and `DRAIN_MIN_AGE_MS` are the same fifteen minutes — so a read
   * topic erases an entry at the very moment the drain becomes willing to touch
   * it. That is the existing blindness restated, not a new one: the drain's
   * floor has always been the TTL, and a topic being read is a topic the drain
   * was never the recovery for.
   *
   * `SCAN`, not `KEYS`: `purge` uses `KEYS` because it runs in tests against a
   * handful of keys, and this runs in production against however many topics
   * have ever been read.
   */
  async listOutstanding(olderThanMs: number): Promise<PendingEntry[]> {
    const cutoff = Date.now() - olderThanMs;
    const pattern = this.key("*");
    const prefix = this.key("");
    const entries: PendingEntry[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        // Score-bounded, so a topic with thousands of live entries costs one
        // range read rather than a full fetch we then filter in memory.
        const flat = await this.redis.zrangebyscore(key, 0, cutoff, "WITHSCORES");
        for (let i = 0; i < flat.length; i += 2) {
          entries.push({
            pendingId: key.slice(prefix.length),
            jobId: flat[i]!,
            enqueuedAt: new Date(Number(flat[i + 1]!)),
          });
        }
      }
    } while (cursor !== "0");
    return entries;
  }

  async purge(): Promise<void> {
    const keys = await this.redis.keys(this.key("*"));
    if (keys.length > 0) await this.redis.del(...keys);
  }

  private key(pendingId: string): string {
    // Scoped to the queue: replicas share the "ingest" queue and therefore the
    // registry, while a differently-named queue (tests) cannot leak pending
    // state into this one's counts.
    return `ingest:pending:${this.queueName}:${pendingId}`;
  }
}
