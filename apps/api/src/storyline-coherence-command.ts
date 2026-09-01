import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { EXIT_FAILED, type CommandSpec } from "./operator-command.js";
import { selectLabelMembers } from "./storyline-label.js";
import { buildCoherencePrompt, readCoherenceReply } from "./storyline-coherence.js";
import { readJudgedStorylines } from "./storyline-judged.js";

/**
 * `pnpm measure:storyline-coherence` — does a model verdict separate the archive's
 * hand-judged storylines?
 *
 * READ-ONLY against the database. It writes nothing to `storylines`; the only
 * side effect is the JSONL transcript it appends, and the model calls it makes.
 *
 * ## What this measures, and why it has to exist before anything ships
 *
 * docs/STORYLINE-LINKING.md, "What the anchor rule cannot see", records that no
 * token statistic separates the storylines a model could name from the ones it
 * declined: thirty-one settings across five families, plus a thirty-setting
 * whole-archive replay grid, and every one destroys more named arcs than it
 * prevents declined piles. The remaining candidate is the seam ADR-0011 reserved — asking a model
 * outright whether the coverage is one story.
 *
 * That candidate is a threshold like any other, and this repo does not ship
 * thresholds unmeasured. It is also the most dangerous one yet proposed, because
 * acting on it DISSOLVES storylines rather than declining to build them, so the
 * number that matters is not how many piles it catches but how many real arcs it
 * would take with them. This CLI produces both, as a confusion matrix over the
 * two hand-judged sets:
 *
 *  - **declined** — a model was shown these and could not name them. A verdict of
 *    NOT ONE STORY here is the gate working.
 *  - **named** — a model named these, and they include every large correct arc in
 *    the archive. A verdict of NOT ONE STORY here is a real storyline destroyed.
 *
 * Both sets are the SAME judgement the campaign already made, so the second
 * column is not independent evidence — a model agreeing with itself is the floor
 * on this measurement, not the ceiling. Read the named-set false-positive rate as
 * optimistic and size the risk accordingly.
 *
 * ## Operating it
 *
 * The sets are interleaved, and the transcript is resumable: a run cut short by
 * quota still yields a BALANCED matrix, and re-running continues where it
 * stopped rather than re-asking. That is not a convenience — the dev key is free
 * tier, its ceiling is 500 requests PER DAY per model, and the labelling
 * campaign exhausts it. Expect to finish a full run across more than one day.
 *
 *   pnpm measure:storyline-coherence --size=2 --per-set=88
 *   pnpm measure:storyline-coherence --report        # matrix only, no calls
 *
 * The transcript records the raw reply beside the verdict (`Row.raw`), so a
 * change to `readCoherenceReply` can be re-scored over a past run by replaying
 * the stored text — no model calls, no quota. That is not a substitute for a
 * rerun after the PROMPT changes, since different text is a different question;
 * a reader change is not, and before `raw` existed the two were
 * indistinguishable and both cost a full day of free-tier ceiling.
 *
 * `--size=N` restricts to storylines of exactly N groups; 2 is where formation
 * is unambiguous and where the failure was reported. `--model=` overrides the
 * configured model, which is how a run continues on a sibling model's quota
 * once one is spent — record which model produced a matrix, because they do not
 * agree.
 */

/** One hand-judged storyline, as the sample holds it. */
interface Judged {
  id: string;
  label: string | null;
  set: "declined" | "named";
  groups: number;
}

interface Row {
  id: string;
  set: "declined" | "named";
  groups: number;
  oldLabel: string | null;
  verdict: "incoherent" | "named" | "unusable";
  detail: string;
  /**
   * The reply the verdict was read FROM, so a later `readCoherenceReply` can be
   * re-scored against this run without asking the model again.
   *
   * Recording only the verdict cost a real rerun: the reader changed twice on
   * 2026-08-21, and the 2026-08-18 matrix could not be corrected offline because
   * every `named` and `incoherent` row had already discarded its text.
   * `--report` reads this when present, and rows written before it existed have
   * it absent.
   */
  raw?: string | null;
}

export const spec: CommandSpec = {
  name: "measure:storyline-coherence",
  synopsis: "[--size=N] [--per-set=N] [--report] [--model=NAME] [--out=FILE]",
  flags: {
    size: {
      kind: "value",
      placeholder: "N",
      describe: "storylines of exactly N groups (default 2; 0 for any)",
    },
    "per-set": { kind: "value", placeholder: "N", describe: "how many of each set (default 88)" },
    report: { kind: "boolean", describe: "print the matrix from the transcript, call no model" },
    model: {
      kind: "value",
      placeholder: "NAME",
      describe: "ask a sibling model — record which one produced a matrix",
    },
    out: {
      kind: "value",
      placeholder: "FILE",
      describe: "the JSONL transcript (default storyline-coherence.jsonl)",
    },
  },
  db: {},
  labeler: (args) => ({
    // `--model=` continues a run on a sibling model's quota once one is spent.
    // The rest of the client — the pacing above all — is the configured one:
    // this spends the SAME key the server is labelling with.
    ...(args.value("model") !== undefined ? { model: args.value("model") as string } : {}),
  }),
  async run({ args, config, db, labeler }) {
    const size = Number(args.value("size") ?? 2);
    const perSet = Number(args.value("per-set") ?? 88);
    const reportOnly = args.boolean("report");
    const transcript = args.value("out") ?? "storyline-coherence.jsonl";
    const model = args.value("model") ?? config.GEMINI_MODEL;

    /** What has already been asked. Only usable answers count as done. */
    const answered = new Map<string, Row>();
    if (existsSync(transcript)) {
      for (const line of readFileSync(transcript, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Row;
          // An `unusable` row is a question still open — quota, a timeout, a
          // contract miss — so it does not close the id. Recording it anyway is
          // what makes the fallback rate visible.
          if (row.verdict !== "unusable") answered.set(row.id, row);
        } catch {
          // A half-written final line from a killed run. The id gets re-asked.
        }
      }
    }

    const judged = await readJudgedStorylines(db);

    const candidates: Record<"declined" | "named", Judged[]> = { declined: [], named: [] };
    for (const set of ["declined", "named"] as const) {
      for (const storyline of judged[set]) {
        if (size > 0 && storyline.groupIds.length !== size) continue;
        candidates[set].push({
          id: storyline.id,
          label: storyline.label,
          set,
          groups: storyline.groupIds.length,
        });
      }
    }
    // By id, so the sample is the same one on every run and a resumed transcript
    // lines up with the run that started it.
    for (const set of ["declined", "named"] as const) {
      candidates[set].sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    /** An even stride, so a subsample spreads over the set rather than its first N. */
    const stride = (all: Judged[], count: number): Judged[] => {
      if (all.length <= count) return all;
      const step = all.length / count;
      return Array.from({ length: count }, (_, index) => all[Math.floor(index * step)]!);
    };

    const chosen: Judged[] = [];
    const left = stride(candidates.declined, perSet);
    const right = stride(candidates.named, perSet);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      // Interleaved: a run stopped by quota still leaves a balanced matrix.
      if (left[index]) chosen.push(left[index]!);
      if (right[index]) chosen.push(right[index]!);
    }

    console.log(
      `${candidates.declined.length} declined and ${candidates.named.length} named storylines ` +
        `at ${size} groups; sampling ${left.length} + ${right.length}`,
    );

    if (!reportOnly) {
      const generator = labeler.generator;
      if (!generator) {
        console.error("no GEMINI_API_KEY: nothing to ask. --report prints the matrix so far.");
        return EXIT_FAILED;
      }

      const pending = chosen.filter((storyline) => !answered.has(storyline.id));
      console.log(`asking ${model} about ${pending.length} of them`);

      let asked = 0;
      let consecutiveFailures = 0;
      for (const storyline of pending) {
        const members = await db
          .selectFrom("articles")
          .innerJoin("storyline_groups", "storyline_groups.group_id", "articles.group_id")
          .select(["articles.title as title", "articles.description as description", "articles.published as published"])
          .where("storyline_groups.storyline_id", "=", storyline.id)
          .execute();
        if (members.length === 0) continue;

        const sample = selectLabelMembers(members, config.STORYLINE_LABEL_SAMPLE);
        const result = await generator.generate({
          prompt: buildCoherencePrompt(sample),
          temperature: 0,
        });
        const reply = readCoherenceReply(result.ok ? result.text : null, sample);

        const row: Row = {
          id: storyline.id,
          set: storyline.set,
          groups: storyline.groups,
          oldLabel: storyline.label,
          raw: result.ok ? result.text : null,
          verdict: reply.kind,
          detail:
            reply.kind === "named"
              ? reply.label
              : reply.kind === "unusable"
                ? (result.ok ? reply.reason : result.reason)
                : "",
        };
        appendFileSync(transcript, `${JSON.stringify(row)}\n`);
        if (reply.kind !== "unusable") {
          answered.set(row.id, row);
          consecutiveFailures = 0;
        } else {
          consecutiveFailures += 1;
          console.error(`  ! ${storyline.id.slice(0, 8)} ${row.detail}`);
          // A spent daily quota returns 429 for every remaining call. Burning the
          // rest of the sample against it produces no data and no useful log.
          if (consecutiveFailures >= 15) {
            console.error("15 consecutive failures — stopping. Re-run to resume.");
            break;
          }
        }
        asked += 1;
        if (asked % 20 === 0) console.error(`  ${asked}/${pending.length}`);
      }
    }

    // ---- the matrix ----
    const matrix = { declined: { incoherent: 0, named: 0 }, named: { incoherent: 0, named: 0 } };
    for (const row of answered.values()) {
      if (!chosen.some((storyline) => storyline.id === row.id)) continue;
      if (row.verdict === "incoherent") matrix[row.set].incoherent += 1;
      else if (row.verdict === "named") matrix[row.set].named += 1;
    }

    const line = (label: string, cell: { incoherent: number; named: number }): string => {
      const total = cell.incoherent + cell.named;
      const share = total === 0 ? "  n/a" : `${((100 * cell.incoherent) / total).toFixed(1)}%`;
      return `  ${label.padEnd(10)} answered ${String(total).padStart(4)}   ` +
        `NOT ONE STORY ${String(cell.incoherent).padStart(4)} (${share})   named ${String(cell.named).padStart(4)}`;
    };

    console.log(`\n=== ${model}, storylines of ${size} groups ===`);
    console.log(line("declined", matrix.declined), "   <- caught (want HIGH)");
    console.log(line("named", matrix.named), "   <- destroyed (want LOW)");

    const caught = matrix.declined.incoherent;
    const destroyed = matrix.named.incoherent;
    console.log(
      `\npiles caught per real arc destroyed: ` +
        (destroyed === 0 ? `${caught} / 0` : (caught / destroyed).toFixed(2)),
    );
    console.log(
      "A ratio near 1 means this is the same bidirectional trade every token\n" +
        "threshold already offers, and buys nothing for the model call.",
    );
    return;
  },
};
