import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHandler as createChoreHandler } from "./chore-route.js";
import type { StorylinePassDeps } from "./chores.js";
import { createHandler as createDrainHandler, type Drainable } from "./drain.js";
import { createHandler as createKeepaliveHandler, type Pingable } from "./keepalive.js";

/**
 * The properties that hold over the WHOLE set of serverless entrypoints.
 *
 * Written over the set rather than one route at a time on purpose, which is
 * `operator-commands.test.ts`'s argument in a place where the stakes are
 * higher. What `cron-route.ts` exists to create is not "this route fails
 * closed" — all three did — it is that a SIXTH route cannot get the bearer
 * check wrong, because there is nowhere left to write one. A per-route test
 * passes on the day somebody adds a function to `api/` with its own
 * `header === secret`; this file fails.
 *
 * ## The rule
 *
 * **An unset `CRON_SECRET` disables a route rather than opening it.** That is
 * promised to operators in `.env.example` ("unset disables all three,
 * **including the pause guard**"), in `deploy/vercel/README.md` and in
 * `docs/chores.md`, and before this file it was asserted route by route and
 * stated as prose in five doc comments. It is the whole reason `CRON_SECRET` is
 * optional in config: a deployment can switch these routes off, and "off" has
 * to mean off rather than open.
 *
 * The two entrypoints that are NOT bearer-gated are here too, with the fact
 * that makes each exemption true asserted rather than described — because "it
 * has no public URL" is a claim about `vercel.json`, and a claim about a
 * configuration file is exactly the kind that stops being true quietly.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string): string => readFileSync(`${ROOT}${file}`, "utf8");

/** A request that WOULD be authorized if a secret were configured. */
const request = (method: string, url: string): IncomingMessage =>
  ({
    method,
    url,
    headers: { authorization: "Bearer whatever-the-caller-guessed" },
  }) as unknown as IncomingMessage;

function capture(): { res: ServerResponse; seen: { status: number | null } } {
  const seen: { status: number | null } = { status: null };
  const res = {
    writeHead(status: number) {
      seen.status = status;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  return { res, seen };
}

const silent = { info: () => {}, warn: () => {} };

/**
 * One bearer-gated entrypoint: its path, the verb a scheduler sends, and a
 * factory that builds the route with an UNSET secret over a boot that records
 * whether it was reached.
 *
 * The boot counter is half the property. "Disabled" has to mean cheap as well
 * as closed — a route that boots the world and then says no lets an
 * unauthenticated caller drive a Postgres pool, a Redis client and an upstream
 * client per request, which is the shape the auth-before-boot ordering exists
 * to prevent.
 */
interface Guarded {
  readonly path: string;
  readonly method: string;
  /** The source file, so the no-second-bearer-check property can read it. */
  readonly source: string;
  /**
   * Every query string that reaches a DIFFERENT body behind this door, so the
   * rule is asserted over each of them and not only over whichever one was
   * written first.
   *
   * `/api/chores` has two: `?pass=` runs a pass, and `?status` reads
   * `chore_runs` back. The read is a query on the existing route rather than a
   * path of its own — `vercel.json` already routes this one, and
   * `zammy_cron_post`'s allow-list would have needed a line for a surface no
   * scheduler ever posts to — and the whole benefit of that is inheriting this
   * check. Inheriting it silently is how a branch added later ends up in front
   * of the auth instead of behind it, so both are listed.
   */
  readonly queries: readonly string[];
  disabled(onBoot: () => void): (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
}

const GUARDED: readonly Guarded[] = [
  {
    path: "/api/chores",
    method: "POST",
    source: "chore-route.ts",
    queries: ["?pass=graph", "?status"],
    disabled: (onBoot) =>
      createChoreHandler(
        async () => {
          onBoot();
          return {} as StorylinePassDeps;
        },
        {
          readSecret: () => undefined,
          waitUntil: () => {},
          logger: silent,
          runPass: async (pass) => ({ pass, outcome: "ok", runId: null, ms: 0 }),
        },
      ),
  },
  {
    path: "/api/drain",
    method: "POST",
    source: "drain.ts",
    queries: [""],
    disabled: (onBoot) =>
      createDrainHandler(async () => {
        onBoot();
        return {
          listOutstanding: async () => [],
          settle: async () => {},
          forget: async () => {},
          dispatch: async () => {},
        } satisfies Drainable;
      }, () => undefined),
  },
  {
    path: "/api/keepalive",
    method: "POST",
    source: "keepalive.ts",
    queries: [""],
    disabled: (onBoot) =>
      createKeepaliveHandler(async () => {
        onBoot();
        return { ping: async () => {} } satisfies Pingable;
      }, () => undefined),
  },
];

/** The two that are deliberately not bearer-gated, and why each is allowed. */
const EXEMPT = [
  {
    path: "/api/index",
    source: "vercel.ts",
    // The public Fastify surface. Its auth is the app's, and an entrypoint that
    // grew a bearer check would be a second place to look when production and
    // Compose disagree.
    reason: "public",
  },
  {
    path: "/api/queues/ingest",
    source: "vercel-queue.ts",
    // A push-mode consumer, reached only by the platform's `queue/v2beta`
    // trigger. No public URL, so no auth code and none missing.
    reason: "platform-only",
  },
] as const;

describe("the fail-closed rule, over every bearer-gated entrypoint", () => {
  it.each(
    GUARDED.flatMap((route) =>
      route.queries.map((query) => [`${route.path}${query}`, route, query] as const),
    ),
  )(
    "%s is disabled, not open, when CRON_SECRET is unset — and disabled cheaply",
    async (_label, route, query) => {
      let boots = 0;
      const handler = route.disabled(() => void (boots += 1));
      const { res, seen } = capture();

      await handler(request(route.method, `${route.path}${query}`), res);

      expect(seen.status).toBe(401);
      expect(boots).toBe(0);
    },
  );

  it("covers every path the production scheduler is allowed to POST to", () => {
    // The list above has to be complete, and `deploy/vercel/supabase-cron.sql`
    // is the only place that says what complete means: `zammy_cron_post`
    // refuses any path not in its allow-list, so that list IS the set of
    // scheduled routes. A schedule added there without a route here would be a
    // money-spending endpoint none of the properties above are asserted over.
    const sql = read("deploy/vercel/supabase-cron.sql");
    const allowList = /if path not in \(([^)]*)\)/.exec(sql)?.[1];
    expect(allowList, "zammy_cron_post's allow-list moved").toBeDefined();
    const scheduled = [
      ...(allowList as string).matchAll(/'([^']+)'/g),
    ].map((match) => (match[1] as string).split("?")[0]);

    expect([...new Set(scheduled)].sort()).toEqual(GUARDED.map((route) => route.path).sort());
  });

  it("leaves the bearer check in exactly one module", () => {
    // The property stated the only way that survives a sixth route: no
    // entrypoint may compare a token itself. `isAuthorized` is
    // `cron-route.ts`'s, it is fail-closed, and `cron-route.test.ts` pins the
    // comparison — so a file that rolled its own is a file that is not covered
    // by any of it. This is also the seam that moved: the check used to be
    // exported from `drain.ts`, which put the guard on every money-spending
    // route inside the module about draining a Redis pending set.
    for (const { source } of [...GUARDED, ...EXEMPT]) {
      const text = read(`apps/api/src/${source}`);
      expect(text, `${source} reads the secret itself`).not.toContain("loadConfig().CRON_SECRET");
      expect(text, `${source} compares a bearer token itself`).not.toContain("`Bearer ${");
    }
  });
});

describe("the two entrypoints that are not bearer-gated", () => {
  it("routes public traffic to the Fastify surface and nowhere else", () => {
    // `/api/index` is exempt because it IS the public surface — every rewrite
    // in `vercel.json` points at it, and its auth is the app's. If a rewrite
    // ever pointed at `/api/chores`, `/api/drain` or `/api/keepalive`, those
    // would be answering browser traffic on a path nobody audited.
    const vercel = JSON.parse(read("vercel.json")) as {
      rewrites: Array<{ source: string; destination: string }>;
      functions: Record<string, { experimentalTriggers?: unknown }>;
    };
    expect([...new Set(vercel.rewrites.map((rule) => rule.destination))]).toEqual(["/api/index"]);
  });

  it("gives the ingest consumer a trigger and no route", () => {
    // The whole basis of "no public URL, so no auth code and none missing".
    // Nothing routes to it; the platform reaches it through the `queue/v2beta`
    // trigger. A rewrite or a `crons` entry pointing here would make it
    // addressable, and an addressable consumer with no bearer check is a
    // stranger's ingest job.
    const vercel = JSON.parse(read("vercel.json")) as {
      rewrites: Array<{ destination: string }>;
      crons?: unknown;
      functions: Record<string, { experimentalTriggers?: unknown }>;
    };
    expect(vercel.functions["api/queues/ingest.ts"]?.experimentalTriggers).toBeDefined();
    expect(
      vercel.rewrites.some((rule) => rule.destination.includes("queues")),
      "something routes public traffic to the ingest consumer",
    ).toBe(false);
    // Vercel's own cron would also make a path addressable on a schedule. The
    // scheduler is Supabase Cron for the minute precision (§3.3), and adding a
    // `crons` array without deleting the pg_cron jobs runs every night twice.
    expect(vercel.crons).toBeUndefined();
  });

  it("keeps every `api/` file a three-line re-export", () => {
    // The testability requirement, and the reason this file can assert
    // anything at all: the five functions Vercel discovers are the only source
    // in the repository no `tsc` covers, so all five must hold nothing but an
    // import and a default export. A bearer check written THERE would be
    // invisible to every test in this workspace.
    const entrypoints = [
      "api/index.ts",
      "api/chores.ts",
      "api/drain.ts",
      "api/keepalive.ts",
      "api/queues/ingest.ts",
    ];
    for (const file of entrypoints) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      expect(code, `${file} does more than re-export`).toHaveLength(2);
      expect(code[1], `${file} does more than re-export`).toBe("export default handler;");
      expect(code[0], `${file} imports something other than the workspace`).toMatch(
        /^import handler from "@zammy\/api\/[\w-]+";$/,
      );
    }
  });
});
