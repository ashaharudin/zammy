import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@zammy/config";
import { createDb, migrateToLatest } from "@zammy/storage";
import { TimelinePage } from "@zammy/shared";
import { buildApp, type App } from "./server.js";

/**
 * The walking skeleton, end to end: real config loading, real Postgres, real
 * Redis, fixture upstream, one process — exactly what `pnpm dev` boots. This
 * is the wiring test; behaviour lives in the planner and route suites.
 */

const PG_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://zammy:zammy@localhost:5432/zammy";
const FIXTURES_DIR = new URL("../../../fixtures/", import.meta.url).pathname;

describe("buildApp", () => {
  let dbName: string;
  let built: App;

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

    built = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        DATABASE_URL: url.toString(),
        REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379",
        CURRENTS_MODE: "fixture",
        CURRENTS_USER_AGENT: "zammy-tests/0.1",
        FIXTURES_DIR,
      }),
    );
    await built.app.ready();
  });

  afterAll(async () => {
    await built.close();
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
    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/timeline?q=${q}&from=2026-08-01T00:00:00Z&to=2026-08-06T00:00:00Z`,
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
    expect((await built.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
  });

});
