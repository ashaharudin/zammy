import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { MAX_KEYWORDS_LENGTH, MAX_VIEW_STORYLINES } from "@zammy/shared";
import {
  MAX_TRACE_MS,
  TRACE_ID_PATTERN,
  TRACE_REQUEST_HEADER,
  TraceReadResponse,
} from "@zammy/shared/request-trace";
import { ApiError, storylineRefreshPath } from "../api.js";
import {
  RECORD_KINDS,
  TraceNotFound,
  browserOnlyTrace,
  fetchTrace,
  readRecordResult,
  recordRequest,
  recordTarget,
  type RecordKind,
  type RecordRequest,
  type RecordResponse,
} from "./traceFetch.js";

/**
 * The playback view's wire half (ADR-0029, "The change", items 5 and 7).
 *
 * The regression that matters most here is one no screen would ever show: the
 * trace TOKEN reaching a URL. A URL is written into the CDN's logs, the function
 * log's request line and the browser's history, and the token opens a trace on
 * production for whoever holds it. So the token is checked against every kind's
 * URL twice — once where the URL is built, once where it is actually fetched.
 *
 * The rest pin what the page is told: a record run whose headers are misread
 * sends the operator after the wrong cause ("check your token" for an edge hit),
 * and a browser-built trace that does not parse under the shared schema is a
 * playback that crashes on the one path the server never exercises.
 */

const TOKEN = "t0k3n-that-must-never-reach-a-url-0123456789";
const UUID_A = "1b671a64-40d5-491e-99b0-da01ff1f3341";
const UUID_B = "0c1f6b8e-2d3a-4e5f-8a9b-0c1d2e3f4a5b";
const TRACE_ID = "3f2b7c1e-9a4d-4b6e-8c2f-1a2b3c4d5e6f";

/** A valid input per kind, so a test can walk every kind at once. */
const INPUT: Record<RecordKind, string> = {
  search: "flood warnings",
  view: `${UUID_A}, ${UUID_B}`,
  storylines: "election",
  open: UUID_A,
  trending: "en",
  reference: "",
};

const request = (kind: RecordKind, overrides: Partial<RecordRequest> = {}): RecordRequest => ({
  kind,
  input: INPUT[kind],
  token: TOKEN,
  bypassEdge: false,
  ...overrides,
});

/** The target, or a failed test naming the error it got instead. */
const targetOf = (r: RecordRequest, nonce = "n0nce") => {
  const target = recordTarget(r, nonce);
  if ("error" in target) throw new Error(`expected a target, got: ${target.error}`);
  return target;
};

const paramsOf = (url: string) => new URL(url, "https://zammy.example").searchParams;

describe("recordTarget", () => {
  it("puts the token in no URL, for any kind", () => {
    for (const kind of RECORD_KINDS) {
      for (const bypassEdge of [false, true]) {
        const { url } = targetOf(request(kind, { bypassEdge }));
        expect(url, kind).not.toContain(TOKEN);
        expect(url, kind).not.toContain(encodeURIComponent(TOKEN));
      }
    }
  });

  it("encodes a search's words rather than trusting them into the URL", () => {
    const words = "rates & fees #1 ?cursor=x";
    const { url, method, route, queryKeys } = targetOf(request("search", { input: `  ${words} ` }));
    expect(url.startsWith("/api/v1/timeline?")).toBe(true);
    expect(url).not.toContain("#");
    // One parameter, whose value is the words exactly: nothing smuggled in beside it.
    expect([...paramsOf(url).keys()]).toEqual(["q"]);
    expect(paramsOf(url).get("q")).toBe(words);
    expect({ method, route, queryKeys }).toEqual({
      method: "GET",
      route: "timeline_search",
      queryKeys: ["q"],
    });
  });

  it("sends a storylines search to its own route, which mints no topic", () => {
    const { url, route, queryKeys } = targetOf(request("storylines"));
    expect(url).toBe("/api/v1/storylines?q=election");
    expect(route).toBe("storylines_search");
    expect(queryKeys).toEqual(["q"]);
  });

  it("refuses an empty search, or one of nothing but spaces, for both keyword kinds", () => {
    for (const kind of ["search", "storylines"] as const) {
      for (const input of ["", "   "]) {
        expect(recordTarget(request(kind, { input }), "n")).toHaveProperty("error");
      }
    }
  });

  it("refuses a search longer than the server would accept", () => {
    const at = "x".repeat(MAX_KEYWORDS_LENGTH);
    expect(recordTarget(request("search", { input: at }), "n")).not.toHaveProperty("error");
    expect(recordTarget(request("search", { input: `${at}x` }), "n")).toHaveProperty("error");
  });

  it("sends a view as one comma-joined parameter, as the timeline's own reads do", () => {
    const { url, route, queryKeys } = targetOf(request("view", { input: `${UUID_A}\n${UUID_B},` }));
    expect(paramsOf(url).get("storyline")).toBe(`${UUID_A},${UUID_B}`);
    expect(route).toBe("timeline_view");
    expect(queryKeys).toEqual(["storyline"]);
  });

  it("folds a view's exact repeats", () => {
    const { url } = targetOf(request("view", { input: `${UUID_A},${UUID_A}, ${UUID_B}` }));
    expect(paramsOf(url).get("storyline")).toBe(`${UUID_A},${UUID_B}`);
  });

  it("refuses a view or an open that names anything but storyline UUIDs", () => {
    for (const input of ["", "not-a-uuid", `${UUID_A},42`, "../../chores"]) {
      expect(recordTarget(request("view", { input }), "n"), input).toHaveProperty("error");
    }
    for (const input of ["", "not-a-uuid", `${UUID_A},${UUID_B}`, `${UUID_A}/../x`]) {
      expect(recordTarget(request("open", { input }), "n"), input).toHaveProperty("error");
    }
  });

  it("refuses a view of more storylines than the server holds in one", () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const at = ids(MAX_VIEW_STORYLINES).join(",");
    const past = ids(MAX_VIEW_STORYLINES + 1).join(",");
    expect(recordTarget(request("view", { input: at }), "n")).not.toHaveProperty("error");
    expect(recordTarget(request("view", { input: past }), "n")).toHaveProperty("error");
  });

  it("opens a storyline by POST to its refresh path, and nothing else", () => {
    const target = targetOf(request("open", { input: ` ${UUID_A} ` }));
    expect(target).toEqual({
      method: "POST",
      url: storylineRefreshPath(UUID_A),
      route: "storyline_open",
      queryKeys: [],
    });
  });

  it("asks trending by the URL the cloud asks it by, so an edge copy can answer", () => {
    // `fetchTrending`'s own spelling: the URL is the CDN's cache key, and a
    // record run that differed from it would never see the edge a reader sees.
    const cloudUrl = `/api/v1/trending?language=${encodeURIComponent("en")}`;
    expect(targetOf(request("trending")).url).toBe(cloudUrl);
    expect(targetOf(request("trending", { input: "" })).url).toBe(cloudUrl);
  });

  it("adds the nonce only for a trending run that asked to skip the edge", () => {
    const bypassed = targetOf(request("trending", { bypassEdge: true }), "abc123");
    expect(bypassed.url).toBe("/api/v1/trending?language=en&_=abc123");
    // The nonce names nothing the server reads, so it is not a query key.
    expect(bypassed.queryKeys).toEqual(["language"]);
    for (const kind of RECORD_KINDS.filter((k) => k !== "trending")) {
      expect(targetOf(request(kind, { bypassEdge: true }), "abc123").url, kind).not.toContain(
        "abc123",
      );
    }
  });

  it("refuses a trending language that is not a code", () => {
    for (const input of ["e", "english language", "en&limit=1", "toolongcode"]) {
      expect(recordTarget(request("trending", { input }), "n"), input).toHaveProperty("error");
    }
    expect(targetOf(request("trending", { input: "zh-Hant" })).url).toBe(
      "/api/v1/trending?language=zh-Hant",
    );
  });

  it("asks for the reference data whatever the input says", () => {
    expect(targetOf(request("reference", { input: "ignored?x=1" }))).toEqual({
      method: "GET",
      url: "/api/v1/reference",
      route: "reference",
      queryKeys: [],
    });
  });
});

/** A record run's response facts, with only the headers and status varying. */
const responseFacts = (headers: Record<string, string>, status = 200): RecordResponse => ({
  headers: new Headers(headers),
  status,
  startedAt: new Date("2026-09-23T18:00:00.000Z"),
  browserMs: 21.04,
  route: "trending",
  method: "GET",
  queryKeys: ["language"],
});

describe("readRecordResult", () => {
  it("reads a stored trace's id as traced", () => {
    expect(readRecordResult(responseFacts({ "x-zammy-trace-id": TRACE_ID }))).toEqual({
      kind: "traced",
      id: TRACE_ID,
    });
  });

  it("reads `unstored` as a trace that never reached the store, with its status", () => {
    expect(readRecordResult(responseFacts({ "x-zammy-trace-id": "unstored" }, 500))).toEqual({
      kind: "unstored",
      status: 500,
    });
  });

  it("builds a browser-only trace for an edge hit, from what the browser measured", () => {
    const result = readRecordResult(responseFacts({ "x-vercel-cache": "HIT" }));
    if (result.kind !== "browser") throw new Error(`expected browser, got ${result.kind}`);
    expect(result.cause).toBe("cache");
    const { trace, runs } = result.response;
    expect(trace.origin).toBeNull();
    expect(trace.touches).toEqual([{ station: "edge", at: 0, ms: 21, outcome: "hit" }]);
    expect(trace).toMatchObject({
      route: "trending",
      method: "GET",
      queryKeys: ["language"],
      status: 200,
      startedAt: "2026-09-23T18:00:00.000Z",
      ms: 21,
    });
    expect(runs).toEqual([]);
  });

  it("reads a stale serve as the edge's too, whatever case the header is in", () => {
    const result = readRecordResult(responseFacts({ "X-Vercel-Cache": "stale" }));
    if (result.kind !== "browser") throw new Error(`expected browser, got ${result.kind}`);
    expect(result.cause).toBe("cache");
    expect(result.response.trace.touches[0]).toMatchObject({ station: "edge", outcome: "stale" });
  });

  it("builds a browser-only edge miss for a platform 504, which never reached onSend", () => {
    const result = readRecordResult(responseFacts({ "x-vercel-cache": "MISS" }, 504));
    if (result.kind !== "browser") throw new Error(`expected browser, got ${result.kind}`);
    expect(result.response.trace.status).toBe(504);
    expect(result.response.trace.touches[0]).toMatchObject({ station: "edge", outcome: "miss" });
  });

  it("tells a platform 504 apart from a cache answer, since a function may have run there", () => {
    // The regression: every browser-only result read as "the CDN answered, no
    // function ran" — the opposite of a function stopped at its time limit, and
    // exactly when the operator is chasing a slow request.
    const timedOut = readRecordResult(responseFacts({ "x-vercel-cache": "MISS" }, 504));
    const noHeader = readRecordResult(responseFacts({}, 504));
    for (const result of [timedOut, noHeader]) {
      if (result.kind !== "browser") throw new Error(`expected browser, got ${result.kind}`);
      expect(result.cause).toBe("timeout");
    }
    // A cached answer is the cache's whatever its status.
    const cached = readRecordResult(responseFacts({ "x-vercel-cache": "HIT" }, 504));
    expect(cached).toMatchObject({ kind: "browser", cause: "cache" });
  });

  it("reads a function's answer with no trace header as untraced, with its status", () => {
    // A wrong token, tracing off, or the budget spent: the server says which never.
    expect(readRecordResult(responseFacts({}))).toEqual({ kind: "untraced", status: 200 });
    expect(readRecordResult(responseFacts({ "x-vercel-cache": "MISS" }, 429))).toEqual({
      kind: "untraced",
      status: 429,
    });
  });

  it("reads an id header it cannot parse as invalid, not as untraced", () => {
    // The header's presence says the server DID trace it; "check your token"
    // would send the operator after the wrong cause.
    const result = readRecordResult(responseFacts({ "x-zammy-trace-id": TRACE_ID.toUpperCase() }));
    expect(result.kind).toBe("invalid");
  });
});

/** A real `Response` whose body records whether it was cancelled. */
const cancellableResponse = (status: number, headers: Record<string, string>) => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status, headers }), cancelled: () => cancelled };
};

describe("recordRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token in the opt-in header alone, uncached, and cancels the body", async () => {
    const { response, cancelled } = cancellableResponse(200, { "x-zammy-trace-id": TRACE_ID });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);

    const result = await recordRequest(request("search", { token: ` ${TOKEN}\n` }), { fetch });

    expect(result).toEqual({ kind: "traced", id: TRACE_ID });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("/api/v1/timeline?q=flood+warnings");
    expect(String(url)).not.toContain(TOKEN);
    expect(init?.method).toBe("GET");
    // Trimmed: a pasted token brings its newline, and `fetch` throws on one.
    expect(init?.headers).toEqual({ [TRACE_REQUEST_HEADER]: `Bearer ${TOKEN}` });
    expect(init?.cache).toBe("no-store");
    expect(cancelled()).toBe(true);
  });

  it("never puts the token in the URL it fetches, for any kind", async () => {
    for (const kind of RECORD_KINDS) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
      await recordRequest(request(kind, { bypassEdge: true }), { fetch });
      const [url] = fetch.mock.calls[0]!;
      expect(String(url), kind).not.toContain(TOKEN);
      expect(String(url), kind).not.toContain(encodeURIComponent(TOKEN));
    }
  });

  it("opens a storyline by POST", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 202 }));
    await recordRequest(request("open"), { fetch });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(storylineRefreshPath(UUID_A));
    expect(init?.method).toBe("POST");
  });

  it("times an edge hit by its own clocks, and skips the edge with its own nonce", async () => {
    const { response } = cancellableResponse(200, { "x-vercel-cache": "HIT" });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const readings = [1_000, 1_042.37];
    const result = await recordRequest(request("trending", { bypassEdge: true }), {
      fetch,
      now: () => readings.shift()!,
      clock: () => new Date("2026-09-23T18:30:00.000Z"),
      nonce: () => "fixednonce",
    });

    expect(String(fetch.mock.calls[0]![0])).toBe("/api/v1/trending?language=en&_=fixednonce");
    if (result.kind !== "browser") throw new Error(`expected browser, got ${result.kind}`);
    expect(result.response.trace.ms).toBe(42.4);
    expect(result.response.trace.startedAt).toBe("2026-09-23T18:30:00.000Z");
  });

  it("makes no request for an input it would refuse", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await recordRequest(request("open", { input: "not-a-uuid" }), { fetch });
    expect(result.kind).toBe("invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes no request without a token a header can carry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tokens = ["", "   ", "two words-and-more-characters", "tök€n-with-non-ascii-chars"];
    for (const token of tokens) {
      const result = await recordRequest(request("search", { token }), { fetch });
      expect(result.kind, JSON.stringify(token)).toBe("invalid");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands its abort signal to fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    await recordRequest(request("reference"), { fetch, signal: controller.signal });
    expect(fetch.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("calls the global fetch as a function, never as a method of something else", async () => {
    // A browser's own `fetch` called with any other `this` throws "Illegal
    // invocation"; a node test would never notice, so the receiver is pinned.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await recordRequest(request("reference"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([undefined, globalThis]).toContain(fetch.mock.contexts[0]);

    // And a `fetch` handed in is not called as a method of the deps object.
    const handed = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    await recordRequest(request("reference"), { fetch: handed });
    expect([undefined, globalThis]).toContain(handed.mock.contexts[0]);
  });
});

/** A stored trace as the read route serves it: a search that enqueued one linked job. */
const storedBody = () => ({
  trace: {
    v: 1,
    id: TRACE_ID,
    route: "timeline_search",
    method: "GET",
    queryKeys: ["q"],
    status: 200,
    startedAt: "2026-09-23T18:00:00.000Z",
    ms: 812.4,
    overheadMs: 1.2,
    origin: {
      instanceSequence: 3,
      redisAtStart: "ready",
      environment: {
        queue: "bullmq",
        currents: "fixture",
        gnews: false,
        googleNews: "fixture",
        summaries: false,
        labeler: false,
      },
    },
    meta: null,
    planes: null,
    touches: [
      {
        station: "rate_limit",
        at: 0,
        ms: 0.4,
        outcome: "counted",
        inferred: true,
        limit: 120,
        remaining: 119,
      },
      { station: "redis", at: 0.6, ms: 0.3, outcome: "miss", command: "GET", key: "page_cache" },
      {
        station: "queue",
        at: 790.1,
        ms: 4.2,
        outcome: "ok",
        job: "segment",
        plane: "search",
        ref: "1",
        linked: true,
      },
    ],
    elided: null,
  },
  runs: [],
  expiresAt: "2026-09-23T19:00:00.000Z",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchTrace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the trace route with no token, uncached, and parses what comes back", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(storedBody()));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    const response = await fetchTrace(TRACE_ID, controller.signal);

    expect(response).toEqual(TraceReadResponse.parse(storedBody()));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`/api/v1/traces/${TRACE_ID}`);
    // The id is the capability; a read that carried the token would put it in every poll.
    expect(init?.headers).toBeUndefined();
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBe(controller.signal);
  });

  it("strips what the schema does not name, rather than passing it through", async () => {
    const body = storedBody();
    const redis = body.trace.touches[1]!;
    vi.stubGlobal("fetch", async () =>
      json({ ...body, trace: { ...body.trace, touches: [{ ...redis, rawKey: "page:v10:abc" }] } }),
    );
    const response = await fetchTrace(TRACE_ID);
    expect(response.trace.touches[0]).not.toHaveProperty("rawKey");
  });

  it("throws TraceNotFound for a 404, so the page stops asking", async () => {
    vi.stubGlobal("fetch", async () => json({ error: { message: "unknown trace" } }, 404));
    const failure = await fetchTrace(TRACE_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TraceNotFound);
    expect(failure).not.toBeInstanceOf(ApiError);
    // No id on the error: it is a read capability, and errors get logged.
    expect(String((failure as Error).message)).not.toContain(TRACE_ID);
  });

  it("throws the ApiError every read throws for a 503, with the server's message", async () => {
    const body = { error: { message: "trace store unavailable" } };
    vi.stubGlobal("fetch", async () => json(body, 503));
    const failure = await fetchTrace(TRACE_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, message: "trace store unavailable" });
  });

  it("refuses a record from a version it cannot read", async () => {
    const body = storedBody();
    vi.stubGlobal("fetch", async () => json({ ...body, trace: { ...body.trace, v: 2 } }));
    await expect(fetchTrace(TRACE_ID)).rejects.toThrow();
  });
});

const browserFacts = {
  startedAt: new Date("2026-09-23T18:00:00.000Z"),
  status: 200,
  ms: 21,
  route: "trending",
  method: "GET",
  queryKeys: ["language"],
  cache: "HIT",
} as const;

describe("browserOnlyTrace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses under the shared schema, with no origin and one edge touch", () => {
    const response = browserOnlyTrace({ ...browserFacts, queryKeys: ["language"] });
    expect(TraceReadResponse.parse(response)).toEqual(response);
    expect(response.trace.origin).toBeNull();
    expect(response.trace.meta).toBeNull();
    expect(response.trace.touches).toEqual([{ station: "edge", at: 0, ms: 21, outcome: "hit" }]);
    expect(response.runs).toEqual([]);
    expect(response.expiresAt).toBe("2026-09-23T19:00:00.000Z");
  });

  it("names each one with a fresh v4 id", () => {
    const idOf = () => browserOnlyTrace({ ...browserFacts, queryKeys: [] }).trace.id;
    const ids = new Set(Array.from({ length: 50 }, idOf));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(TRACE_ID_PATTERN);
  });

  it("still names it without randomUUID, which an insecure context lacks", () => {
    // A dev stack opened over http by its LAN address has `getRandomValues`
    // and no `randomUUID`; the id must still be a v4 the schema accepts.
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(array),
    });
    const idOf = () => browserOnlyTrace({ ...browserFacts, queryKeys: [] }).trace.id;
    const ids = new Set(Array.from({ length: 100 }, idOf));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(TRACE_ID_PATTERN);
  });

  it("bounds the browser's measurement as the server bounds its own", () => {
    const msOf = (ms: number) => browserOnlyTrace({ ...browserFacts, queryKeys: [], ms }).trace.ms;
    expect(msOf(12.345)).toBe(12.3);
    expect(msOf(-3)).toBe(0);
    expect(msOf(Number.NaN)).toBe(0);
    expect(msOf(10 * MAX_TRACE_MS)).toBe(MAX_TRACE_MS);
  });
});
