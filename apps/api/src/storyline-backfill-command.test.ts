import { loadConfig } from "@zammy/config";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./operator-command.js";
import { backfillBar, spec } from "./storyline-backfill-command.js";
import { createLinkerConfig } from "./wiring.js";

/**
 * The one mapping in this command that a typo inverts silently.
 *
 * `honourRefusals: ignoreRefusals` — the flag passed through unnegated — type
 * checks, passes every linker and backfill test (both read the field, neither
 * knows what the CLI meant by it), and rebuilds every pile a verdict has ever
 * refused. It is one character away from the fix and there is no other test in
 * the suite that would notice, which is the whole reason this file exists.
 *
 * Pure: `backfillBar` takes a config and a flag and returns a bar. Nothing here
 * opens a pool or reaches `process`.
 */

const BASE = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/zammy",
  REDIS_URL: "redis://localhost:6379",
  CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
};

const config = (env: Record<string, string> = {}) =>
  loadConfig({ ...BASE, ...env } as NodeJS.ProcessEnv);

/**
 * Exactly what `run` computes, without running anything else: the same function
 * over the same parsed `Args`. The flag name and its negation are inside
 * `backfillBar`, so they are under test here rather than restated.
 */
const barFor = (argv: string[], env: Record<string, string> = {}) =>
  backfillBar(config(env), parseArgs(spec, argv));

describe("the bar backfill:storylines judges at", () => {
  it("honours recorded refusals by default", () => {
    expect(barFor([]).honourRefusals).toBe(true);
  });

  it("ignores them only when the operator asks", () => {
    expect(barFor(["--ignore-refusals"]).honourRefusals).toBe(false);
  });

  it("never gates, whatever the environment says", () => {
    // The flag defaults TRUE in `packages/config` and the live path turns it on
    // wherever a key is set, so "the environment cannot reach this field" is a
    // property worth pinning rather than assuming: a gated backfill defers every
    // formation to a tail that does not exist (`assertNoUnresolvableGate`).
    const envs: Record<string, string>[] = [
      {},
      { STORYLINE_COHERENCE_GATE: "true", GEMINI_API_KEY: "a-key" },
      { GEMINI_API_KEY: "a-key" },
    ];
    for (const env of envs) {
      expect(barFor([], env).coherenceGate).toBe(false);
      expect(barFor(["--ignore-refusals"], env).coherenceGate).toBe(false);
    }
  });

  it("differs from the live bar on those two fields and nothing else", () => {
    // The divergence is NAMED, so it has to be the only one. Everything a
    // backfill retrieves or bridges on must be what live ingest used, or the
    // rebuild leaves an archive nothing has measured (`wiring.ts`'s header).
    const live = createLinkerConfig(config({ GEMINI_API_KEY: "a-key" }));
    const backfill = barFor(["--ignore-refusals"], { GEMINI_API_KEY: "a-key" });

    expect({ ...backfill, coherenceGate: null, honourRefusals: null }).toEqual({
      ...live,
      coherenceGate: null,
      honourRefusals: null,
    });
  });

  it("is the live bar exactly, on a plain run with no key", () => {
    // No key means the live path's gate is off too, and a plain run honours
    // refusals like everything else — so there is nothing left to differ on.
    expect(barFor([])).toEqual(createLinkerConfig(config()));
  });
});
