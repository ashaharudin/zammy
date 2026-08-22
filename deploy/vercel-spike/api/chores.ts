import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";

/**
 * Spike question 3: does 202-then-`waitUntil` survive the function returning,
 * and does the 202 arrive inside pg_net's timeout from cold?
 *
 * The shape VERCEL-ALL-IN-SCOPE §3.3 specifies: bearer-check `CRON_SECRET`,
 * return immediately, do the work after. What this proves is only the mechanism
 * — that background work outlives the response and that `maxDuration` bounds
 * the background half rather than the request half. The real route's work is a
 * chore pass and a `chore_runs` row.
 *
 * `SPIKE_SLEEP_MS` past `maxDuration` is the interesting run: the log should
 * show the work being cut off, not the response failing.
 */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  const secret = process.env.CRON_SECRET;
  const authorized =
    // Vercel Cron sends the secret as a bearer token; Supabase Cron will too.
    request.headers.authorization === `Bearer ${secret}` ||
    // Vercel's own scheduler also identifies itself, which is worth observing
    // separately from the shared secret.
    typeof request.headers["x-vercel-cron-schedule"] === "string";
  if (secret && !authorized) {
    response.writeHead(401).end("unauthorized");
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const pass = url.searchParams.get("pass") ?? "none";
  const sleepMs = Number(url.searchParams.get("sleep") ?? process.env.SPIKE_SLEEP_MS ?? 5000);
  const startedAt = Date.now();

  waitUntil(
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      console.log(
        JSON.stringify({
          spike: "chore finished after the response",
          pass,
          requestedSleepMs: sleepMs,
          actualMs: Date.now() - startedAt,
          cronSchedule: request.headers["x-vercel-cron-schedule"] ?? null,
        }),
      );
    })(),
  );

  response.writeHead(202, { "content-type": "application/json" });
  response.end(JSON.stringify({ accepted: pass, sleepMs, region: process.env.VERCEL_REGION }));
}
