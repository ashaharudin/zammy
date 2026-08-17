import { z } from "zod";

/**
 * The Gemini flash-tier text client — this repo's ONLY external model call
 * (ADR-0011, "Labels").
 *
 * It is deliberately tiny, and the size is the argument. The one thing we ask a
 * model to do is name a storyline in a handful of words; anything larger here
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
 *  - a PACER, because the free tier publishes 15 requests per minute and the
 *    ceiling is per key, not per caller — see `admit` below;
 *  - no daily budget, no circuit breaker, no fixture mode. Currents has those
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
  /**
   * The provider's per-minute ceiling, in requests. 15 is the free tier's
   * published figure and the default in config; raise it with the plan.
   *
   * Enforced HERE rather than in each caller because the ceiling belongs to the
   * KEY, and five callers share one: the live ingest tail, the late-candidate
   * sweep, the nightly drift chore, the backfill and the operator CLI. A pace
   * set per caller is a pace the sixth caller forgets, and retries — which are
   * requests the callers cannot see — would be uncounted by all five.
   *
   * The scope of that enforcement is one CLIENT, so one PROCESS: the server's
   * three callers share the instance it builds, and each CLI builds its own. A
   * CLI run against a live server therefore puts two pacers on the key and up
   * to 2x this number through it — see STORYLINE-BACKFILL.md, "Operating it",
   * for the `--label-rate` lever, and the 429 cooldown below for what catches
   * it when nobody pulls that lever.
   *
   * 0 disables the pacer, for tests that assert on retry behaviour and have no
   * clock to spend on it.
   */
  maxRequestsPerMinute?: number;
  /**
   * How long a call may sit in the queue before giving up on the model.
   *
   * A pacer without this is an unbounded queue, and the live tail is exactly
   * where one would grow: ingest can promote storylines faster than 15/min for
   * a burst, and every waiter holds its members in memory. Past the cap the
   * call returns `ok: false` and the caller takes the bigram fallback — the
   * same move it already makes for a 503. 2 minutes is ~30 deep at 15/min,
   * more than an ingest batch produces.
   */
  maxRateWaitMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

/** The pacer's window. The published limit is per minute; so is this. */
const WINDOW_MS = 60_000;

/**
 * A 429's `Retry-After`, in ms, or null when it said nothing usable.
 *
 * Worth reading rather than falling back to our own backoff: the local pacer
 * models OUR spend, and a 429 is the API saying that model is wrong — usually
 * because something else shares the key (a second task, an operator's CLI, a
 * backfill on someone's laptop). The header is the only number in the exchange
 * that accounts for all of them.
 *
 * Both spellings, per RFC 9110: delta-seconds, or an HTTP-date.
 */
function parseRetryAfter(headers: Headers, now: number): number | null {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function createGeminiClient(options: GeminiOptions): TextGenerator {
  const {
    apiKey,
    model,
    baseUrl,
    thinkingLevel = "",
    timeoutMs = 8_000,
    maxRetries = 2,
    backoffBaseMs = 250,
    maxRequestsPerMinute = 15,
    maxRateWaitMs = 120_000,
    fetch: fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;

  const url = `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;

  /**
   * When each recent request was — or WILL BE — sent, oldest first. A sliding
   * window, not a tumbling counter: a counter that resets on the minute admits
   * up to 2x the limit across the boundary, which is the one burst the ceiling
   * exists to stop.
   */
  let sent: number[] = [];
  /** Set by a 429 that carried `Retry-After`: nothing goes out before this. */
  let cooldownUntil = 0;

  /** Hold a slot, keeping `sent` sorted so the window arithmetic stays a lookup. */
  function reserve(at: number): void {
    const after = sent.findIndex((when) => when > at);
    if (after < 0) sent.push(at);
    else sent.splice(after, 0, at);
  }

  /** Give a held slot back, for a caller that will not spend it after all. */
  function release(at: number): void {
    const held = sent.indexOf(at);
    if (held >= 0) sent.splice(held, 1);
  }

  function tooLong(wait: number): string {
    return `rate limited locally (${Math.round(wait / 1000)}s wait exceeds the ${Math.round(maxRateWaitMs / 1000)}s cap)`;
  }

  /**
   * Take the next slot, waiting for it if one is not free yet.
   *
   * Slots are RESERVED BEFORE the wait, not after it, and that is the whole
   * concurrency story — no mutex, no queue object. Two callers arriving in the
   * same tick each read a window that already contains the other's reservation,
   * so they stack rather than colliding.
   *
   * The wait is then a LOOP rather than one sleep, because the frontier can move
   * while a waiter sleeps towards it: another call's 429 sets `cooldownUntil`,
   * and a waiter that computed its ready time before the 429 arrived would wake
   * inside the cooldown and send the exact request the cooldown exists to stop.
   * So on waking we compare the cooldown against our reservation again, move the
   * reservation if it grew, and sleep the remainder — as many times as it takes.
   * Only the cooldown is re-read: the window slot was settled when we reserved,
   * and later arrivals hold later reservations, so re-deriving it from a window
   * that now contains them would make us queue behind callers who queued behind
   * us.
   *
   * Returns the reason to give up, or null to proceed.
   */
  async function admit(signal: AbortSignal | undefined): Promise<string | null> {
    if (maxRequestsPerMinute <= 0) return null;

    const arrivedAt = now();
    // Reservations in the future are not expired, however far ahead they sit.
    const cutoff = arrivedAt - WINDOW_MS;
    if (sent.length > 0 && sent[0]! <= cutoff) sent = sent.filter((when) => when > cutoff);

    // The oldest request that would still be inside the window if we sent now.
    // Once IT ages out there is room for one more, and that is our slot.
    const windowSlot =
      sent.length >= maxRequestsPerMinute
        ? sent[sent.length - maxRequestsPerMinute]! + WINDOW_MS
        : 0;
    let readyAt = Math.max(arrivedAt, windowSlot, cooldownUntil);
    if (readyAt - arrivedAt > maxRateWaitMs) return tooLong(readyAt - arrivedAt);

    reserve(readyAt);

    while (readyAt > now()) {
      await sleep(readyAt - now());
      // Only after an actual wait: a caller who arrived already aborted is the
      // fetch signal's business, and short-circuiting it here would skip the
      // request the abort path is written against.
      if (signal?.aborted) {
        // The slot was never spent, and a reservation nobody sends against
        // holds a live caller back for up to a window.
        release(readyAt);
        return "aborted";
      }
      if (cooldownUntil > readyAt) {
        // The cap is on the wait this caller has been asked to sit through in
        // total, so a cooldown landing mid-wait can push it past the cap the
        // same way a long `Retry-After` does on arrival.
        if (cooldownUntil - arrivedAt > maxRateWaitMs) {
          release(readyAt);
          return tooLong(cooldownUntil - arrivedAt);
        }
        release(readyAt);
        readyAt = cooldownUntil;
        reserve(readyAt);
      }
    }
    return null;
  }

  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      let lastReason = "no attempt made";

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) await sleep(backoffBaseMs * 2 ** (attempt - 1));

        // Inside the retry loop on purpose: a retry is another request against
        // the same ceiling, and a client that paced only first attempts would
        // send 3x the limit on the exact day the API is unhappy enough to make
        // every call retry.
        const refusal = await admit(request.signal);
        if (refusal) {
          // On a retry the first failure is still the story; the pacer only
          // explains why there was no second ask. A log line that said only
          // "rate limited locally" would hide the 503 that started it.
          return { ok: false, reason: attempt === 0 ? refusal : `${lastReason} (${refusal})` };
        }

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
          if (response.status === 429) {
            // We earned a 429 despite the pacer, so the pacer's model of the
            // spend is short — another process is on this key. Hold the WHOLE
            // client back for as long as the API asked, not just this call:
            // the other waiters are about to make the same mistake.
            const after = parseRetryAfter(response.headers, now());
            if (after !== null) cooldownUntil = Math.max(cooldownUntil, now() + after);
            continue;
          }
          // 5xx is worth a second ask; everything else is our bug and asking
          // again spends money to be told the same thing.
          if (response.status >= 500) continue;
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
