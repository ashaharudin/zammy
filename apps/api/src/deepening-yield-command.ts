import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { sql } from "kysely";
import { buildServices, type Services } from "./server.js";
import { UsageError, type Args, type CommandSpec } from "./operator-command.js";
import { processDeepenJob } from "./storyline-deepening.js";
import { deepeningQuery } from "./cloud-query.js";
import { canonicalKeywords, fingerprintOf } from "./canonical.js";
import { readStorylineLanguage } from "@zammy/storage";

/**
 * `pnpm measure:deepening-yield` — the instrument plan §G6's decision gate is
 * taken on.
 *
 * ## The question, and why a CLI rather than a query
 *
 * G6 asks how many distinct articles the deepening plane adds to a clicked arc
 * and how many were already there. Half of that is a join over `sightings` and
 * `articles` and could be a query. The other half does not exist until somebody
 * spends the upstream calls — there is no scheduler (plan §9 survives G5), so
 * `queueStorylineDeepening`'s only caller is a reader opening a storyline, and
 * an archive with no deepening traffic in it has nothing to measure.
 *
 * So this manufactures the traffic and records what it cost, and it does so by
 * calling `processDeepenJob` — the REAL consumer, not a re-implementation. Every
 * gate the production path applies applies here: the grounding gate, the
 * horizon clamp, the single-flight lock, the attach-by-provenance rule, the
 * coverage write. What this file adds is a span it may choose, a pace it must
 * keep, and a transcript.
 *
 * ## Why it may choose the span, which is the one liberty it takes
 *
 * `queueStorylineDeepening` plans the span itself, always at the leading edge:
 * `now - lookbackDays … now`, snapped, capped at `DEEPEN_SPAN_MS`. On a
 * CONTINUOUSLY-FED archive that is the right window to measure, because the
 * discovery plane has been working it the whole time and "did Currents already
 * have this" is a fair question about it.
 *
 * The dev archive is not continuously fed. Its last six days hold 26–219
 * articles apiece against 1,615–3,802 a day a fortnight earlier — a laptop that
 * was switched off, not a news drought. Measured at that edge the answer would
 * be "the deepening plane adds almost everything", which is a fact about the
 * laptop. Naming the span is what lets the comparison be run where the archive
 * actually looked. The bias direction is stated in the plan's pre-registration
 * and it is the conservative one: a dense span is the archive at its most
 * competitive, so it depresses the yield rather than flattering it.
 *
 * ## What it will not do
 *
 * It does not write its own coverage, its own topic or its own attachment — all
 * three are `processDeepenJob`'s, so a bug in any of them shows up in the number
 * instead of being papered over. It does not skip the grounding gate: an arc the
 * gate refuses is recorded as a refusal, because how often the gate fires is
 * itself part of what the phase owes.
 *
 * ## Commands
 *
 *     arcs    --from --to [--limit]        the arc sample, no upstream calls
 *     run     --from --to [--limit] --tag  fetch, and write a transcript
 *     report  --tag                        classify the transcript against the DB
 *
 * `arcs` exists so the sample can be inspected — and argued with — before any
 * budget is spent on it.
 */

/**
 * The floor a pair has to clear to be REPORTED as a possible fold miss.
 *
 * 0.6 of the union, which on a ten-word headline is seven shared words. Chosen
 * to over-report rather than to be right: the number it feeds is subtracted
 * from the yield, so a false positive costs the design a point it deserved and
 * a false negative hands it one it did not. Every pair is printed, so the floor
 * is auditable and the count can be corrected downward by hand.
 */
const FOLD_MISS_FLOOR = 0.6;

export const spec: CommandSpec = {
  name: "measure:deepening-yield",
  synopsis:
    "<arcs|run|report> --from=YYYY-MM-DD --to=YYYY-MM-DD\n" +
    "                              [--limit=N] [--tag=NAME] [--pace-ms=N] [--out=PATH]",
  details: `
  arcs     print the arc sample for a span and exit. No upstream calls.
  run      deepen each arc in the sample over the span, one call apiece,
           and append a JSONL transcript. Spends real Google News calls.
  report   read a transcript back and classify every article the run
           produced: absorbed, genuinely new, or a fold miss.

  --from/--to  the span to deepen. UTC dates, exclusive of --to's day.
  --limit      how many arcs (default 20).
  --tag        names the transcript; required for run and report.
  --pace-ms    gap between calls (default 15000). GOOGLE_NEWS_BURST_CALL_LIMIT
               defaults to 5 per 60s and the governor THROWS at the ceiling,
               so this is a real constraint rather than politeness.
  --out        transcript directory (default ./.g6, gitignored).
`,
  positional: { placeholder: "<arcs|run|report>", values: ["arcs", "run", "report"] },
  flags: {
    from: { kind: "value", placeholder: "YYYY-MM-DD", describe: "span start, UTC" },
    to: { kind: "value", placeholder: "YYYY-MM-DD", describe: "span end, exclusive" },
    limit: { kind: "value", placeholder: "N", describe: "how many arcs (default 20)" },
    tag: { kind: "value", placeholder: "NAME", describe: "names the transcript" },
    "pace-ms": { kind: "value", placeholder: "N", describe: "gap between calls (default 15000)" },
    out: { kind: "value", placeholder: "PATH", describe: "transcript directory (default ./.g6)" },
  },
  // No `db` and no `labeler`: this one calls `processDeepenJob`, the REAL
  // consumer, so what it needs is the whole server — `buildServices` — and a
  // handle built here would be a second pool beside the one that consumer uses.
  // It closes what it opened, below.
  async run({ args, config }) {
    const outDir = args.value("out") ?? ".g6";
    const tag = args.value("tag");
    const limit = Number(args.value("limit") ?? 20);
    const paceMs = Number(args.value("pace-ms") ?? 15_000);
    const command = args.positionals[0];

    const services = await buildServices(config, log);
    try {
      if (command === "arcs") {
        const { from, to } = parseSpan(args);
        const arcs = await readArcs(services, from, to, limit);
        for (const arc of arcs) {
          const query = deepeningQuery({
            label: arc.label,
            profileTokens: await profileTokens(services, arc.id),
          });
          console.log(
            [
              arc.id,
              String(arc.spanArticles).padStart(5),
              String(arc.spanDomains).padStart(4),
              String(arc.totalArticles).padStart(5),
              query === null ? "UNGROUNDED" : "grounded  ",
              arc.label,
            ].join("  "),
          );
        }
        console.error(`\n${arcs.length} arcs, span ${from.toISOString()} … ${to.toISOString()}`);
      }

      if (command === "run") {
        if (!tag) throw new UsageError();
        const { from, to } = parseSpan(args);
        const path = `${outDir}/${tag}.jsonl`;
        if (!existsSync(outDir)) {
          const { mkdirSync } = await import("node:fs");
          mkdirSync(outDir, { recursive: true });
        }
        const arcs = await readArcs(services, from, to, limit);

        const baseline = {
          tag,
          kind: "baseline" as const,
          at: new Date().toISOString(),
          from: from.toISOString(),
          to: to.toISOString(),
          maxArticleId: await maxArticleId(services),
          storylines: await storylineCount(services),
          labels: await labelCount(services),
          arcs: arcs.length,
        };
        writeFileSync(path, `${JSON.stringify(baseline)}\n`);
        console.error(`baseline ${JSON.stringify(baseline)}`);

        for (const [index, arc] of arcs.entries()) {
          if (index > 0) await sleep(paceMs);
          const arcBefore = await arcArticleCount(services, arc.id);
          const articlesBefore = await maxArticleId(services);
          const started = Date.now();
          const attempt: Attempt = {
            tag,
            storylineId: arc.id,
            label: arc.label,
            keywords: null,
            from: from.toISOString(),
            to: to.toISOString(),
            spanArticles: arc.spanArticles,
            spanDomains: arc.spanDomains,
            arcBefore,
            arcAfter: arcBefore,
            articlesBefore,
            ms: 0,
            outcome: "ok",
          };
          const query = deepeningQuery({
            label: arc.label,
            profileTokens: await profileTokens(services, arc.id),
          });
          attempt.keywords = query?.keywords ?? null;
          try {
            await processDeepenJob(services.deps, {
              kind: "deepen",
              storylineId: arc.id,
              from: from.toISOString(),
              to: to.toISOString(),
            });
            if (query === null) attempt.outcome = "ungrounded";
          } catch (error) {
            attempt.outcome = "error";
            attempt.error = {
              name: error instanceof Error ? error.constructor.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
            };
          }
          attempt.ms = Date.now() - started;
          attempt.arcAfter = await arcArticleCount(services, arc.id);
          appendFileSync(path, `${JSON.stringify({ kind: "attempt", ...attempt })}\n`);
          console.error(
            `[${index + 1}/${arcs.length}] ${attempt.outcome.padEnd(10)} ` +
              `${String(attempt.ms).padStart(6)}ms  arc ${arcBefore}→${attempt.arcAfter}  ${arc.label}`,
          );
        }

        const final = {
          tag,
          kind: "final" as const,
          at: new Date().toISOString(),
          maxArticleId: await maxArticleId(services),
          storylines: await storylineCount(services),
          labels: await labelCount(services),
        };
        appendFileSync(path, `${JSON.stringify(final)}\n`);
        console.error(`final ${JSON.stringify(final)}`);
      }

      if (command === "report") {
        if (!tag) throw new UsageError();
        const path = `${outDir}/${tag}.jsonl`;
        const lines = readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const baseline = lines.find((line) => line.kind === "baseline") as
          | { maxArticleId: string; storylines: number; labels: number }
          | undefined;
        const final = lines.find((line) => line.kind === "final") as
          | { maxArticleId: string; storylines: number; labels: number }
          | undefined;
        const attempts = lines.filter(
          (line) => line.kind === "attempt",
        ) as unknown as Attempt[];
        if (!baseline) throw new Error(`${path} has no baseline record`);
        const highWater = BigInt(baseline.maxArticleId);

        const perArc: ArcReport[] = [];
        for (const attempt of attempts) {
          if (attempt.outcome !== "ok" || attempt.keywords === null) continue;
          const fingerprint = await deepeningFingerprint(
            services,
            attempt.storylineId,
            attempt.keywords,
          );
          const rows = await sql<{
            id: string;
            source_domain: string | null;
            title: string;
            published: Date;
            discovery: boolean;
            deepened: boolean;
          }>`
            select a.id,
                   a.source_domain,
                   a.title,
                   a.published,
                   exists (
                     select 1 from sightings s
                      where s.article_id = a.id and s.plane is distinct from 'deepening'
                   ) as discovery,
                   exists (
                     select 1 from sightings s
                      where s.article_id = a.id and s.plane = 'deepening'
                   ) as deepened
              from topic_articles ta
              join articles a on a.id = ta.article_id
             where ta.fingerprint = decode(${fingerprint}, 'hex')
          `.execute(services.deps.db);

          const absorbed: string[] = [];
          const created: typeof rows.rows = [];
          let stale = 0;
          for (const row of rows.rows) {
            // `deepened` FIRST, and it is the correction a first draft of this
            // report needed. `topic_articles` is cumulative and the topic a
            // deepening fetch mints is keyed on `canonicalKeywords(label)` — the
            // same fingerprint a READER typing those words would land on. So an arc
            // whose label collides with a topic somebody already searched inherits
            // that topic's whole article list, and counting the list as the batch
            // reported 102 absorbed articles on one arc against a 100-item cap.
            //
            // A row that carries no deepening sighting was not in this batch, full
            // stop. That test needs no snapshot of the archive and no arithmetic on
            // ids, so it is the one the classification hangs on; the id high-water
            // mark below only separates the two classes that ARE in the batch.
            if (!row.deepened) stale += 1;
            else if (row.discovery) absorbed.push(row.id);
            else if (BigInt(row.id) > highWater) created.push(row);
            else stale += 1;
          }

          // CLASS 3. Every created row is offered the pre-run archive's same-domain
          // rows within 36 HOURS and asked whether one of them is the same story
          // under a headline the fold could not reconcile.
          //
          // `alt_key` buckets by UTC DAY, so a same-day window would be the exact
          // complement of the fold — and would therefore miss the fold's other
          // failure mode, which this run turned out to be full of: Google News
          // stamps 90% of these items 07:00:00Z, midnight US Pacific, so a story
          // Currents saw at 23:00Z the previous evening is a different alt-key day
          // and mints a second row. +/-36h catches that class; it also catches a
          // genuine next-day follow-up, which is why every pair is printed. The comparison is deliberately
          // LOOSER than `stripOutletSuffix`: a positional strip that would be wrong
          // as a fold (ADR-0018 measured it merging 68 Frontiers papers) is exactly
          // right as a candidate generator, because a false candidate is reviewed
          // and a missed one is silently counted as yield.
          const misses: FoldMiss[] = [];
          for (const row of created) {
            if (row.source_domain === null) continue;
            const twins = await sql<{ id: string; title: string }>`
              select id, title
                from articles
               where source_domain = ${row.source_domain}
                 and id <= ${baseline.maxArticleId}::bigint
                 and abs(extract(epoch from (published - ${row.published}::timestamptz))) <= 129600
            `.execute(services.deps.db);
            let best: FoldMiss | null = null;
            for (const twin of twins.rows) {
              const score = titleOverlap(row.title, twin.title);
              if (score >= FOLD_MISS_FLOOR && (best === null || score > best.score)) {
                best = {
                  score,
                  domain: row.source_domain,
                  createdId: row.id,
                  createdTitle: row.title,
                  twinId: twin.id,
                  twinTitle: twin.title,
                };
              }
            }
            if (best) misses.push(best);
          }

          perArc.push({
            storylineId: attempt.storylineId,
            label: attempt.label,
            spanArticles: attempt.spanArticles,
            spanDomains: attempt.spanDomains,
            ingested: rows.rows.length,
            absorbed: absorbed.length,
            created: created.length,
            foldMisses: misses.length,
            stale,
            attachedToArc: attempt.arcAfter - attempt.arcBefore,
            misses,
          });
        }

        console.log(
          JSON.stringify(
            {
              tag,
              baseline,
              final,
              attempts: {
                total: attempts.length,
                ok: attempts.filter((a) => a.outcome === "ok").length,
                ungrounded: attempts.filter((a) => a.outcome === "ungrounded").length,
                error: attempts.filter((a) => a.outcome === "error").length,
                errors: attempts.filter((a) => a.error).map((a) => ({
                  label: a.label,
                  ...a.error,
                })),
                msQuantiles: quantiles(attempts.filter((a) => a.outcome === "ok").map((a) => a.ms)),
              },
              perArc,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await services.close();
    }
    return;
  },
};

/**
 * An arc as the sample sees it: the label the query is derived from, and how
 * much of it the archive already holds INSIDE the measured span.
 *
 * `spanArticles` is the selection key rather than the arc's total size, and the
 * difference is the whole point of a span-shifted run. An arc with 500 articles
 * spread over July is not an arc a reader would have clicked in the middle of
 * August; an arc with 40 articles all inside the span is.
 */
interface ArcRow {
  id: string;
  label: string;
  spanArticles: number;
  spanDomains: number;
  totalArticles: number;
}

/**
 * The arcs a reader would plausibly have clicked DURING the span.
 *
 * Not the trending cloud, and the reason is the same liberty the span is: the
 * cloud is computed over `TREND_WINDOW_HOURS` ending now, so on a span-shifted
 * run it would rank arcs by activity in a week the experiment is not measuring.
 * Ranking by in-span article count is the closest honest stand-in — it is what
 * `readTrendingStorylines` is mostly ranking by, minus the decay and minus the
 * source-count gate, both of which are about ordering a live board rather than
 * about which arcs were alive.
 *
 * The `>= 2` domain floor is `MIN_SOURCE_DOMAINS`' floor, applied here for the
 * reason the plan asks the question at all: an arc no reader would call
 * newsworthy is not a fair test of a plane whose job is to deepen newsworthy
 * ones. Which arcs that floor lets through is reported separately.
 */
async function readArcs(
  services: Services,
  from: Date,
  to: Date,
  limit: number,
): Promise<ArcRow[]> {
  const rows = await sql<{
    id: string;
    label: string;
    span_articles: string;
    span_domains: string;
    total_articles: string;
  }>`
    with member as (
      select s.id as storyline_id, s.label, a.id as article_id, a.source_domain, a.published
        from storylines s
        join storyline_groups sg on sg.storyline_id = s.id
        join articles a on a.group_id = sg.group_id
       where s.label is not null
         and s.merged_into is null
    )
    select storyline_id as id,
           label,
           count(*) filter (where published >= ${from} and published < ${to}) as span_articles,
           count(distinct source_domain) filter (where published >= ${from} and published < ${to}) as span_domains,
           count(*) as total_articles
      from member
     group by storyline_id, label
    having count(*) filter (where published >= ${from} and published < ${to}) >= 5
       and count(distinct source_domain) filter (where published >= ${from} and published < ${to}) >= 2
     order by span_articles desc, id
     limit ${limit}
  `.execute(services.deps.db);

  return rows.rows.map((row) => ({
    id: row.id,
    label: row.label,
    spanArticles: Number(row.span_articles),
    spanDomains: Number(row.span_domains),
    totalArticles: Number(row.total_articles),
  }));
}

/** Distinct articles currently reachable from an arc, through its groups. */
async function arcArticleCount(services: Services, storylineId: string): Promise<number> {
  const row = await sql<{ n: string }>`
    select count(distinct a.id) as n
      from storyline_groups sg
      join articles a on a.group_id = sg.group_id
     where sg.storyline_id = ${storylineId}
  `.execute(services.deps.db);
  return Number(row.rows[0]?.n ?? 0);
}

/** The article-id high-water mark. Everything above it postdates the snapshot. */
async function maxArticleId(services: Services): Promise<string> {
  const row = await sql<{ id: string | null }>`select max(id) as id from articles`.execute(
    services.deps.db,
  );
  return row.rows[0]?.id ?? "0";
}

/** How many labels have been written. The G5 guarantee is that this does not move. */
async function labelCount(services: Services): Promise<number> {
  const row = await sql<{ n: string }>`
    select count(*) as n from storylines where label is not null
  `.execute(services.deps.db);
  return Number(row.rows[0]?.n ?? 0);
}

async function storylineCount(services: Services): Promise<number> {
  const row = await sql<{ n: string }>`select count(*) as n from storylines`.execute(
    services.deps.db,
  );
  return Number(row.rows[0]?.n ?? 0);
}

/**
 * One arc's call, as the transcript records it.
 *
 * `error` carries the class name and message rather than the object: the whole
 * reason this field exists is the throttling question, and a `NewsQuotaError`
 * from our own governor, a 429 the provider sent and a socket timeout are three
 * different answers to it that a stringified object would blur.
 */
interface Attempt {
  tag: string;
  storylineId: string;
  label: string;
  keywords: string | null;
  from: string;
  to: string;
  spanArticles: number;
  spanDomains: number;
  arcBefore: number;
  arcAfter: number;
  articlesBefore: string;
  ms: number;
  outcome: "ok" | "ungrounded" | "error";
  error?: { name: string; message: string };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const log = {
  info: (fields: object, message: string): void =>
    console.error(JSON.stringify({ level: "info", message, ...fields })),
  warn: (fields: object, message: string): void =>
    console.error(JSON.stringify({ level: "warn", message, ...fields })),
};

/**
 * `--from`/`--to` as instants. A missing or nonsensical span prints the whole
 * help rather than a one-line complaint: this command spends real upstream
 * calls, and the sub-command table is what says which of the three does.
 */
function parseSpan(args: Args): { from: Date; to: Date } {
  const rawFrom = args.value("from");
  const rawTo = args.value("to");
  if (!rawFrom || !rawTo) throw new UsageError();
  const from = new Date(`${rawFrom}T00:00:00Z`);
  const to = new Date(`${rawTo}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new UsageError();
  }
  return { from, to };
}


/** An arc's profile tokens, which the grounding gate is computed against. */
async function profileTokens(services: Services, storylineId: string): Promise<string[]> {
  const row = await sql<{ profile_tokens: string[] | null }>`
    select profile_tokens from storylines where id = ${storylineId}
  `.execute(services.deps.db);
  return row.rows[0]?.profile_tokens ?? [];
}

/**
 * How alike two headlines are, for the purpose of asking whether the fold
 * SHOULD have merged them — never for deciding that it will.
 *
 * Jaccard over word sets after a positional suffix strip, lowercasing and a
 * punctuation collapse. Three deliberate departures from `stripOutletSuffix`,
 * all in the same direction:
 *
 *  - The suffix is peeled by POSITION, not by naming the domain. ADR-0018
 *    measured that rule merging 68 unrelated `Frontiers | …` papers, which
 *    disqualifies it as a fold and qualifies it here: this is looking for
 *    candidates a stricter rule would hide.
 *  - Word ORDER is discarded, so a headline an outlet re-cut survives.
 *  - The threshold is a similarity score, which ADR-0018 refuses for identity
 *    for good reasons that do not apply to a report a person then reads.
 *
 * Every pair above the floor is printed in full so the count can be checked
 * rather than believed.
 */
export function titleOverlap(left: string, right: string): number {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function titleWords(title: string): Set<string> {
  const stripped = title.replace(/\s+[-|–—]\s+[^-|–—]{1,60}$/u, "");
  return new Set(
    stripped
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}


interface FoldMiss {
  score: number;
  domain: string;
  createdId: string;
  createdTitle: string;
  twinId: string;
  twinTitle: string;
}

interface ArcReport {
  storylineId: string;
  label: string;
  spanArticles: number;
  spanDomains: number;
  ingested: number;
  absorbed: number;
  created: number;
  foldMisses: number;
  stale: number;
  attachedToArc: number;
  misses: FoldMiss[];
}

function quantiles(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { min: sorted[0] ?? 0, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] ?? 0 };
}

/**
 * The fingerprint `processDeepenJob` minted for one arc's fetch, recomputed the
 * same way it computed it — `canonicalKeywords` over the label, the arc's own
 * language, no country and no category.
 *
 * This is the per-arc attribution, and it is exact rather than inferred: the
 * fetch enrolls every article of its batch into that topic through
 * `topic_articles`, created and absorbed alike, so the topic IS the batch. The
 * alternative — clustering `sightings.first_seen_at` — would have to guess where
 * one call ended and the next began.
 *
 * The one way it can lie is a fingerprint that collided with a topic a reader
 * had already searched, which would attribute that reader's articles to this
 * arc. `stale` in the report is what detects it: a row in the topic that
 * predates the run and carries no deepening sighting.
 */
async function deepeningFingerprint(
  services: Services,
  storylineId: string,
  keywords: string,
): Promise<string> {
  const language = await readStorylineLanguage(services.deps.db, storylineId);
  return fingerprintOf({
    keywords: canonicalKeywords(keywords),
    language: language ?? null,
    country: null,
    category: null,
  });
}
