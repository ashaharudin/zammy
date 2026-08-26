import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INGEST_RETENTION_SECONDS,
  MAX_INGEST_DELIVERIES,
  isPermanentIngestFailure,
  OBSERVED_REDELIVERY_LEASE_SECONDS,
  VercelIngestQueue,
  shouldRetryDelivery,
  type PublishMessage,
} from "./ingest-queue-vercel.js";
import {
  PendingSet,
  STALE_PENDING_MS,
  ingestJobId,
  parseIngestJob,
  parseIngestJobId,
  pendingIdOf,
  type IngestJob,
  type SegmentJob,
} from "./ingest-queue.js";
import {
  NewsAuthError,
  NewsBlockedError,
  NewsCircuitOpenError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsTimeoutError,
  NewsUpstreamError,
} from "@zammy/news-client";

/**
 * The hosted driver, split the way VERCEL-ALL-IN-SCOPE §3.2 says it has to be:
 * the pure parts asserted directly, the pending-set arithmetic against a real
 * Redis, and the transport faked. Delivery semantics — does a failed message
 * really come back, does `idempotencyKey` really suppress the second delivery —
 * belong to the platform now and are trusted rather than tested. The BullMQ
 * driver's suite still asserts them for the deployment that can.
 *
 * What IS testable here, and is the part a bug would actually live in: that we
 * publish with the right dedup key and the right TTL, that the ledger keeps the
 * same shape it kept under BullMQ, and that nothing can start a worker in a
 * request instance.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

const segment = (over: Partial<SegmentJob> = {}): SegmentJob => ({
  fingerprint: "f".repeat(64),
  from: "2026-08-08T00:00:00.000Z",
  to: "2026-08-09T00:00:00.000Z",
  startPage: 1,
  ...over,
});

interface Published {
  topic: string;
  payload: IngestJob;
  options: { idempotencyKey: string; retentionSeconds: number };
}

const opened: VercelIngestQueue[] = [];

afterEach(async () => {
  for (const open of opened.splice(0)) {
    await open.obliterate().catch(() => {});
    await open.close().catch(() => {});
  }
});

function makeQueue(
  options: {
    redisUrl?: string;
    log?: { warn(fields: object, message: string): void };
    now?: () => number;
    queueName?: string;
  } = {},
): { queue: VercelIngestQueue; published: Published[] } {
  const published: Published[] = [];
  const publish: PublishMessage = async (topic, payload, sendOptions) => {
    published.push({ topic, payload, options: sendOptions });
    return { messageId: randomUUID() };
  };
  const queue = new VercelIngestQueue(options.redisUrl ?? REDIS_URL, {
    queueName: options.queueName ?? `test-vq-${randomUUID()}`,
    publish,
    ...(options.log ? { log: options.log } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  opened.push(queue);
  return { queue, published };
}

describe("ingestJobId", () => {
  it("addresses a segment by its full identity and a top-up by its leading edge", () => {
    // The whole of dedup under both transports. A top-up that carried (from,
    // to) would mint a fresh identity on every 1.5s poll, because every poll
    // re-reads "now" as the upper bound.
    const from = Date.parse("2026-08-08T00:00:00.000Z");
    const to = Date.parse("2026-08-09T00:00:00.000Z");
    expect(ingestJobId(segment())).toBe(`seg_${"f".repeat(64)}_${from}_${to}_p1`);
    expect(ingestJobId(segment({ startPage: 3 }))).not.toBe(ingestJobId(segment()));

    const topup = segment({ kind: "topup", to: "2026-08-09T12:00:00.000Z" });
    const laterPoll = segment({ kind: "topup", to: "2026-08-09T12:00:01.500Z" });
    expect(ingestJobId(topup)).toBe(`topup_${"f".repeat(64)}_${from}`);
    expect(ingestJobId(laterPoll)).toBe(ingestJobId(topup));
  });

  it("gives a sample the identity its pending slot is keyed by", () => {
    // One slot per language, no day key: the window rolls with the clock
    // (ADR-0008), so consecutive samples ARE the same job and the freshness
    // lock is what spaces them.
    const job: IngestJob = { kind: "sample", language: "en" };
    expect(ingestJobId(job)).toBe("sample_en");
    expect(pendingIdOf(job)).toBe("sample_en");
    expect(pendingIdOf(segment())).toBe("f".repeat(64));
  });
});

describe("parseIngestJobId", () => {
  const NOW = new Date("2026-08-25T12:00:00.000Z");

  it("round-trips a segment exactly, which is what the manual drain rests on", () => {
    // The pending set stores IDENTITIES, not payloads, so the drain can only act
    // on an outstanding entry if this inverse is faithful. It is faithful because
    // a fingerprint contains no underscore — luck rather than design, which is
    // precisely why it is pinned here.
    for (const job of [segment(), segment({ startPage: 7 })]) {
      expect(parseIngestJobId(ingestJobId(job), NOW)).toEqual(job);
    }
  });

  it("round-trips a sample, including a language subtag with an underscore", () => {
    expect(parseIngestJobId("sample_en", NOW)).toEqual({ kind: "sample", language: "en" });
    // Not split on "_": the remainder after the prefix is the whole language.
    const odd: IngestJob = { kind: "sample", language: "zh_Hant" };
    expect(parseIngestJobId(ingestJobId(odd), NOW)).toEqual(odd);
  });

  it("restores a top-up's upper bound from the clock, because its identity omits it", () => {
    // The ONE case that cannot round-trip, and by design: a top-up dedups by its
    // leading edge alone. `to` is "now" by definition, so it is supplied again.
    const topup = segment({ kind: "topup", to: "2026-08-09T12:00:00.000Z" });
    expect(parseIngestJobId(ingestJobId(topup), NOW)).toEqual({
      fingerprint: "f".repeat(64),
      from: topup.from,
      to: NOW.toISOString(),
      startPage: 1,
      kind: "topup",
    });
  });

  it("returns null for anything it does not recognise", () => {
    // The drain drops these rather than dispatching them: a member written by a
    // different version of `ingestJobId` will not become readable later.
    for (const bad of [
      "",
      "sample_",
      "seg_abc",
      "seg_abc_notanumber_123_p1",
      "seg_abc_1_2_3",
      "seg_abc_1_2_p0",
      "seg_abc_1_2_pX",
      "topup_abc",
      "topup_abc_nope",
      "written_by_an_older_version",
    ]) {
      expect(parseIngestJobId(bad, NOW)).toBeNull();
    }
  });
});

describe("parseIngestJob", () => {
  it("narrows the shapes a hosted queue can hand back", () => {
    expect(parseIngestJob(segment())).toEqual(segment());
    expect(parseIngestJob({ kind: "sample", language: "en" })).toEqual({
      kind: "sample",
      language: "en",
    });
    // Carried through, because it is what makes a top-up dedup by its leading
    // edge — dropped, it would re-enqueue on every poll.
    expect(parseIngestJob(segment({ kind: "topup" }))).toEqual(segment({ kind: "topup" }));
  });

  it("rejects a payload it cannot act on rather than half-reading it", () => {
    // These are not hypothetical: a message published by an older deployment
    // whose payload has since changed arrives here, and a redelivery loop is
    // the wrong answer to a shape that will never parse.
    expect(parseIngestJob(null)).toBeNull();
    expect(parseIngestJob("segment")).toBeNull();
    expect(parseIngestJob({ kind: "sample" })).toBeNull();
    expect(parseIngestJob({ ...segment(), startPage: "1" })).toBeNull();
    expect(parseIngestJob({ fingerprint: "f", from: "x" })).toBeNull();
  });
});

describe("isPermanentIngestFailure", () => {
  it("drops the failures the message itself causes", () => {
    // `invalid_query` is the one production produced (2026-08-26): a lookback
    // violation on the oldest segment of a cold search, three deliveries and
    // ~610s spent on a 400 that could not become a 200.
    expect(isPermanentIngestFailure(new NewsInvalidQueryError("400"))).toBe(true);
    expect(isPermanentIngestFailure(new NewsAuthError("401"))).toBe(true);
    expect(isPermanentIngestFailure(new NewsBlockedError("cloudflare 1010"))).toBe(true);
  });

  it("keeps the retries for failures the world causes", () => {
    expect(isPermanentIngestFailure(new NewsUpstreamError("502", 502))).toBe(false);
    expect(isPermanentIngestFailure(new NewsQuotaError("429"))).toBe(false);
    expect(isPermanentIngestFailure(new NewsTimeoutError("deadline"))).toBe(false);
  });

  it("keeps an open circuit, whose `retryable: false` means something else", () => {
    // The whole reason this is a kind list rather than a read of `retryable`.
    // The flag answers "retry immediately?" against a 30s cooldown; a
    // redelivery lands 305s out, long after the breaker has gone half-open.
    const error = new NewsCircuitOpenError("open", new Date());
    expect(error.retryable).toBe(false);
    expect(isPermanentIngestFailure(error)).toBe(false);
  });

  it("keeps anything that is not a news error at all", () => {
    // The contended-segment-lock throw in `processSegmentJob` is a plain Error,
    // and it is exactly the case redelivery was built for.
    expect(isPermanentIngestFailure(new Error("segment is locked; retrying later"))).toBe(
      false,
    );
    expect(isPermanentIngestFailure(undefined)).toBe(false);
  });
});

describe("shouldRetryDelivery", () => {
  it("gives a job the same three attempts BullMQ gives it", () => {
    // The retry budget is a property of the work — an upstream blip, a
    // contended segment lock — not of the transport, so the two drivers must
    // not disagree about it. `deliveryCount` starts at 1.
    expect(MAX_INGEST_DELIVERIES).toBe(3);
    expect(shouldRetryDelivery(1)).toBe(true);
    expect(shouldRetryDelivery(2)).toBe(true);
    expect(shouldRetryDelivery(3)).toBe(false);
    expect(shouldRetryDelivery(4)).toBe(false);
  });
});

describe("VercelIngestQueue", () => {
  it("publishes with the content address as the idempotency key", async () => {
    const { queue, published } = makeQueue();

    await queue.enqueueSegment(segment());
    await queue.enqueueSample({ kind: "sample", language: "en" });

    expect(published).toHaveLength(2);
    expect(published[0]!.topic).toBe(queue.name);
    expect(published[0]!.payload).toEqual(segment());
    expect(published[0]!.options.idempotencyKey).toBe(ingestJobId(segment()));
    expect(published[1]!.options.idempotencyKey).toBe("sample_en");
  });

  it("publishes with a TTL that outlives the retry budget, not the 24-hour default", async () => {
    // This assertion USED to pin the TTL to `STALE_PENDING_MS / 1000` (§0's
    // decision), and that is exactly the bug it locked in: the redelivery lease
    // is 300 s, so a 300 s TTL deleted the message five seconds before its first
    // retry was due and no failed job ever came back (§10 question 0). The
    // property worth pinning is the INEQUALITY — the TTL must outlive the whole
    // retry budget, or `shouldRetryDelivery` is deciding about deliveries the
    // platform will never make.
    //
    // Note the old guard "and it must NOT be the pending window" is gone, not
    // relaxed: `STALE_PENDING_MS` was raised to this same 900 s, so the two
    // agree again and no comparison of values can tell them apart. Which way
    // the derivation runs is what changed, and the two `toBe`s below are what
    // pin it — retention comes from the measured lease, not from Redis.
    const { queue, published } = makeQueue();

    await queue.enqueueSegment(segment());

    expect(published[0]!.options.retentionSeconds).toBe(INGEST_RETENTION_SECONDS);
    expect(published[0]!.options.retentionSeconds).toBe(900);
    expect(published[0]!.options.retentionSeconds).toBeGreaterThan(
      MAX_INGEST_DELIVERIES * OBSERVED_REDELIVERY_LEASE_SECONDS - 1,
    );
  });

  it("holds the pending window at or past the message TTL", () => {
    // The other half of §10 question 0, and the half that is not about
    // publishing at all. `STALE_PENDING_MS` prunes on READ, so a window that
    // expires before the platform has finished retrying makes `pendingCount`
    // return 0 for work that is still owed — and a 0 is what lets
    // `timeline-service`'s cache gate write an unfinished page as `complete`,
    // for up to 24 h on the historical freshness tier. At 300 s against a 305 s
    // second delivery that is exactly what happened.
    //
    // The inequality is asserted here rather than written as an expression
    // because `ingest-queue.ts` cannot import this file — the dependency runs
    // the other way. So this test is the ONLY thing holding the two constants
    // together, and a change to either has to keep it green.
    expect(STALE_PENDING_MS).toBeGreaterThanOrEqual(INGEST_RETENTION_SECONDS * 1000);
    expect(STALE_PENDING_MS).toBe(900_000);
    // Past the retry budget itself and not merely past the retention that
    // bounds it: the last delivery lands two leases in, at ~610 s.
    expect(STALE_PENDING_MS).toBeGreaterThan(
      (MAX_INGEST_DELIVERIES - 1) * OBSERVED_REDELIVERY_LEASE_SECONDS * 1000,
    );
  });

  it("counts pending work per topic and clears it on settle", async () => {
    // The half of the transport swap that did NOT change: `meta.ingest` is what
    // the client polls against (§6.5), and it is still this Redis registry.
    const { queue } = makeQueue();
    const other = "e".repeat(64);

    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment({ startPage: 2 }));

    expect(await queue.pendingCount(segment().fingerprint)).toBe(2);
    expect(await queue.pendingCount(other)).toBe(0);

    await queue.settle(segment());
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);
    await queue.settle(segment({ startPage: 2 }));
    expect(await queue.pendingCount(segment().fingerprint)).toBe(0);
  });

  it("still reports work whose LEDGER WRITE was lost", async () => {
    // The hazard this closes, in order: the publish succeeds (it is outside the
    // best-effort wrapper, deliberately), the `ZADD` is refused by a one-command
    // Redis blip and swallowed, Redis is fine again by the time anything counts
    // — so `pendingCount` would answer a truthful-looking 0 for work that is
    // genuinely owed. `timeline-service` reads that as `complete` and its cache
    // gate writes a page missing the segment this job is about to fetch, for up
    // to 24 h on the historical tier, with nothing in `degraded` to explain it.
    //
    // Note the failure is injected on ONE call: the point is that the damage
    // outlives the blip, so a test that kept Redis down would prove less.
    const warnings: object[] = [];
    const queueName = `test-vq-${randomUUID()}`;
    const { queue, published } = makeQueue({
      queueName,
      log: { warn: (fields) => void warnings.push(fields) },
    });
    const add = vi
      .spyOn(PendingSet.prototype, "add")
      .mockRejectedValueOnce(new Error("READONLY: redis blip"));

    await queue.enqueueSegment(segment());
    add.mockRestore();

    // The work really was scheduled — that half never failed.
    expect(published).toHaveLength(1);
    // What the caller sees is the truth anyway.
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);
    expect(warnings).toHaveLength(1);
    // Scoped to its own topic, like every other pending count.
    expect(await queue.pendingCount("e".repeat(64))).toBe(0);

    // And the residual, asserted rather than left as prose: the ledger in Redis
    // really is empty, so a DIFFERENT instance serving that read still sees the
    // honest-looking 0. Nothing local can fix that, and there is nowhere durable
    // to put the note — Redis is what refused it. This is the pre-existing
    // behaviour, bounded by STALE_PENDING_MS, not a hole this change opens.
    const { queue: other } = makeQueue({ queueName });
    expect(await other.pendingCount(segment().fingerprint)).toBe(0);
  });

  it("clears the stand-in when the job settles, rather than holding in_progress", async () => {
    // A lost `ZADD` followed by a successful run must not leave the topic
    // reporting forever. `settle` drops the note whether or not Redis takes the
    // `ZREM`, because a settled job is not owed either way.
    const { queue } = makeQueue();
    const add = vi
      .spyOn(PendingSet.prototype, "add")
      .mockRejectedValueOnce(new Error("READONLY: redis blip"));

    await queue.enqueueSegment(segment());
    add.mockRestore();
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);

    await queue.settle(segment());

    expect(await queue.pendingCount(segment().fingerprint)).toBe(0);
  });

  it("does NOT clear the stand-in when the settle happens on another instance", async () => {
    // The production case, and the reason the test above is not the whole story.
    // Under this driver `settle` is called from the consumer function and the
    // drain route — separate deployables from the request path that enqueued —
    // so the instance holding the note never settles the job. Expiry, not
    // settlement, is what clears it, and the topic reads busy on that instance
    // for the full window even though the fill landed seconds after the enqueue.
    //
    // Pinned because it is easy to read `settle`'s `forget` as covering this,
    // and because it is where the fifteen-minute window is actually spent.
    const queueName = `test-vq-${randomUUID()}`;
    const { queue: requester } = makeQueue({ queueName });
    const add = vi
      .spyOn(PendingSet.prototype, "add")
      .mockRejectedValueOnce(new Error("READONLY: redis blip"));

    await requester.enqueueSegment(segment());
    add.mockRestore();
    expect(await requester.pendingCount(segment().fingerprint)).toBe(1);

    // The consumer drains and settles, on its own instance.
    const { queue: consumer } = makeQueue({ queueName });
    await consumer.settle(segment());

    // Redis agrees the work is done...
    expect(await consumer.pendingCount(segment().fingerprint)).toBe(0);
    // ...and the instance that lost the write still says otherwise.
    expect(await requester.pendingCount(segment().fingerprint)).toBe(1);
  });

  it("expires the stand-in on the ledger entry's own clock", async () => {
    // The note substitutes for a ZSET member, so it has to age out like one, or
    // an instance that lost one write reports that topic as busy until it dies —
    // and in-memory state has no prune-on-read to save it. The clock is injected
    // rather than faked because ioredis does not survive fake timers.
    let now = Date.parse("2026-08-25T12:00:00.000Z");
    const { queue } = makeQueue({ now: () => now });
    const add = vi
      .spyOn(PendingSet.prototype, "add")
      .mockRejectedValueOnce(new Error("READONLY: redis blip"));

    await queue.enqueueSegment(segment());
    add.mockRestore();
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);

    now += STALE_PENDING_MS - 1;
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);
    now += 1;
    expect(await queue.pendingCount(segment().fingerprint)).toBe(0);
  });

  it("counts a lost write once, however many times the same job is re-enqueued", async () => {
    // Same reason `PendingSet.add` uses `ZADD NX`: §6.4 re-enqueues a top-up on
    // every 1.5s poll, so a note that refreshed its own timestamp would never
    // age out, and one appended per attempt would inflate `meta.ingest` without
    // limit. First failure wins; a later success takes over from the ledger.
    const { queue } = makeQueue();
    const add = vi
      .spyOn(PendingSet.prototype, "add")
      .mockRejectedValue(new Error("READONLY: redis blip"));

    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment());
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);

    // The write lands this time, so the ledger is authoritative again and the
    // note must not be counted alongside it.
    add.mockRestore();
    await queue.enqueueSegment(segment());

    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);
  });

  it("counts a re-published duplicate once", async () => {
    // Publish is NOT idempotent — the spike watched two identical sends return
    // two message ids without throwing — so the ledger is what has to hold the
    // line for `meta.ingest`. Only one delivery follows, so only one entry may.
    const { queue, published } = makeQueue();

    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment());

    expect(published).toHaveLength(2);
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);
  });

  it("keeps samples and segments in separate registries", async () => {
    // They are polled separately: a timeline read asks about its fingerprint, a
    // trending read about `sample_<language>`.
    const { queue } = makeQueue();

    await queue.enqueueSample({ kind: "sample", language: "en" });
    await queue.enqueueSample({ kind: "sample", language: "fr" });

    expect(await queue.pendingCount("sample_en")).toBe(1);
    expect(await queue.pendingCount("sample_fr")).toBe(1);
    expect(await queue.pendingCount(segment().fingerprint)).toBe(0);
  });

  it("refuses to start a consumer in this process", async () => {
    // The failure the whole plan is arranged to avoid. A no-op would be worse
    // than a throw: reads would keep succeeding and the topic would sit at
    // `in_progress` forever with nothing draining it.
    const { queue } = makeQueue();
    expect(() => queue.startConsumer(async () => {})).toThrow(/its own deployable/);
  });

  it("does not fail a read when the pending set is unreachable", async () => {
    // Fail-open on the READ, the same direction §3.4 and §3.5 take. Under BullMQ
    // this case could not arise — Redis WAS the queue — but here the message is
    // already safe in a hosted topic, so failing the read to be accurate about a
    // progress hint would trade a working page for nothing.
    //
    // This used to assert `pendingCount === 0` here, and that was the hazard
    // written down as an expectation: the enqueue's publish had succeeded, so a
    // 0 claimed a settled topic for work genuinely owed, and `timeline-service`
    // caches a `complete` page. Fail-open belongs to reads; a lost WRITE is
    // compensated instead (see the lost-ledger-write tests above).
    const warnings: string[] = [];
    const { queue, published } = makeQueue({
      log: { warn: (_fields, message) => warnings.push(message) },
    });
    await queue.close(); // every command from here rejects

    await expect(queue.enqueueSegment(segment())).resolves.toBeUndefined();
    // The message went out, and the read still answers rather than throwing…
    expect(published).toHaveLength(1);
    // …but it answers with the work it knows it failed to write down.
    expect(await queue.pendingCount(segment().fingerprint)).toBe(1);
    expect(warnings.some((w) => w.includes("under-report"))).toBe(true);
  });
});
