import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGeminiClient, type FetchLike } from "./gemini.js";

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
    expect(body.generationConfig.maxOutputTokens).toBe(256);
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

    expect(result).toEqual({ ok: false, reason: "http 429" });
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 400 — that is our prompt's bug, not the model's mood", async () => {
    const { fetch, calls } = recorder(jsonResponse({ error: {} }, 400));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({ ok: false, reason: "http 400" });
    expect(calls).toHaveLength(1);
  });

  it("reports a blocked prompt as unavailable, with the reason kept", async () => {
    const { fetch } = recorder(jsonResponse(RESPONSES.blocked));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "blocked: SAFETY",
    });
  });

  it("reports a candidate with no text as unavailable, with its finish reason", async () => {
    // Recorded from the live API: a reasoning model spent its whole output
    // budget on thoughts and returned a candidate with no content at all.
    // `maxOutputTokens` counts thinking, which is why the cap is now 256.
    const { fetch } = recorder(jsonResponse(RESPONSES.truncated));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "empty (MAX_TOKENS)",
    });
  });

  it("survives a response that is not the shape we know", async () => {
    const { fetch } = recorder(jsonResponse({ candidates: "surprise" }));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep });

    expect(await client.generate({ prompt: "name this story" })).toEqual({
      ok: false,
      reason: "unexpected response shape",
    });
  });

  it("survives a network fault, retrying and then reporting it", async () => {
    const { fetch, calls } = recorder(new Error("ECONNRESET"));
    const client = createGeminiClient({ ...OPTIONS, fetch, sleep: noSleep, maxRetries: 1 });

    const result = await client.generate({ prompt: "name this story" });

    expect(result).toEqual({ ok: false, reason: "network: ECONNRESET" });
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

    expect(result).toEqual({ ok: false, reason: "aborted" });
    expect(calls).toHaveLength(1);
  });
});
