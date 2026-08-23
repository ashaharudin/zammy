import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify from "fastify";

/**
 * Spike question 1, ANSWERED 2026-08-22: `api/[...path].ts` is not a catch-all.
 * Vercel's bare `api/` directory parsed the filename as ONE dynamic segment
 * literally named `...path` — `/api/healthz` and `/api/v1` reached this function,
 * `/api/v1/echo` and anything deeper never did, and Vercel answered NOT_FOUND
 * itself rather than letting Fastify's own handler run. Since zammy's routes are
 * `/api/v1/timeline` and friends, the layout as designed would have 404ed every
 * one of them.
 *
 * The fix is a rewrite rather than a filename (`vercel.json`), and it preserves
 * what §3.1 actually needs: a rewrite leaves the ORIGINAL path visible, measured
 * — `/healthz` rewritten to `/api/healthz` arrived as `/healthz`. So Fastify
 * still routes on what the browser asked for, and one project keeps one origin.
 *
 * VERCEL-ALL-IN-SCOPE §3.1 wants `api/[...path].ts` handing the request to
 * Fastify with `app.server.emit("request", req, res)`, so the router matches on
 * the path the browser asked for. A rewrite that collapses `/api/v1/timeline`
 * to `/api` would make every route 404 and the failure would look like a
 * routing bug rather than a platform one — so the echo route below reports
 * exactly what Fastify received.
 *
 * The module-scope singleton is the other half of §3.1: build once per instance,
 * not once per request, so the pool and the clients survive a warm invocation.
 */
const booted = (async () => {
  const startedAt = Date.now();
  const app = Fastify({ logger: false });

  // Registered under BOTH paths on purpose. `/healthz` lives outside `/api`,
  // so it can only reach this function through a rewrite (§3.1's "two
  // rewrites") — and a rewrite changes the path Fastify sees. Serving both
  // means the probe answers either way, and the echo route reports which one
  // actually arrived.
  for (const path of ["/healthz", "/readyz", "/api/healthz", "/api/readyz"]) {
    app.get(path, async (request) => ({ ok: true, fastifySaw: request.url }));
  }

  app.get("/api/v1/echo/*", async (request) => ({
    // If this is not the full path the browser requested, the one-project
    // layout is out and §1.1's fallback (two projects and a rewrite) is in.
    fastifySaw: request.url,
    method: request.method,
    // §3.1's other watch item: with no proxy in front, `TRUSTED_PROXY_HOPS`
    // must be whatever makes `request.ip` the client rather than Vercel's edge.
    ip: request.ip,
    forwardedFor: request.headers["x-forwarded-for"] ?? null,
  }));

  app.get("/api/v1/coldstart", async () => ({
    // Wall clock from module evaluation to `ready()`, which is the part of a
    // cold start the application controls. Compare against the ~360 ms measured
    // locally in VERCEL-PHASE-0-FINDINGS §7.
    buildMs: Date.now() - startedAt,
    region: process.env.VERCEL_REGION ?? null,
    // Non-null on a warm instance that has already served a request.
    warm: warmSince !== null,
  }));

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({ notFound: request.url });
  });

  await app.ready();
  return app;
})();

let warmSince: number | null = null;

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const app = await booted;
  warmSince ??= Date.now();
  app.server.emit("request", request, response);
}
