import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@zammy/config";
import {
  NewsAuthError,
  NewsBlockedError,
  NewsCallerAbortedError,
  NewsCircuitOpenError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsSchemaError,
  NewsTimeoutError,
  NewsUpstreamError,
} from "@zammy/news-client";
import { MAX_TRACE_TOUCHES, PgTable } from "@zammy/shared/request-trace";
import type { Database } from "@zammy/storage";
import { PendingSet, type IngestJob } from "./ingest-queue.js";
import { pageCacheKey } from "./page-cache.js";
import { refreshLockKey } from "./single-flight.js";
import { reserveFallbackCall, reserveTopicCall } from "./topic-budget.js";
import {
  PG_WALK_NODE_LIMIT,
  TRACEABLE_TABLES,
  classifyRedisKey,
  hasNxFlag,
  headerCount,
  jobKindOf,
  jobPlaneOf,
  metaFromBody,
  pgOperationOf,
  pgTablesOf,
  planesFromBody,
  subjectOf,
  withViewLabels,
  queryKeysOf,
  rateLimitOutcome,
  redisCommandOf,
  redisFailureOf,
  redisKeyArg,
  redisOutcomeOf,
  redisStatusOf,
  traceEnvironment,
  traceRouteOf,
  upstreamFailureOf,
  upstreamOutcomeOf,
  viewStorylinesOf,
} from "./trace-redact.js";

/**
 * The classifiers that stand between what a request touched and what a trace
 * may say about it (ADR-0029, "Why the trace is enums").
 *
 * The regressions these catch are the quiet ones: a key builder that moved its
 * prefix (every touch of that kind silently reclassifies as `other`), the
 * deepening lock read as a fill lock because the rows were reordered, a table
 * name read out of a bound PARAMETER rather than out of the statement, an
 * upstream error's message — which carries the request URL, and so the
 * reader's search text — surviving into a failure class, and a new table in
 * `Database` that the trace cannot name.
 */

const FINGERPRINT = "a".repeat(64);

/** A Kysely that compiles and never connects: the operation trees are the subject. */
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/** Records the key a real builder hands Redis, so the classifier is tested against it. */
function keyRecorder(): { redis: Redis; keys: string[] } {
  const keys: string[] = [];
  const record = async (key: string): Promise<number> => {
    keys.push(key);
    return 1;
  };
  const redis = { incr: record, expire: record, zadd: record } as unknown as Redis;
  return { redis, keys };
}

describe("classifyRedisKey", () => {
  const span = { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-02T00:00:00Z") };

  for (const queueName of ["ingest", "test-planner-x"]) {
    it(`classifies every key the codebase builds, under queue ${queueName}`, async () => {
      const budget = keyRecorder();
      await reserveTopicCall(budget.redis, FINGERPRINT, 10, new Date("2026-08-01T00:00:00Z"));
      await reserveFallbackCall(budget.redis, "google-news", 10, new Date("2026-08-01T00:00:00Z"));
      const ledger = keyRecorder();
      await new PendingSet(ledger.redis, queueName).add({ kind: "sample", language: "en" });

      const cases: Array<[string, string]> = [
        ["ref:languages", "reference"],
        [pageCacheKey(FINGERPRINT, span, null, 20), "page_cache"],
        // `cacheKeyFor` and `sampleLockFor` (trending-service.ts) are module-private;
        // these are their exact templates.
        [`${queueName}:trending:en`, "trending_cache"],
        [`${queueName}:lock:sample:en`, "sample_lock"],
        [refreshLockKey(`storyline:${"b".repeat(8)}`, span), "deepen_lock"],
        [refreshLockKey(FINGERPRINT, span), "fill_lock"],
        // storyline-summary-job.ts builds this inline.
        ["lock:summarize:11111111-1111-4111-8111-111111111111", "summarize_lock"],
        [budget.keys[0]!, "topic_budget"],
        // INCR then EXPIRE for each counter, so the fallback's INCR is the third key.
        [budget.keys[2]!, "topic_budget"],
        // search-fallback.ts: its own subject, so the fill lock's class.
        [refreshLockKey(`fallback:${FINGERPRINT}`, span), "fill_lock"],
        [ledger.keys[0]!, "pending_ledger"],
      ];
      for (const [key, expected] of cases) {
        expect(classifyRedisKey(key, queueName), key).toBe(expected);
      }
    });
  }

  it("tests the deepening lock BEFORE the fill lock whose prefix it shares", () => {
    const key = refreshLockKey("storyline:abc", span);
    expect(key.startsWith("lock:refresh:")).toBe(true);
    expect(classifyRedisKey(key, "ingest")).toBe("deepen_lock");
  });

  it("returns a class and never the key, even for input it does not recognise", () => {
    // The keys the tracer sees but has no bin for — the limiter's, the quota
    // governors', anything new — and non-strings. Every one is `other`.
    for (const key of [
      "ratelimit:127.0.0.1",
      "quota:currents:burst",
      "secret:quokka-zebra",
      undefined,
      null,
      42,
      Buffer.from("page:x"),
    ]) {
      const cls = classifyRedisKey(key, "ingest");
      expect(cls, String(key)).toBe("other");
    }
    expect(classifyRedisKey("page:v10:secret-fp", "ingest")).toBe("page_cache");
  });
});

describe("redisCommandOf", () => {
  it("maps ioredis names onto the wire vocabulary, folding the variants", () => {
    expect(redisCommandOf("get")).toBe("GET");
    expect(redisCommandOf("mget")).toBe("MGET");
    expect(redisCommandOf("evalsha")).toBe("EVAL");
    expect(redisCommandOf("pexpire")).toBe("EXPIRE");
    expect(redisCommandOf("zcard")).toBe("ZCARD");
    expect(redisCommandOf("zremrangebyscore")).toBe("other");
    expect(redisCommandOf("SET")).toBe("SET");
  });
});

describe("redisKeyArg", () => {
  it("finds the key third for EVAL and EVALSHA, and only when a key is declared", () => {
    expect(redisKeyArg("eval", ["script", 1, "lock:refresh:x", "token"])).toBe("lock:refresh:x");
    expect(redisKeyArg("evalsha", ["sha", "1", "lock:refresh:x"])).toBe("lock:refresh:x");
    expect(redisKeyArg("eval", ["script", 0, "not-a-key"])).toBeUndefined();
  });

  it("takes the first argument for everything else", () => {
    expect(redisKeyArg("set", ["lock:refresh:x", "token", "PX", 30_000, "NX"])).toBe(
      "lock:refresh:x",
    );
    expect(redisKeyArg("mget", ["ref:languages", "ref:regions"])).toBe("ref:languages");
  });
});

describe("hasNxFlag", () => {
  it("sees NX anywhere past the key and value, in either case", () => {
    expect(hasNxFlag(["k", "v", "PX", 1000, "NX"])).toBe(true);
    expect(hasNxFlag(["k", "v", "nx"])).toBe(true);
    expect(hasNxFlag(["k", "v", "PX", 1000])).toBe(false);
    // A VALUE that happens to read "NX" is the second argument, and not a flag.
    expect(hasNxFlag(["k", "NX"])).toBe(false);
  });
});

describe("redisOutcomeOf", () => {
  it("reads a cache GET or MGET as hit or miss by nullness alone", () => {
    expect(redisOutcomeOf("GET", "page_cache", [], null)).toBe("miss");
    expect(redisOutcomeOf("GET", "page_cache", [], "{}")).toBe("hit");
    expect(redisOutcomeOf("MGET", "reference", [], ["{}", null])).toBe("miss");
    expect(redisOutcomeOf("MGET", "reference", [], ["{}", "{}"])).toBe("hit");
    expect(redisOutcomeOf("GET", "trending_cache", [], null)).toBe("miss");
    // Not a cache: the reply's shape means nothing to a reader.
    expect(redisOutcomeOf("GET", "other", [], null)).toBe("ok");
  });

  it("reads an NX SET as acquired or held", () => {
    const args = ["lock:refresh:x", "token", "PX", 30_000, "NX"];
    expect(redisOutcomeOf("SET", "fill_lock", args, "OK")).toBe("acquired");
    expect(redisOutcomeOf("SET", "fill_lock", args, null)).toBe("held");
    expect(redisOutcomeOf("SET", "reference", ["ref:languages", "{}", "PX", 1], "OK")).toBe("ok");
  });

  it("reads a lock's compare-and-delete as released, or lost when it expired mid-call", () => {
    for (const key of ["fill_lock", "deepen_lock", "summarize_lock"] as const) {
      expect(redisOutcomeOf("EVAL", key, [], 1)).toBe("released");
      expect(redisOutcomeOf("EVAL", key, [], 0)).toBe("lost");
    }
    expect(redisOutcomeOf("EVAL", "other", [], 1)).toBe("ok");
  });

  it("calls everything else ok", () => {
    expect(redisOutcomeOf("INCR", "topic_budget", [], 3)).toBe("ok");
    expect(redisOutcomeOf("EXPIRE", "topic_budget", [], 1)).toBe("ok");
    expect(redisOutcomeOf("ZCARD", "pending_ledger", [], 4)).toBe("ok");
  });
});

describe("redisFailureOf", () => {
  it("names a client that was not connected, and drops every message", () => {
    expect(
      redisFailureOf(new Error("Stream isn't writeable and enableOfflineQueue options is false")),
    ).toBe("not_ready");
    expect(redisFailureOf(new Error("Connection is closed."))).toBe("failed");
    expect(redisFailureOf("not an error")).toBe("failed");
  });
});

describe("redisStatusOf", () => {
  it("folds ioredis' statuses into four", () => {
    expect(redisStatusOf("ready")).toBe("ready");
    for (const status of ["wait", "connecting", "connect"]) {
      expect(redisStatusOf(status)).toBe("connecting");
    }
    expect(redisStatusOf("reconnecting")).toBe("reconnecting");
    expect(redisStatusOf("end")).toBe("down");
    expect(redisStatusOf("close")).toBe("down");
  });
});

describe("pgOperationOf", () => {
  it("names DML by its root node and calls everything else raw", () => {
    expect(pgOperationOf(db.selectFrom("articles").selectAll().toOperationNode())).toBe("select");
    expect(
      pgOperationOf(db.insertInto("topics").values({ fingerprint: "x" } as never).toOperationNode()),
    ).toBe("insert");
    expect(
      pgOperationOf(db.updateTable("storylines").set({ status: "active" }).toOperationNode()),
    ).toBe("update");
    expect(pgOperationOf(db.deleteFrom("fetch_log").toOperationNode())).toBe("delete");
    expect(pgOperationOf(sql`select 1`.toOperationNode())).toBe("raw");
  });
});

describe("pgTablesOf", () => {
  it("names the tables of an aliased join by table, not alias", () => {
    const node = db
      .selectFrom("articles as a")
      .innerJoin("topic_articles as ta", "ta.article_id", "a.id")
      .select("a.id")
      .toOperationNode();
    expect(pgTablesOf(node)).toEqual(["articles", "topic_articles"]);
  });

  it("drops a CTE's alias, keeping the tables it reads", () => {
    const node = db
      .with("matched", (qb) => qb.selectFrom("storylines").select("id"))
      .selectFrom("matched")
      .innerJoin("storyline_days", "storyline_days.storyline_id", "matched.id")
      .selectAll()
      .toOperationNode();
    const tables = pgTablesOf(node);
    expect(new Set(tables)).toEqual(new Set(["storylines", "storyline_days"]));
    expect(tables).not.toContain("matched");
  });

  it("reads a raw statement's own fragments — resolveIn's recursive CTE is storylines", () => {
    // `resolveIn` (packages/storage/src/storylines.ts), verbatim.
    const storylineId = "11111111-1111-4111-8111-111111111111";
    const node = sql`
      with recursive chain(id, merged_into, depth) as (
        select id, merged_into, 0 from storylines where id = ${storylineId}::uuid
        union all
        select next.id, next.merged_into, chain.depth + 1
        from storylines next join chain on next.id = chain.merged_into
        where chain.depth < 32
      )
      select id from chain order by depth desc limit 1
    `.toOperationNode();
    expect(pgTablesOf(node)).toEqual(["storylines"]);
  });

  it("never reads a table out of a bound value, even one written as SQL", () => {
    const node = sql`select 1 from topics where keywords = ${"from storyline_days"}`.toOperationNode();
    expect(pgTablesOf(node)).toEqual(["topics"]);
  });

  it("reads a nested fragment, which is the template's code and not a value", () => {
    const join = sql`join topic_articles ta on ta.article_id = a.id`;
    const node = sql`select a.id from articles a ${join} where a.id = ${1}`.toOperationNode();
    expect(pgTablesOf(node)).toEqual(["articles", "topic_articles"]);
  });

  it("stops walking after its node budget", () => {
    // A chain deeper than the budget with the only table at the bottom.
    let node: Record<string, unknown> = {
      kind: "TableNode",
      table: { kind: "SchemableIdentifierNode", identifier: { kind: "IdentifierNode", name: "articles" } },
    };
    for (let i = 0; i < PG_WALK_NODE_LIMIT + 10; i += 1) node = { kind: "WrapperNode", inner: node };
    expect(pgTablesOf(node)).toEqual([]);

    let shallow: Record<string, unknown> = {
      kind: "TableNode",
      table: { kind: "SchemableIdentifierNode", identifier: { kind: "IdentifierNode", name: "articles" } },
    };
    for (let i = 0; i < 10; i += 1) shallow = { kind: "WrapperNode", inner: shallow };
    expect(pgTablesOf(shallow)).toEqual(["articles"]);
  });

  it("caps a touch at six tables", () => {
    const node = sql`select 1 from articles join topics join sightings join storylines
      join storyline_days join storyline_groups join topic_articles`.toOperationNode();
    expect(pgTablesOf(node)).toHaveLength(6);
  });
});

describe("TRACEABLE_TABLES", () => {
  it("is exactly the wire's table vocabulary", () => {
    // The other half of `satisfies Record<keyof Database, true>`: a table the
    // schema lacks would be dropped at parse time and the trace would be refused.
    expect(Object.keys(TRACEABLE_TABLES)).toEqual(PgTable.options);
  });
});

describe("REQUEST_TRACE_MAX_TOUCHES", () => {
  it("stops at the shared ceiling, which config repeats as a literal", () => {
    const base = {
      DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
      REDIS_URL: "redis://localhost:6379",
      CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
    };
    expect(MAX_TRACE_TOUCHES).toBe(400);
    expect(
      loadConfig({ ...base, REQUEST_TRACE_MAX_TOUCHES: String(MAX_TRACE_TOUCHES) } as NodeJS.ProcessEnv)
        .REQUEST_TRACE_MAX_TOUCHES,
    ).toBe(MAX_TRACE_TOUCHES);
    expect(() =>
      loadConfig({
        ...base,
        REQUEST_TRACE_MAX_TOUCHES: String(MAX_TRACE_TOUCHES + 1),
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("upstreamFailureOf", () => {
  it("names every NewsError kind", () => {
    const cases: Array<[Error, string]> = [
      [new NewsAuthError("x"), "auth"],
      [new NewsBlockedError("x"), "blocked"],
      [new NewsInvalidQueryError("x"), "invalid_query"],
      [new NewsQuotaError("x"), "quota"],
      [new NewsUpstreamError("x", 502), "upstream"],
      [new NewsCircuitOpenError("x", new Date()), "circuit_open"],
      [new NewsTimeoutError("x"), "timeout"],
      [new NewsCallerAbortedError("x"), "caller_aborted"],
      [new NewsSchemaError("x"), "schema"],
    ];
    for (const [error, kind] of cases) expect(upstreamFailureOf(error), kind).toBe(kind);
  });

  it("calls anything else unknown, and never echoes its message", () => {
    const error = new Error("GET https://api.example/v1/search?keywords=quokka failed");
    const failure = upstreamFailureOf(error);
    expect(failure).toBe("unknown");
    expect(JSON.stringify({ failure })).not.toContain("quokka");
    // A kind the wire does not list is unknown too, not passed through.
    const unlisted = Object.assign(new Error("x"), { kind: "quokka", retryable: false, provider: "p" });
    expect(upstreamFailureOf(unlisted)).toBe("unknown");
  });
});

describe("upstreamOutcomeOf", () => {
  it("separates a refusal from a failure", () => {
    expect(upstreamOutcomeOf("quota")).toBe("refused");
    expect(upstreamOutcomeOf("circuit_open")).toBe("refused");
    expect(upstreamOutcomeOf("answered")).toBe("refused");
    expect(upstreamOutcomeOf("upstream")).toBe("failed");
    expect(upstreamOutcomeOf("unreachable")).toBe("failed");
    expect(upstreamOutcomeOf("unknown")).toBe("failed");
  });
});

describe("jobKindOf and jobPlaneOf", () => {
  it("read a job's kind and plane off its discriminant", () => {
    const segment: IngestJob = {
      fingerprint: FINGERPRINT,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      startPage: 1,
      plane: "search",
    };
    expect([jobKindOf(segment), jobPlaneOf(segment)]).toEqual(["segment", "search"]);
    const topup: IngestJob = { ...segment, plane: "deepening", kind: "topup" };
    expect([jobKindOf(topup), jobPlaneOf(topup)]).toEqual(["topup", "deepening"]);
    expect(jobKindOf({ kind: "sample", language: "en" })).toBe("sample");
    const deepen: IngestJob = { kind: "deepen", storylineId: "x", from: "a", to: "b" };
    expect([jobKindOf(deepen), jobPlaneOf(deepen)]).toEqual(["deepen", undefined]);
    expect(jobKindOf({ kind: "summarize", storylineId: "x", at: "a" })).toBe("summarize");
    // A fallback carries no plane field, and has one: it exists only for a search.
    const fallback: IngestJob = { kind: "fallback", fingerprint: FINGERPRINT, from: "a", to: "b" };
    expect([jobKindOf(fallback), jobPlaneOf(fallback)]).toEqual(["fallback", "search"]);
  });
});

describe("traceRouteOf", () => {
  it("names every traceable route by its pattern", () => {
    expect(traceRouteOf("GET", "/api/v1/timeline", { q: "x" })).toBe("timeline_search");
    expect(traceRouteOf("GET", "/api/v1/timeline", { storyline: "a,b" })).toBe("timeline_view");
    expect(traceRouteOf("GET", "/api/v1/storylines", { q: "x" })).toBe("storylines_search");
    expect(traceRouteOf("POST", "/api/v1/storylines/:id/refresh", {})).toBe("storyline_open");
    expect(traceRouteOf("GET", "/api/v1/trending", {})).toBe("trending");
    expect(traceRouteOf("GET", "/api/v1/reference", {})).toBe("reference");
  });

  it("leaves the operator route, HEAD, the trace route and a 404 alone", () => {
    expect(traceRouteOf("GET", "/api/v1/topics/:fingerprint", {})).toBeNull();
    expect(traceRouteOf("HEAD", "/api/v1/timeline", { q: "x" })).toBeNull();
    expect(traceRouteOf("GET", "/api/v1/traces/:id", {})).toBeNull();
    expect(traceRouteOf("GET", undefined, {})).toBeNull();
    expect(traceRouteOf("POST", "/api/v1/timeline", {})).toBeNull();
  });
});

describe("queryKeysOf", () => {
  it("lists the parameter NAMES present, in the enum's order, and nothing it does not know", () => {
    expect(queryKeysOf({ limit: "3", q: "quokka zebra", secret: "x", cursor: undefined })).toEqual([
      "q",
      "limit",
    ]);
    expect(JSON.stringify(queryKeysOf({ q: "quokka" }))).not.toContain("quokka");
    expect(queryKeysOf(undefined)).toEqual([]);
  });
});

describe("viewStorylinesOf", () => {
  it("counts a view's storylines, within the view's own ceiling", () => {
    expect(viewStorylinesOf({ storyline: "a" })).toBe(1);
    expect(viewStorylinesOf({ storyline: "a,b,c" })).toBe(3);
    expect(viewStorylinesOf({ storyline: Array.from({ length: 13 }, () => "a").join(",") })).toBe(
      undefined,
    );
    expect(viewStorylinesOf({ q: "x" })).toBeUndefined();
  });
});

describe("rateLimitOutcome", () => {
  it("reads the limiter's reply four ways", () => {
    expect(rateLimitOutcome(200, undefined, undefined)).toBeNull();
    expect(rateLimitOutcome(429, 120, 0)).toBe("limited");
    expect(rateLimitOutcome(200, "120", "120")).toBe("fail_open");
    expect(rateLimitOutcome(200, "120", "117")).toBe("counted");
  });
});

describe("headerCount", () => {
  it("reads an integer header and refuses anything else", () => {
    expect(headerCount("120")).toBe(120);
    expect(headerCount(7)).toBe(7);
    expect(headerCount(["5"])).toBe(5);
    expect(headerCount("1.5")).toBeNull();
    expect(headerCount(undefined)).toBeNull();
    expect(headerCount("abc")).toBeNull();
  });
});

describe("metaFromBody", () => {
  it("keeps a response's meta without its clock reading", () => {
    // The shape `readTimeline` and `readTrending` both answer with.
    const body = {
      topic: { fingerprint: FINGERPRINT, keywords: ["quokka"], coverage: null },
      meta: {
        servedFrom: "cache",
        asOf: "2026-09-01T12:00:00.000Z",
        stale: false,
        degraded: null,
        ingest: { state: "complete", pendingJobs: 0 },
      },
    };
    const meta = metaFromBody(body);
    expect(meta).toEqual({
      servedFrom: "cache",
      stale: false,
      degraded: null,
      ingest: { state: "complete", pendingJobs: 0 },
    });
    expect(JSON.stringify(meta)).not.toContain("quokka");
    expect(metaFromBody({ storylines: [] })).toBeNull();
    expect(metaFromBody("not json")).toBeNull();
  });
});

describe("planesFromBody", () => {
  // The refresh route's 202 (routes.ts), in its three shapes.
  const opened = (overrides: Record<string, unknown>) => ({
    storyline: "11111111-1111-4111-8111-111111111111",
    queued: true,
    keywords: ["quokka"],
    fingerprint: FINGERPRINT,
    deepening: { status: "queued", queued: true },
    summaries: { status: "queued", queued: true },
    ...overrides,
  });

  it("reads each plane's gate off a storyline open's body", () => {
    expect(planesFromBody("storyline_open", opened({}))).toEqual({
      refresh: "queued",
      deepening: "queued",
      summaries: "queued",
    });
    expect(
      planesFromBody(
        "storyline_open",
        opened({
          queued: false,
          deepening: { status: "unavailable", queued: false },
          summaries: { status: "disabled", queued: false },
        }),
      ),
    ).toEqual({ refresh: "fresh", deepening: "unavailable", summaries: "disabled" });
    expect(
      planesFromBody("storyline_open", opened({ queued: false, keywords: [], fingerprint: undefined })),
    ).toMatchObject({ refresh: "no_keywords" });
  });

  it("reads the refresh's own status where the body states it", () => {
    // `deferred` (ADR-0017, amended) is `queued: false` with keywords — which the
    // inference would read as `fresh`, so the stated status has to win.
    expect(
      planesFromBody(
        "storyline_open",
        opened({ queued: false, refresh: { status: "deferred", queued: false } }),
      ),
    ).toMatchObject({ refresh: "deferred" });
    // And a status the schema does not know is no planes at all, not a guess.
    expect(
      planesFromBody("storyline_open", opened({ refresh: { status: "mystery", queued: true } })),
    ).toBeNull();
  });

  it("is null for every other route and for an error body", () => {
    expect(planesFromBody("timeline_search", opened({}))).toBeNull();
    expect(planesFromBody("storyline_open", { error: { message: "unknown storyline" } })).toBeNull();
  });
});

describe("traceEnvironment", () => {
  it("records the live configuration, Google News off when its flag is", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
      REDIS_URL: "redis://localhost:6379",
      CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
    } as NodeJS.ProcessEnv);
    expect(traceEnvironment(config, { labeler: false })).toEqual({
      queue: "bullmq",
      currents: "fixture",
      gnews: false,
      googleNews: "off",
      summaries: false,
      labeler: false,
    });
    expect(
      traceEnvironment({ ...config, GOOGLE_NEWS_ENABLED: true, GOOGLE_NEWS_MODE: "live" }, {
        labeler: true,
      }),
    ).toMatchObject({ googleNews: "live", labeler: true });
  });
});

// ADR-0031: the one place a trace holds what was asked.
describe("subjectOf", () => {
  const A = "1b671a64-40d5-491e-99b0-da01ff1f3341";
  const B = "2c671a64-40d5-491e-99b0-da01ff1f3342";

  it("keeps a search's keywords and filters, trimmed and bounded", () => {
    expect(
      subjectOf("timeline_search", { q: "  quokka zebra ", language: "en", country: "au" }, {}),
    ).toEqual({ keywords: "quokka zebra", language: "en", country: "au" });
    expect(subjectOf("storylines_search", { q: "k".repeat(300) }, {})).toEqual({
      keywords: "k".repeat(200),
    });
  });

  it("names a view's storylines by id, UUIDs only, and an open's by its param", () => {
    expect(subjectOf("timeline_view", { storyline: `${A},nope,${B.toUpperCase()}` }, {})).toEqual({
      storylines: [{ id: A }, { id: B }],
    });
    expect(subjectOf("storyline_open", {}, { id: A })).toEqual({ storylines: [{ id: A }] });
    expect(subjectOf("storyline_open", {}, { id: "not-a-uuid" })).toBeNull();
  });

  it("keeps trending's language, and nothing for reference or an empty ask", () => {
    expect(subjectOf("trending", { language: "fr", limit: "10" }, {})).toEqual({ language: "fr" });
    expect(subjectOf("trending", {}, {})).toBeNull();
    expect(subjectOf("reference", { q: "ignored" }, {})).toBeNull();
    expect(subjectOf("timeline_search", { q: ["a", "b"] }, {})).toBeNull();
  });
});

describe("withViewLabels", () => {
  const A = "1b671a64-40d5-491e-99b0-da01ff1f3341";
  const B = "2c671a64-40d5-491e-99b0-da01ff1f3342";

  it("takes the view's ids and labels from its reply, survivors and all", () => {
    const body = {
      storylines: [
        { id: B, label: "Nepal Flash Floods", from: "x", to: "y" },
        { id: A, label: null },
      ],
    };
    expect(withViewLabels("timeline_view", { storylines: [{ id: A }] }, body)).toEqual({
      storylines: [
        { id: B, label: "Nepal Flash Floods" },
        { id: A, label: null },
      ],
    });
  });

  it("keeps the requested ids where the reply names none, and leaves other routes alone", () => {
    const subject = { storylines: [{ id: A }] };
    expect(withViewLabels("timeline_view", subject, { error: { message: "x" } })).toBe(subject);
    expect(withViewLabels("timeline_view", subject, { storylines: [] })).toBe(subject);
    const search = { keywords: "floods" };
    expect(withViewLabels("timeline_search", search, { storylines: [{ id: A, label: "L" }] })).toBe(
      search,
    );
  });

  it("cuts an overlong label rather than refusing the record", () => {
    const body = { storylines: [{ id: A, label: "l".repeat(250) }] };
    expect(withViewLabels("timeline_view", null, body)?.storylines?.[0]?.label).toHaveLength(200);
  });
});
