import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { loadConfig } from "@zammy/config";
import {
  dissolveFormation,
  readStorylineLabelInput,
  recordFormationRefusal,
  type Database,
} from "@zammy/storage";
import type { Kysely } from "kysely";
import { createGeminiClient } from "./gemini.js";
import { buildCoherencePrompt, readCoherenceReply } from "./storyline-coherence.js";
import { selectLabelMembers } from "./storyline-label.js";
import { createConfiguredDb } from "./wiring.js";

/**
 * `pnpm dissolve:storyline-piles [--apply] [--limit=N] [--rate=N] [--out=FILE]`
 *
 * The RETROACTIVE half of ADR-0011's coherence gate. The gate stops new
 * coincidence piles from forming; this undoes the ones already in the archive.
 *
 * **Dry run by default.** `--apply` is the only thing that writes. A dry run
 * makes the same model calls and prints the same verdicts, so the decision to
 * apply is made against the actual list rather than against a description of it.
 *
 * ## Scope, and why it is this narrow
 *
 * Storylines of **exactly two groups** whose `label_source` is `bigram` — the
 * hand-verified set. A model was shown each of these and could not name it, and
 * reading them confirms the report: they are dominated by two unrelated articles
 * sharing a word (docs/STORYLINE-LINKING.md, "What the anchor rule cannot see").
 *
 * Everything else is deliberately out of scope, and the archive is why:
 *
 *  - **3+ groups** — 199 of the 250 declined piles at that size have absorbed
 *    merges, up to 30 aliases deep. Undoing one asks which of N groups belong
 *    together, which is the split ADR-0011 refuses to build. Only a full gated
 *    relink reaches them.
 *  - **`label_source is null`** (774 at two groups) — never offered to a model, so
 *    no verdict exists and none of it is hand-verified.
 *  - **model-named storylines** — the validation found ~26% of the two-group ones
 *    are piles the namer papered over, which makes them a real target and a bad
 *    first one: there is no hand-checked ground truth behind them.
 *
 * ## What it does per storyline
 *
 * Asks the coherence prompt, then acts only on an EXPLICIT refusal — the same
 * three-way rule the live gate uses (`readCoherenceReply`), for the same reason:
 * an unavailable or out-of-quota model must leave the archive alone rather than
 * dissolve it. A refusal detaches the later-attached group back to its own
 * storyline (`dissolveFormation`, which revives the original UUID) and records
 * the pair, so the next backfill does not rebuild the pile.
 *
 * Bridges are left standing. That is `dissolveFormation`'s documented judgement:
 * K counts DISTINCT groups, so a shrunken storyline cannot reach it alone.
 *
 * ## Operating it
 *
 * Resumable through the same transcript trick as `measure:storyline-coherence`,
 * and for the same reason — the free tier's ceiling is 500 requests per day per
 * model, and this is 88 of them.
 *
 *   pnpm dissolve:storyline-piles              # dry run, the whole set
 *   pnpm dissolve:storyline-piles --limit=10   # dry run, a taste
 *   pnpm dissolve:storyline-piles --apply      # write
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const apply = args.includes("--apply");
const limit = Number(flag("limit") ?? 0);
const transcript = flag("out") ?? "storyline-dissolve.jsonl";

const config = loadConfig();
const db = createConfiguredDb(config);

interface Row {
  id: string;
  label: string | null;
  verdict: "incoherent" | "named" | "unusable";
  detail: string;
  /** Set on an --apply run that actually wrote. */
  dissolved?: boolean;
}

/** Verdicts already collected. A dry run's transcript is a valid input to --apply. */
const known = new Map<string, Row>();
if (existsSync(transcript)) {
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      // `unusable` closes nothing: quota and timeouts are questions still open.
      if (row.verdict !== "unusable") known.set(row.id, row);
    } catch {
      // A half-written final line from a killed run; the id gets re-asked.
    }
  }
}

/** The later-attached group — the one that turned a singleton into a pile. */
async function departingGroup(
  database: Kysely<Database>,
  storylineId: string,
): Promise<string | null> {
  const rows = await database
    .selectFrom("storyline_groups")
    .select(["group_id", "attached_at"])
    .where("storyline_id", "=", storylineId)
    .orderBy("attached_at", "desc")
    .orderBy("group_id", "desc")
    .execute();
  return rows.length === 2 ? rows[0]!.group_id : null;
}

try {
  const rows = await db
    .selectFrom("storylines")
    .innerJoin("storyline_groups", "storyline_groups.storyline_id", "storylines.id")
    .select((eb) => [
      "storylines.id as id",
      "storylines.label as label",
      eb.fn.countAll<string>().as("groups"),
    ])
    .where("storylines.merged_into", "is", null)
    .where("storylines.status", "<>", "provisional")
    .where("storylines.label_source", "=", "bigram")
    .groupBy(["storylines.id", "storylines.label"])
    .having((eb) => eb(eb.fn.countAll(), "=", 2))
    .orderBy("storylines.id")
    .execute();

  const targets = limit > 0 ? rows.slice(0, limit) : rows;
  console.log(
    `${rows.length} declined storylines at exactly 2 groups; ` +
      `${targets.length} in scope, ${known.size} already judged`,
  );
  console.log(apply ? "MODE: apply — this WRITES\n" : "MODE: dry run — nothing is written\n");

  if (!config.GEMINI_API_KEY) {
    console.error("no GEMINI_API_KEY: there is no verdict to act on.");
    process.exit(1);
  }
  const generator = createGeminiClient({
    apiKey: config.GEMINI_API_KEY,
    model: config.GEMINI_MODEL,
    baseUrl: config.GEMINI_BASE_URL,
    thinkingLevel: config.GEMINI_THINKING_LEVEL || undefined,
    timeoutMs: config.GEMINI_TIMEOUT_MS,
    maxRequestsPerMinute: Number(flag("rate") ?? config.GEMINI_MAX_RPM),
    maxRateWaitMs: config.GEMINI_MAX_RATE_WAIT_MS,
  });

  const tally = { refused: 0, kept: 0, unusable: 0, dissolved: 0, skipped: 0 };
  let consecutiveFailures = 0;
  /** Ids the transcript already holds a verdict for — never written twice. */
  const alreadyRecorded = new Set(known.keys());

  for (const target of targets) {
    const departing = await departingGroup(db, target.id);
    if (departing === null) {
      // Grew or shrank since the query. Not a formation any more, so not ours.
      tally.skipped += 1;
      continue;
    }

    let row = known.get(target.id);
    if (!row) {
      const { members } = await readStorylineLabelInput(db, {
        storylineId: target.id,
        limit: config.STORYLINE_LABEL_SAMPLE,
      });
      if (members.length === 0) {
        tally.skipped += 1;
        continue;
      }
      const sample = selectLabelMembers(members, config.STORYLINE_LABEL_SAMPLE);
      const result = await generator.generate({
        prompt: buildCoherencePrompt(sample),
        temperature: 0,
      });
      const reply = readCoherenceReply(result.ok ? result.text : null, sample);
      row = {
        id: target.id,
        label: target.label,
        verdict: reply.kind,
        detail:
          reply.kind === "named"
            ? reply.label
            : reply.kind === "unusable"
              ? (result.ok ? reply.reason : result.reason)
              : "",
      };

      if (reply.kind === "unusable") {
        // Never acts. The archive's key has a 500-a-day ceiling, and a cleanup
        // that read silence as a refusal would dissolve on quota rather than on
        // evidence — the same rule the live gate lives by.
        tally.unusable += 1;
        consecutiveFailures += 1;
        appendFileSync(transcript, `${JSON.stringify(row)}\n`);
        // Not cached: an unusable answer is a question still open.
        console.log(`  ?  ${target.id.slice(0, 8)} "${target.label}" — ${row.detail}`);
        if (consecutiveFailures >= 15) {
          console.error("\n15 consecutive failures — stopping. Re-run to resume.");
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
      known.set(target.id, row);
    }

    // Persist every usable verdict, whichever way it went, and BEFORE acting on
    // it. A `named` row is a question permanently answered — re-asking it on the
    // next run buys the same answer for another slice of a 500-a-day ceiling —
    // and a dry run's transcript is meant to be a valid input to `--apply`.
    if (!alreadyRecorded.has(target.id)) appendFileSync(transcript, `${JSON.stringify(row)}\n`);

    if (row.verdict === "named") {
      tally.kept += 1;
      console.log(`  keep      ${target.id.slice(0, 8)} "${target.label}" -> "${row.detail}"`);
      continue;
    }

    tally.refused += 1;
    if (!apply) {
      console.log(`  DISSOLVE  ${target.id.slice(0, 8)} "${target.label}"  (dry run)`);
      continue;
    }

    const result = await dissolveFormation(db, {
      storylineId: target.id,
      groupId: departing,
      timeZone: config.APP_TIMEZONE,
    });
    if (result.dissolved) {
      // The refusal is what stops the next backfill rebuilding the pile. Written
      // AFTER the dissolve so a crash between them leaves work to redo rather
      // than a refusal for a pile that still exists.
      const remaining = await db
        .selectFrom("storyline_groups")
        .select("group_id")
        .where("storyline_id", "=", target.id)
        .executeTakeFirst();
      if (remaining) {
        await recordFormationRefusal(db, {
          groupA: departing,
          groupB: remaining.group_id,
        });
      }
      tally.dissolved += 1;
      console.log(
        `  DISSOLVED ${target.id.slice(0, 8)} "${target.label}" ` +
          `-> freed ${result.freedStorylineId?.slice(0, 8)}` +
          `${result.revivedAlias ? " (revived)" : " (new)"}`,
      );
    } else {
      tally.skipped += 1;
      console.log(`  skip      ${target.id.slice(0, 8)} — ${result.refusedBecause}`);
    }
  }

  console.log(
    `\nrefused ${tally.refused} · kept ${tally.kept} · no verdict ${tally.unusable} · ` +
      `skipped ${tally.skipped}` +
      (apply ? ` · DISSOLVED ${tally.dissolved}` : " · nothing written (dry run)"),
  );
  if (!apply && tally.refused > 0) {
    console.log(`\nRe-run with --apply to dissolve those ${tally.refused}.`);
  }
} finally {
  await db.destroy();
}
