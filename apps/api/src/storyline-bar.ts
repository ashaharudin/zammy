import type { StoryDfConfig } from "./story-df.js";
import type { LinkRules } from "./storyline-link.js";
import type { LinkerConfig } from "./storyline-linker.js";

/**
 * The bar a group is judged at, as it ships (ADR-0011) — one object, which is
 * the thing `wiring.ts`'s header asks for and could not deliver on its own.
 *
 * `createLinkerConfig` fixed the bar for the two PRODUCTION entrypoints and
 * nothing else, so the same fifteen fields were written out again at nineteen
 * sites: two operator CLIs, a second default in `test-support.ts`, and ~18 more
 * across 13 test files. Re-measuring a threshold was a nineteen-file change,
 * and — worse — a test asserting formation behaviour was asserting against a
 * COPY of the bar, free to drift from the one production runs without a single
 * test going red. `wiring.test.ts` now pins the two together.
 *
 * A value and not a function, because ADR-0011 requires the decision functions
 * stay pure and swappable: the bar is data handed to them, and `storylineBar`
 * below is only the adapter that applies a named divergence to it.
 *
 * Type-only imports on purpose. Every test that asserts against the bar imports
 * this module, and a runtime edge to `storyline-linker.ts` would drag
 * `@zammy/storage` into the pure ones (`storyline-link.test.ts`).
 *
 * The values are the measured ones, and docs/STORYLINE-LINKING.md ("The pinned
 * values") records what measured them and which are honestly unmeasured. They
 * are duplicated from the `packages/config` zod defaults, which is the one
 * duplication left and the only one a test can watch: `wiring.test.ts` asserts
 * `createLinkerConfig(loadConfig(defaults))` deep-equals `storylineBar()`, so
 * moving a default in exactly one of the two places goes red.
 */
export const STORYLINE_BAR: LinkerConfig = Object.freeze({
  // Structural, not optional: no storylines means no timeline rows.
  enabled: true,
  rules: Object.freeze({
    // 0.002 of a 16,000-article fortnight is ~32 articles. Measured: at the
    // pinned bar the largest storyline is 0.18% of the corpus against
    // ADR-0009's 99% percolation failure.
    anchorMaxShare: 0.002,
    // Unmeasured, and it never binds in English — the share is already 32 at a
    // 16,000-article window, so the floor only matters for a language whose
    // fortnight holds under ~5,000 articles.
    anchorDfFloor: 10,
    massThreshold: 20,
    // Both unmeasured for the same reason: a 31-day archive replays 30, 90 and
    // 365 identically, because nothing in it is ever dormant.
    dormancyDays: 90,
    dormantStrictness: 1.5,
  }),
  // K. Measured: K=1 quadruples merges (826 → 3,416), which is the
  // single-bridge percolation ADR-0011 predicted.
  mergeBridges: 2,
  /**
   * OFF, which is what a bar with no model configured means.
   *
   * Production computes this as `STORYLINE_COHERENCE_GATE && a key is set`, and
   * the flag's own default is true — so this field is where the two disagree,
   * and it disagrees the way every caller of `storylineBar()` needs: no key, no
   * verdict to wait for, and deferring would only lose formations to a tail
   * that can never resolve them. A test that is ABOUT the gate says
   * `storylineBar({ coherenceGate: true })`.
   */
  coherenceGate: false,
  /**
   * ON, and unlike the gate above it does not depend on a model being
   * configured — the verdicts are already bought.
   *
   * A refusal is durable, hand-checked evidence keyed on GROUPS, so it outlives
   * the storylines it was about and costs one indexed read to honour. The one
   * caller that may turn it off says so on the command line
   * (`backfill:storylines --ignore-refusals`), which is the only shape in which
   * "rebuild from pure token evidence" is a decision someone made rather than a
   * side effect of having no API key.
   */
  honourRefusals: true,
  // The shipped default: the whole profile capped at 200, not the
  // anchor-eligible subset capped at 4,000.
  narrowRetrieval: false,
  // Unbounded, the shipped default — `bridgePairs` takes the full
  // cross-product. `STORYLINE_MAX_BRIDGING_QUALIFIERS` spells this 0; see
  // `maxBridgingQualifiers` in `wiring.ts` for why the translation is a
  // function.
  maxBridgingQualifiers: undefined,
  storyDf: Object.freeze({ windowDays: 14, timeZone: "UTC" }),
  timeZone: "UTC",
});

/**
 * One caller's divergence from `STORYLINE_BAR`, and nothing more.
 *
 * `rules` and `storyDf` merge into the shipped ones rather than replacing them,
 * so a test that loosens the anchor share for a corpus of five articles says
 * only that — and does not silently re-declare the dormancy window it does not
 * care about, which is how the nineteen copies came to exist.
 */
export interface StorylineBarOverrides
  extends Partial<Omit<LinkerConfig, "rules" | "storyDf">> {
  rules?: Partial<LinkRules>;
  storyDf?: Partial<StoryDfConfig>;
}

/**
 * The shipped bar with a named divergence applied.
 *
 * A function rather than a spread of the constant at each call site so no
 * caller can mutate the next one's bar through the shared nested objects —
 * `rules` and `storyDf` come back fresh every call. (`STORYLINE_BAR` is frozen
 * as well; the freeze is the belt, this is the braces.)
 *
 * Everything absent from `overrides` is the shipped decision, and that is the
 * point: a caller states what it differs on beside the reason it differs, and
 * every field it says nothing about tracks production automatically.
 */
export function storylineBar(overrides: StorylineBarOverrides = {}): LinkerConfig {
  const bar: LinkerConfig = {
    ...STORYLINE_BAR,
    ...overrides,
    rules: { ...STORYLINE_BAR.rules, ...overrides.rules },
    storyDf: { ...STORYLINE_BAR.storyDf, ...overrides.storyDf },
  };
  // Buying a verdict while discarding the ones already bought: the gate would
  // spend a model call re-asking a pair it had already refused, every night,
  // which is the loop migration 0015 exists to close. Refused here because this
  // is the sanctioned way to build a bar and every production path uses it — a
  // test constructing by spread bypasses this deliberately, and is welcome to.
  if (bar.coherenceGate && !bar.honourRefusals) {
    throw new Error(
      "coherenceGate with honourRefusals off would buy a verdict for a pair " +
        "already refused, every night. Refusals are free to replay; only new " +
        "verdicts cost anything.",
    );
  }
  return bar;
}
