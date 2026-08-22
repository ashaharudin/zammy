import type { IncomingMessage, ServerResponse } from "node:http";
import { send } from "@vercel/queue";

/**
 * Spike question 2's producer. Publishes one message with the two options
 * VERCEL-ALL-IN-SCOPE §3.2 depends on:
 *
 *   - `idempotencyKey` — what replaces BullMQ's content-addressed `jobId`
 *     (`ingestJobId`). Billed at 2x the operation, which is the price of dedup.
 *   - `retentionSeconds: 300` — the §0 decision that the dedup window match
 *     `STALE_PENDING_MS` rather than the 24-hour default, so a failed run's
 *     segment can be re-enqueued in five minutes instead of tomorrow.
 *
 * A `DuplicateMessageError` on the second identical call is the PASS condition
 * for dedup, not a failure.
 */
export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const key = url.searchParams.get("key") ?? "spike-1";

  try {
    const { messageId } = await send(
      "spike-ingest",
      { kind: "segment", key, at: new Date().toISOString() },
      { idempotencyKey: key, retentionSeconds: 300 },
    );
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ published: messageId, idempotencyKey: key }));
  } catch (error) {
    // Name the class: `UnauthorizedError` here is the answer to spike question
    // 5 (is Queues available on Hobby at all), and it is the one failure that
    // is a finding rather than a bug.
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.constructor.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
