import { loadConfig } from "@zammy/config";
import { createDb, readLabelCandidates } from "@zammy/storage";
import { sql } from "kysely";
import { createGeminiClient, type TextGenerator } from "./gemini.js";
import {
  buildLabelPrompt,
  fallbackLabel,
  needsLabel,
  selectLabelMembers,
  validateLabel,
  type LabelMember,
} from "./storyline-label.js";
import { labelStoryline, type LabelOutcome } from "./storyline-label-service.js";

/**
 * `pnpm label:storylines [--limit=N] [--preview] [--dry-run]` — the labeler's
 * operator command (ADR-0011, "Labels").
 *
 * Default mode labels real v2 storylines: everything promoted that has no label
 * or whose membership has drifted since it got one. This is what S5's backfill
 * pass and any later repair run does.
 *
 * `--preview` is a READ-ONLY harness over the dev archive, and it exists
 * because the v2 storylines it would otherwise label do not exist yet — the
 * linker is S3. It borrows the OLD `articles.storyline_id` day-bounded storylines purely as
 * a source of real multi-article coverage, runs the real selection, prompt,
 * validation and fallback over it, and writes nothing. What it measures is what
 * this session needs measured: what the labels look like on real headlines, and
 * what a thousand of them cost. It is not a backfill and does not pretend to
 * be — ADR-0011 ignores the old day-bounded storylines entirely — and it goes with the old
 * columns in S9.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const preview = args.includes("--preview");
const dryRun = args.includes("--dry-run");
const limit = Number(flag("limit") ?? (preview ? 40 : 200));

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

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
  `model: ${generator ? `${config.GEMINI_MODEL} (live)` : "none — GEMINI_API_KEY unset, fallback only"}`,
);

try {
  const startedAt = Date.now();
  if (preview) await runPreview();
  else await runLabeller();
  console.log(`\nran in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} finally {
  await db.destroy();
}

/** The real thing: label promoted storylines that need it. */
async function runLabeller(): Promise<void> {
  const candidates = await readLabelCandidates(db, { limit });
  console.log(`${candidates.length} promoted storylines\n`);

  const outcomes: LabelOutcome[] = [];
  for (const storyline of candidates) {
    if (
      !needsLabel(storyline, {
        groupCount: storyline.groupCount,
        trigger: "drift",
        driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
      })
    ) {
      continue;
    }
    if (dryRun) {
      console.log(`  would label ${storyline.id} (${storyline.groupCount} groups)`);
      continue;
    }
    const outcome = await labelStoryline(
      {
        db,
        generator,
        sampleSize: config.STORYLINE_LABEL_SAMPLE,
        driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
      },
      { storyline, trigger: "drift" },
    );
    outcomes.push(outcome);
    console.log(
      `  ${(outcome.label ?? "—").padEnd(28)} ${outcome.source.padEnd(7)} ` +
        `${String(outcome.groupCount).padStart(3)} groups${outcome.modelFailure ? `  (${outcome.modelFailure})` : ""}`,
    );
  }

  report(outcomes.map((outcome) => ({ label: outcome.label, source: outcome.source })));
}

/**
 * Read-only over the dev archive's OLD day-bounded storylines. Same functions, no writes.
 */
async function runPreview(): Promise<void> {
  const { rows } = await sql<{
    storyline_id: string;
    groups: number;
    members: Array<{ title: string; description: string | null; published: string }>;
  }>`
    select
      storyline_id,
      count(distinct group_id)::int as groups,
      json_agg(json_build_object(
        'title', title, 'description', description, 'published', published
      ) order by published) as members
    from (
      select distinct on (a.storyline_id, a.group_id)
             a.storyline_id, a.group_id, a.title, a.description, a.published
      from articles a
      order by a.storyline_id, a.group_id, a.published asc, a.id asc
    ) hero
    group by storyline_id
    having count(distinct group_id) > 1
    order by count(distinct group_id) desc
    limit ${limit}
  `.execute(db);

  console.log(
    `${rows.length} multi-group day-bounded storylines from the archive (read-only; ` +
      "the old day-bounded model, borrowed as coverage — see the header)\n",
  );

  const results: Array<{ label: string | null; source: string }> = [];
  let promptChars = 0;

  for (const row of rows) {
    const members: LabelMember[] = row.members.map((member) => ({
      title: member.title,
      description: member.description,
      published: new Date(member.published),
    }));
    const sample = selectLabelMembers(members, config.STORYLINE_LABEL_SAMPLE);
    const prompt = buildLabelPrompt(sample);
    promptChars += prompt.length;

    let label: string | null = null;
    let source = "none";
    let note = "";

    if (generator) {
      const result = await generator.generate({ prompt });
      if (result.ok) {
        const validated = validateLabel(result.text, sample);
        if (validated) {
          label = validated;
          source = "model";
        } else {
          note = `contract: ${result.text.slice(0, 40)}`;
        }
      } else {
        note = result.reason;
      }
    }
    if (label === null) {
      const fallback = fallbackLabel(sample);
      if (fallback) {
        label = fallback;
        source = "bigram";
      }
    }

    results.push({ label, source });
    console.log(
      `  ${(label ?? "—").padEnd(28)} ${source.padEnd(7)} ${String(row.groups).padStart(3)} groups` +
        `  ${sample[sample.length - 1]!.title.slice(0, 60)}${note ? `  (${note})` : ""}`,
    );
  }

  report(results);

  // The cost figure this session owes (~4 chars/token is the usual English
  // rule of thumb; the recorded fixture's usageMetadata puts a 10-headline
  // prompt at ~812 tokens, which agrees).
  const meanPromptTokens = rows.length ? promptChars / rows.length / 4 : 0;
  console.log(
    `\nprompt size: ${meanPromptTokens.toFixed(0)} tokens mean over ${rows.length} labels ` +
      `(+~4 out). Per 1,000 labels: ~${((meanPromptTokens * 1000) / 1_000_000).toFixed(2)}M ` +
      "input tokens — see docs/STORYLINE-LABELS.md for what that costs.",
  );
}

function report(results: Array<{ label: string | null; source: string }>): void {
  const by = (source: string) => results.filter((result) => result.source === source).length;
  console.log(
    `\nlabelled ${results.filter((r) => r.label).length}/${results.length}: ` +
      `${by("model")} model, ${by("bigram")} bigram, ${by("none")} none`,
  );
}
