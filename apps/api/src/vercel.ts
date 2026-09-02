import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { bootOnce, configOrExplain } from "./cron-route.js";
import { buildApp } from "./server.js";

/**
 * The Vercel request entrypoint (VERCEL-ALL-IN-SCOPE §3.1). `index.ts` remains
 * the Compose entrypoint and is untouched: `listen()` plus the SIGTERM drain
 * are still exactly right there, and nothing about local development changes.
 *
 * Three properties this file exists to hold, all of them load-bearing:
 *
 *   1. **Build once per instance, not once per request.** The singleton below is
 *      what makes the Postgres pool, the Redis client and the fixture store
 *      survive a warm invocation. Rebuilding per request would open a pool per
 *      request against a pooler sized for 1–2 connections per instance.
 *   2. **No consumer.** `{ consumer: false }` — a BullMQ Worker in a function
 *      that suspends between requests is the failure the whole plan is arranged
 *      to avoid (`BuildAppOptions.consumer`).
 *   3. **Fastify routes on the path the browser asked for.** The request is
 *      handed to the server as-is via `emit("request")`, so `/api/v1/timeline`
 *      is what `find-my-way` matches. The rewrite in `vercel.json` is what gets
 *      it here, and a rewrite preserves the original path — measured on the
 *      spike, because the `api/[...path].ts` filename the scope doc first
 *      specified is NOT a catch-all and 404ed everything deeper than one
 *      segment.
 *
 * Note what this file does not do: no auth, no routing, no error mapping. Those
 * belong to the app, and an entrypoint that grew any of them would be a second
 * place to look when production and Compose disagree.
 *
 * **That is also why it takes only two things from `cron-route.ts`** — the
 * boot-once it had its own copy of, and the `ConfigError` wrapping all five
 * entrypoints share — and not `createCronRoute`. This is the public surface;
 * its auth is the app's. `cron-routes.test.ts` asserts the exemption rather
 * than leaving it as this paragraph.
 */

/** The half of `App` an entrypoint actually needs. Narrow so it can be faked. */
interface Servable {
  app: FastifyInstance;
}

export type VercelHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

/**
 * The handler, given something that builds an app. Parameterized for the tests:
 * the singleton, the 503 and the retry-after-failure are the behaviour worth
 * pinning, and none of it should need a database to assert.
 */
export function createHandler(boot: () => Promise<Servable>): VercelHandler {
  // Once per instance, and a failed boot forgotten so the next request builds
  // again — which matters because the things that fail at boot here (Postgres
  // reachable, Supabase awake) are transient and an instance is reused for
  // hours. `cron-route.ts` has the argument for both halves; this file had the
  // first of five copies of it.
  const ready = bootOnce(boot);

  return async (request, response) => {
    let servable: Servable;
    try {
      servable = await ready();
    } catch (error) {
      // 503, not 500: the app never came up, so this instance served nothing —
      // and the platform's log is the only place the reason survives on Hobby
      // (VERCEL-ALL-IN-SCOPE §7, one-hour retention).
      const message = error instanceof Error ? error.message : String(error);
      console.error("boot failed:", message);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "unavailable" }));
      return;
    }

    // The standard Fastify-on-serverless hand-off. Not `inject`: this is a real
    // socket, and the response must stream back through it.
    servable.app.server.emit("request", request, response);
  };
}

/**
 * Config is loaded here rather than at module scope so a bad deploy fails with
 * a 503 and a listed reason on every request, instead of a module that throws
 * during import and reports whatever the platform makes of that.
 */
async function bootFromEnvironment(): Promise<Servable> {
  // `configOrExplain` prints the same message `index.ts` prints, for the same
  // reason: every problem at once, not one 401 per missing variable.
  const config = configOrExplain();

  const built = await buildApp(config, { consumer: false });
  // `emit("request")` bypasses Fastify's own readiness gate, so this await is
  // the gate: plugins registered, routes compiled, before the first request.
  await built.app.ready();
  return built;
}

export default createHandler(bootFromEnvironment);
