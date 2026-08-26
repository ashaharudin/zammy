import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createHandler, type Pingable } from "./keepalive.js";

/**
 * The Supabase free-tier pause guard (VERCEL-ALL-IN-SCOPE §3.3).
 *
 * Three lines of behaviour and one property that is the whole point of the file:
 * **it answers synchronously.** The chores route returns 202 before its work so
 * the scheduler's timeout cannot kill the night; this route must do the
 * opposite, because a ping whose result is not in the response cannot tell a
 * paused project from a healthy one.
 */

const SECRET = "s3cret";

const request = (headers: Record<string, string> = {}): IncomingMessage =>
  ({ method: "POST", url: "/api/keepalive", headers }) as unknown as IncomingMessage;

function capture(): { res: ServerResponse; seen: { status: number | null; body: unknown } } {
  const seen: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    writeHead(status: number) {
      seen.status = status;
      return this;
    },
    end(payload: string) {
      seen.body = JSON.parse(payload);
      return this;
    },
  } as unknown as ServerResponse;
  return { res, seen };
}

const pinger = (ping: () => Promise<void>): Pingable => ({ ping });

describe("the keep-alive route", () => {
  it("pings and says so", async () => {
    let pings = 0;
    const handler = createHandler(
      async () =>
        pinger(async () => {
          pings += 1;
        }),
      () => SECRET,
    );
    const { res, seen } = capture();

    await handler(request({ authorization: `Bearer ${SECRET}` }), res);

    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ status: "awake" });
    // The result is IN the response, not deferred. A 202 here would make a
    // paused project and a healthy one produce identical answers, which is the
    // one outcome this route may not have.
    expect(pings).toBe(1);
  });

  it("answers 503 when the database does not", async () => {
    // 503 and not 500: a statement about a dependency rather than about this
    // route, and the status a scheduler's own log makes legible without anyone
    // reading ours.
    const handler = createHandler(
      async () =>
        pinger(async () => {
          throw new Error("connection terminated");
        }),
      () => SECRET,
    );
    const { res, seen } = capture();

    await handler(request({ authorization: `Bearer ${SECRET}` }), res);

    expect(seen.status).toBe(503);
    expect(seen.body).toEqual({ status: "unavailable" });
  });

  it("answers 503 when it cannot boot at all", async () => {
    const handler = createHandler(async () => {
      throw new Error("no DATABASE_URL");
    }, () => SECRET);
    const { res, seen } = capture();

    await handler(request({ authorization: `Bearer ${SECRET}` }), res);

    expect(seen.status).toBe(503);
  });

  it("refuses an unauthorized caller WITHOUT booting", async () => {
    // It opens a database connection, which is the only thing on this deployment
    // an anonymous caller could make happen repeatedly for free.
    let boots = 0;
    const handler = createHandler(
      async () => {
        boots += 1;
        return pinger(async () => {});
      },
      () => SECRET,
    );
    const { res, seen } = capture();

    await handler(request({ authorization: "Bearer wrong" }), res);

    expect(seen.status).toBe(401);
    expect(boots).toBe(0);
  });

  it("is disabled, not open, when CRON_SECRET is unset", async () => {
    // The same fail-closed rule as the chores and the drain — and the cost is
    // worth being explicit about: a project with no CRON_SECRET has no pause
    // guard, and will eventually pause.
    const handler = createHandler(
      async () => pinger(async () => {}),
      () => undefined,
    );
    const { res, seen } = capture();

    await handler(request({ authorization: "Bearer " }), res);

    expect(seen.status).toBe(401);
  });
});
