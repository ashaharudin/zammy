import { describe, expect, it } from "vitest";
import {
  CallPriority,
  GeneratorPurpose,
  JobKind,
  PgOperation,
  RateLimitOutcome,
  RedisCommand,
  RedisKeyClass,
  RedisOutcome,
  Station,
  UpstreamCall,
  UpstreamFailure,
  UpstreamOutcome,
  type Touch,
  type TraceEnvironment,
} from "@zammy/shared/request-trace";
import { buildTimeline, type Stop } from "./choreography.js";
import { TRACE_FIXTURES, traceFixture } from "./fixtures/traceFixtures.js";
import {
  canvasMs,
  captionFor,
  describeHeadline,
  describeStep,
  describeSubject,
  describeSummary,
  formatMs,
  honestyNotes,
  keyClassLabel,
  routeLabel,
  stationName,
  stationPlate,
} from "./stepText.js";

/**
 * The page's words (ADR-0029).
 *
 * Canvas text is checked against the pixel font's character set, copied here
 * from `pixelFont.ts` FONT_CHARS rather than imported: a caption the font cannot
 * draw becomes `?` on the stage, and this test must fail on that whether or not
 * the font module happens to be right today. DOM text is checked for the tell-tales of a
 * template that met a field it did not expect — "undefined", "NaN", "null".
 */

const FONT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:!?-+/%×✓✗'()#><=_";
const fontSafe = (text: string) => [...text].every((c) => FONT_CHARS.includes(c));

const stop = (touches: Touch[], overrides: Partial<Stop> = {}): Stop => {
  const first = touches[0]!;
  return {
    station: first.station,
    key: first.station === "redis" ? first.key : null,
    touches,
    count: touches.length,
    parallel: 1,
    realAt: first.at,
    realEnd: first.ms === null ? null : first.at + first.ms,
    outcome: first.outcome,
    tables: first.station === "postgres" ? first.tables : [],
    ...overrides,
  };
};

const msFor = (outcome: string) => (outcome === "open" ? null : 1);

/** One touch for every combination of every enum a caption reads. */
function everyTouch(): Touch[] {
  const out: Touch[] = [];
  const at = 0;
  for (const outcome of RedisOutcome.options) {
    for (const command of RedisCommand.options) {
      for (const key of RedisKeyClass.options) {
        out.push({ station: "redis", at, ms: msFor(outcome), outcome, command, key });
      }
    }
  }
  for (const outcome of ["ok", "open"] as const) {
    for (const operation of PgOperation.options) {
      const tables = ["articles" as const];
      out.push({ station: "postgres", at, ms: msFor(outcome), outcome, operation, tables });
    }
  }
  for (const station of ["currents", "google_news", "gemini"] as const) {
    for (const outcome of UpstreamOutcome.options) {
      for (const call of UpstreamCall.options) {
        for (const failure of [undefined, ...UpstreamFailure.options]) {
          for (const priority of [undefined, ...CallPriority.options]) {
            const base = { station, at, ms: msFor(outcome), outcome, call, priority, failure };
            if (station === "gemini") {
              for (const purpose of [undefined, ...GeneratorPurpose.options]) {
                out.push({ ...base, station, purpose });
              }
            } else {
              out.push({ ...base, station });
            }
          }
        }
      }
    }
  }
  for (const outcome of ["ok", "failed", "open"] as const) {
    for (const job of JobKind.options) {
      for (const linked of [true, false]) {
        const ref = "99.99.99.99";
        out.push({ station: "queue", at, ms: msFor(outcome), outcome, job, ref, linked });
      }
    }
  }
  for (const outcome of RateLimitOutcome.options) {
    const counts = [[120, 117], [null, null], [100_000, 99_999], [0, 0]] as const;
    for (const [limit, remaining] of counts) {
      out.push({ station: "rate_limit", at, ms: 1, outcome, inferred: true, limit, remaining });
    }
  }
  for (const outcome of ["hit", "stale", "miss"] as const) {
    out.push({ station: "edge", at, ms: 1, outcome });
  }
  return out;
}

describe("captionFor", () => {
  it("fits ten glyphs of the pixel font for every enum combination, alone and merged", () => {
    for (const touch of everyTouch()) {
      for (const count of [1, 2, 7, 83, 400]) {
        const caption = captionFor(stop([touch], { count }));
        expect(caption.length, JSON.stringify(touch)).toBeLessThanOrEqual(10);
        expect(fontSafe(caption), `${caption} ${JSON.stringify(touch)}`).toBe(true);
        expect(caption.length).toBeGreaterThan(0);
      }
    }
  });

  it("captions what a stop found in a word or two: HIT, NO CONN, 429, OPEN", () => {
    const redis = (outcome: "hit" | "miss" | "acquired" | "held" | "not_ready"): Touch => ({
      station: "redis",
      at: 0,
      ms: 1,
      outcome,
      command: "GET",
      key: "page_cache",
    });
    expect(captionFor(stop([redis("hit")]))).toBe("HIT");
    expect(captionFor(stop([redis("miss")]))).toBe("MISS");
    expect(captionFor(stop([redis("acquired")]))).toBe("ACQUIRED");
    expect(captionFor(stop([redis("held")]))).toBe("HELD");
    expect(captionFor(stop([redis("not_ready")]))).toBe("NO CONN");
    const limited: Touch = {
      station: "rate_limit",
      at: 0,
      ms: 1,
      outcome: "limited",
      inferred: true,
      limit: 120,
      remaining: 0,
    };
    expect(captionFor(stop([limited]))).toBe("429");
    const open: Touch = {
      station: "gemini",
      at: 0,
      ms: null,
      outcome: "open",
      call: "generate",
      purpose: "label",
    };
    expect(captionFor(stop([open]))).toBe("OPEN");
  });

  it("leads a merged stop with its count, and keeps only the count when both will not fit", () => {
    const pg: Touch = {
      station: "postgres",
      at: 0,
      ms: 1,
      outcome: "ok",
      operation: "insert",
      tables: ["articles"],
    };
    expect(captionFor(stop([pg], { count: 5 }))).toBe("×5 INSERT");
    expect(captionFor(stop([pg], { count: 83 }))).toBe("×83 INSERT");
    const lock: Touch = {
      station: "redis",
      at: 0,
      ms: 1,
      outcome: "not_ready",
      command: "SET",
      key: "fill_lock",
    };
    expect(captionFor(stop([lock], { count: 5 }))).toBe("×5 NO CONN");
    expect(captionFor(stop([lock], { count: 181 }))).toBe("×181");
  });
});

describe("formatMs", () => {
  it("reads 0.4 ms, 45 ms, 1,234 ms, 7.9 s — and unknown for a call with no end", () => {
    expect(formatMs(0.4)).toBe("0.4 ms");
    expect(formatMs(45)).toBe("45 ms");
    expect(formatMs(1234)).toBe("1,234 ms");
    expect(formatMs(7900)).toBe("7.9 s");
    expect(formatMs(null)).toBe("unknown");
  });

  it("reaches seconds and minutes for runs that arrive much later, without the locale", () => {
    expect(formatMs(305_010)).toBe("305 s");
    expect(formatMs(1_020_000)).toBe("17 min");
    expect(formatMs(Number.NaN)).toBe("unknown");
  });
});

describe("canvasMs", () => {
  it("is short, uppercase and font-safe at every scale", () => {
    for (const ms of [0, 0.4, 9.9, 45, 999, 1204, 9_999, 305_010, 5_000_000]) {
      const text = canvasMs(ms);
      expect(fontSafe(text), text).toBe(true);
      expect(text.length).toBeLessThanOrEqual(7);
    }
    expect(canvasMs(712)).toBe("712MS");
    expect(canvasMs(1400)).toBe("1.4S");
    expect(canvasMs(null)).toBe("?");
  });
});

describe("names and plates", () => {
  const env: TraceEnvironment = {
    queue: "bullmq",
    currents: "fixture",
    gnews: true,
    googleNews: "live",
    summaries: true,
    labeler: true,
  };

  it("names the queue and Currents from the environment that recorded the trace", () => {
    expect(stationName("queue", env)).toBe("BullMQ");
    expect(stationName("queue", { ...env, queue: "vercel" })).toBe("Vercel Queues");
    expect(stationName("currents", env)).toBe("Currents (fixture) + GNews");
    expect(stationName("currents", { ...env, currents: "live", gnews: false })).toBe("Currents");
    expect(stationName("edge", null)).toBe("CDN edge");
  });

  it("keeps every plate within 8 glyphs of the font", () => {
    for (const s of Station.options) {
      const plate = stationPlate(s, env);
      expect(plate.length).toBeLessThanOrEqual(8);
      expect(fontSafe(plate)).toBe(true);
    }
  });

  it("labels every Redis key class", () => {
    expect(keyClassLabel("fill_lock")).toBe("single-flight lock");
    for (const key of RedisKeyClass.options) expect(keyClassLabel(key).length).toBeGreaterThan(0);
  });

  it("writes the route label in the font", () => {
    for (const e of TRACE_FIXTURES) expect(fontSafe(routeLabel(e.response.trace))).toBe(true);
    expect(routeLabel(traceFixture("cold-search")!.response.trace)).toBe("GET /API/V1/TIMELINE");
  });
});

describe("describeStep", () => {
  it("never leaks undefined, NaN or null into any step of any example, at either pace", () => {
    for (const e of TRACE_FIXTURES) {
      for (const pace of ["readable", "real"] as const) {
        const timeline = buildTimeline(e.response, { pace });
        for (const step of timeline.steps) {
          const text = describeStep(step, timeline);
          expect(text, `${e.slug} ${step.index}`).not.toMatch(/undefined|NaN|null|\[object/);
          const head = `Step ${step.index + 1} of ${timeline.steps.length} · `;
          expect(text.startsWith(head)).toBe(true);
        }
      }
    }
  });

  it("describes a Redis stop as who · station · command · key class · outcome · time", () => {
    const timeline = buildTimeline(traceFixture("cold-search")!.response, { pace: "readable" });
    const lock = timeline.steps.find((s) => s.key === "fill_lock" && s.part.kind === "request")!;
    expect(describeStep(lock, timeline)).toBe(
      `Step ${lock.index + 1} of ${timeline.steps.length} · Request · Redis · SET · ` +
        "single-flight lock · acquired · 1.0 ms",
    );
  });

  it("names a redelivered job's attempt and when it started", () => {
    const response = traceFixture("cold-search")!.response;
    const timeline = buildTimeline(response, { pace: "readable" });
    const retry = response.runs.findLastIndex((r) => r.ref === "4");
    const start = timeline.steps.find(
      (s) => s.kind === "run" && s.part.kind === "run" && s.part.run === retry,
    )!;
    expect(describeStep(start, timeline)).toContain(
      "Job 4 (fill), attempt 2 · started 308 s after the request",
    );
    const first = timeline.steps.find(
      (s) =>
        s.kind === "run_end" &&
        s.part.kind === "run" &&
        response.runs[s.part.run]?.result === "threw",
    )!;
    expect(describeStep(first, timeline)).toContain(
      "Job 4 (fill), attempt 1 · threw (the upstream failed)",
    );
  });

  it("says a helper's call ran in parallel, and that it never ended", () => {
    const timeline = buildTimeline(traceFixture("cold-search")!.response, { pace: "readable" });
    const gemini = timeline.steps.find((s) => s.station === "gemini")!;
    const text = describeStep(gemini, timeline);
    expect(text).toContain("Request, in parallel · Gemini · generate (label)");
    expect(text).toContain("still running when the record was sealed");
    expect(text).not.toContain("ms");
  });
});

describe("describeHeadline", () => {
  it("summarises the request in one line", () => {
    expect(describeHeadline(traceFixture("cold-search")!.response.trace)).toBe(
      "GET /api/v1/timeline (search, q) → 200 in 1,204 ms · served from upstream · 4 jobs pending",
    );
  });

  it("names the planes of a storyline open and the edge of a CDN hit", () => {
    expect(describeHeadline(traceFixture("storyline-open")!.response.trace)).toContain(
      "refresh queued · deepening queued · summaries queued",
    );
    const edge = traceFixture("edge-hit")!.response.trace;
    expect(describeHeadline(edge)).toContain("no function ran");
  });

  it("never says no function ran of a platform 504, which the browser draws as an edge miss", () => {
    const edge = traceFixture("edge-hit")!.response;
    const timeout = {
      ...edge,
      trace: {
        ...edge.trace,
        status: 504,
        touches: edge.trace.touches.map((t) =>
          t.station === "edge" ? { ...t, outcome: "miss" as const } : t,
        ),
      },
    };
    const headline = describeHeadline(timeout.trace);
    expect(headline).toContain("the platform answered in the API's place");
    expect(headline).not.toMatch(/no function ran|CDN edge/);
    const notes = honestyNotes(timeout);
    expect(notes.some((n) => n.startsWith("Nothing was recorded: the platform answered 504"))).toBe(
      true,
    );
    expect(notes.join(" ")).not.toMatch(/no function ran|CDN answered/i);
  });

  it("never leaks a missing field into any example's headline", () => {
    for (const e of TRACE_FIXTURES) {
      expect(describeHeadline(e.response.trace)).not.toMatch(/undefined|NaN|null/);
    }
  });
});

describe("honestyNotes", () => {
  it("tells the cold search's reader about the elision and the call still running", () => {
    const notes = honestyNotes(traceFixture("cold-search")!.response);
    expect(notes.some((n) => n.includes("elided"))).toBe(true);
    expect(notes.some((n) => n.includes("1 call was still running"))).toBe(true);
    expect(notes.some((n) => n.includes("inferred"))).toBe(true);
    expect(notes.some((n) => n.includes("wall clocks"))).toBe(true);
    expect(notes.some((n) => n.includes("overhead") || n.includes("of its own"))).toBe(true);
  });

  it("says nothing it cannot back up", () => {
    const notes = honestyNotes(traceFixture("rate-limited")!.response);
    expect(notes).toEqual([
      "The rate-limit step is inferred from hook timing and the x-ratelimit headers, not observed.",
    ]);
  });

  it("owns up to a browser-only trace, and to linked jobs nobody saw run", () => {
    const edge = traceFixture("edge-hit")!.response;
    expect(honestyNotes(edge).some((n) => n.startsWith("No function ran"))).toBe(true);
    const cold = traceFixture("cold-search")!.response;
    const orphaned = { ...cold, runs: cold.runs.filter((r) => r.ref !== "3") };
    const notes = honestyNotes(orphaned);
    expect(notes.some((n) => n.startsWith("1 linked job has no recorded run"))).toBe(true);
  });

  it("reports fixture mode and a shared run", () => {
    const cold = traceFixture("cold-search")!.response;
    const fixture = {
      ...cold,
      trace: {
        ...cold.trace,
        origin: {
          ...cold.trace.origin!,
          environment: { ...cold.trace.origin!.environment, currents: "fixture" as const },
        },
      },
      runs: cold.runs.map((r, i) => (i === 0 ? { ...r, sharedWith: 2 } : r)),
    };
    const notes = honestyNotes(fixture);
    expect(notes.some((n) => n.startsWith("Currents is in fixture mode"))).toBe(true);
    expect(notes.some((n) => n.startsWith("A job run was shared"))).toBe(true);
  });
});

// ADR-0031: what a trace asked for, in the plate's and the dropdown's words.
describe("describeSubject", () => {
  const A = "1b671a64-40d5-491e-99b0-da01ff1f3341";

  it("quotes keywords and labels, and names an unlabelled storyline by its id", () => {
    expect(describeSubject({ keywords: "quokka zebra", language: "en", country: "au" })).toBe(
      "“quokka zebra” (en, au)",
    );
    expect(describeSubject({ storylines: [{ id: A, label: "Nepal Flash Floods" }] })).toBe(
      "storyline “Nepal Flash Floods”",
    );
    expect(describeSubject({ storylines: [{ id: A }, { id: A, label: null }] })).toBe(
      `storylines ${A}, ${A}`,
    );
    expect(describeSubject({ language: "fr" })).toBe("language fr");
    // Filters alone are named for what they are.
    expect(describeSubject({ country: "au" })).toBe("country au");
    expect(describeSubject({ language: "en", country: "au" })).toBe("language en, country au");
  });

  it("is null for a trace that asked nothing, or predates subjects", () => {
    expect(describeSubject(null)).toBeNull();
    expect(describeSubject(undefined)).toBeNull();
    expect(describeSubject({})).toBeNull();
  });
});

describe("describeSummary", () => {
  it("reads as when, what was asked, and how it answered", () => {
    const summary = {
      id: "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b",
      route: "timeline_search" as const,
      method: "GET" as const,
      status: 200,
      startedAt: "2026-09-01T12:04:31.000Z",
      ms: 812,
      subject: { keywords: "quokka zebra" },
    };
    expect(describeSummary(summary, () => "12:04:31")).toBe(
      `12:04:31 · search “quokka zebra” → 200 in ${formatMs(812)}`,
    );
    expect(describeSummary({ ...summary, route: "reference", subject: null }, () => "t")).toBe(
      `t · reference → 200 in ${formatMs(812)}`,
    );
  });
});
