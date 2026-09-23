import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  JOB_REF_PATTERN,
  TRACE_ID_PATTERN,
  traceSignature,
  type JobKind,
  type Touch,
  type TouchOf,
} from "@zammy/shared/request-trace";
import {
  EXAMPLE_SLUGS,
  EXAMPLE_TRACES,
  MIRROR_AT,
  exampleBySlug,
  type ExampleSlug,
} from "./exampleTraces.js";

/**
 * The built-in examples are claims about the code (ADR-0029).
 *
 * The signatures below are the SAME table `apps/api/src/trace-examples.test.ts`
 * holds the server's real recordings to, so an example and the code it depicts
 * cannot drift apart without one side going red. The path invariants catch the
 * edits a signature cannot see — a Postgres read slipped into the cache hit, an
 * enqueue that happens before the Currents call it depends on, a cold instance
 * whose ledger wait no longer looks like one.
 */

const SIGNATURES: Readonly<Record<ExampleSlug, readonly string[]>> = {
  "cache-hit": ["rate_limit:counted", "redis:reference", "redis:page_cache"],
  "cold-search": [
    "rate_limit:counted",
    "redis:reference",
    "redis:page_cache",
    "redis:fill_lock",
    "redis:topic_budget",
    "currents:search",
    "redis:fill_lock",
    "queue:segment",
    "redis:pending_ledger",
  ],
  "storyline-open": [
    "rate_limit:counted",
    "redis:reference",
    "queue:topup",
    "queue:deepen",
    "queue:summarize",
  ],
  "rate-limited": ["rate_limit:limited"],
  "quota-degraded": [
    "rate_limit:counted",
    "redis:reference",
    "redis:page_cache",
    "redis:fill_lock",
    "redis:topic_budget",
    "currents:search",
    "redis:fill_lock",
    "redis:pending_ledger",
  ],
  "cold-instance": [
    "rate_limit:fail_open",
    "redis:reference",
    "redis:page_cache",
    "redis:fill_lock",
    "redis:pending_ledger",
  ],
  "edge-hit": ["edge:hit"],
};

const FILL_RUN = ["redis:fill_lock", "redis:topic_budget", "currents:search", "redis:fill_lock"];
const RUN_SIGNATURES: Readonly<Record<JobKind, readonly string[]>> = {
  segment: FILL_RUN,
  topup: FILL_RUN,
  deepen: ["redis:deepen_lock", "google_news:search", "redis:deepen_lock"],
  summarize: ["redis:summarize_lock", "gemini:generate", "redis:summarize_lock"],
  // No example runs a sample job; listed so the table is total over JobKind.
  sample: [],
};

function example(slug: ExampleSlug) {
  const found = exampleBySlug(slug);
  if (!found) throw new Error(`no example ${slug}`);
  return found;
}

const queueTouches = (touches: readonly Touch[]): TouchOf<"queue">[] =>
  touches.filter((t): t is TouchOf<"queue"> => t.station === "queue");

describe("EXAMPLE_TRACES", () => {
  it("parses every file, in EXAMPLE_SLUGS order", () => {
    // The module parses at load, so reaching this line at all means every file
    // matched TraceReadResponse; the order is what the picker shows.
    expect(EXAMPLE_TRACES.map((e) => e.slug)).toEqual([...EXAMPLE_SLUGS]);
  });

  it("uses unique slugs that can never be mistaken for a trace id", () => {
    const slugs = EXAMPLE_TRACES.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(TRACE_ID_PATTERN.test(slug)).toBe(false);
  });

  it("gives every example its own fixed id, one no recorder could ever mint", () => {
    const ids = EXAMPLE_TRACES.map((e) => e.response.trace.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^00000000-0000-4000-8000-00000000000[1-7]$/);
    expect(example("cold-search").response.trace.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(example("edge-hit").response.trace.id).toBe("00000000-0000-4000-8000-000000000007");
  });

  it("says, in every summary, that the timings are illustrative", () => {
    for (const e of EXAMPLE_TRACES) expect(e.summary).toContain("illustrative");
  });

  it("finds an example by slug, and nothing for a slug that is not one", () => {
    expect(exampleBySlug("rate-limited")?.response.trace.status).toBe(429);
    expect(exampleBySlug("not-an-example")).toBeUndefined();
  });
});

describe("the pinned fidelity signatures", () => {
  for (const slug of EXAMPLE_SLUGS) {
    it(`holds for ${slug}'s request`, () => {
      expect(traceSignature(example(slug).response.trace.touches)).toEqual(SIGNATURES[slug]);
    });
  }

  it("holds for every run, by its job kind", () => {
    for (const e of EXAMPLE_TRACES) {
      for (const run of e.response.runs) {
        expect(traceSignature(run.touches), `${e.slug} run ${run.ref}`).toEqual(
          RUN_SIGNATURES[run.job],
        );
      }
    }
  });
});

describe("the path invariants", () => {
  it("serves the cache hit without touching Postgres", () => {
    const { touches } = example("cache-hit").response.trace;
    expect(touches.some((t) => t.station === "postgres")).toBe(false);
  });

  it("answers the rate-limited request at the limiter and nowhere else", () => {
    const { trace } = example("rate-limited").response;
    expect(trace.status).toBe(429);
    expect(trace.touches).toHaveLength(1);
    expect(trace.touches[0]?.station).toBe("rate_limit");
  });

  it("refuses the quota-degraded call for quota, and enqueues nothing", () => {
    const { touches } = example("quota-degraded").response.trace;
    const refused = touches.filter(
      (t) => t.station === "currents" && t.outcome === "refused" && t.failure === "quota",
    );
    expect(refused).toHaveLength(1);
    expect(queueTouches(touches)).toHaveLength(0);
  });

  it("enqueues the cold search's jobs after its Currents call and before the ledger count", () => {
    const { touches } = example("cold-search").response.trace;
    const lastCurrents = touches.findLastIndex((t) => t.station === "currents");
    const zcard = touches.findIndex((t) => t.station === "redis" && t.command === "ZCARD");
    const queued = touches.flatMap((t, i) => (t.station === "queue" ? [i] : []));
    expect(queued.length).toBeGreaterThan(0);
    for (const index of queued) {
      expect(index).toBeGreaterThan(lastCurrents);
      expect(index).toBeLessThan(zcard);
    }
  });

  it("opens a storyline onto topup, deepen and summarize, as refs 1, 2, 3", () => {
    const queued = queueTouches(example("storyline-open").response.trace.touches);
    expect(queued.map((t) => t.job)).toEqual(["topup", "deepen", "summarize"]);
    expect(queued.map((t) => t.ref)).toEqual(["1", "2", "3"]);
  });

  it("starts the cold instance connecting, first in line, with a ledger wait you can see", () => {
    const { trace } = example("cold-instance").response;
    expect(trace.origin?.redisAtStart).toBe("connecting");
    expect(trace.origin?.instanceSequence).toBe(1);
    const zcard = trace.touches.find((t) => t.station === "redis" && t.command === "ZCARD");
    expect(zcard?.ms).toBeGreaterThanOrEqual(250);
  });

  it("draws the edge hit with no function behind it", () => {
    const { trace } = example("edge-hit").response;
    expect(trace.origin).toBeNull();
    expect(trace.touches).toHaveLength(1);
    expect(trace.touches[0]?.station).toBe("edge");
  });
});

describe("the job runs", () => {
  it("names, for every run, a ref this trace enqueued", () => {
    for (const e of EXAMPLE_TRACES) {
      const { trace, runs } = e.response;
      const known = new Set(queueTouches(trace.touches).map((t) => t.ref));
      // A run's own children are rendered `<parent>.<n>` server-side already.
      for (const run of runs) for (const t of queueTouches(run.touches)) known.add(t.ref);
      for (const run of runs) {
        expect(JOB_REF_PATTERN.test(run.ref)).toBe(true);
        expect(known.has(run.ref), `${e.slug} run ${run.ref}`).toBe(true);
      }
    }
  });

  it("starts every run at or after its trace — but not necessarily after the response", () => {
    for (const e of EXAMPLE_TRACES) {
      const start = Date.parse(e.response.trace.startedAt);
      for (const run of e.response.runs) {
        expect(Date.parse(run.startedAt)).toBeGreaterThanOrEqual(start);
      }
    }
  });

  it("keeps runs sorted by (startedAt, ref), as the read route returns them", () => {
    for (const e of EXAMPLE_TRACES) {
      const keys = e.response.runs.map((r) => `${r.startedAt}|${r.ref}`);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it("gives every touch offset room inside the record that holds it", () => {
    // A touch starting after its own record ended would be drawn after the
    // respond step, which no real recorder can produce.
    for (const e of EXAMPLE_TRACES) {
      const records = [e.response.trace, ...e.response.runs];
      for (const record of records) {
        for (const t of record.touches) {
          expect(t.at).toBeLessThanOrEqual(record.ms);
          if (t.ms !== null) expect(t.at + t.ms).toBeLessThanOrEqual(record.ms + 1e-9);
        }
      }
    }
  });
});

describe("the code each example mirrors", () => {
  const ROOT = new URL("../../../../", import.meta.url);

  it("cites ranges that exist, each still beginning with the text it names", () => {
    // Line numbers alone drift with every edit above them — this file's first
    // citations into server.ts and routes.ts were pre-change numbers the day they
    // shipped, pointing a reader at the wrong function. So each names its first
    // line's text, and a slide is caught here, with where the text is now.
    const wrong: string[] = [];
    for (const e of EXAMPLE_TRACES) {
      for (const { at, begins } of e.mirrors) {
        const [, path, first, last] = MIRROR_AT.exec(at)!;
        const cite = `examples/${e.slug}.json cites ${at}`;
        const file = new URL(path!, ROOT);
        if (!existsSync(file)) {
          wrong.push(`${cite}, and there is no such file`);
          continue;
        }
        const lines = readFileSync(file, "utf8").split("\n");
        const [a, b] = [Number(first), Number(last)];
        if (!(a >= 1 && a <= b && b <= lines.length)) {
          wrong.push(`${cite}, outside the file's ${lines.length} lines`);
        } else if (!lines[a - 1]!.includes(begins)) {
          const now = lines.findIndex((line) => line.includes(begins)) + 1;
          const hint = now > 0 ? `; it is on line ${now} now (${path}:${now}-${now + b - a})` : "";
          wrong.push(`${cite}, but line ${a} does not hold "${begins}"${hint}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("depicts the production configuration wherever a function ran", () => {
    // What the module header promises: an example is a picture of production,
    // not of whatever environment serves the page.
    const PROD = {
      queue: "vercel",
      currents: "live",
      gnews: false,
      googleNews: "live",
      summaries: true,
      labeler: true,
    };
    for (const e of EXAMPLE_TRACES) {
      const records = [e.response.trace, ...e.response.runs];
      for (const record of records) {
        if (record.origin) expect(record.origin.environment, e.slug).toEqual(PROD);
      }
    }
  });
});
