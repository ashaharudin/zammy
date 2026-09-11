import { describe, expect, it } from "vitest";
import { loadConfig } from "@zammy/config";
import { STORYLINE_BAR, storylineBar } from "./storyline-bar.js";
import { createLinkerConfig, createSummarizer, summarySharesLabelerPacer } from "./wiring.js";

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

  it("shares when both variables hold the SAME key", () => {
    // Which is which variable it was read from, not which key is spent — and
    // spelling one key twice must not buy two windows on it.
    expect(
      summarySharesLabelerPacer(
        config({ GEMINI_API_KEY: "one-key", SUMMARY_API_KEY: "one-key" }),
      ),
    ).toBe(true);
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

describe("the bar a group is judged at", () => {
  /**
   * The bar a TEST asserts against is the bar production ships.
   *
   * This is the assertion the fourteen-field copies made impossible. Every one
   * of them was written out by hand — `test-support.ts` as a whole second
   * default, ~18 more across 13 test files, and two operator CLIs — so a test
   * asserting formation behaviour was asserting against a bar free to drift from
   * `createLinkerConfig`'s, and nothing in the suite would have gone red on the
   * day it did. `STORYLINE_BAR` is the only copy now, and this is what holds it
   * to the environment's defaults.
   *
   * `config()` sets no `STORYLINE_*` variable and no key, so every field of the
   * two objects is comparable: the zod defaults in `packages/config` and the
   * literals in `storyline-bar.ts` are the last duplication left, and moving a
   * measured threshold in exactly one of them fails here.
   */
  it("agrees with the shipped defaults, field for field", () => {
    expect(createLinkerConfig(config())).toEqual(storylineBar());
  });

  it("puts the ENVIRONMENT on the shipped bar, rather than a literal of its own", () => {
    // Every configured field moved off its default at once, so a variable
    // dropped from `linkerBarFromEnv` shows up as the shipped value standing
    // where the operator's should be — the failure a per-field test would only
    // catch one field at a time.
    const moved = createLinkerConfig(
      config({
        STORYLINE_ANCHOR_MAX_SHARE: "0.007",
        STORYLINE_ANCHOR_DF_FLOOR: "13",
        STORYLINE_MASS_THRESHOLD_V2: "17",
        STORYLINE_DORMANCY_DAYS: "45",
        STORYLINE_DORMANT_STRICTNESS: "2.5",
        STORYLINE_MERGE_BRIDGES: "3",
        STORYLINE_NARROW_RETRIEVAL: "true",
        STORYLINE_MAX_BRIDGING_QUALIFIERS: "2",
        STORYLINE_DF_WINDOW_DAYS: "21",
        APP_TIMEZONE: "America/Edmonton",
        GEMINI_API_KEY: "a-key",
      }),
    );
    expect(moved).toEqual({
      enabled: true,
      rules: {
        anchorMaxShare: 0.007,
        anchorDfFloor: 13,
        massThreshold: 17,
        dormancyDays: 45,
        dormantStrictness: 2.5,
      },
      mergeBridges: 3,
      coherenceGate: true,
      // Not env-derived and deliberately so: replaying a verdict already
      // recorded is not a knob an operator tunes per deployment. The one caller
      // that may decline says it on the command line (`--ignore-refusals`).
      honourRefusals: true,
      narrowRetrieval: true,
      maxBridgingQualifiers: 2,
      storyDf: { windowDays: 21, timeZone: "America/Edmonton" },
      timeZone: "America/Edmonton",
    });
  });

  it("holds the gate to a key, whichever way the flag is set", () => {
    // `STORYLINE_COHERENCE_GATE` defaults to TRUE, so this is the one field
    // where `STORYLINE_BAR` and the flag's own default disagree: the bar ships
    // it off because no key is configured, and there is no verdict to wait for.
    expect(createLinkerConfig(config()).coherenceGate).toBe(false);
    expect(createLinkerConfig(config({ STORYLINE_COHERENCE_GATE: "true" })).coherenceGate).toBe(
      false,
    );
    expect(
      createLinkerConfig(config({ STORYLINE_COHERENCE_GATE: "false", GEMINI_API_KEY: "a-key" }))
        .coherenceGate,
    ).toBe(false);
    expect(createLinkerConfig(config({ GEMINI_API_KEY: "a-key" })).coherenceGate).toBe(true);
  });

  it("cannot be moved by one caller for the next", () => {
    // Why `storylineBar` is a function. `STORYLINE_BAR` is ONE object now, so a
    // caller reaching into a nested field of a bar it was handed would move the
    // bar for every test in the process — this change's own accident, arriving
    // from the other direction.
    const mine = storylineBar();
    mine.rules.massThreshold = 1;
    expect(storylineBar().rules.massThreshold).toBe(20);
    expect(STORYLINE_BAR.rules.massThreshold).toBe(20);
  });
});
