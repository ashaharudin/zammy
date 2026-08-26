import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { CHORE_PASSES, type ChorePass, type ChoreRunResult } from "./chore-runner.js";
import { SCHEDULE_PASSES, createHandler, parseChoreRequest } from "./chore-route.js";
import type { StorylinePassDeps } from "./chores.js";

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
