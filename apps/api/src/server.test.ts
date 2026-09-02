import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import pg from "pg";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "@zammy/config";
import { createDb, migrateToLatest } from "@zammy/storage";
import { TimelinePage } from "@zammy/shared";
import { RATE_LIMIT_NAMESPACE, buildApp, type App } from "./server.js";

/**
 * The walking skeleton, end to end: real config loading, real Postgres, real
 * Redis, fixture upstream, one process — exactly what `pnpm dev` boots. This
 * is the wiring test; behaviour lives in the planner and route suites.
 */

const PG_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://zammy:zammy@localhost:5432/zammy";
const FIXTURES_DIR = new URL("../../../fixtures/", import.meta.url).pathname;
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

/**
 * The per-IP rate-limit bucket, which is Redis-held now (§3.5) and therefore
 * outlives the process that filled it. That is the point in production and a
 * nuisance here: the limit test below deliberately exhausts it, and without a
 * reset every /api/v1/* assertion in this file would 429 for the rest of the
 * minute — including on the next run.
 *
 * Its own client rather than the app's, because `buildServices` connects
 * lazily with `enableOfflineQueue: false`: the app's client is not writable
 * yet at the moment `buildApp` returns, which is the same reason a cold
 * instance's first `/readyz` reads `degraded`.
 */
const housekeeping = new Redis(REDIS_URL);
const clearRateLimitBucket = (): Promise<number> =>
  housekeeping.del(`${RATE_LIMIT_NAMESPACE}127.0.0.1`);

/** The three passes a scheduler points at (`deploy/vercel/supabase-cron.sql`). */
const SCHEDULED = ["retention", "storylines", "summaries"];

describe("buildApp", () => {
  let dbName: string;
  let built: App;
  let config: Config;

  beforeAll(async () => {
    dbName = `zammy_app_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${dbName}`;

    const migrator = createDb(url.toString());
    await migrateToLatest(migrator);
    await migrator.destroy();

    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: url.toString(),
      REDIS_URL,
      CURRENTS_MODE: "fixture",
      CURRENTS_USER_AGENT: "zammy-tests/0.1",
      FIXTURES_DIR,
    });
    built = await buildApp(config);
    await built.app.ready();
    await clearRateLimitBucket();
  });

  afterAll(async () => {
    await built.close();
    await housekeeping.quit();
    const cleanup = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });

  it("serves health and a real timeline from one wired process", async () => {
    const health = await built.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);

    // Distinctive keywords so this run cannot hit a previous run's page cache
    // (fingerprints are deterministic by design, and Redis outlives the test).
    const q = encodeURIComponent(`climate ${randomUUID().slice(0, 8)}`);

    /**
     * The window is RELATIVE to now, because this is the ONE suite that runs
     * the real wiring, and the real wiring's clock is `() => new Date()`
     * (`wiring.ts:379`). Nothing here can pin it.
     *
     * A hardcoded `2026-08-01 → 2026-08-06` was therefore measured against a
     * horizon that moves: `subtractCoverage` clamps the requested window to
     * `planHorizon(now, 30)` before diffing, so once the window sank entirely
     * below `now − 30d` it clamped to empty, nothing was planned, nothing was
     * fetched, and `topic.coverage` came back null — a wiring test failing on
     * the calendar rather than on the wiring. It had four days left when this
     * was written: `planHorizon` reaches the window's `to` — 2026-08-06, plus
     * 30 days, less the 15-minute plan slack — at 2026-09-04T23:45Z.
     *
     * 6 → 1 days back is wrong in no direction at once: well inside the 30-day
     * lookback so nothing clamps, and a 5-day span well under the 7-day
     * per-call range ceiling so nothing slices. The dates are not load-bearing
     * beyond that — the random second keyword matches nothing in the fixture
     * corpus whatever window it is asked over, which is what makes an empty,
     * fully-covered timeline the assertion below.
     */
    const DAY_MS = 86_400_000;
    const now = Date.now();
    const from = new Date(now - 6 * DAY_MS).toISOString();
    const to = new Date(now - 1 * DAY_MS).toISOString();
    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/timeline?q=${q}&from=${from}&to=${to}`,
    });

    expect(response.statusCode).toBe(200);
    const body = TimelinePage.parse(response.json());
    // The random second term matches nothing — a valid, empty, fully-covered
    // timeline is the honest answer, and coverage means it was truly planned.
    expect(body.items).toEqual([]);
    expect(body.meta.ingest.state).toBe("complete");
    expect(body.topic.coverage).not.toBeNull();
  });

  it("rate-limits /api/v1/* per IP but never the operational endpoints (§9.4)", async () => {
    // Novel-fingerprint spam is the §9.4 attack: each junk keyword mints a
    // topic and can trigger upstream spend. The limiter must sit in front of
    // /api/v1/* — and ONLY there, or the ALB health check would take the API
    // out of rotation exactly when someone hammers it.
    let limited = false;
    for (let i = 0; i < 100 && !limited; i += 1) {
      const response = await built.app.inject({ method: "GET", url: "/api/v1/reference" });
      limited = response.statusCode === 429;
    }
    expect(limited).toBe(true);

    expect((await built.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);

    // And the counter is SHARED, which is the whole of §3.5: elastic instances
    // made the in-process ceiling RATE_LIMIT_PER_MINUTE × an unbounded number,
    // and Hobby has no WAF to put the limit anywhere else. A second app on the
    // same Redis inherits the exhausted bucket rather than handing the caller a
    // fresh allowance.
    const second = await buildApp(config, { consumer: false });
    try {
      // Wait for the CLIENT, not the clock. `buildServices` fires
      // `redis.connect()` without awaiting it and the client does not queue
      // commands offline, so a request that arrives first takes the limiter's
      // `skipOnError` path and passes with the full allowance — the same
      // fail-open that a cold Vercel instance shows in production, and here it
      // would read as "the bucket was not shared" rather than as what it is.
      for (let i = 0; i < 100 && second.redis.status !== "ready"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(second.redis.status).toBe("ready");

      const response = await second.app.inject({ method: "GET", url: "/api/v1/reference" });
      expect(response.statusCode).toBe(429);
    } finally {
      await second.close();
      await clearRateLimitBucket();
    }
  });

  it("reports whether the chores ran, without letting them change `status`", async () => {
    // The gap ADR-0015 left. Hobby retains logs for an hour and the chores route
    // answers 202 before the pass starts, so `chore_runs` is the only durable
    // record — and `/readyz` reported Postgres, Redis and upstream quota while
    // saying nothing at all about whether last night ran. This is the one URL a
    // person already curls after a deploy.
    const response = await built.app.inject({ method: "GET", url: "/readyz" });
    const body = response.json() as {
      status: string;
      checks: { postgres: { ok: boolean }; redis: { ok: boolean } };
      upstream: { dailyRemaining: number };
      chores: { ok: boolean; overdue: string[]; stalled: string[]; lastRunAt: string | null };
    };

    // ADDITIVE, and asserted as such: `deploy/vercel/deploy.sh` and
    // `provision-production.sh` both document `status` as a statement about
    // Postgres and Redis — `ready`, `degraded`, `unready` and nothing else.
    // This database has no chore runs at all, so every scheduled pass is
    // overdue, and the probe still reads `ready` with a 200. An overdue chore is
    // not a reason to call the API unable to serve, and a probe that went red
    // overnight would train whoever reads it to ignore the colour.
    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.checks.postgres.ok).toBe(true);
    expect(typeof body.upstream.dailyRemaining).toBe("number");

    expect(body.chores.ok).toBe(false);
    expect(body.chores.stalled).toEqual([]);
    expect(body.chores.lastRunAt).toBeNull();
    // The clock is the real one here, so which of the three is overdue depends
    // on what time the suite runs — the exact list is `chore-status.test.ts`'s,
    // against a fixed instant. What holds at every hour is that something is
    // late in a table with no rows, and that only a SCHEDULED pass can be: the
    // other six are steps of the composite night, addressable for a re-run and
    // scheduled nowhere, so reporting them would mean nine overdue passes every
    // night of a perfectly healthy deployment.
    expect(body.chores.overdue.length).toBeGreaterThan(0);
    expect(body.chores.overdue.filter((pass) => !SCHEDULED.includes(pass))).toEqual([]);
    // And nothing an unauthenticated caller has no business with: the digest
    // carries pass names, a flag and one timestamp. Run ids, sources, error
    // strings and model-call counts are behind the bearer check on
    // `/api/chores?status`.
    expect(Object.keys(body.chores).sort()).toEqual([
      "lastRunAt",
      "ok",
      "overdue",
      "stalled",
    ]);
  });

  it("starts the §9.1 consumer by default and not at all when told not to", async () => {
    // The seam the Vercel request function needs (VERCEL-ALL-IN-SCOPE §3.1):
    // one process that serves AND drains is right for Compose, and wrong for an
    // instance that suspends between requests. Both halves are asserted here
    // because the default is the load-bearing one — a `consumer` option that
    // silently defaulted to false would leave Compose enqueueing into a queue
    // nothing reads, and every read would still return 200.
    expect(built.consumer).toBe(true);

    const requestOnly = await buildApp(config, { consumer: false });
    try {
      expect(requestOnly.consumer).toBe(false);
      // Still a whole HTTP surface: the publish side, the pool and the Redis
      // client are all built. Only the worker is absent.
      const health = await requestOnly.app.inject({ method: "GET", url: "/readyz" });
      expect(health.statusCode).toBe(200);
    } finally {
      await requestOnly.close();
    }
  });

  it("releases the connections it already opened when boot fails", async () => {
    // A failed boot used to cost nothing, because the only caller was index.ts
    // and it exits the process. The Vercel entrypoint retries on the NEXT
    // request instead (vercel.ts), so anything this attempt left open leaks
    // once per request, for the life of an instance that lives for hours. The
    // failure reproduced here is the plausible one rather than a contrived one:
    // fixture mode with `fixtures/` not where the deployment put it, which is
    // the one Phase 1 unknown only a deploy can settle (VERCEL-ALL-IN-SCOPE §9).
    //
    // Redis is what gets asserted because it is the only thing actually dialled
    // by then — the pg pool is lazy and has yet to open a socket. Standing in
    // for it with a bare TCP server is what makes "did that connection go away?"
    // answerable at all; `resume()` is not optional, because a paused socket
    // never emits `end`, so the server would keep counting a connection the
    // client had already closed and the assertion would pass without running.
    const open: Socket[] = [];
    const sockets = createServer((socket) => {
      open.push(socket);
      socket.resume();
    });
    await new Promise<void>((resolve) => sockets.listen(0, "127.0.0.1", resolve));
    const port = (sockets.address() as { port: number }).port;

    try {
      const doomed = loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        DATABASE_URL: config.DATABASE_URL,
        REDIS_URL: `redis://127.0.0.1:${port}`,
        CURRENTS_MODE: "fixture",
        CURRENTS_USER_AGENT: "zammy-tests/0.1",
        FIXTURES_DIR: `${FIXTURES_DIR}does-not-exist/`,
      });

      await expect(buildApp(doomed, { consumer: false })).rejects.toThrow(/No fixtures loaded/);
      await expect.poll(() => connectionCount(sockets), { timeout: 5_000 }).toBe(0);
    } finally {
      // Before close(), which otherwise waits out a leak rather than reporting
      // it — a regression here should fail the assertion, not hang the suite.
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => sockets.close(resolve));
    }
  }, 20_000);

});

function connectionCount(server: Server): Promise<number> {
  return new Promise((resolve) => server.getConnections((_error, count) => resolve(count)));
}
