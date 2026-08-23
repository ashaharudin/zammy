import { QueueClient } from "@vercel/queue";

/**
 * Spike question 2's consumer, and the file the whole plan turns on: a
 * push-mode Vercel Queues consumer declared from `vercel.json` on a **bare
 * `api/` function in a Vite project**. Every documented example is Next.js App
 * Router; the docs steer Vite projects toward Nitro instead. If this does not
 * fire, VERCEL-ALL-IN-SCOPE §1.1's fallback layout is what ships.
 *
 * `handleNodeCallback`, not `handleCallback`: the top-level `handleCallback`
 * returns a Web-standard `POST` handler, and an `api/` directory function on
 * the Node runtime is handed `(req, res)`. `handleNodeCallback` is the
 * `(req, res)` form and exists only on a `QueueClient` instance.
 *
 * There is nowhere to write, so the proof is the log line — read it with
 * `vercel logs <deployment>`. Hobby keeps an hour of them, which is exactly
 * the constraint that makes §3.3's durable `chore_runs` record non-optional in
 * the real build.
 */
const queue = new QueueClient();

export default queue.handleNodeCallback(
  async (message, metadata) => {
    console.log(
      JSON.stringify({
        spike: "consumer fired",
        message,
        messageId: metadata.messageId,
        deliveryCount: metadata.deliveryCount,
        topicName: metadata.topicName,
        consumerGroup: metadata.consumerGroup,
        expiresAt: metadata.expiresAt,
      }),
    );

    // Throw on demand to watch redelivery: `deliveryCount` should climb, and
    // the `retry` handler below should acknowledge it away rather than let it
    // spin (there is no DLQ — §3.2).
    if ((message as { key?: string }).key === "poison") {
      throw new Error("deliberate failure, to observe redelivery");
    }
  },
  {
    retry: (_error, metadata) => {
      if (metadata.deliveryCount > 3) return { acknowledge: true };
      return { afterSeconds: 5 };
    },
  },
);
