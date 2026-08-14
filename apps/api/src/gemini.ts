import { z } from "zod";

/**
 * The Gemini flash-tier text client — this repo's ONLY external model call
 * (ADR-0011, "Labels").
 *
 * It is deliberately tiny, and the size is the argument. The one thing we ask a
 * model to do is name a storyline in two or three words; anything larger here
 * would be scope this product has not decided it wants, and every call already
 * has a deterministic fallback, so the client's job is to answer or get out of
 * the way quickly.
 *
 * What it borrows from `@zammy/currents-client` (§5.3) and what it does not:
 *
 *  - injectable `fetch`, clock and sleep, so retry behaviour is tested offline
 *    against RECORDED responses and never against the live API;
 *  - retries on 429, 5xx and network faults only — a 400 is our prompt's bug and
 *    a retry buys the same answer twice;
 *  - NO quota governor, no circuit breaker, no fixture mode. Currents has those
 *    because a failed search is a reader staring at an empty page; a failed
 *    label is a storyline that renders without one. `unavailable` is a normal
 *    return value here, not an incident.
 *
 * The key travels in `x-goog-api-key`, never in the URL: query strings reach
 * logs and proxies, and §5.5 says the key must never appear in output.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiOptions {
  apiKey: string;
  /** Flash tier per ADR-0011; the exact version is config's knob. */
  model: string;
  baseUrl: string;
  /**
   * How much the model may think before answering, for the families that
   * reason by default (Gemini 3.x). Empty — the default — omits the field.
   *
   * MEASURED against the live API on 2026-08-14, asking for the Fort Hood
   * label: `gemini-3.7-flash` spends ~300 thinking tokens at its floor
   * (`low`; `none` and `minimal` are 400s) and ~460 with no setting at all,
   * while `gemini-3.1-flash-lite` with the field OMITTED spends zero and
   * returns the same three words. Thinking bills as output, so that is the
   * whole per-label cost, spent on a task that is recall rather than
   * reasoning. Left as a knob because the families spell it differently and a
   * later model may need it.
   */
  thinkingLevel?: string;
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  backoffBaseMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface GenerateRequest {
  prompt: string;
  /**
   * A label is three words, but this cap is NOT three words' worth. Measured
   * 2026-08-14: `maxOutputTokens` counts a reasoning model's THINKING tokens
   * too, so a 32-token cap on `gemini-3.7-flash` returned an empty candidate
   * with `finishReason: MAX_TOKENS` — the whole budget spent before a word was
   * written. Generous, because it costs nothing unless it is used, and the
   * chatty-model guard the small cap was reaching for is `validateLabel`'s job
   * anyway.
   */
  maxOutputTokens?: number;
  /** 0 by default: the same coverage should name the same story on a replay. */
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Either the model answered or it did not. There is no third case worth
 * modelling: every caller's response to a failure is the same fallback, so a
 * taxonomy of failures here would be a taxonomy nobody branches on. The reason
 * survives as a string for the log line and the CLI's report.
 */
export type GenerateResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** What the labeler needs from a model. Two implementations satisfy it. */
export interface TextGenerator {
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

/**
 * `generateContent`'s response, narrowed to the one field we read. Parsed
 * rather than indexed into: a shape change upstream must read as "no label
 * this time", not as `undefined` reaching the validator.
 */
const GenerateContentResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string() }).partial()).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

export function createGeminiClient(options: GeminiOptions): TextGenerator {
  const {
    apiKey,
    model,
    baseUrl,
    thinkingLevel = "",
    timeoutMs = 8_000,
    maxRetries = 2,
    backoffBaseMs = 250,
    fetch: fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const url = `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;

  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      let lastReason = "no attempt made";

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) await sleep(backoffBaseMs * 2 ** (attempt - 1));

        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = request.signal
          ? AbortSignal.any([request.signal, timeout])
          : timeout;

        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: request.prompt }] }],
              generationConfig: {
                temperature: request.temperature ?? 0,
                maxOutputTokens: request.maxOutputTokens ?? 256,
                candidateCount: 1,
                ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
              },
            }),
            signal,
          });
        } catch (error) {
          // The caller's own abort is final; ours is a timeout worth retrying
          // once, since the fallback is waiting either way.
          if (request.signal?.aborted) return { ok: false, reason: "aborted" };
          lastReason = `network: ${(error as Error).message}`;
          continue;
        }

        if (!response.ok) {
          lastReason = `http ${response.status}`;
          // 429 and 5xx are worth a second ask; everything else is our bug and
          // asking again spends money to be told the same thing.
          if (response.status === 429 || response.status >= 500) continue;
          return { ok: false, reason: lastReason };
        }

        let parsed;
        try {
          parsed = GenerateContentResponse.safeParse(await response.json());
        } catch (error) {
          return { ok: false, reason: `unreadable body: ${(error as Error).message}` };
        }
        if (!parsed.success) return { ok: false, reason: "unexpected response shape" };

        const blocked = parsed.data.promptFeedback?.blockReason;
        if (blocked) return { ok: false, reason: `blocked: ${blocked}` };

        const text = parsed.data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("")
          .trim();
        if (!text) {
          const finish = parsed.data.candidates?.[0]?.finishReason;
          return { ok: false, reason: finish ? `empty (${finish})` : "empty response" };
        }
        return { ok: true, text };
      }

      return { ok: false, reason: lastReason };
    },
  };
}
