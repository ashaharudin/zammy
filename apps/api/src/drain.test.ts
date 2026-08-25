import { describe, expect, it } from "vitest";
import {
  DRAIN_MIN_AGE_MS,
  isAuthorized,
  runDrain,
  type Drainable,
  type DrainReport,
} from "./drain.js";
import { INGEST_RETENTION_SECONDS } from "./ingest-queue-vercel.js";
import {
  ingestJobId,
  type IngestJob,
  type PendingEntry,
  type SegmentJob,
} from "./ingest-queue.js";

/**
 * The manual drain's own behaviour, with no Redis and no upstream.
 *
 * What is worth pinning here is not that it fills — that is one line — but the
 * three ways a fallback of last resort can be WORSE than not having one: it can
 * spend quota on work the queue is still retrying, it can spend quota forever on
 * a segment that will never succeed, and it can be reachable by someone who
 * should not reach it. Each has a test below, and each is the reason for a
 * decision in `drain.ts` that would otherwise read as arbitrary.
 */

const T0 = new Date("2026-08-25T12:00:00.000Z");
const clock = (at: Date) => () => at;

function entry(job: IngestJob, ageMs: number): PendingEntry {
  return {
    pendingId: "kind" in job && job.kind === "sample" ? `sample_${job.language}` : job.fingerprint,
    jobId: ingestJobId(job),
    enqueuedAt: new Date(T0.getTime() - ageMs),
  };
}

const segment = (fingerprint = "a".repeat(64)): SegmentJob => ({
  fingerprint,
  from: "2026-08-08T00:00:00.000Z",
  to: "2026-08-09T00:00:00.000Z",
  startPage: 1,
});

const silent = { info: () => {}, warn: () => {} };

interface Harness {
  drainable: Drainable;
  dispatched: IngestJob[];
  settled: IngestJob[];
  askedFor: number[];
}

function harness(entries: PendingEntry[], fail: (job: IngestJob) => boolean = () => false): Harness {
  const dispatched: IngestJob[] = [];
  const settled: IngestJob[] = [];
  const askedFor: number[] = [];
  return {
    dispatched,
    settled,
    askedFor,
    drainable: {
      listOutstanding: async (olderThanMs) => {
        askedFor.push(olderThanMs);
        return entries;
      },
      settle: async (job) => void settled.push(job),
      dispatch: async (job) => {
        dispatched.push(job);
        if (fail(job)) throw new Error("upstream said no");
      },
    },
  };
}

describe("runDrain", () => {
  it("fills an abandoned job and settles it", async () => {
    const job = segment();
    const h = harness([entry(job, DRAIN_MIN_AGE_MS + 1000)]);

    const report = await runDrain(h.drainable, { now: clock(T0) }, silent);

    expect(h.dispatched).toEqual([job]);
    expect(h.settled).toEqual([job]);
    expect(report).toEqual<DrainReport>({
      scanned: 1,
      filled: 1,
      failed: 0,
      unreadable: 0,
      truncated: false,
    });
  });

  it("only ever asks for entries past the whole retry budget", async () => {
    // The load-bearing assertion of this file. Below this line the platform may
    // still redeliver, and a fill there spends upstream quota on a segment the
    // queue is about to deliver anyway — the one way this route makes things
    // worse. The floor is the message TTL, so an entry past it names work whose
    // message has certainly expired.
    const h = harness([]);

    await runDrain(h.drainable, { now: clock(T0) }, silent);

    expect(h.askedFor).toEqual([DRAIN_MIN_AGE_MS]);
    expect(DRAIN_MIN_AGE_MS).toBe(INGEST_RETENTION_SECONDS * 1000);
    expect(DRAIN_MIN_AGE_MS).toBe(900_000);
  });

  it("settles a job whose fill FAILED, so a poisoned segment cannot be retried forever", async () => {
    // There is no dead-letter queue (§3.2), so the bound has to live here: one
    // attempt per entry. Leaving it in the ledger would re-fill it on every pass
    // and spend quota each time. It costs nothing observable — the entry is
    // already past the TTL, so the next `meta.ingest` read would prune it anyway.
    const job = segment();
    const h = harness([entry(job, DRAIN_MIN_AGE_MS + 1)], () => true);

    const report = await runDrain(h.drainable, { now: clock(T0) }, silent);

    expect(h.dispatched).toEqual([job]);
    expect(h.settled).toEqual([job]);
    expect(report.failed).toBe(1);
    expect(report.filled).toBe(0);
  });

  it("keeps going after one job fails", async () => {
    const bad = segment("b".repeat(64));
    const good = segment("c".repeat(64));
    const h = harness(
      [entry(bad, DRAIN_MIN_AGE_MS + 1), entry(good, DRAIN_MIN_AGE_MS + 1)],
      (job) => "fingerprint" in job && job.fingerprint === bad.fingerprint,
    );

    const report = await runDrain(h.drainable, { now: clock(T0) }, silent);

    expect(h.dispatched).toEqual([bad, good]);
    expect(report).toMatchObject({ scanned: 2, filled: 1, failed: 1 });
  });

  it("drops an entry it cannot read back into a job, without dispatching it", async () => {
    const h = harness([
      { pendingId: "whatever", jobId: "written_by_an_older_version", enqueuedAt: T0 },
    ]);

    const report = await runDrain(h.drainable, { now: clock(T0) }, silent);

    expect(h.dispatched).toEqual([]);
    // Nothing to settle: settling needs a job, and this entry has none. The next
    // `meta.ingest` read prunes it as stale residue.
    expect(h.settled).toEqual([]);
    expect(report.unreadable).toBe(1);
  });

  it("stops at the job limit and says it was truncated", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry(segment(String(i).repeat(64)), DRAIN_MIN_AGE_MS + 1),
    );
    const h = harness(entries);

    const report = await runDrain(h.drainable, { now: clock(T0), limit: 2 }, silent);

    expect(h.dispatched).toHaveLength(2);
    expect(report).toMatchObject({ scanned: 5, filled: 2, truncated: true });
  });

  it("stops at the deadline, but never mid-job", async () => {
    // The clock advances 100 s per reading, so the deadline trips between jobs.
    // A fill that has started has already spent its quota, so the bound is
    // checked before dispatch and never interrupts one.
    let ticks = 0;
    const now = (): Date => new Date(T0.getTime() + ticks++ * 100_000);
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry(segment(String(i).repeat(64)), DRAIN_MIN_AGE_MS * 10),
    );
    const h = harness(entries);

    const report = await runDrain(h.drainable, { now, deadlineMs: 250_000 }, silent);

    expect(report.truncated).toBe(true);
    expect(h.dispatched.length).toBeGreaterThan(0);
    expect(h.dispatched.length).toBeLessThan(5);
    // Every job that was dispatched was also settled — no half-done entries.
    expect(h.settled).toHaveLength(h.dispatched.length);
  });

  it("survives a settle that fails, and still counts the fill", async () => {
    const job = segment();
    const h = harness([entry(job, DRAIN_MIN_AGE_MS + 1)]);
    const drainable: Drainable = {
      ...h.drainable,
      settle: async () => {
        throw new Error("redis is down");
      },
    };

    const report = await runDrain(drainable, { now: clock(T0) }, silent);

    expect(report.filled).toBe(1);
  });
});

describe("isAuthorized", () => {
  it("refuses everything when no secret is configured", () => {
    // Fail-CLOSED. This is the only route that spends upstream quota without a
    // user asking, so an unset secret disables it rather than opening it.
    expect(isAuthorized("Bearer anything", undefined)).toBe(false);
    expect(isAuthorized(undefined, undefined)).toBe(false);
  });

  it("accepts the bearer token and refuses near-misses", () => {
    expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorized("Bearer s3cret ", "s3cret")).toBe(false);
    expect(isAuthorized("Bearer s3crets", "s3cret")).toBe(false);
    expect(isAuthorized("s3cret", "s3cret")).toBe(false);
    expect(isAuthorized("Basic s3cret", "s3cret")).toBe(false);
    expect(isAuthorized(undefined, "s3cret")).toBe(false);
  });
});
