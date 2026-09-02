import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigError } from "@zammy/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootOnce,
  configOrExplain,
  createCronRoute,
  isAuthorized,
  platformDefer,
  secretFromEnvironment,
  type CronRequest,
} from "./cron-route.js";

/**
 * The shape the five serverless entrypoints share, on its own.
 *
 * Every piece here was a copy in two to five files before this module existed,
 * and the pieces that had no test are the ones that mattered most: four of the
 * five `bootOnce`s were module-private and asserted nowhere, and the FORGET
 * half of boot-once is the half that decides whether a transient Postgres
 * failure costs one request or the whole life of an instance.
 *
 * `cron-routes.test.ts` holds the properties that are only true over the SET —
 * chiefly that an unset `CRON_SECRET` disables a route rather than opening it.
 * This file is the module.
 */

const request = (
  method: string,
  url = "/api/thing",
  headers: Record<string, string | string[]> = {},
): IncomingMessage => ({ method, url, headers }) as unknown as IncomingMessage;

function capture(): {
  res: ServerResponse;
  seen: { status: number | null; body: unknown; headers: unknown };
} {
  const seen: { status: number | null; body: unknown; headers: unknown } = {
    status: null,
    body: null,
    headers: null,
  };
  const res = {
    writeHead(status: number, headers: unknown) {
      seen.status = status;
      seen.headers = headers;
      return this;
    },
    end(payload: string) {
      seen.body = JSON.parse(payload);
      return this;
    },
  } as unknown as ServerResponse;
  return { res, seen };
}

const silent = { info: () => {}, warn: () => {} };

describe("isAuthorized", () => {
  it("refuses everything when no secret is configured", () => {
    // Fail-CLOSED, and it is a security property rather than a convenience:
    // these are the only surfaces that spend upstream quota, rewrite the
    // storyline graph or open a connection without a user asking, so an unset
    // secret disables them rather than opening them.
    expect(isAuthorized("Bearer anything", undefined)).toBe(false);
    expect(isAuthorized(undefined, undefined)).toBe(false);
    // The empty string is the one an operator produces by accident — a
    // `CRON_SECRET=` line, or an unset variable through a wrapper script — and
    // it must refuse rather than match a bare `Bearer `.
    expect(isAuthorized("Bearer ", "")).toBe(false);
  });

  it("accepts the bearer token and refuses near-misses", () => {
    expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorized("Bearer s3cret ", "s3cret")).toBe(false);
    expect(isAuthorized("Bearer s3crets", "s3cret")).toBe(false);
    expect(isAuthorized("s3cret", "s3cret")).toBe(false);
    expect(isAuthorized("Basic s3cret", "s3cret")).toBe(false);
    expect(isAuthorized(undefined, "s3cret")).toBe(false);
  });
});

describe("bootOnce", () => {
  it("boots once across sequential and concurrent callers", async () => {
    // The reason the Postgres pool, the Redis client and the upstream client
    // survive a warm invocation. A boot per request would open a pool per
    // request against a pooler sized for one or two connections per instance.
    let boots = 0;
    const ready = bootOnce(async () => {
      boots += 1;
      return boots;
    });

    const [a, b] = await Promise.all([ready(), ready()]);
    const c = await ready();

    expect(boots).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it("forgets a failed boot so the next request retries it", async () => {
    // The half that had no test in four of the five copies. What fails at boot
    // — Postgres reachable, Supabase awake, Redis shaking hands — is transient,
    // and a Vercel instance is reused for hours, so a first failure must not
    // decide the rest of its life.
    let attempts = 0;
    const ready = bootOnce(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("DATABASE_URL is unreachable");
      return "up";
    });

    await expect(ready()).rejects.toThrow("DATABASE_URL is unreachable");
    await expect(ready()).resolves.toBe("up");
    expect(attempts).toBe(2);
  });

  it("reports the failure to the caller rather than swallowing it", async () => {
    // The internal `.catch` exists to clear the slot, not to handle the error.
    // A boot failure is how the drain answers 503 and how the chores route logs
    // "pass did not run", so it has to reach whoever asked.
    const ready = bootOnce(async () => {
      throw new ConfigError(["DATABASE_URL is required"]);
    });
    await expect(ready()).rejects.toBeInstanceOf(ConfigError);
  });

  it("keeps retrying, rather than giving up after the first forget", async () => {
    // A paused Supabase project takes more than one request to wake, so
    // "forgets a failure" has to mean every failure and not just the first.
    // Once it succeeds it is a singleton again.
    let attempts = 0;
    const ready = bootOnce(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("still paused");
      return attempts;
    });

    await expect(ready()).rejects.toThrow("still paused");
    await expect(ready()).rejects.toThrow("still paused");
    await expect(ready()).resolves.toBe(3);
    await expect(ready()).resolves.toBe(3);
    expect(attempts).toBe(3);
  });
});

describe("platformDefer", () => {
  it("warns when there is no platform request context to defer into", async () => {
    // `@vercel/functions`' `waitUntil` is `getContext().waitUntil?.(promise)`
    // and `getContext()` returns `{}` off-platform — a SILENT no-op. Paired
    // with an unconditional 202 that is the worst outcome available: the caller
    // is told the work was accepted and nothing holds the instance open to run
    // it. It cannot be fixed by awaiting, so it is said out loud instead.
    const warnings: string[] = [];
    const defer = platformDefer({
      info: () => {},
      warn: (_fields, message) => void warnings.push(message),
    });

    defer(Promise.resolve());

    expect(warnings.some((line) => line.includes("no platform request context"))).toBe(true);
  });

  it("says nothing when the platform context is real", () => {
    // The same symbol `waitUntil` itself reads, faked here because the SDK does
    // not export `getContext`.
    const key = Symbol.for("@vercel/request-context");
    const globals = globalThis as Record<symbol, unknown>;
    const saved = globals[key];
    const held: Array<Promise<unknown>> = [];
    globals[key] = { get: () => ({ waitUntil: (p: Promise<unknown>) => void held.push(p) }) };
    const warnings: string[] = [];

    try {
      platformDefer({ info: () => {}, warn: (_f, message) => void warnings.push(message) })(
        Promise.resolve(),
      );
    } finally {
      if (saved === undefined) delete globals[key];
      else globals[key] = saved;
    }

    expect(warnings).toEqual([]);
    expect(held).toHaveLength(1);
  });
});

describe("createCronRoute", () => {
  const SECRET = "s3cret";
  const authorized = (method = "POST", url = "/api/thing") =>
    request(method, url, { authorization: `Bearer ${SECRET}` });

  const route = (
    over: {
      methods?: readonly string[] | null;
      readSecret?: () => string | undefined;
      defer?: true | ((promise: Promise<unknown>) => void);
      boot?: () => Promise<string>;
      handle?: (context: CronRequest<string>) => Promise<void>;
    } = {},
  ) =>
    createCronRoute<string>({
      name: "/api/thing",
      methods: over.methods === undefined ? ["POST"] : over.methods,
      boot: over.boot ?? (async () => "booted"),
      readSecret: over.readSecret ?? (() => SECRET),
      logger: silent,
      ...(over.defer === undefined ? {} : { defer: over.defer }),
      handle: over.handle ?? (async ({ json }) => void json(200, { ok: true })),
    });

  it("answers 405 to an undeclared method, before auth and before the boot", async () => {
    // A wrong verb is not a secret, and a 401 to a GET would tell us less about
    // a misconfigured scheduler than a 405 does.
    let boots = 0;
    const handler = route({
      boot: async () => {
        boots += 1;
        return "booted";
      },
    });
    const { res, seen } = capture();

    await handler(request("GET", "/api/thing", { authorization: `Bearer ${SECRET}` }), res);

    expect(seen.status).toBe(405);
    expect(seen.body).toEqual({ error: "method not allowed" });
    expect(boots).toBe(0);
  });

  it("answers every method for a route that declares none", async () => {
    // `null` rather than a list, which is what the pause guard has always done.
    const handler = route({ methods: null });
    const { res, seen } = capture();

    await handler(request("DELETE", "/api/thing", { authorization: `Bearer ${SECRET}` }), res);

    expect(seen.status).toBe(200);
  });

  it("refuses an unauthorized caller WITHOUT booting", async () => {
    // The ordering is the assertion. A boot opens a Postgres pool, a Redis
    // client and an upstream client; the bearer check reads `process.env`.
    // Booting first let an unauthenticated request drive real connections on a
    // route an operator had switched off — and, because `bootOnce` forgets a
    // FAILED boot, one fresh boot per request wherever the boot does not
    // succeed.
    let boots = 0;
    const handler = route({
      boot: async () => {
        boots += 1;
        return "booted";
      },
    });
    const { res, seen } = capture();

    await handler(request("POST", "/api/thing", { authorization: "Bearer wrong" }), res);

    expect(seen.status).toBe(401);
    expect(seen.body).toEqual({ error: "unauthorized" });
    expect(boots).toBe(0);
  });

  it("takes the first of a repeated Authorization header", async () => {
    // `node:http` hands a repeated header back as an array, and a route that
    // compared the array would refuse a request the platform sent.
    const handler = route();
    const { res, seen } = capture();

    await handler(
      request("POST", "/api/thing", { authorization: [`Bearer ${SECRET}`, "Bearer wrong"] }),
      res,
    );

    expect(seen.status).toBe(200);
  });

  it("hands the body a parsed URL and a boot it can call when it likes", async () => {
    // *When* the boot happens is the difference between the three routes and
    // not an implementation detail — the pause guard boots inside the try whose
    // result is the response, the drain before the work, the chores route
    // inside the deferred half — so the module hands over `ready()` and does
    // not call it.
    const seenBody: Array<{ limit: string | null; ready: string }> = [];
    const handler = route({
      handle: async ({ url, ready, json }) => {
        seenBody.push({ limit: url.searchParams.get("limit"), ready: await ready() });
        json(200, { ok: true });
      },
    });
    const { res, seen } = capture();

    await handler(authorized("POST", "/api/thing?limit=7"), res);

    expect(seenBody).toEqual([{ limit: "7", ready: "booted" }]);
    expect(seen.status).toBe(200);
  });

  it("boots once across requests, once the caller is authorized", async () => {
    let boots = 0;
    const handler = route({
      boot: async () => {
        boots += 1;
        return "booted";
      },
      handle: async ({ ready, json }) => {
        await ready();
        json(200, { ok: true });
      },
    });

    await handler(authorized(), capture().res);
    await handler(authorized(), capture().res);

    expect(boots).toBe(1);
  });

  it("writes JSON, with the content type", async () => {
    const handler = route();
    const { res, seen } = capture();

    await handler(authorized(), res);

    expect(seen.headers).toEqual({ "content-type": "application/json" });
    expect(seen.body).toEqual({ ok: true });
  });

  it("refuses to defer for a route that declared no deferral", async () => {
    // The structural half of "`platformDefer` must not spread". Four of the
    // five entrypoints declare nothing, so a body that reached for `waitUntil`
    // throws here rather than silently running the work in the foreground —
    // and "it ran inline" and "it did not run" are too different to leave to a
    // `undefined`.
    const handler = route({
      handle: async ({ defer, json }) => {
        defer(Promise.resolve());
        json(200, { ok: true });
      },
    });
    const { res } = capture();

    await expect(handler(authorized(), res)).rejects.toThrow(
      "/api/thing did not declare a deferral",
    );
  });

  it("uses the deferral a route declared", async () => {
    const held: Array<Promise<unknown>> = [];
    const handler = route({
      defer: (promise) => void held.push(promise),
      handle: async ({ defer, json }) => {
        defer(Promise.resolve("work"));
        json(202, { accepted: true });
      },
    });
    const { res, seen } = capture();

    await handler(authorized(), res);

    expect(seen.status).toBe(202);
    expect(await Promise.all(held)).toEqual(["work"]);
  });

  it("lets a throw out of the body propagate", async () => {
    // What a throw out of these handlers has always done. A `try` here would
    // turn the failures no body has an answer for into a silent 500 with no log
    // line, which is the opposite of what a one-hour log retention wants.
    const handler = route({
      handle: async () => {
        throw new Error("the body blew up");
      },
    });
    const { res, seen } = capture();

    await expect(handler(authorized(), res)).rejects.toThrow("the body blew up");
    expect(seen.status).toBeNull();
  });
});

describe("reading the environment", () => {
  const env = process.env;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = env;
  });

  const configured = (over: Record<string, string> = {}): void => {
    process.env = {
      DATABASE_URL: "postgres://user:pass@localhost:5432/zammy",
      REDIS_URL: "redis://localhost:6379",
      CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
      ...over,
    } as NodeJS.ProcessEnv;
  };

  it("reads the secret without building anything", () => {
    configured({ CRON_SECRET: "from-the-environment" });
    expect(secretFromEnvironment()).toBe("from-the-environment");
  });

  it("reads an unset secret as undefined, which the routes refuse on", () => {
    configured();
    expect(secretFromEnvironment()).toBeUndefined();
  });

  it("reads a secret it cannot load as undefined, rather than throwing", () => {
    // A config that will not load reads the same as an unset secret at the
    // callsite — refuse. The boot reports the real reason to anyone holding the
    // token, and an unauthenticated caller gets a 401 rather than a stack.
    process.env = {} as NodeJS.ProcessEnv;
    expect(secretFromEnvironment()).toBeUndefined();
  });

  it("prints a ConfigError's whole complaint before rethrowing it", () => {
    // Every problem at once, which is the message `index.ts` prints — not one
    // 401 per missing variable across five redeploys.
    process.env = {} as NodeJS.ProcessEnv;
    expect(() => configOrExplain()).toThrow(ConfigError);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("DATABASE_URL");
  });

  it("hands back the config when there is one", () => {
    configured();
    expect(configOrExplain().DATABASE_URL).toContain("postgres://");
    expect(console.error).not.toHaveBeenCalled();
  });
});
