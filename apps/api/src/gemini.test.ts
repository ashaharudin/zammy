import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGeminiClient, createPacer, type FetchLike } from "./gemini.js";

/**
 * The one external model call (ADR-0011), tested against RECORDED RESPONSES and
 * an injected fetch — never the live API. A test suite that spends money is a
 * test suite people stop running, and a labeler whose retry behaviour is only
 * exercised in production is a labeler whose retry behaviour is unknown.
 *
 * What is worth asserting is narrow: the key never leaves the header, a 429 or
 * 503 is worth asking again, a 400 is not, and every failure mode arrives as
 * `ok: false` rather than as a throw — because the caller's next move is the
 * same fallback in all of them.
 *
 * The pacer's suite below is wider, because a rate limit is a claim about
 * WALL-CLOCK and the only honest way to test one is against a clock you own.
 */

const RESPONSES = JSON.parse(
  readFileSync(new URL("../../../fixtures/gemini-label-responses.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const OPTIONS = {
  apiKey: "test-key",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.example/v1beta",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Replays the given responses in order, recording what it was asked. */
function recorder(...responses: Array<Response | Error>): {
  fetch: FetchLike;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next!;
    },
  };
}

const noSleep = async () => {};

describe("the Gemini client", () => {
  it("asks the configured model and returns the text", async () => {
    const { fetch, calls } = recorder(jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({ ok: true, text: "Fort Hood Crash" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.example/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("carries the key in a header and never in the URL", async () => {
    // A key in a query string reaches access logs, proxies and error reports;
    // §5.5 says it must never appear in output at all.
    const { fetch, calls } = recorder(jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    await client.generate({ prompt: "name this story" });

    const { url, init } = calls[0]!;
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("pins temperature to 0 by default, so a replay names the story the same", async () => {
    const { fetch, calls } = recorder(jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    await client.generate({ prompt: "name this story" });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
  });

  it("asks for no thinking by default, and passes a level through when set", async () => {
    // Measured 2026-08-14: naming a story is recall, not reasoning. A 3.x flash
    // model spends ~300 thinking tokens on it and bills them as output, while
    // flash-lite with the field omitted spends none and answers the same.
    const bare = recorder(jsonResponse(RESPONSES.ok));
    await createGeminiClient({ ...OPTIONS, fetch: bare.fetch, sleep: noSleep }).generate({
      prompt: "name this story",
    });
    expect(
      JSON.parse(bare.calls[0]!.init.body as string).generationConfig.thinkingConfig,
    ).toBeUndefined();

    const thinking = recorder(jsonResponse(RESPONSES.ok));
    await createGeminiClient({
      ...OPTIONS,
      thinkingLevel: "low",
      fetch: thinking.fetch,
      sleep: noSleep,
    }).generate({ prompt: "name this story" });
    expect(
      JSON.parse(thinking.calls[0]!.init.body as string).generationConfig.thinkingConfig,
    ).toEqual({ thinkingLevel: "low" });
  });

  it("does not retry a retired model, and says which one", async () => {
    // Measured live: `gemini-2.5-flash` still appears under /models and 404s on
    // use — "no longer available to new users". Asking again cannot help, and
    // the reason has to reach the operator rather than dying as "unavailable".
    const { fetch, calls } = recorder(jsonResponse(RESPONSES.retired_model, 404));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "http 404",
      failure: "unreachable",
    });
    expect(calls).toHaveLength(1);
  });

  it("retries a 503 and returns the answer that follows", async () => {
    const { fetch, calls } = recorder(
      jsonResponse(RESPONSES.overloaded, 503),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({ ok: true, text: "Fort Hood Crash" });
    expect(calls).toHaveLength(2);
  });

  it("retries a 429, and gives up as unavailable rather than throwing", async () => {
    const { fetch, calls } = recorder(jsonResponse({ error: {} }, 429));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep, maxRetries: 2 });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({ ok: false, reason: "http 429", failure: "unreachable" });
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 400 — that is our prompt's bug, not the model's mood", async () => {
    const { fetch, calls } = recorder(jsonResponse({ error: {} }, 400));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({ ok: false, reason: "http 400", failure: "unreachable" });
    expect(calls).toHaveLength(1);
  });

  it("reports a blocked prompt as unavailable, with the reason kept", async () => {
    const { fetch } = recorder(jsonResponse(RESPONSES.blocked));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "blocked: SAFETY",
      // The model looked at the prompt and declined it — a verdict on the
      // prompt, not a failure to reach the model. The summariser counts this
      // against the span; the labeler does not care either way.
      failure: "answered",
    });
  });

  it("reports a candidate with no text as unavailable, with its finish reason", async () => {
    // Recorded from the live API: a reasoning model spent its whole output
    // budget on thoughts and returned a candidate with no content at all.
    // `maxOutputTokens` counts thinking, which is why the cap is now 2048 —
    // `gemma-4-26b-a4b-it` alone needs ~700 of it just to finish thinking.
    const { fetch } = recorder(jsonResponse(RESPONSES.truncated));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "empty (MAX_TOKENS)",
      failure: "answered",
    });
  });

  it("reads the answer past a reasoning model's thought parts", async () => {
    // The regression that cost production a night of labels (2026-08-28): the
    // client joined every part, so the answer arrived with the whole thinking
    // transcript in front of it, failed `validateLabel`'s 2-5 word contract,
    // and every storyline silently took the bigram fallback. Same model id and
    // same request as the `ok` fixture two weeks earlier — only the response
    // shape moved.
    const { fetch } = recorder(jsonResponse(RESPONSES.thinking));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: true,
      text: "Fort Hood Crash",
    });
  });

  it("reports a candidate that is thoughts and nothing else", async () => {
    // The budget ran out between the thinking and the answer. Distinct from
    // `truncated` above, which carried no content at all — this one is the
    // reason to raise `maxOutputTokens`, and the log line has to say which.
    const thoughtsOnly = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "thinking...", thought: true }] },
          finishReason: "MAX_TOKENS",
        },
      ],
    };
    const { fetch } = recorder(jsonResponse(thoughtsOnly));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "thoughts only (MAX_TOKENS)",
      failure: "answered",
    });
  });

  it("survives a response that is not the shape we know", async () => {
    const { fetch } = recorder(jsonResponse({ candidates: "surprise" }));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "unexpected response shape",
      // OUR problem to fix — this model has changed response shape under a
      // pinned id before — so it must not count against whatever was asked.
      failure: "unreachable",
    });
  });

  it("survives a network fault, retrying and then reporting it", async () => {
    const { fetch, calls } = recorder(new Error("ECONNRESET"));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep, maxRetries: 1 });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({
      ok: false,
      reason: "network: ECONNRESET",
      failure: "unreachable",
    });
    expect(calls).toHaveLength(2);
  });

  it("stops immediately when the caller aborts", async () => {
    // The caller's deadline is final — unlike our own timeout, which is worth
    // one more ask because the fallback is waiting either way.
    const controller = new AbortController();
    const { fetch, calls } = recorder(new Error("aborted"));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });
    controller.abort();

    const result = await client.generate({
      prompt: "name this story",
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, reason: "aborted", failure: "unreachable" });
    expect(calls).toHaveLength(1);
  });
});

/**
 * The pacer (the free tier publishes 15 requests/minute, per key).
 *
 * Tested on a VIRTUAL clock — `sleep` advances `now` and nothing else does — so
 * the assertions are about how much time the client insisted on spending rather
 * than about how long the suite takes to run. A rate-limit test that really
 * waits a minute is a rate-limit test nobody runs.
 */
describe("the Gemini client's rate limiter", () => {
  /** A clock the client moves only by sleeping. */
  function clock() {
    let at = 0;
    return {
      now: () => at,
      sleep: async (ms: number) => {
        at += ms;
      },
      advance: (ms: number) => {
        at += ms;
      },
      elapsed: () => at,
    };
  }

  /** Like `recorder`, but stamps each request with the virtual time it went out. */
  function paced(now: () => number, ...responses: Array<Response | Error>) {
    const at: number[] = [];
    let index = 0;
    const fetch: FetchLike = async () => {
      at.push(now());
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next!.clone();
    };
    return { fetch, at };
  }

  it("spaces requests so the per-minute ceiling is never exceeded", async () => {
    const time = clock();
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRequestsPerMinute: 3,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(await client.generate({ prompt: "name this story" })).toEqual({
        ok: true,
        text: "Fort Hood Crash",
      });
    }

    // Three go out at once; the fourth waits for the first to age out.
    expect(at).toEqual([0, 0, 0, 60_000]);
  });

  it("slides the window rather than tumbling it", async () => {
    // The failure this rules out: a counter that resets on the minute admits a
    // full limit at :59 and another at :01 — twice the ceiling, in the two
    // seconds most likely to be a burst.
    const time = clock();
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRequestsPerMinute: 2,
    });

    await client.generate({ prompt: "one" });
    time.advance(30_000);
    await client.generate({ prompt: "two" });
    await client.generate({ prompt: "three" });

    // The third waits on the FIRST request's own minute, not on a shared one.
    expect(at).toEqual([0, 30_000, 60_000]);
  });

  it("counts retries against the ceiling, not just first attempts", async () => {
    // The day every call retries is the day the ceiling matters most, and a
    // client that paced only first attempts would send 3x the limit on it.
    const time = clock();
    const { fetch, at } = paced(
      time.now,
      jsonResponse(RESPONSES.overloaded, 503),
      jsonResponse(RESPONSES.overloaded, 503),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRequestsPerMinute: 2,
      maxRetries: 2,
      backoffBaseMs: 0,
    });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: true,
      text: "Fort Hood Crash",
    });
    expect(at).toEqual([0, 0, 60_000]);
  });

  it("gives up on the model rather than queueing past the wait cap", async () => {
    // An unbounded queue is the live tail's failure mode: a promotion burst
    // outruns 15/min and every waiter holds its members in memory. Past the cap
    // the caller takes the bigram fallback, which is what it does for a 503.
    const time = clock();
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRequestsPerMinute: 1,
      maxRateWaitMs: 10_000,
    });

    await client.generate({ prompt: "one" });
    const second = await client.generate({ prompt: "two" });

    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toMatch(/^rate limited locally/);
    // Refused locally, so it cost no request and no wall-clock.
    expect(at).toEqual([0]);
    expect(time.elapsed()).toBe(0);
  });

  it("holds the whole client back for a 429's Retry-After", async () => {
    // A 429 despite the pacer means something else is on this key. The header
    // is the only number in the exchange that accounts for both of us, and it
    // has to outlive the call that earned it.
    const time = clock();
    const { fetch, at } = paced(
      time.now,
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "45" },
      }),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRequestsPerMinute: 100,
      maxRetries: 0,
      backoffBaseMs: 0,
    });

    expect(await client.generate({ prompt: "one" })).toEqual({
      ok: false,
      reason: "http 429",
      failure: "unreachable",
    });
    // A different call, well under the window's ceiling — and still held.
    expect(await client.generate({ prompt: "two" })).toEqual({
      ok: true,
      text: "Fort Hood Crash",
    });
    expect(at).toEqual([0, 45_000]);
  });

  it("also reads Retry-After as an HTTP-date", async () => {
    const time = clock();
    const { fetch, at } = paced(
      time.now,
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "retry-after": new Date(20_000).toUTCString() },
      }),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRetries: 0,
      backoffBaseMs: 0,
    });

    await client.generate({ prompt: "one" });
    await client.generate({ prompt: "two" });

    expect(at).toEqual([0, 20_000]);
  });

  it("stacks concurrent callers instead of letting them collide", async () => {
    // Slots are reserved before the wait, so two callers arriving in the same
    // tick each see the other's reservation. The live tail and the nightly
    // chore share one client and can overlap.
    //
    // Asserted on the WAITS rather than on when each fetch went out: the fake
    // clock is shared, so a caller that jumps it forward drags the stamps of
    // the callers still suspended behind it. What the pacer actually decides is
    // who waits and for how long.
    const time = clock();
    const waits: number[] = [];
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      now: time.now,
      sleep: async (ms) => {
        waits.push(ms);
        time.advance(ms);
      },
      maxRequestsPerMinute: 2,
    });

    const results = await Promise.all([
      client.generate({ prompt: "one" }),
      client.generate({ prompt: "two" }),
      client.generate({ prompt: "three" }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(at).toHaveLength(3);
    // Two admitted free, and exactly one made to wait out the window — where a
    // pacer that reserved after sleeping would have let all three straight
    // through, each having read a window with room in it.
    expect(waits).toEqual([60_000]);
  });

  /**
   * A virtual clock with real suspension, for the concurrency tests.
   *
   * `clock()` above advances the moment `sleep` is called, which is enough when
   * one caller sleeps at a time but wrong when several do: the assertion we want
   * here is about what a sleeping waiter does when the world changes UNDER it,
   * so the waiter has to actually stay suspended while another caller's response
   * is handled. `sleep` therefore parks a timer, and `run` fires them in time
   * order — the earliest first, draining the microtask queue after each — so the
   * interleaving is the one a real event loop would produce, deterministically.
   */
  function scheduler() {
    let at = 0;
    let parked: Array<{ due: number; wake: () => void }> = [];
    return {
      now: () => at,
      sleep: (ms: number) =>
        new Promise<void>((wake) => {
          parked.push({ due: at + ms, wake });
        }),
      /** Run until nothing is sleeping. */
      async run(): Promise<void> {
        for (let guard = 0; guard < 100; guard += 1) {
          // A real macrotask, so everything the callers can do at the current
          // time — send, park, handle a response — has happened before we move
          // the clock. Drained FIRST, so the callers who never slept get to run
          // at time zero rather than at the first sleeper's wake-up.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (parked.length === 0) return;
          parked.sort((a, b) => a.due - b.due);
          const next = parked.shift()!;
          at = Math.max(at, next.due);
          next.wake();
        }
      },
    };
  }

  it("holds waiters already sleeping when another call's 429 starts a cooldown", async () => {
    // The bug this rules out: a waiter computes its ready time, sleeps, and
    // wakes into a cooldown that was set while it slept — sending the exact
    // request the cooldown exists to stop, and doing it on behalf of a client
    // whose whole claim is that nothing goes out before `cooldownUntil`.
    //
    // Three callers arrive together against a 1/min ceiling, so the first sends
    // and the other two are parked at :60 and :120. The first earns a 429 asking
    // for 90 seconds.
    const time = scheduler();
    const { fetch, at } = paced(
      time.now,
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "90" },
      }),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      now: time.now,
      sleep: time.sleep,
      maxRequestsPerMinute: 1,
      maxRetries: 0,
      backoffBaseMs: 0,
      maxRateWaitMs: 300_000,
    });

    const calls = Promise.all([
      client.generate({ prompt: "one" }),
      client.generate({ prompt: "two" }),
      client.generate({ prompt: "three" }),
    ]);
    await time.run();
    const results = await calls;

    expect(results[0]).toEqual({ ok: false, reason: "http 429", failure: "unreachable" });
    expect(results[1]).toEqual({ ok: true, text: "Fort Hood Crash" });
    expect(results[2]).toEqual({ ok: true, text: "Fort Hood Crash" });
    // The waiter due at :60 held rather than firing inside the cooldown — and
    // did not fire AT the cooldown's end either: the :120 reservation was
    // already there, so a :90 send would have put two requests 30s apart under
    // a 1/min ceiling. It re-derived a window slot behind the unmoved :120
    // waiter instead.
    expect(at).toEqual([0, 120_000, 180_000]);
    expect(at.slice(1).every((sentAt) => sentAt >= 90_000)).toBe(true);
  });

  it("keeps the ceiling when a cooldown relocates several waiters at once", async () => {
    // The burst this rules out: every waiter parked at bare `cooldownUntil`
    // fires in the same tick the cooldown expires — under a 2/min ceiling, a
    // cooldown landing across two reserved slots would discharge them together
    // and spend the whole minute's budget at one instant, re-earning exactly
    // the 429 the cooldown answered. Relocated waiters must re-derive a window
    // slot, not just a cooldown floor.
    const time = scheduler();
    const { fetch, at } = paced(
      time.now,
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "70" },
      }),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      now: time.now,
      sleep: time.sleep,
      maxRequestsPerMinute: 2,
      maxRetries: 0,
      backoffBaseMs: 0,
      maxRateWaitMs: 300_000,
    });

    // Two send at :0 (the first earns the 429 → cooldown to :70), two are
    // parked at :60 inside the cooldown, one at :120 beyond it.
    const calls = Promise.all(
      ["one", "two", "three", "four", "five"].map((prompt) => client.generate({ prompt })),
    );
    await time.run();
    const results = await calls;

    expect(results.slice(1).every((result) => result.ok)).toBe(true);
    // No sliding minute may ever hold more than the ceiling — including the
    // minute straddling the cooldown's expiry.
    for (const sentAt of at) {
      const inWindow = at.filter((t) => t > sentAt - 60_000 && t <= sentAt);
      expect(inWindow.length).toBeLessThanOrEqual(2);
    }
  });

  it("abandons a long wait when the caller aborts during it", async () => {
    const time = clock();
    const controller = new AbortController();
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      now: time.now,
      sleep: async (ms) => {
        time.advance(ms);
        controller.abort();
      },
      maxRequestsPerMinute: 1,
    });

    await client.generate({ prompt: "one" });
    const second = await client.generate({ prompt: "two", signal: controller.signal });

    expect(second).toEqual({ ok: false, reason: "aborted", failure: "unreachable" });
    expect(at).toEqual([0]);
  });

  it("gives the slot back when a waiter aborts, rather than banking a phantom send", async () => {
    // A reservation is a promise to spend a request. An abandoned one that stays
    // in the window is a request nobody made, and it holds the next live caller
    // back for up to a minute on the strength of it.
    const time = clock();
    const controller = new AbortController();
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      now: time.now,
      sleep: async (ms) => {
        time.advance(ms);
        controller.abort();
      },
      maxRequestsPerMinute: 1,
    });

    await client.generate({ prompt: "one" });
    await client.generate({ prompt: "two", signal: controller.signal });
    // :60 now, the first request has aged out, and the abandoned :60 slot must
    // not be standing where the third caller's own slot is.
    await client.generate({ prompt: "three" });

    expect(at).toEqual([0, 60_000]);
  });

  it("keeps the failure that caused a retry when the pacer blocks the retry", async () => {
    // A 429 with a long Retry-After puts the retry past the wait cap. The
    // operator needs to read "429, and we did not ask again", not a bare
    // "rate limited locally" that hides who said no first.
    const time = clock();
    const { fetch } = paced(
      time.now,
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "retry-after": "600" },
      }),
      jsonResponse(RESPONSES.ok),
    );
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRetries: 1,
      backoffBaseMs: 0,
      maxRateWaitMs: 120_000,
    });

    const result = await client.generate({ prompt: "name this story" });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe(
      "http 429 (rate limited locally (600s wait exceeds the 120s cap))",
    );
  });

  it("can be switched off, for callers that pace themselves", async () => {
    const time = clock();
    const { fetch, at } = paced(time.now, jsonResponse(RESPONSES.ok));
    const client = createGeminiClient({
      ...OPTIONS,
      fetch,
      sleep: time.sleep,
      now: time.now,
      maxRequestsPerMinute: 0,
    });

    for (let i = 0; i < 5; i += 1) await client.generate({ prompt: "name this story" });

    expect(at).toEqual([0, 0, 0, 0, 0]);
  });
});

/**
 * A pacer shared by two clients (ADR-0023).
 *
 * The reason this exists at all: the per-minute ceiling belongs to the KEY, and
 * `SUMMARY_MODEL` made "one process, one model" false. Two clients each counting
 * their own window admit up to 2x the limit — the same overshoot two PROCESSES
 * on one key produce, except this one is inside a single process and therefore
 * entirely preventable.
 */
describe("a shared pacer", () => {
  function clock() {
    let at = 0;
    return {
      now: () => at,
      sleep: async (ms: number) => {
        at += ms;
      },
    };
  }

  function paced(now: () => number, response: Response) {
    const at: number[] = [];
    const fetch: FetchLike = async () => {
      at.push(now());
      return response.clone();
    };
    return { fetch, at };
  }

  it("counts two models' calls against ONE window", async () => {
    const time = clock();
    const first = paced(time.now, jsonResponse(RESPONSES.ok));
    const second = paced(time.now, jsonResponse(RESPONSES.ok));
    const pacer = createPacer({
      maxRequestsPerMinute: 2,
      sleep: time.sleep,
      now: time.now,
    });
    const shared = { ...OPTIONS, sleep: time.sleep, now: time.now, pacer };
    const labeler = createGeminiClient({ ...shared, fetch: first.fetch });
    const summarizer = createGeminiClient({
      ...shared,
      model: "another-model",
      fetch: second.fetch,
    });

    await labeler.generate({ prompt: "name this story" });
    await summarizer.generate({ prompt: "summarise this morning" });
    // The third call is the one the ceiling of 2 has to push into the next
    // window — and it does not matter which client makes it.
    await labeler.generate({ prompt: "name this story" });

    expect(first.at).toEqual([0, 60_000]);
    expect(second.at).toEqual([0]);
  });

  it("lets a 429 on one client hold the other back", async () => {
    const time = clock();
    const limited = paced(
      time.now,
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    const other = paced(time.now, jsonResponse(RESPONSES.ok));
    const pacer = createPacer({
      maxRequestsPerMinute: 100,
      sleep: time.sleep,
      now: time.now,
    });
    const shared = { ...OPTIONS, sleep: time.sleep, now: time.now, pacer, maxRetries: 0 };

    await createGeminiClient({ ...shared, fetch: limited.fetch }).generate({
      prompt: "name this story",
    });
    await createGeminiClient({ ...shared, fetch: other.fetch }).generate({
      prompt: "summarise this morning",
    });

    // The other waiter is about to make the same mistake, and the cooldown is
    // the client's — now the pacer's — rather than the call's.
    expect(other.at).toEqual([30_000]);
  });
});
