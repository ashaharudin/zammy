import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createStorylineHandler } from "./vercel-storyline.js";

/**
 * The HTTP glue around `renderStorylinePage`: boot once per instance, forget a
 * failed boot, and turn whatever the render returns into a real response.
 * `render-storyline.test.ts` already drives the render itself against a real
 * database — this file is `vercel.test.ts`'s own shape applied to the
 * storyline entrypoint, and stays deliberately ignorant of Postgres: a request
 * for a path this function rejects before ever touching `deps.db`
 * (`extractStorylineId` returns `null`) exercises the glue with no database at
 * all, and a `db` that throws on first touch exercises the request-time 500
 * without needing a real one to fail.
 */

const TEMPLATE = `<html><head><title>t</title></head><body><div id="root"></div></body></html>`;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: (req: never, res: never) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => void handler(req as never, res as never));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A `db` that throws the moment anything TOUCHES it (not when it is merely
 * held) — enough to exercise the request-time error path without a real
 * Postgres connection, and without failing BOOT itself, which only holds this
 * value and never calls into it. */
function throwingDb(): never {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error("render harness: the storyline handler reached the database");
      },
    },
  ) as never;
}

describe("createStorylineHandler", () => {
  it("answers 503 when boot fails, and builds again on the next request", async () => {
    let attempts = 0;
    const base = await serve(
      createStorylineHandler(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("DATABASE_URL is unreachable");
        return {
          deps: {
            db: throwingDb(),
            now: () => new Date(),
            config: { grouping: { timeZone: "UTC" } },
          },
          template: TEMPLATE,
        };
      }),
    );

    const failed = await fetch(`${base}/storyline/x`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ status: "unavailable" });
    expect(attempts).toBe(1);

    // A path `extractStorylineId` refuses outright never reaches `deps.db`, so
    // the second (successful) boot answers its ordinary 404 rather than the
    // request-time 500 the throwing db would otherwise produce.
    const recovered = await fetch(`${base}/storyline/not-a-uuid`);
    expect(recovered.status).toBe(404);
    expect(attempts).toBe(2);
  });

  it("builds once per instance, across concurrent requests", async () => {
    let builds = 0;
    const base = await serve(
      createStorylineHandler(async () => {
        builds += 1;
        return {
          deps: {
            db: throwingDb(),
            now: () => new Date(),
            config: { grouping: { timeZone: "UTC" } },
          },
          template: TEMPLATE,
        };
      }),
    );

    await Promise.all([
      fetch(`${base}/storyline/not-a-uuid`),
      fetch(`${base}/storyline/not-a-uuid`),
    ]);
    await fetch(`${base}/storyline/not-a-uuid`);

    expect(builds).toBe(1);
  });

  it("answers 500, not a hang or a crash, when the render throws mid-request", async () => {
    const base = await serve(
      createStorylineHandler(async () => ({
        deps: {
          db: throwingDb(),
          now: () => new Date(),
          config: { grouping: { timeZone: "UTC" } },
        },
        template: TEMPLATE,
      })),
    );

    // A real-shaped UUID reaches `resolveStoryline(deps.db, id)`, and this
    // `db` throws the moment anything touches it.
    const response = await fetch(`${base}/storyline/0192f3c4-5d6e-7f80-9123-456789abcdef/x`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "internal error" } });
  });

  it("serves a well-formed 404 page for a path naming no storyline", async () => {
    const base = await serve(
      createStorylineHandler(async () => ({
        deps: {
          db: throwingDb(),
          now: () => new Date(),
          config: { grouping: { timeZone: "UTC" } },
        },
        template: TEMPLATE,
      })),
    );

    const response = await fetch(`${base}/storyline/not-a-uuid`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Storyline not found");
  });
});
