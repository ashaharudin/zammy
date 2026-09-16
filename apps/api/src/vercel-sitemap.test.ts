import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSitemapHandler } from "./vercel-sitemap.js";
import { createReadHarness, type ReadTestHarness } from "./test-support.js";

/**
 * The HTTP glue around `buildSitemap`: boot once per instance, forget a failed
 * boot, and answer XML with a cacheable header. `render-sitemap.test.ts`
 * already drives `buildSitemap` itself in depth (what gets listed and why) —
 * this file is `vercel.test.ts`'s own shape applied to the sitemap
 * entrypoint, and uses a real (empty) database only because `buildSitemap`
 * reaches `readTrendingStorylines`' raw `sql` tag, which a hand-built fake
 * `db` cannot stand in for the way `render-storyline.test.ts`'s can — that one
 * short-circuits before touching `db` at all on the paths this file cares
 * about.
 */

let harness: ReadTestHarness;
const servers: Server[] = [];

beforeAll(async () => {
  harness = await createReadHarness();
});

afterAll(async () => {
  await harness.teardown();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: (req: never, res: never) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => void handler(req as never, res as never));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fakeDeps() {
  return {
    db: harness.deps.db,
    now: () => new Date("2026-08-13T22:00:00.000Z"),
    defaultLanguage: "en",
    trending: { windowHours: 48, halfLifeHours: 8 },
  };
}

describe("createSitemapHandler", () => {
  it("answers 503 when boot fails, and builds again on the next request", async () => {
    let attempts = 0;
    const base = await serve(
      createSitemapHandler(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("DATABASE_URL is unreachable");
        return fakeDeps();
      }),
    );

    const failed = await fetch(`${base}/sitemap.xml`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ status: "unavailable" });

    const recovered = await fetch(`${base}/sitemap.xml`);
    expect(recovered.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("builds once per instance, across concurrent requests", async () => {
    let builds = 0;
    const base = await serve(
      createSitemapHandler(async () => {
        builds += 1;
        return fakeDeps();
      }),
    );

    await Promise.all([fetch(`${base}/sitemap.xml`), fetch(`${base}/sitemap.xml`)]);
    await fetch(`${base}/sitemap.xml`);

    expect(builds).toBe(1);
  });

  it("serves XML with a cacheable content-type and header, home URL included", async () => {
    const base = await serve(createSitemapHandler(async () => fakeDeps()));

    const response = await fetch(`${base}/sitemap.xml`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(response.headers.get("cache-control")).toContain("s-maxage=900");
    expect(await response.text()).toContain("<loc>https://www.zammy.info/</loc>");
  });

  it("answers 500, not a hang or a crash, when the render throws mid-request", async () => {
    const throwingDb = new Proxy(
      {},
      {
        get(): never {
          throw new Error("render harness: the sitemap handler reached the database");
        },
      },
    );
    const base = await serve(
      createSitemapHandler(async () => ({ ...fakeDeps(), db: throwingDb as never })),
    );

    const response = await fetch(`${base}/sitemap.xml`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "internal error" } });
  });
});
