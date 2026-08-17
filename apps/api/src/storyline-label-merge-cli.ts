import { loadConfig } from "@zammy/config";
import {
  createDb,
  readLabelMergeCandidates,
  readStorylineCoverageText,
} from "@zammy/storage";
import { sql } from "kysely";
import { createGeminiClient, type TextGenerator } from "./gemini.js";
import { properNounEvidence } from "./term-scoring.js";
import {
  labelWords,
  sharedLabels,
  type LabelMergeCandidate,
} from "./storyline-label-merge.js";
import {
  mergeAgreeingLabels,
  planLabelMerges,
} from "./storyline-label-merge-service.js";

/**
 * `pnpm merge:storyline-labels [--dry-run] [--grace=N]` — the label-agreement
 * merge as an operator command.
 *
 * `--dry-run` is the point of this file. The pass merges storylines and merging
 * has no inverse (ADR-0011 refuses split), so the plan must be readable before it
 * is written — and reading it is also how the precision guard gets checked: a
 * dry run prints every cluster it REFUSED and why, which is where a generic
 * model label shows itself.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dryRun = args.includes("--dry-run");

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const rules = {
  graceDays: Number(flag("grace") ?? config.STORYLINE_LABEL_MERGE_GRACE_DAYS),
  maxComponent: Number(
    flag("max-component") ?? config.STORYLINE_LABEL_MERGE_MAX_COMPONENT,
  ),
};

const generator: TextGenerator | null = config.GEMINI_API_KEY
  ? createGeminiClient({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      baseUrl: config.GEMINI_BASE_URL,
      thinkingLevel: config.GEMINI_THINKING_LEVEL,
      timeoutMs: config.GEMINI_TIMEOUT_MS,
    })
  : null;

console.log(
  `${dryRun ? "DRY RUN — nothing is written" : "LIVE — storylines will be merged"} · ` +
    `grace ${rules.graceDays}d · max component ${rules.maxComponent} · ` +
    `relabel: ${generator ? config.GEMINI_MODEL : "off (no GEMINI_API_KEY)"}`,
);

try {
  await report();
  if (dryRun) {
    const { plans, refusals, sharedLabels: shared } = await planLabelMerges({ db, rules });
    console.log(
      `\nwould merge ${plans.reduce((n, p) => n + p.loserIds.length, 0)} storylines ` +
        `into ${plans.length} survivors · ${shared} shared labels · ` +
        `${refusals.length} refused`,
    );
  } else {
    const result = await mergeAgreeingLabels({
      db,
      rules,
      timeZone: config.APP_TIMEZONE,
      ...(generator
        ? {
            labeler: {
              generator,
              modelId: config.GEMINI_MODEL,
              sampleSize: config.STORYLINE_LABEL_SAMPLE,
              driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
            },
          }
        : {}),
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
  }
} finally {
  await db.destroy();
}

/**
 * What every shared label looks like, decided or refused, with the words that
 * carried it. Printed in both modes: after a live run this is the record of what
 * the pass saw, and the refusals are the interesting half either way.
 */
async function report(): Promise<void> {
  const rows = await readLabelMergeCandidates(db);
  const candidates: LabelMergeCandidate[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    spanFromMs: row.spanFrom.getTime(),
    spanToMs: row.spanTo.getTime(),
    groupCount: row.groupCount,
  }));
  const clusters = sharedLabels(candidates);
  console.log(
    `\n${rows.length} model-labelled live storylines · ` +
      `${clusters.size} labels held by more than one`,
  );

  for (const [label, arcs] of clusters) {
    const coverage = await readStorylineCoverageText(
      db,
      arcs.map((arc) => arc.id),
    );
    const evidence = properNounEvidence(coverage);
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
