import { describe, expect, it } from "vitest";
import { loadConfig } from "@zammy/config";
import { createSummarizer, summarySharesLabelerPacer } from "./wiring.js";

/**
 * The wiring decisions that are invisible at runtime.
 *
 * `wiring.ts` exists so two entrypoints cannot build these objects differently,
 * and most of what it does is obvious enough that a test would only restate it.
 * These two are not: a summariser on the wrong pacer still works, and a
 * summariser with no model still returns an object — the difference shows up as
 * a rate limit nobody is watching, or as a preserve nobody notices is empty.
 */

const BASE = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/zammy",
  REDIS_URL: "redis://localhost:6379",
  CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
};

const config = (over: Record<string, string> = {}) =>
  loadConfig({ ...BASE, ...over } as NodeJS.ProcessEnv);

describe("summarySharesLabelerPacer", () => {
  it("shares the window while both models are on one key", () => {
    // The ceiling belongs to the KEY, not the model id — two clients each
    // counting their own window admit up to 2x it.
    expect(summarySharesLabelerPacer(config({ GEMINI_API_KEY: "one-key" }))).toBe(true);
  });

  it("stops sharing the moment a second key is configured", () => {
    // Handing the second key the first key's window would halve a rate limit
    // somebody configured a second key precisely to stop sharing.
    expect(
      summarySharesLabelerPacer(
        config({ GEMINI_API_KEY: "one-key", SUMMARY_API_KEY: "another-key" }),
      ),
    ).toBe(false);
  });

  it("shares when neither is set, which is the no-model case anyway", () => {
    expect(summarySharesLabelerPacer(config())).toBe(true);
  });

  it("treats a PRESENT but EMPTY second key as unset", () => {
    // Which is what `.env.example` and a blank dashboard field send. Read as a
    // key, it both silences the summariser (`?? ` does not fall through "")
    // and inverts this decision — the two lanes stop sharing a window on the
    // strength of a key that does not exist.
    expect(
      summarySharesLabelerPacer(config({ GEMINI_API_KEY: "one-key", SUMMARY_API_KEY: "" })),
    ).toBe(true);
  });
});

describe("createSummarizer", () => {
  it("has no generator and no model id without a key", () => {
    // A supported deployment state, not a degraded one — and the model id must
    // be null too, or every row would claim it came from a model that was never
    // called.
    const summarizer = createSummarizer(config());
    expect(summarizer.generator).toBeNull();
    expect(summarizer.modelId).toBeNull();
  });

  it("falls back to GEMINI_API_KEY, and records the summary model's id", () => {
    const summarizer = createSummarizer(
      config({ GEMINI_API_KEY: "one-key", SUMMARY_MODEL: "some-other-model" }),
    );
    expect(summarizer.generator).not.toBeNull();
    expect(summarizer.modelId).toBe("some-other-model");
  });

  it("still uses GEMINI_API_KEY when the second key is present and empty", () => {
    // The failure this pins is silent: a working labeler beside a summariser
    // with no model at all, from doing exactly what the docs say — copy
    // `.env.example`, fill in one key, turn the flag on.
    const summarizer = createSummarizer(
      config({ GEMINI_API_KEY: "one-key", SUMMARY_API_KEY: "" }),
    );
    expect(summarizer.generator).not.toBeNull();
    expect(summarizer.modelId).not.toBeNull();
  });

  it("builds a generator from SUMMARY_API_KEY alone", () => {
    // No GEMINI_API_KEY at all: labels fall back to the bigram extractor and
    // summaries still work, which is a legitimate configuration.
    const summarizer = createSummarizer(config({ SUMMARY_API_KEY: "summary-key" }));
    expect(summarizer.generator).not.toBeNull();
  });

  it("passes the gate's knobs through, so the pass and the rows agree", () => {
    const summarizer = createSummarizer(
      config({
        GEMINI_API_KEY: "one-key",
        SUMMARY_SETTLING_DAYS: "5",
        SUMMARY_RECOMPUTE_DELTA: "9",
        SUMMARY_CLIFF_DAYS: "20",
        SUMMARY_MAX_ATTEMPTS: "2",
        SUMMARY_SEGMENT_SAMPLE: "3",
      }),
    );
    expect(summarizer).toMatchObject({
      settlingDays: 5,
      recomputeDelta: 9,
      cliffDays: 20,
      maxAttempts: 2,
      sampleSize: 3,
    });
  });
});
