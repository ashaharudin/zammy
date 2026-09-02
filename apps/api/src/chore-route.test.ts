import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { CHORE_PASSES, type ChorePass, type ChoreRunResult } from "./chore-runner.js";
import {
  SCHEDULE_PASSES,
  createHandler,
  handleChorePass,
  parseChoreRequest,
} from "./chore-route.js";
import type { StorylinePassDeps } from "./chores.js";
import type { CronRequest } from "./cron-route.js";

/**
 * The chores route's own behaviour, with no Postgres behind it
 * (VERCEL-ALL-IN-SCOPE §3.3). What the pass DOES is `chore-runner.test.ts`
 * against a real database; what this file pins is the four things that are
 * properties of the HTTP surface and of nothing else:
 *
 *   - it refuses an unauthenticated caller BEFORE opening anything,
 *   - a header is never an authenticator,
 *   - the 202 goes out before the pass starts — the whole reason pg_net's
 *     timeout is a question about the request rather than about the night,
 *   - and an unrecognised pass is the one thing that does NOT get a 202, because
 *     the 202 contract would swallow a scheduler misconfiguration forever.
 */

const SECRET = "s3cret";

const request = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage => ({ method, url, headers }) as unknown as IncomingMessage;

const authorized = (url: string, headers: Record<string, string> = {}) =>
  request("POST", url, { authorization: `Bearer ${SECRET}`, ...headers });

function capture(): {
  res: ServerResponse;
  seen: { status: number | null; body: unknown };
} {
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

const silent = { info: () => {}, warn: () => {} };

interface Harness {
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /** Resolves the deferred half, so a test can await what `waitUntil` holds. */
  settle: () => Promise<void>;
  ran: Array<{ pass: ChorePass; deps: StorylinePassDeps }>;
  boots: number;
}

function harness(
  options: {
    secret?: string | undefined;
    boot?: () => Promise<StorylinePassDeps>;
    onRun?: () => Promise<void>;
  } = {},
): Harness {
  const deferred: Array<Promise<unknown>> = [];
  const ran: Array<{ pass: ChorePass; deps: StorylinePassDeps }> = [];
  const state = { boots: 0 };

  const handler = createHandler(
    options.boot ??
      (async () => {
        state.boots += 1;
        return {} as StorylinePassDeps;
      }),
    {
      readSecret: () => ("secret" in options ? options.secret : SECRET),
      waitUntil: (promise) => void deferred.push(promise),
      logger: silent,
      runPass: async (pass, deps): Promise<ChoreRunResult> => {
        await options.onRun?.();
        ran.push({ pass, deps });
        return { pass, outcome: "ok", runId: "run-1", ms: 1 };
      },
    },
  );

  return {
    handler,
    settle: async () => {
      await Promise.all(deferred);
    },
    ran,
    get boots() {
      return state.boots;
    },
  };
}

describe("parseChoreRequest", () => {
  it("takes the pass from the query", () => {
    expect(parseChoreRequest(new URL("http://x/api/chores?pass=labels"), {})).toEqual({
      pass: "labels",
      overrides: {},
    });
  });

  it("falls back to the cron schedule header", () => {
    // §3.3: "pick the pass from the query or from the `x-vercel-cron-schedule`
    // header". These two expressions are the schedules this system has always
    // run — `0 3 * * *` retention, `0 4 * * *` storylines, both UTC.
    expect(
      parseChoreRequest(new URL("http://x/api/chores"), {
        "x-vercel-cron-schedule": "0 4 * * *",
      }),
    ).toMatchObject({ pass: "storylines" });
    expect(SCHEDULE_PASSES["0 3 * * *"]).toBe("retention");
  });

  it("prefers an explicit pass over the schedule", () => {
    expect(
      parseChoreRequest(new URL("http://x/api/chores?pass=graph"), {
        "x-vercel-cron-schedule": "0 4 * * *",
      }),
    ).toMatchObject({ pass: "graph" });
  });

  it("refuses rather than defaulting", () => {
    // A default would be worse than a refusal: the two composites cost hours and
    // money respectively, so "the cron entry lost its query string" must not
    // silently become "run the expensive one".
    expect(parseChoreRequest(new URL("http://x/api/chores"), {})).toBeNull();
    expect(parseChoreRequest(new URL("http://x/api/chores?pass=nightly"), {})).toBeNull();
    expect(
      parseChoreRequest(new URL("http://x/api/chores"), {
        "x-vercel-cron-schedule": "*/5 * * * *",
      }),
    ).toBeNull();
  });

  it("reads the per-run overrides, and ignores nonsense", () => {
    expect(
      parseChoreRequest(new URL("http://x/api/chores?pass=labels&max-labels=12"), {}),
    ).toMatchObject({ overrides: { maxLabels: 12 } });
    expect(
      parseChoreRequest(
        new URL("http://x/api/chores?pass=late-candidates&changed-only=false"),
        {},
      ),
    ).toMatchObject({ overrides: { lateCandidatesChangedOnly: false } });
    // Unparseable is ignored rather than refused: the configured default is
    // never a wrong answer, and a 400 here would fail a night over a typo.
    expect(
      parseChoreRequest(new URL("http://x/api/chores?pass=labels&max-labels=lots"), {}),
    ).toEqual({ pass: "labels", overrides: {} });
  });

  it("reads the summary pass's own ceiling", () => {
    // A count of MODEL CALLS, not of days — a day costs between one and five.
    expect(
      parseChoreRequest(new URL("http://x/api/chores?pass=summaries&max-summaries=30"), {}),
    ).toMatchObject({ pass: "summaries", overrides: { maxSummaries: 30 } });
    expect(
      parseChoreRequest(new URL("http://x/api/chores?pass=summaries&max-summaries=0"), {}),
    ).toEqual({ pass: "summaries", overrides: {} });
  });

  it("maps the summary schedule to its pass", () => {
    // 05:00 UTC, an hour after the storyline night: they spend the same key, and
    // the 04:00 pass is the one that has been killed at maxDuration before.
    expect(SCHEDULE_PASSES["0 5 * * *"]).toBe("summaries");
    expect(
      parseChoreRequest(new URL("http://x/api/chores"), {
        "x-vercel-cron-schedule": "0 5 * * *",
      }),
    ).toMatchObject({ pass: "summaries" });
  });
});

describe("createHandler", () => {
  it("refuses an unauthorized caller WITHOUT booting", async () => {
    // Same ordering the drain makes, for the same reason: `boot` opens a
    // Postgres pool, the bearer check reads `process.env`. A pass also spends
    // Gemini quota and rewrites the storyline graph, which is not something an
    // anonymous caller gets to start.
    const h = harness();
    const { res, seen } = capture();

    await h.handler(request("POST", "/api/chores?pass=graph", { authorization: "Bearer no" }), res);
    await h.settle();

    expect(seen.status).toBe(401);
    expect(h.boots).toBe(0);
    expect(h.ran).toEqual([]);
  });

  it("is disabled, not open, when CRON_SECRET is unset", async () => {
    const h = harness({ secret: undefined });
    const { res, seen } = capture();

    await h.handler(authorized("/api/chores?pass=graph"), res);

    expect(seen.status).toBe(401);
  });

  it("does not accept the cron header as authorization", async () => {
    // The spike's throwaway route did, and it is client-settable — anyone could
    // have started a label pass by setting a header. Vercel's own scheduler
    // sends `Authorization: Bearer $CRON_SECRET`, which is the real check.
    const h = harness();
    const { res, seen } = capture();

    await h.handler(request("POST", "/api/chores", { "x-vercel-cron-schedule": "0 4 * * *" }), res);
    await h.settle();

    expect(seen.status).toBe(401);
    expect(h.ran).toEqual([]);
  });

  it("answers 400 to an unknown pass, and names the ones it knows", async () => {
    const h = harness();
    const { res, seen } = capture();

    await h.handler(authorized("/api/chores?pass=nightly"), res);

    expect(seen.status).toBe(400);
    expect(seen.body).toEqual({ error: "unknown pass", passes: [...CHORE_PASSES] });
  });

  it("refuses a method that is neither GET nor POST", async () => {
    const h = harness();
    const { res, seen } = capture();

    await h.handler(request("PUT", "/api/chores?pass=graph"), res);

    expect(seen.status).toBe(405);
  });

  it("accepts GET, because Vercel's own cron sends nothing else", async () => {
    // The drain is POST-only against a crawler following a link by accident;
    // this route is behind the same bearer check, so POST-only here would rule
    // out the documented Pro-tier scheduler for no gain.
    const h = harness();
    const { res, seen } = capture();

    await h.handler(
      request("GET", "/api/chores?pass=graph", { authorization: `Bearer ${SECRET}` }),
      res,
    );
    await h.settle();

    expect(seen.status).toBe(202);
    expect(h.ran.map((entry) => entry.pass)).toEqual(["graph"]);
  });

  it("answers 202 BEFORE the pass runs", async () => {
    // The property the whole shape turns on. pg_net is asynchronous with its own
    // timeout — 2 s by default, plausibly shorter than a cold Node boot plus TLS
    // — so the 202 has to be about the REQUEST and `maxDuration` about the pass.
    let startPass!: () => void;
    const gate = new Promise<void>((resolve) => {
      startPass = resolve;
    });
    const h = harness({ onRun: () => gate });
    const { res, seen } = capture();

    await h.handler(authorized("/api/chores?pass=storylines"), res);

    expect(seen.status).toBe(202);
    expect(seen.body).toEqual({ accepted: "storylines" });
    expect(h.ran).toEqual([]); // still gated — the response did not wait for it

    startPass();
    await h.settle();
    expect(h.ran.map((entry) => entry.pass)).toEqual(["storylines"]);
  });

  it("applies the per-run overrides to the configured night", async () => {
    const h = harness({
      boot: async () =>
        ({ maxLabels: 50, lateCandidatesChangedOnly: true }) as StorylinePassDeps,
    });
    const { res } = capture();

    await h.handler(authorized("/api/chores?pass=labels&max-labels=9&changed-only=false"), res);
    await h.settle();

    expect(h.ran[0]?.deps).toMatchObject({
      maxLabels: 9,
      lateCandidatesChangedOnly: false,
    });
  });

  it("warns when there is no platform request context to defer into", async () => {
    // `@vercel/functions`' `waitUntil` is `getContext().waitUntil?.(promise)` and
    // `getContext()` returns `{}` off-platform — a SILENT no-op, paired with an
    // unconditional 202. The caller is told the pass was accepted and nothing
    // holds the instance open to run it, which is indistinguishable from a
    // platform kill. It cannot be fixed by awaiting (that is the 202 the whole
    // shape exists for), so it is said out loud instead.
    const warnings: string[] = [];
    const handler = createHandler(async () => ({}) as StorylinePassDeps, {
      readSecret: () => SECRET,
      logger: { info: () => {}, warn: (_fields, message) => void warnings.push(message) },
      runPass: async (pass) => ({ pass, outcome: "ok", runId: null, ms: 0 }),
    });
    const { res, seen } = capture();

    await handler(authorized("/api/chores?pass=graph"), res);

    expect(seen.status).toBe(202);
    expect(warnings.some((line) => line.includes("no platform request context"))).toBe(true);
  });

  it("still answers 202 when the boot fails", async () => {
    // Nothing downstream of the 202 is visible to the scheduler, boot included.
    // The failure is a log line and a missing `chore_runs` row — the same trade
    // every other failure here makes, and the reason that table is not optional.
    const h = harness({
      boot: async () => {
        throw new Error("no database");
      },
    });
    const { res, seen } = capture();

    await h.handler(authorized("/api/chores?pass=graph"), res);
    expect(seen.status).toBe(202);

    await h.settle();
    expect(h.ran).toEqual([]);
  });
});

/**
 * The body on its own, which is what `cron-route.ts` made possible: no socket,
 * no bearer check, no `waitUntil`. Two things are only reachable this way — the
 * `chore pass accepted` line, which is the only record that exists before the
 * background half opens a `chore_runs` row, and the report of a pass that
 * FAILED, which has no response left to travel in.
 */
describe("handleChorePass", () => {
  function context(
    url: string,
    headers: Record<string, string> = {},
    ready: () => Promise<StorylinePassDeps> = async () => ({}) as StorylinePassDeps,
  ): {
    context: CronRequest<StorylinePassDeps>;
    seen: { status: number | null; body: unknown };
    lines: Array<{ level: string; fields: Record<string, unknown>; message: string }>;
    settle: () => Promise<void>;
  } {
    const seen: { status: number | null; body: unknown } = { status: null, body: null };
    const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
    const deferred: Array<Promise<unknown>> = [];
    return {
      seen,
      lines,
      settle: async () => void (await Promise.all(deferred)),
      context: {
        request: { method: "POST", url, headers } as unknown as IncomingMessage,
        url: new URL(url, "http://localhost"),
        ready,
        json: (status, body) => {
          seen.status = status;
          seen.body = body;
        },
        logger: {
          info: (fields, message) =>
            void lines.push({ level: "info", fields: fields as Record<string, unknown>, message }),
          warn: (fields, message) =>
            void lines.push({ level: "warn", fields: fields as Record<string, unknown>, message }),
        },
        defer: (promise) => void deferred.push(promise),
      },
    };
  }

  const ok = async (pass: ChorePass): Promise<ChoreRunResult> => ({
    pass,
    outcome: "ok",
    runId: "run-1",
    ms: 12,
  });

  it("records the pass and the schedule that chose it, before anything runs", async () => {
    // The only record of the request that exists before the background half
    // opens a `chore_runs` row — and on a night the boot fails, the only record
    // that ever exists.
    const c = context("/api/chores", { "x-vercel-cron-schedule": "0 5 * * *" });

    await handleChorePass(c.context, ok);

    expect(c.seen.status).toBe(202);
    expect(c.lines[0]).toMatchObject({
      level: "info",
      message: "chore pass accepted",
      fields: { pass: "summaries", schedule: "0 5 * * *" },
    });
  });

  it("logs a null schedule when the query chose the pass", async () => {
    const c = context("/api/chores?pass=graph&max-labels=9");

    await handleChorePass(c.context, ok);

    expect(c.lines[0]).toMatchObject({ fields: { pass: "graph", schedule: null, maxLabels: 9 } });
    expect(c.seen.body).toEqual({ accepted: "graph", maxLabels: 9 });
  });

  it("reports a FAILED pass on the warn channel, with the run it belonged to", async () => {
    // There is no response left to put it in — the 202 went out before the pass
    // started — so this line and the `chore_runs` row are the whole diagnostic.
    const c = context("/api/chores?pass=storylines");

    await handleChorePass(c.context, async (pass) => ({
      pass,
      outcome: "failed",
      runId: "run-9",
      ms: 4200,
      error: new Error("42703 column link_dirty_at does not exist"),
    }));
    await c.settle();

    expect(c.lines.at(-1)).toMatchObject({
      level: "warn",
      message: "chore pass FAILED",
      fields: {
        pass: "storylines",
        runId: "run-9",
        ms: 4200,
        err: "42703 column link_dirty_at does not exist",
      },
    });
  });

  it("says the pass did not run when the boot never came up", async () => {
    const c = context("/api/chores?pass=graph", {}, async () => {
      throw new Error("no DATABASE_SESSION_URL");
    });

    await handleChorePass(c.context, ok);
    await c.settle();

    expect(c.seen.status).toBe(202);
    expect(c.lines.at(-1)).toMatchObject({
      level: "warn",
      message: "chore boot failed; pass did not run",
      fields: { pass: "graph", err: "no DATABASE_SESSION_URL" },
    });
  });

  it("neither defers nor logs for an unknown pass", async () => {
    // The 400 is the one answer that is not a 202, and nothing may be started
    // behind it: an unrecognised pass name is a scheduler misconfiguration, and
    // a log line claiming a pass was accepted would make it look handled.
    const c = context("/api/chores?pass=nightly");

    await handleChorePass(c.context, ok);

    expect(c.seen.status).toBe(400);
    expect(c.seen.body).toEqual({ error: "unknown pass", passes: [...CHORE_PASSES] });
    expect(c.lines).toEqual([]);
  });

  /**
   * `?status` — the read behind the same door as the run.
   *
   * The branch exists because `chore_runs` had exactly one reader in the whole
   * system, `pnpm chores status`, which needs a shell and a `DATABASE_URL` the
   * Vercel deployment does not have: the durable record ADR-0015 accepts
   * one-hour log retention in exchange for was unreadable on the deployment it
   * was written for.
   *
   * What "overdue" and "stalled" MEAN is `chore-status.ts`, asserted there over
   * rows and a clock with no Postgres. What these pin is the three things that
   * are properties of this HTTP surface and of nothing else: it answers
   * synchronously, it starts no pass, and a read failure is a 503 naming the
   * reason rather than a 500. The fail-closed half is `cron-routes.test.ts`,
   * which tables `?status` beside `?pass=` over every gated entrypoint.
   */
  describe("?status", () => {
    /**
     * A Kysely stand-in for the ONE read `readChoreRuns` makes: a chain that
     * ignores every builder call and resolves `execute()` to the rows it holds.
     * Narrow on purpose, exactly as `storyline-summary-command.test.ts`'s is —
     * the moment anything asks it a second question the answer is silently
     * wrong, which is why the pass half of this route's subject is tested
     * against a real database in `chore-runner.test.ts`.
     */
    function rowsDb(rows: readonly unknown[] | Error): StorylinePassDeps["db"] {
      const chain: unknown = new Proxy(() => undefined, {
        get: (_target, property) =>
          property === "execute"
            ? async () => {
                if (rows instanceof Error) throw rows;
                return rows;
              }
            : property === "then"
              ? undefined
              : chain,
        apply: () => chain,
      });
      return chain as StorylinePassDeps["db"];
    }

    const NOW = new Date("2026-09-01T06:30:00Z");
    const statusDeps = (rows: readonly unknown[] | Error): StorylinePassDeps =>
      ({ db: rowsDb(rows), now: () => NOW }) as unknown as StorylinePassDeps;

    it("answers 200 with the verdict, and starts no pass", async () => {
      // Synchronously, unlike every other answer this route gives. The 202 shape
      // exists to fit pg_net's timeout, and no scheduler can reach this branch:
      // `zammy_cron_post` refuses any path not in its fixed allow-list and none
      // of the five listed paths carries `status`. The only caller is a person
      // holding the token, and a status that answered 202 would tell them
      // nothing at all.
      const c = context("/api/chores?status", {}, async () =>
        statusDeps([
          {
            id: "run-1",
            pass: "retention",
            source: "route",
            started_at: new Date("2026-09-01T03:00:02Z"),
            finished_at: new Date("2026-09-01T03:00:41Z"),
            outcome: "ok",
            report: null,
            error: null,
            model_calls: null,
          },
        ]),
      );

      await handleChorePass(c.context, ok);
      await c.settle();

      expect(c.seen.status).toBe(200);
      const body = c.seen.body as {
        ok: boolean;
        overdue: string[];
        stalled: string[];
        passes: Array<{ pass: string; last: { startedAt: string } | null }>;
      };
      expect(body.passes.find((entry) => entry.pass === "retention")?.last?.startedAt).toBe(
        "2026-09-01T03:00:02.000Z",
      );
      // Two of the three scheduled passes have no row here, which is the answer
      // the endpoint exists to give.
      expect(body.overdue).toEqual(["storylines", "summaries"]);
      expect(body.stalled).toEqual([]);
      expect(body.ok).toBe(false);
    });

    it("does not run the pass a `pass=` alongside it would have named", async () => {
      // `?status` is read FIRST, before pass selection. An operator who types
      // both gets the read: a status request that also spent the label budget
      // would be the worse of the two possible readings by a wide margin.
      const c = context("/api/chores?status&pass=labels", {}, async () => statusDeps([]));

      await handleChorePass(c.context, ok);
      await c.settle();

      expect(c.seen.status).toBe(200);
    });

    it("answers 503 with the reason when chore_runs cannot be read", async () => {
      // The commonest cause by far is a deployment whose migrations have not
      // caught up, which is a statement about the database rather than about
      // this code — the same 42P01 `chores-command.ts` translates into a
      // configuration exit code.
      const c = context("/api/chores?status", {}, async () =>
        statusDeps(new Error('relation "chore_runs" does not exist')),
      );

      await handleChorePass(c.context, ok);

      expect(c.seen.status).toBe(503);
      expect(c.seen.body).toEqual({
        error: "chore_runs unreadable",
        reason: 'relation "chore_runs" does not exist',
      });
    });

    it("answers 503 when the boot itself never came up", async () => {
      // Unlike the pass branch, which answers 202 and logs — there the response
      // is sent before the boot is even attempted. Here the boot's failure IS
      // the answer, so it travels in the response.
      const c = context("/api/chores?status", {}, async () => {
        throw new Error("no DATABASE_SESSION_URL");
      });

      await handleChorePass(c.context, ok);

      expect(c.seen.status).toBe(503);
      expect(c.seen.body).toEqual({ error: "boot failed", reason: "no DATABASE_SESSION_URL" });
    });
  });
});
