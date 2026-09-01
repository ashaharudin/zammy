import { readLabelMergeCandidates, readStorylineCoverageText } from "@zammy/storage";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "@zammy/storage";
import { singular } from "./grouping.js";
import { properNounEvidence } from "./headline-tokens.js";
import { NON_NEGATIVE_NUMBER, type CommandSpec } from "./operator-command.js";
import { labelWords, sharedLabels, type LabelMergeCandidate } from "./storyline-label-merge.js";
import { mergeAgreeingLabels, planLabelMerges } from "./storyline-label-merge-service.js";

/**
 * `pnpm merge:storyline-labels [--dry-run] [--grace=N]` — the label-agreement
 * merge as an operator command.
 *
 * `--dry-run` is the point of this file. The pass merges storylines and merging
 * has no inverse (ADR-0011 refuses split), so the plan must be readable before it
 * is written — and reading it is also how the precision guard gets checked: a
 * dry run prints every component it REFUSED and why, which is where a generic
 * model label shows itself.
 *
 * **The merge RULES are this command's own, and the model client is not.** That
 * distinction is the whole reason `wiring.createLabelMergeRules` is not called
 * here: `--grace` and `--max-component` exist precisely to let an operator try
 * another bar, which is the documented kind of divergence (`wiring.ts`). Pacing
 * is not a bar an operator is trying — it is the ceiling on a key the server is
 * spending at the same time, and building a client here to say so was how this
 * file came to run at `gemini.ts`'s literal 30 rpm while the deployment was
 * configured for 15.
 */
export const spec: CommandSpec = {
  name: "merge:storyline-labels",
  synopsis: "[--dry-run] [--grace=N] [--max-component=N]",
  flags: {
    "dry-run": { kind: "boolean", describe: "print the plan and the refusals, write nothing" },
    grace: {
      kind: "value",
      placeholder: "N",
      describe: "days two spans may be apart and still count as touching",
    },
    "max-component": {
      kind: "value",
      placeholder: "N",
      describe: "the anti-swallow valve: refuse a component larger than this",
    },
  },
  db: {},
  labeler: true,
  async run({ args, config, db, labeler }) {
    const dryRun = args.boolean("dry-run");

    /**
     * The bar, from the flags. `Number("abc")` is NaN and NaN fails the
     * comparison it lands in — which for `--grace` fails safe (`spansTouch`
     * refuses) and for `--max-component` fails OPEN: `component.length > NaN`
     * is false, so the anti-swallow valve silently stops guarding on the one
     * run where the operator typed the flag wrong. A merge has no inverse, so
     * a bad flag stops the run (`Args.number`).
     */
    const rules = {
      graceDays: args.number("grace", NON_NEGATIVE_NUMBER, {
        fallback: config.STORYLINE_LABEL_MERGE_GRACE_DAYS,
      }),
      maxComponent: args.number("max-component", NON_NEGATIVE_NUMBER, {
        fallback: config.STORYLINE_LABEL_MERGE_MAX_COMPONENT,
      }),
    };

    console.log(
      `${dryRun ? "DRY RUN — nothing is written" : "LIVE — storylines will be merged"} · ` +
        `grace ${rules.graceDays}d · max component ${rules.maxComponent} · ` +
        `relabel: ${labeler.generator ? config.GEMINI_MODEL : "off (no GEMINI_API_KEY)"}`,
    );

    await report(db);
    if (dryRun) {
      const { plans, refusals, sharedLabels: shared } = await planLabelMerges({ db, rules });
      console.log(
        `\nwould merge ${plans.reduce((n, p) => n + p.loserIds.length, 0)} storylines ` +
          `into ${plans.length} survivors · ${shared} shared labels · ` +
          `${refusals.length} refused`,
      );
      return;
    }

    const result = await mergeAgreeingLabels({
      db,
      rules,
      timeZone: config.APP_TIMEZONE,
      ...(labeler.generator ? { labeler } : {}),
      log: {
        info: (obj, msg) => console.log(msg, JSON.stringify(obj)),
        warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)),
      },
    });
    console.log(
      `\nmerged ${result.merged} storylines into ${result.survivors.length} survivors · ` +
        `${result.refusals.length} refused · ${result.failures} failed`,
    );
    for (const survivor of result.survivors) {
      const { rows } = await sql<{ label: string | null; groups: string }>`
        select s.label,
               (select count(*) from storyline_groups g where g.storyline_id = s.id) as groups
        from storylines s where s.id = ${survivor.winnerId}::uuid
      `.execute(db);
      console.log(
        `  ${survivor.winnerId.slice(0, 8)} absorbed ${survivor.absorbed} · ` +
          `now ${rows[0]?.groups ?? "?"} groups · label "${rows[0]?.label ?? "(none)"}"`,
      );
    }
  },
};

/**
 * What every shared label looks like, decided or refused, with the words that
 * carried it. Printed in both modes: after a live run this is the record of what
 * the pass saw, and the refusals are the interesting half either way.
 */
async function report(db: Kysely<Database>): Promise<void> {
  const rows = await readLabelMergeCandidates(db);
  const candidates: LabelMergeCandidate[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    spanFromMs: row.spanFrom.getTime(),
    spanToMs: row.spanTo.getTime(),
    groupCount: row.groupCount,
  }));
  const components = sharedLabels(candidates);
  console.log(
    `\n${rows.length} model-labelled live storylines · ` +
      `${components.size} labels held by more than one`,
  );

  for (const [label, arcs] of components) {
    const coverage = await readStorylineCoverageText(
      db,
      arcs.map((arc) => arc.id),
    );
    // Folded on both sides, exactly as the planner does it — a report that
    // printed different grounded names from the run it explains is worse than
    // no report. See `planLabelMerges`.
    const evidence = properNounEvidence(coverage, singular);
    const names = labelWords(label).filter((word) => evidence(word));
    const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

    console.log(
      `\n"${label}" — ${arcs.length} arcs, ${coverage.length} articles\n` +
        `  grounded names: ${names.length > 0 ? names.join(", ") : "NONE — refused"}`,
    );
    for (const arc of [...arcs].sort((a, b) => a.spanFromMs - b.spanFromMs)) {
      console.log(
        `    ${arc.id.slice(0, 8)}  ${day(arc.spanFromMs)} → ${day(arc.spanToMs)}  ` +
          `${String(arc.groupCount).padStart(3)} groups`,
      );
    }
  }
}
