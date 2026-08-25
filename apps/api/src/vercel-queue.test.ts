import { describe, expect, it, vi } from "vitest";
import { createMessageHandler, type DeliveryMetadata } from "./vercel-queue.js";
import { MAX_INGEST_DELIVERIES } from "./ingest-queue-vercel.js";
import type { IngestJob, SegmentJob } from "./ingest-queue.js";

/**
 * The push-mode consumer's own behaviour, with no platform and no database.
 *
 * Everything asserted here is a way the queue could go wrong SILENTLY, which is
 * what makes it worth pinning: a job that runs but is never settled leaves the
 * topic reading `in_progress` until the five-minute stale prune; a job that is
 * settled before it runs turns at-least-once into at-most-once; and a payload
 * that cannot be parsed spins until retention expires unless something decides
 * to drop it.
 */

const segment: SegmentJob = {
  fingerprint: "f".repeat(64),
  from: "2026-08-08T00:00:00.000Z",
  to: "2026-08-09T00:00:00.000Z",
  startPage: 1,
};

const delivery = (over: Partial<DeliveryMetadata> = {}): DeliveryMetadata => ({
  messageId: "msg-1",
  deliveryCount: 1,
  ...over,
});

const silent = { info: () => {}, warn: () => {} };

function drainable(dispatch: (job: IngestJob) => Promise<void>) {
  const settled: IngestJob[] = [];
  return {
    settled,
    drainable: {
      queue: { settle: async (job: IngestJob) => void settled.push(job) },
      dispatch,
    },
  };
}

describe("createMessageHandler", () => {
  it("dispatches the job and settles it once", async () => {
    const seen: IngestJob[] = [];
    const { settled, drainable: d } = drainable(async (job) => void seen.push(job));

    await createMessageHandler(d, silent)(segment, delivery());

    expect(seen).toEqual([segment]);
    expect(settled).toEqual([segment]);
  });

  it("settles only after the work is done, never before", async () => {
    // The property that keeps at-least-once honest. If the settle happened
    // first, a handler that then threw would leave a gap nothing is tracking
    // and nothing is going to fill.
    const order: string[] = [];
    const { drainable: d } = drainable(async () => {
      order.push("dispatch");
    });
    d.queue.settle = async () => void order.push("settle");

    await createMessageHandler(d, silent)(segment, delivery());

    expect(order).toEqual(["dispatch", "settle"]);
  });

  it("rethrows while retries remain, so the platform redelivers", async () => {
    const { settled, drainable: d } = drainable(async () => {
      throw new Error("transient upstream failure");
    });
    const handle = createMessageHandler(d, silent);

    await expect(handle(segment, delivery({ deliveryCount: 1 }))).rejects.toThrow(
      "transient upstream failure",
    );
    // Still outstanding: a job that will be attempted again is pending work.
    expect(settled).toEqual([]);
  });

  it("settles and gives up on the last delivery rather than spinning", async () => {
    // There is no dead-letter queue. Swallowing the error acknowledges the
    // message; settling is what stops the topic reading as warming. The gap the
    // job named is re-planned by the next reader who finds it unfilled.
    const { settled, drainable: d } = drainable(async () => {
      throw new Error("permanently broken");
    });
    const warn = vi.fn();

    await expect(
      createMessageHandler(d, { info: () => {}, warn })(
        segment,
        delivery({ deliveryCount: MAX_INGEST_DELIVERIES }),
      ),
    ).resolves.toBeUndefined();

    expect(settled).toEqual([segment]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops a payload it cannot read instead of retrying it forever", async () => {
    const { settled, drainable: d } = drainable(async () => {
      throw new Error("should never be dispatched");
    });
    const warn = vi.fn();

    await expect(
      createMessageHandler(d, { info: () => {}, warn })({ nonsense: true }, delivery()),
    ).resolves.toBeUndefined();

    // Nothing to settle: an unparseable payload has no job identity, so there
    // is no pending entry it could correspond to.
    expect(settled).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("routes a sample to the same dispatch a segment takes", async () => {
    // One mapping, in `ingestDispatch`. Two copies of that discriminant is one
    // place for a sample to start being processed as a segment on exactly one
    // of the two consumers.
    const seen: IngestJob[] = [];
    const { settled, drainable: d } = drainable(async (job) => void seen.push(job));

    await createMessageHandler(d, silent)({ kind: "sample", language: "en" }, delivery());

    expect(seen).toEqual([{ kind: "sample", language: "en" }]);
    expect(settled).toEqual([{ kind: "sample", language: "en" }]);
  });
});
