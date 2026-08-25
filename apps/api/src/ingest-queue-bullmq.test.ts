import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BullMqIngestQueue } from "./ingest-queue-bullmq.js";
import type { SegmentJob } from "./ingest-queue.js";

/**
 * The in-process job consumer's queue (ARCHITECTURE 9.1). At-least-once
 * delivery is a deployment requirement, not a nicety: instances are recycled
 * on every deploy, and a naive LPOP loses whatever the dying one held (§4.1).
 * Runs against the compose Redis; every test gets its own queue name.
 *
 * These four assert REAL dedup and REAL retry against a real transport, which
 * is exactly what the hosted driver cannot be asked for — VERCEL-ALL-IN-SCOPE
 * §3.2 records that as a genuine loss of test power. It is a loss only on the
 * deployment that takes it: this driver still runs Compose and local
 * development, so the semantics stay pinned here.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

const segment = (over: Partial<SegmentJob> = {}): SegmentJob => ({
  fingerprint: "f".repeat(64),
  from: "2026-08-08T00:00:00.000Z",
  to: "2026-08-09T00:00:00.000Z",
  startPage: 1,
  ...over,
});

let queue: BullMqIngestQueue;

afterEach(async () => {
  await queue.obliterate();
  await queue.close();
});

function makeQueue() {
  return new BullMqIngestQueue(REDIS_URL, { queueName: `test-ingest-${randomUUID()}` });
}

describe("BullMqIngestQueue", () => {
  it("delivers an enqueued segment to the consumer", async () => {
    queue = makeQueue();
    const processed: SegmentJob[] = [];

    await queue.enqueueSegment(segment());
    queue.startConsumer(async (job) => {
      // The consumer is handed the JOB UNION; a segment is anything that is not
      // the breadth sample, exactly as `server.ts` discriminates it. These tests
      // enqueue only segments, so the guard never fails — it is what makes that
      // claim checkable rather than assumed (§12).
      if (job.kind !== "sample") processed.push(job);
    });

    await vi.waitFor(() => expect(processed).toHaveLength(1), { timeout: 5_000 });
    expect(processed[0]).toEqual(segment());
  });

  it("deduplicates identical pending segments", async () => {
    // The same gap gets planned by every reader who arrives while it is
    // unfilled; without dedup, a popular cold topic enqueues its own segment
    // once per reader and the queue multiplies quota spend (§6.3).
    queue = makeQueue();
    const processed: SegmentJob[] = [];

    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment({ startPage: 3 })); // genuinely different

    queue.startConsumer(async (job) => {
      if (job.kind !== "sample") processed.push(job);
    });

    await vi.waitFor(() => expect(processed).toHaveLength(2), { timeout: 5_000 });
    // Settle briefly: a third delivery arriving late would prove dedup failed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processed).toHaveLength(2);
  });

  it("counts pending work per topic for meta.ingest", async () => {
    queue = makeQueue();
    const other = "e".repeat(64);

    await queue.enqueueSegment(segment());
    await queue.enqueueSegment(segment({ startPage: 2 }));

    expect(await queue.pendingCount(segment().fingerprint)).toBe(2);
    expect(await queue.pendingCount(other)).toBe(0);

    queue.startConsumer(async () => {});
    await vi.waitFor(
      async () => expect(await queue.pendingCount(segment().fingerprint)).toBe(0),
      { timeout: 5_000 },
    );
  });

  it("retries a failed job — at least once, not at most once", async () => {
    queue = makeQueue();
    let attempts = 0;

    await queue.enqueueSegment(segment());
    queue.startConsumer(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient upstream failure");
    });

    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 10_000 });
    await vi.waitFor(
      async () => expect(await queue.pendingCount(segment().fingerprint)).toBe(0),
      { timeout: 5_000 },
    );
  });
});
