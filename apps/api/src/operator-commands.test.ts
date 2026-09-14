import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@zammy/config";
import { describe, expect, it } from "vitest";
import { spec as chores } from "./chores-command.js";
import { spec as deepeningYield } from "./deepening-yield-command.js";
import { spec as labelWordsBackfill } from "./label-words-backfill-command.js";
import { helpText, parseArgs, type CommandSpec } from "./operator-command.js";
import { spec as regroup } from "./regroup-command.js";
import { spec as storyDf } from "./story-df-command.js";
import { spec as storylineBackfill } from "./storyline-backfill-command.js";
import { spec as storylineCoherence } from "./storyline-coherence-command.js";
import { spec as storylineDissolve } from "./storyline-dissolve-command.js";
import { spec as storylineLabel } from "./storyline-label-command.js";
import { spec as storylineLabelMerge } from "./storyline-label-merge-command.js";
import { spec as storylineProfilesBackfill } from "./storyline-profiles-backfill-command.js";
import { spec as storylineSummary } from "./storyline-summary-command.js";
import { spec as storylineSweep } from "./storyline-sweep-command.js";
import { createLabeler } from "./wiring.js";

/**
 * The properties that hold over the WHOLE set of operator commands.
 *
 * Written over the set rather than one command at a time on purpose. What the
 * `operator-command.ts` refactor exists to create is not "this command paces
 * itself correctly" — five of them did, more or less — it is that a THIRTEENTH
 * command cannot re-declare pacing at all, because there is nowhere left to
 * declare it. A per-command test would pass on the day somebody adds a
 * `createGeminiClient` call to a new file; this one fails.
 *
 * The failure it is written against is real and was live:
 * `storyline-label-merge-cli.ts` built its own client and omitted
 * `maxRequestsPerMinute`, so it took `gemini.ts`'s literal 30 rpm default and
 * ignored `GEMINI_MAX_RPM` entirely — 2x the configured ceiling on the key the
 * server labels with.
 *
 * That this file merely IMPORTS all twelve is half the point. Before the
 * refactor the same import list would have opened twelve Postgres pools and
 * could have called `process.exit` before the first assertion ran.
 */

/** Every operator command, and the `<name>-cli.ts` that runs it. */
const COMMANDS: ReadonlyArray<readonly [file: string, spec: CommandSpec]> = [
  ["chores", chores],
  ["deepening-yield", deepeningYield],
  ["label-words-backfill", labelWordsBackfill],
  ["regroup", regroup],
  ["story-df", storyDf],
  ["storyline-backfill", storylineBackfill],
  ["storyline-coherence", storylineCoherence],
  ["storyline-dissolve", storylineDissolve],
  ["storyline-label", storylineLabel],
  ["storyline-label-merge", storylineLabelMerge],
  ["storyline-profiles-backfill", storylineProfilesBackfill],
  ["storyline-summary", storylineSummary],
  ["storyline-sweep", storylineSweep],
];

const SRC = fileURLToPath(new URL(".", import.meta.url));
const read = (file: string): string => readFileSync(`${SRC}${file}`, "utf8");

const BASE = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/zammy",
  REDIS_URL: "redis://localhost:6379",
  CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
};
const config = (over: Record<string, string> = {}) =>
  loadConfig({ ...BASE, ...over } as NodeJS.ProcessEnv);

describe("the operator commands, as a set", () => {
  it("covers every `*-cli.ts` entrypoint `package.json` runs", () => {
    // A command missing from the list above is a command none of the
    // properties below are asserted over — so the list has to be complete, and
    // `package.json` is the only place that says what complete means.
    const scripts = JSON.parse(read("../package.json")).scripts as Record<string, string>;
    const entrypoints = Object.values(scripts)
      .map((command) => /dist\/([\w-]+)-cli\.js/.exec(command)?.[1])
      .filter((file): file is string => file !== undefined)
      .sort();
    expect(COMMANDS.map(([file]) => file).sort()).toEqual(entrypoints);
  });

  it("obtains every labeler from `wiring.createLabeler`, and never builds a client", () => {
    // The property, stated the only way that survives a thirteenth command:
    // nothing under an operator entrypoint may reach for the client
    // constructor. Pacing is `createLabeler`'s, `createLabeler` reads
    // `GEMINI_MAX_RPM`, and a command's legitimate divergence is a
    // `LabelerOverrides` field with its reason written beside it.
    for (const [file] of COMMANDS) {
      for (const source of [`${file}-cli.ts`, `${file}-command.ts`]) {
        expect(read(source), `${source} builds its own model client`).not.toContain(
          "createGeminiClient",
        );
      }
    }
  });

  it("keeps each `*-cli.ts` a thin entrypoint, so the run body imports clean", () => {
    // The testability requirement: importing a command must not connect to
    // Postgres, load config, or exit. The entrypoints are the only files that
    // may do any of it, and they do it through `runCommand` alone.
    for (const [file] of COMMANDS) {
      const source = read(`${file}-cli.ts`);
      expect(source, `${file}-cli.ts does more than run the command`).toContain(
        "runCommand(spec)",
      );
      expect(source).not.toContain("loadConfig");
      expect(source).not.toContain("process.argv");
      expect(source).not.toContain("process.exit(");
    }
  });

  it("declares a labeler for exactly the commands that name a storyline", () => {
    // The rest have no business holding one. `summaries:storylines` is the
    // interesting exclusion: it spends the model too, but through
    // `createSummarizer` — a separate lane the moment `SUMMARY_API_KEY` is set.
    const withLabeler = COMMANDS.filter(([, spec]) => spec.labeler).map(([, spec]) => spec.name);
    expect(withLabeler.sort()).toEqual([
      "backfill:storylines",
      "dissolve:storyline-piles",
      "label:storylines",
      "measure:storyline-coherence",
      "merge:storyline-labels",
    ]);
  });

  it("overrides only the fields `LabelerOverrides` opens, and only with a reason", () => {
    // Every override a command asks for, resolved against an empty command
    // line. The point is the SHAPE: nothing here reaches the key, the base
    // URL, the timeout, the sample size or the drift factor, and every entry
    // has a stated reason in the spec beside it.
    const overrides = Object.fromEntries(
      COMMANDS.filter(([, spec]) => typeof spec.labeler === "function").map(([, spec]) => [
        spec.name,
        (spec.labeler as (args: never, config: never) => object)(
          parseArgs(spec, []) as never,
          config() as never,
        ),
      ]),
    );
    expect(overrides).toEqual({
      // An operator watching a terminal would rather wait than take a bigram.
      "label:storylines": { maxRateWaitMs: 900_000 },
      // A backfill has no deadline and thousands of labels to place.
      "backfill:storylines": { maxRateWaitMs: 900_000 },
      // `--model=` continues a run on a sibling model's quota; unset, nothing.
      "measure:storyline-coherence": {},
      // `--rate` is a cleanup run's own pace against a key a server shares;
      // unset it is the configured ceiling, which is the default 30 here.
      "dissolve:storyline-piles": { maxRequestsPerMinute: 30 },
    });
  });

  it("gives every command a --help that names all of its flags", () => {
    for (const [, spec] of COMMANDS) {
      const text = helpText(spec);
      // The two that write their own table are exempt from the generated one;
      // everywhere else `--help` must mention everything the parser accepts,
      // or it is a list of the flags somebody remembered to document.
      if (spec.details === undefined) {
        for (const flag of Object.keys(spec.flags)) {
          expect(text, `${spec.name} --help omits --${flag}`).toContain(`--${flag}`);
        }
      }
      expect(text, `${spec.name} --help does not mention --help`).toContain("--help");
    }
  });
});

describe("createLabeler records the model it called", () => {
  it("stamps `modelId`, so `label_source` is the model id and not the literal", () => {
    // Defect B. Without this the server path, the chore path and
    // `pnpm label:storylines` all wrote `label_source = 'model'`, while
    // `backfill:storylines --relabel` computed its "already current" target as
    // the real id — so a relabel campaign re-spent quota on every row it had
    // already paid for.
    const labeler = createLabeler(config({ GEMINI_API_KEY: "a-key", GEMINI_MODEL: "gemma-9" }));
    expect(labeler.generator).not.toBeNull();
    expect(labeler.modelId).toBe("gemma-9");
  });

  it("claims no model id with no key, because nothing was asked", () => {
    // A row must not claim provenance from a model that was never called: with
    // no key the label comes from the bigram extractor and says so.
    const labeler = createLabeler(config());
    expect(labeler.generator).toBeNull();
    expect(labeler.modelId).toBeUndefined();
  });

  it("records the SIBLING model when a command overrides it", () => {
    // `measure:storyline-coherence --model=` asks another model. What
    // `label_source` must record is the model that answered.
    const labeler = createLabeler(config({ GEMINI_API_KEY: "a-key" }), undefined, undefined, {
      model: "gemma-other",
    });
    expect(labeler.modelId).toBe("gemma-other");
  });

  it("passes the sample and drift knobs through unchanged", () => {
    const labeler = createLabeler(
      config({ STORYLINE_LABEL_SAMPLE: "7", STORYLINE_LABEL_DRIFT_FACTOR: "3" }),
    );
    expect(labeler).toMatchObject({ sampleSize: 7, driftFactor: 3 });
  });
});
