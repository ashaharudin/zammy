import { randomUUID } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EdgeOutcome,
  Elision,
  JobRef,
  MAX_TRACE_RUNS,
  MAX_TRACE_TOUCHES,
  PostgresTouch,
  RedisTouch,
  RequestTrace,
  Touch,
  TraceId,
  TraceReadResponse,
  traceAuthorization,
  traceReadPath,
  traceSignature,
  PostgresOutcome,
  QueueOutcome,
  RateLimitOutcome,
  RedisOutcome,
  UpstreamOutcome,
  type JobRun,
  type RequestTrace as RequestTraceRecord,
  type TouchOf,
} from "./request-trace.js";

/**
 * The trace contract's own readings (ADR-0029): the parts that are a RULE —
 * what the schema refuses, what it strips, what the fidelity signature keeps —
 * rather than a field, and so can be got wrong without failing a type.
 *
 * The regressions these catch are redaction ones first. The schema is the
 * boundary between what a request touched and what it asked: a `key` field
 * that loosened to `z.string()`, a `tables` array that took any identifier, or
 * an object that stopped stripping unknown keys would each let a raw Redis
 * key, a SQL fragment or a fingerprint through to a record anyone holding the
 * id can read — and nothing else in the system would notice.
 */

/**
 * One parseable touch per station, reused below (and the shape the example
 * traces are written in). `satisfies` rather than an annotation so each keeps
 * its own literal type for the signature tests.
 */
const TOUCH_LITERALS = {
  edge: { station: "edge", at: 0, ms: 21, outcome: "hit" },
  rate_limit: {
    station: "rate_limit",
    at: 0,
    ms: 1.9,
    outcome: "counted",
    inferred: true,
    limit: 120,
    remaining: 117,
  },
  redis: { station: "redis", at: 2.3, ms: 1, outcome: "hit", command: "MGET", key: "reference" },
  postgres: {
    station: "postgres",
    at: 5.2,
    ms: 3.4,
    outcome: "ok",
    operation: "insert",
    tables: ["topics"],
  },
  queue: {
    station: "queue",
    at: 1130.3,
    ms: 15.2,
    outcome: "ok",
    job: "segment",
    plane: "search",
    ref: "1",
    linked: true,
  },
  currents: {
    station: "currents",
    at: 15.2,
    ms: 712,
    outcome: "ok",
    call: "search",
    priority: "interactive",
  },
  google_news: {
    station: "google_news",
    at: 9.8,
    ms: 1480,
    outcome: "ok",
    call: "search",
    priority: "background",
  },
  gemini: {
    station: "gemini",
    at: 11.5,
    ms: 2400,
    outcome: "ok",
    call: "generate",
    purpose: "summary",
  },
} as const satisfies Record<Touch["station"], Touch>;

const TRACE_ID = "00000000-0000-4000-8000-000000000001";

function trace(overrides: Partial<RequestTraceRecord> = {}): RequestTraceRecord {
  return {
    v: 1,
    id: TRACE_ID,
    route: "timeline_search",
    method: "GET",
    queryKeys: ["q"],
    status: 200,
    startedAt: "2026-09-01T12:00:00.000Z",
    ms: 9.8,
    overheadMs: 0,
    origin: {
      instanceSequence: 1,
      redisAtStart: "ready",
      environment: {
        queue: "bullmq",
        currents: "fixture",
        gnews: false,
        googleNews: "off",
        summaries: false,
        labeler: false,
      },
    },
    meta: null,
    planes: null,
    touches: [TOUCH_LITERALS.rate_limit, TOUCH_LITERALS.redis],
    elided: null,
    ...overrides,
  };
}

function run(ref: string, startedAt: string): JobRun {
  return {
    v: 1,
    ref,
    job: "segment",
    plane: "search",
    source: "bullmq",
    startedAt,
    ms: 10,
    overheadMs: 0,
    result: "ok",
    sharedWith: 1,
    origin: trace().origin!,
    touches: [],
    elided: null,
  };
}

describe("Touch", () => {
  it("parses one literal for every station", () => {
    for (const [station, literal] of Object.entries(TOUCH_LITERALS)) {
      const parsed = Touch.safeParse(literal);
      expect(parsed.success, station).toBe(true);
      expect(parsed.data).toEqual(literal);
    }
  });

  it("strips a field no station declares, which is the redaction backstop", () => {
    // Objects are deliberately NOT `.strict()`: a recorder that grows a field
    // by mistake has it dropped on the way to Redis, rather than either stored
    // or turned into a request-path failure.
    const parsed = Touch.parse({ ...TOUCH_LITERALS.redis, rawKey: "page:v10:abc" });
    expect(parsed).not.toHaveProperty("rawKey");
    expect(JSON.stringify(parsed)).not.toContain("page:v10");
  });
});

describe("RedisTouch", () => {
  it("refuses a raw key where a key CLASS belongs", () => {
    expect(RedisTouch.safeParse({ ...TOUCH_LITERALS.redis, key: "page:v10:abc" }).success).toBe(
      false,
    );
  });
});

describe("PostgresTouch", () => {
  it("refuses a table the schema does not name, SQL included", () => {
    expect(
      PostgresTouch.safeParse({ ...TOUCH_LITERALS.postgres, tables: ["articles; drop"] }).success,
    ).toBe(false);
  });

  it("refuses more than six tables on one touch", () => {
    const seven = [
      "articles",
      "topics",
      "sightings",
      "storylines",
      "storyline_days",
      "storyline_groups",
      "topic_articles",
    ];
    expect(PostgresTouch.safeParse({ ...TOUCH_LITERALS.postgres, tables: seven }).success).toBe(
      false,
    );
    expect(
      PostgresTouch.safeParse({ ...TOUCH_LITERALS.postgres, tables: seven.slice(0, 6) }).success,
    ).toBe(true);
  });
});

describe("JobRef", () => {
  it("accepts a local counter nested at most four deep", () => {
    for (const ref of ["1", "3.2", "99.1.2.3"]) {
      expect(JobRef.safeParse(ref).success, ref).toBe(true);
    }
  });

  it("refuses zero, a zero part, a fifth level, words and three digits", () => {
    for (const ref of ["0", "1.0", "1.1.1.1.1", "x", "100"]) {
      expect(JobRef.safeParse(ref).success, ref).toBe(false);
    }
  });
});

describe("TraceId", () => {
  it("accepts what randomUUID mints", () => {
    for (let i = 0; i < 100; i += 1) {
      const id = randomUUID();
      expect(TraceId.safeParse(id).success, id).toBe(true);
    }
  });

  it("refuses an uppercase UUID and a version-1 one", () => {
    // The read route's id check IS this pattern, so a looser one would let the
    // route issue a store command for a key no trace could ever have written.
    expect(TraceId.safeParse(randomUUID().toUpperCase()).success).toBe(false);
    expect(TraceId.safeParse("6fa459ea-ee8a-11ca-a9ad-3c0754ea4b6a").success).toBe(false);
  });
});

describe("Elision", () => {
  const base = { after: 13, count: 181, fromAt: 739.2, toAt: 1128.6 };

  it("accepts an empty station tally and a positive one", () => {
    expect(Elision.safeParse({ ...base, stations: {} }).success).toBe(true);
    expect(Elision.safeParse({ ...base, stations: { postgres: 3 } }).success).toBe(true);
  });

  it("refuses a station counted zero times, which would be a station that did not go", () => {
    expect(Elision.safeParse({ ...base, stations: { postgres: 0 } }).success).toBe(false);
  });
});

describe("TraceReadResponse", () => {
  it("refuses a seventeenth run", () => {
    const runs = Array.from({ length: MAX_TRACE_RUNS + 1 }, (_, i) =>
      run(String(i + 1), "2026-09-01T12:00:01.000Z"),
    );
    const response = { trace: trace(), runs, expiresAt: "2026-09-01T13:00:00.000Z" };
    expect(TraceReadResponse.safeParse(response).success).toBe(false);
    expect(
      TraceReadResponse.safeParse({ ...response, runs: runs.slice(0, MAX_TRACE_RUNS) }).success,
    ).toBe(true);
  });
});

describe("RequestTrace", () => {
  it("refuses a record over the touch ceiling", () => {
    const touches = Array.from({ length: MAX_TRACE_TOUCHES + 1 }, () => TOUCH_LITERALS.postgres);
    expect(RequestTrace.safeParse(trace({ touches })).success).toBe(false);
    expect(
      RequestTrace.safeParse(trace({ touches: touches.slice(0, MAX_TRACE_TOUCHES) })).success,
    ).toBe(true);
  });
});

describe("traceSignature", () => {
  it("drops Postgres, the reference refill, the reference calls and label Gemini", () => {
    // Each of these is decided by timing or warmth rather than by the code's
    // path, and a signature that kept them could not pin an example.
    const touches: Touch[] = [
      TOUCH_LITERALS.rate_limit,
      TOUCH_LITERALS.postgres,
      { station: "redis", at: 1, ms: 1, outcome: "ok", command: "SET", key: "reference" },
      {
        station: "currents",
        at: 2,
        ms: 1,
        outcome: "ok",
        call: "available_languages",
        priority: "interactive",
      },
      {
        station: "currents",
        at: 2,
        ms: 1,
        outcome: "ok",
        call: "available_regions",
        priority: "interactive",
      },
      {
        station: "currents",
        at: 2,
        ms: 1,
        outcome: "ok",
        call: "available_categories",
      },
      { station: "gemini", at: 3, ms: null, outcome: "open", call: "generate", purpose: "label" },
    ];
    expect(traceSignature(touches)).toEqual(["rate_limit:counted"]);
  });

  it("collapses consecutive duplicates but keeps a repeat that something came between", () => {
    const lock = {
      station: "redis",
      at: 1,
      ms: 1,
      outcome: "acquired",
      command: "SET",
      key: "fill_lock",
    } as const;
    const budget = { ...lock, command: "INCR", key: "topic_budget", outcome: "ok" } as const;
    expect(traceSignature([lock, budget, budget, TOUCH_LITERALS.postgres, lock])).toEqual([
      "redis:fill_lock",
      "redis:topic_budget",
      "redis:fill_lock",
    ]);
    // Postgres between two identical tokens is dropped first, so they collapse.
    expect(traceSignature([lock, TOUCH_LITERALS.postgres, lock])).toEqual(["redis:fill_lock"]);
  });

  it("keeps a summary's Gemini call, since the click plane is where it is the point", () => {
    expect(traceSignature([TOUCH_LITERALS.gemini])).toEqual(["gemini:generate"]);
  });

  it("names every other station by what the code decided", () => {
    expect(
      traceSignature([
        TOUCH_LITERALS.edge,
        TOUCH_LITERALS.queue,
        TOUCH_LITERALS.currents,
        TOUCH_LITERALS.google_news,
      ]),
    ).toEqual(["edge:hit", "queue:segment", "currents:search", "google_news:search"]);
  });
});

describe("the outcome types", () => {
  // Compile-time: `pnpm --filter @zammy/shared typecheck` reads the tests. A
  // consumer that names `RedisOutcome` must be naming exactly what a Redis
  // touch can hold, so a member added to a touch's schema and not to its enum
  // (or the other way round) fails here rather than as a narrowed switch.
  it("are exactly what each station's touch can hold", () => {
    expectTypeOf<RedisOutcome>().toEqualTypeOf<TouchOf<"redis">["outcome"]>();
    expectTypeOf<PostgresOutcome>().toEqualTypeOf<TouchOf<"postgres">["outcome"]>();
    expectTypeOf<UpstreamOutcome>().toEqualTypeOf<TouchOf<"currents">["outcome"]>();
    expectTypeOf<UpstreamOutcome>().toEqualTypeOf<TouchOf<"google_news">["outcome"]>();
    expectTypeOf<UpstreamOutcome>().toEqualTypeOf<TouchOf<"gemini">["outcome"]>();
    expectTypeOf<QueueOutcome>().toEqualTypeOf<TouchOf<"queue">["outcome"]>();
    expectTypeOf<RateLimitOutcome>().toEqualTypeOf<TouchOf<"rate_limit">["outcome"]>();
    expectTypeOf<EdgeOutcome>().toEqualTypeOf<TouchOf<"edge">["outcome"]>();
  });
});

describe("traceAuthorization", () => {
  it("is the Bearer shape the cron routes already speak", () => {
    expect(traceAuthorization("x")).toBe("Bearer x");
  });
});

describe("traceReadPath", () => {
  it("encodes its argument, so an id can never become a different path", () => {
    expect(traceReadPath(TRACE_ID)).toBe(`/api/v1/traces/${TRACE_ID}`);
    expect(traceReadPath("../topics/x?y")).toBe("/api/v1/traces/..%2Ftopics%2Fx%3Fy");
  });
});
