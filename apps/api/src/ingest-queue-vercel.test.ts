import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_INGEST_DELIVERIES,
  VercelIngestQueue,
  shouldRetryDelivery,
  type PublishMessage,
} from "./ingest-queue-vercel.js";
import {
  STALE_PENDING_MS,
  ingestJobId,
  parseIngestJob,
  pendingIdOf,
  type IngestJob,
  type SegmentJob,
} from "./ingest-queue.js";

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
  options: { redisUrl?: string; log?: { warn(fields: object, message: string): void } } = {},
): { queue: VercelIngestQueue; published: Published[] } {
  const published: Published[] = [];
  const publish: PublishMessage = async (topic, payload, sendOptions) => {
    published.push({ topic, payload, options: sendOptions });
    return { messageId: randomUUID() };
  };
  const queue = new VercelIngestQueue(options.redisUrl ?? REDIS_URL, {
    queueName: `test-vq-${randomUUID()}`,
    publish,
    ...(options.log ? { log: options.log } : {}),
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

  it("publishes with a TTL equal to the pending window, not the 24-hour default", async () => {
    // §0's decision, and the reason it matters: at the default retention a
    // failed run's segment could not be re-enqueued until tomorrow, while its
    // pending entry had long since aged out and the topic read as complete.
    const { queue, published } = makeQueue();

    await queue.enqueueSegment(segment());

    expect(published[0]!.options.retentionSeconds).toBe(STALE_PENDING_MS / 1000);
    expect(published[0]!.options.retentionSeconds).toBe(300);
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
    // Fail-open, the same direction §3.4 and §3.5 take. Under BullMQ this case
    // could not arise — Redis WAS the queue — but here the message is already
    // safe in a hosted topic, so failing the read to be accurate about a
    // spinner would trade a working page for nothing.
    const warnings: string[] = [];
    const { queue, published } = makeQueue({
      log: { warn: (_fields, message) => warnings.push(message) },
    });
    await queue.close(); // every command from here rejects

    await expect(queue.enqueueSegment(segment())).resolves.toBeUndefined();
    // The message went out. Only the progress hint was lost.
    expect(published).toHaveLength(1);
    expect(await queue.pendingCount(segment().fingerprint)).toBe(0);
    expect(warnings.some((w) => w.includes("under-report"))).toBe(true);
  });
});
