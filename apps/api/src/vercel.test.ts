import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createHandler } from "./vercel.js";

/**
 * The entrypoint's own behaviour, with no database and no platform: the app is
 * built once per instance, the request reaches Fastify with its path intact,
 * and a boot that fails answers 503 without poisoning the instance.
 *
 * Driven through a real `node:http` server on purpose. `emit("request")` is the
 * whole mechanism, and it takes a real socket — `app.inject` would prove
 * something about Fastify rather than about the hand-off.
 */

const servers: Server[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function serve(handler: (req: never, res: never) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => void handler(req as never, res as never));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fakeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.get("/api/v1/echo/*", async (request) => ({ saw: request.url }));
  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}

describe("createHandler", () => {
  it("hands the request to Fastify with the original path and query intact", async () => {
    // The property the rewrite exists to preserve (VERCEL-ALL-IN-SCOPE §3.1):
    // a routed path collapsed anywhere in this chain would 404 every real route.
    const base = await serve(
      createHandler(async () => {
        const app = fakeApp();
        await app.ready();
        return { app };
      }),
    );

    const response = await fetch(`${base}/api/v1/echo/deep/path?q=1`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saw: "/api/v1/echo/deep/path?q=1" });
  });

  it("builds the app once across requests, and once across concurrent ones", async () => {
    // The reason the pool and the Redis client survive a warm invocation. A
    // per-request build would open a pool per request against a pooler sized
    // for one or two connections per instance.
    let builds = 0;
    const base = await serve(
      createHandler(async () => {
        builds += 1;
        const app = fakeApp();
        await app.ready();
        return { app };
      }),
    );

    await Promise.all([fetch(`${base}/healthz`), fetch(`${base}/healthz`)]);
    await fetch(`${base}/healthz`);

    expect(builds).toBe(1);
  });

  it("answers 503 when boot fails, and builds again on the next request", async () => {
    // Postgres unreachable and a paused Supabase project are both transient,
    // and an instance is reused for hours — so a first failure must not decide
    // the rest of its life.
    let attempts = 0;
    const base = await serve(
      createHandler(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("DATABASE_URL is unreachable");
        const app = fakeApp();
        await app.ready();
        return { app };
      }),
    );

    const failed = await fetch(`${base}/healthz`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ status: "unavailable" });

    const recovered = await fetch(`${base}/healthz`);
    expect(recovered.status).toBe(200);
    expect(attempts).toBe(2);
  });
});
