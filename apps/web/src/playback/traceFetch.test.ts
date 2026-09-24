import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceReadResponse } from "@zammy/shared/request-trace";
import { ApiError } from "../api.js";
import { TraceNotFound, TracingOff, fetchRecentTraces, fetchTrace } from "./traceFetch.js";

/**
 * The playback view's wire half (ADR-0029, "The change", item 7, as amended by ADR-0031):
 * the two reads the page makes, a stored trace by id and the recent list.
 *
 * What these pin is what the page is TOLD: a 404 on the trace read is final and names no id,
 * a 404 on the list means tracing is off (and is not an `ApiError` the page would retry), and
 * both are parsed rather than cast, so a record from a newer API fails loudly here instead of
 * animating garbage.
 */

const TRACE_ID = "3f2b7c1e-9a4d-4b6e-8c2f-1a2b3c4d5e6f";

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

  it("reads the trace route with no headers, uncached, and parses what comes back", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(storedBody()));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    const response = await fetchTrace(TRACE_ID, controller.signal);

    expect(response).toEqual(TraceReadResponse.parse(storedBody()));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`/api/v1/traces/${TRACE_ID}`);
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

describe("fetchRecentTraces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const summary = {
    id: TRACE_ID,
    route: "timeline_search",
    method: "GET",
    status: 200,
    startedAt: "2026-09-23T18:00:00.000Z",
    ms: 812.4,
    subject: { keywords: "flood warnings" },
  };

  it("reads the list route uncached, and parses the summaries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ traces: [{ ...summary, touches: [] }] }),
    );
    vi.stubGlobal("fetch", fetch);
    const traces = await fetchRecentTraces();
    expect(traces).toEqual([summary]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("/api/v1/traces");
    expect(init?.cache).toBe("no-store");
  });

  it("reads a 404 as tracing off, which the page does not retry", async () => {
    vi.stubGlobal("fetch", async () => json({ message: "Route GET:/api/v1/traces not found" }, 404));
    const failure = await fetchRecentTraces().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TracingOff);
    expect(failure).not.toBeInstanceOf(ApiError);
  });

  it("throws the ApiError every read throws for a 503", async () => {
    vi.stubGlobal("fetch", async () => json({ error: { message: "trace store unavailable" } }, 503));
    await expect(fetchRecentTraces()).rejects.toMatchObject({ status: 503 });
  });

  it("refuses a list longer than the API keeps", async () => {
    vi.stubGlobal("fetch", async () =>
      json({ traces: Array.from({ length: 11 }, () => summary) }),
    );
    await expect(fetchRecentTraces()).rejects.toThrow();
  });
});
