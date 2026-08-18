import { loadConfig } from "@zammy/config";
import { createDb } from "@zammy/storage";
import { zonedDayKey } from "./app-day.js";
import { storyTokens } from "./storyline.js";
import { replayLinker, type ReplayGroup } from "./storyline-replay.js";
import type { Corpus, LinkRules } from "./storyline-link.js";
import { readJudgedStorylines, scoreJudged, type JudgedStoryline } from "./storyline-judged.js";

/**
 * `pnpm measure:storylines-v2 [--days=N]` — the ADR-0011 threshold sweep.
 *
 * Read-only. Replays the group→storyline decision over the live corpus for a
 * grid of (anchor share, mass, K, dormancy) and reports what each WOULD build:
 * how many storylines, how many are real, and above all the LARGEST-STORYLINE
 * SHARE — the percolation alarm. ADR-0009's transitive first cut absorbed 1,179
 * of a day's 1,190 groups, a 99% share, and that failure is the specification's
 * north star. A sweep that cannot see it coming is not a sweep.
 *
 * The trailing corpus slides with the replay: each group is judged against the
 * 14 days before IT arrived, not against today. `story_token_days` is loaded
 * once and windowed in memory — a df lookup per group through Postgres would
 * take longer than the month it measures.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const days = Number(flag("days") ?? 31);
if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const TZ = config.APP_TIMEZONE;
const WINDOW = config.STORYLINE_DF_WINDOW_DAYS;

try {
  const from = new Date(Date.now() - days * 86_400_000);

  // ---- the corpus, as groups ----
  const rows = await db
    .selectFrom("articles")
    .select(["id", "group_id", "title", "description", "language", "published"])
    .where("published", ">=", from)
    .orderBy("published", "asc")
    .orderBy("id", "asc")
    .execute();

  const byGroup = new Map<string, ReplayGroup & { memberTokens: string[][] }>();
  for (const row of rows) {
    const existing = byGroup.get(row.group_id);
    const tokens = storyTokens(row.title, row.description);
    if (existing) {
      existing.memberTokens.push(tokens);
      if (row.published.getTime() < existing.publishedMs) {
        existing.publishedMs = row.published.getTime();
        existing.dayKey = zonedDayKey(row.published, TZ);
      }
      continue;
    }
    byGroup.set(row.group_id, {
      groupId: row.group_id,
      memberTokens: [tokens],
      language: row.language,
      publishedMs: row.published.getTime(),
      dayKey: zonedDayKey(row.published, TZ),
    });
  }
  const groups = [...byGroup.values()];
  console.log(
    `${rows.length} articles in ${groups.length} groups over ${days} days ` +
      `(timezone ${TZ}, df window ${WINDOW}d)`,
  );

  // ---- the trailing corpus, windowed in memory ----
  const dfRows = await db
    .selectFrom("story_token_days")
    .select(["day", "language", "token", "df"])
    .execute();
  const corpusRows = await db
    .selectFrom("story_corpus_days")
    .select(["day", "language", "articles"])
    .execute();

  /** language → day → token → df, and language → day → articles. */
  const dfByDay = new Map<string, Map<string, Map<string, number>>>();
  for (const row of dfRows) {
    const lang = dfByDay.get(row.language) ?? new Map();
    const day = lang.get(row.day) ?? new Map<string, number>();
    day.set(row.token, row.df);
    lang.set(row.day, day);
    dfByDay.set(row.language, lang);
  }
  const sizeByDay = new Map<string, Map<string, number>>();
  for (const row of corpusRows) {
    const lang = sizeByDay.get(row.language) ?? new Map<string, number>();
    lang.set(row.day, row.articles);
    sizeByDay.set(row.language, lang);
  }

  /** The window's inclusive day keys, ending on the group's own day. */
  const windowDays = (endKey: string): string[] => {
    const end = new Date(`${endKey}T12:00:00Z`);
    const keys: string[] = [];
    for (let back = 0; back < WINDOW; back += 1) {
      keys.push(zonedDayKey(new Date(end.getTime() - back * 86_400_000), "UTC"));
    }
    return keys;
  };

  // Memoized per (language, dayKey): every group on one day shares a window,
  // and there are ~30 days, not 20,000.
  const corpusCache = new Map<string, { size: number; df: Map<string, number> }>();
  const corpusFor = (language: string | null, dayKey: string) => {
    const lang = language ?? "";
    const key = `${lang}|${dayKey}`;
    const hit = corpusCache.get(key);
    if (hit) return hit;

    const df = new Map<string, number>();
    let size = 0;
    for (const day of windowDays(dayKey)) {
      size += sizeByDay.get(lang)?.get(day) ?? 0;
      for (const [token, count] of dfByDay.get(lang)?.get(day) ?? []) {
        df.set(token, (df.get(token) ?? 0) + count);
      }
    }
    const corpus = { size, df };
    corpusCache.set(key, corpus);
    return corpus;
  };
  const corpusAt = (group: ReplayGroup): Corpus => corpusFor(group.language, group.dayKey);

  // ---- the hand-judged sets (docs/STORYLINE-LINKING.md, "What the anchor rule
  //      cannot see") ----
  //
  // The columns below are the sweep's answer to "check what a change DESTROYS,
  // not just what it prevents". Every threshold in this design trades the two
  // directions off against each other, and until the labelling campaign there
  // was nothing to weigh the trade against but an operator reading samples.
  //
  // `declined` are storylines a model was shown and could not name — dominated
  // by two unrelated articles sharing a word, and the thing a candidate change
  // is trying to stop. `named` are the ones it named, including every large
  // correct arc in the archive, and a candidate change must leave them standing.
  const judged = await readJudgedStorylines(db);
  const declined: JudgedStoryline[] = judged.declined;
  const named: JudgedStoryline[] = judged.named;
  // Only groups the replay was actually offered count — a judged arc reaching
  // back past `--days` must not be charged to the rule under test.
  const known = (groupId: string): boolean => byGroup.has(groupId);
  console.log(
    `hand-judged sets: ${declined.length} declined (unnameable), ${named.length} named`,
  );

  /** The two directions and the alarm, for one replay. */
  const judgedColumns = (result: { built: { groupIds: string[] }[] }): string => {
    const bad = scoreJudged(result.built, declined, known);
    const good = scoreJudged(result.built, named, known);
    const pct = (part: number, whole: number): string =>
      whole === 0 ? "  n/a" : `${((100 * part) / whole).toFixed(1).padStart(5)}%`;
    return (
      `${String(bad.formed).padStart(5)}/${String(bad.n).padEnd(4)} ${pct(bad.formed, bad.n)}  ` +
      `${String(good.intact).padStart(5)}/${String(good.n).padEnd(4)} ${pct(good.intact, good.n)}  ` +
      `${pct(good.groupsTogether, good.groupsTotal)}`
    );
  };
  const JUDGED_HEADER = " PILES-FORMED       NAMED-INTACT       kept";

  // ---- the sweep ----
  const SHARES = [0.001, 0.002, 0.003, 0.005, 0.01, 0.02];
  const MASSES = [8, 12, 16, 20, 25];
  const BASE = { anchorDfFloor: 10, dormancyDays: 90, dormantStrictness: 1.5 };

  // `--focus-only` skips the grid: once the operator is comparing two
  // candidate settings by READING what they build, re-running 25 replays to
  // reprint a table they already have is minutes per look.
  const focusOnly = args.includes("--focus-only");
  if (!focusOnly) {
  console.log("\nanchor+mass sweep (K=2, dormancy 90d):");
  console.log(
    "share   mass  storylines  promoted  attached  merges  LARGEST  share%   p50  p99  daySlots" +
      JUDGED_HEADER,
  );
  for (const anchorMaxShare of SHARES) {
    for (const massThreshold of MASSES) {
      const rules: LinkRules = { ...BASE, anchorMaxShare, massThreshold };
      const result = replayLinker(groups, corpusAt, rules, 2);
      console.log(
        `${String(anchorMaxShare).padEnd(7)} ${String(massThreshold).padEnd(5)} ` +
          `${String(result.storylines).padStart(10)}  ${String(result.promoted).padStart(8)}  ` +
          `${String(result.attached).padStart(8)}  ${String(result.merges).padStart(6)}  ` +
          `${String(result.largestStoryline).padStart(7)}  ` +
          `${(result.largestShare * 100).toFixed(2).padStart(6)}  ` +
          `${String(result.p50).padStart(4)} ${String(result.p99).padStart(4)}  ` +
          `${String(result.daySlots).padStart(8)}  ` +
          judgedColumns(result),
      );
    }
  }

  }

  // ---- K, at the anchor+mass the operator is looking at ----
  const focus = {
    anchorMaxShare: Number(flag("share") ?? 0.01),
    massThreshold: Number(flag("mass") ?? 16),
  };
  if (!focusOnly) {
  console.log(`\nbridge count K (share=${focus.anchorMaxShare}, mass=${focus.massThreshold}):`);
  console.log("K   storylines  promoted  merges  LARGEST  share%");
  for (const k of [1, 2, 3, 4]) {
    const result = replayLinker(groups, corpusAt, { ...BASE, ...focus }, k);
    console.log(
      `${String(k).padEnd(3)} ${String(result.storylines).padStart(10)}  ` +
        `${String(result.promoted).padStart(8)}  ${String(result.merges).padStart(6)}  ` +
        `${String(result.largestStoryline).padStart(7)}  ` +
        `${(result.largestShare * 100).toFixed(2).padStart(6)}`,
    );
  }

  }

  // ---- dormancy, same focus ----
  if (!focusOnly) {
  console.log(`\ndormancy window (share=${focus.anchorMaxShare}, mass=${focus.massThreshold}, K=2):`);
  console.log("days  strictness  storylines  promoted  LARGEST  share%");
  for (const dormancyDays of [7, 30, 90, 365]) {
    for (const dormantStrictness of [1.5, 2]) {
      const result = replayLinker(
        groups,
        corpusAt,
        { ...BASE, ...focus, dormancyDays, dormantStrictness },
        2,
      );
      console.log(
        `${String(dormancyDays).padEnd(5)} ${String(dormantStrictness).padEnd(11)} ` +
          `${String(result.storylines).padStart(10)}  ${String(result.promoted).padStart(8)}  ` +
          `${String(result.largestStoryline).padStart(7)}  ` +
          `${(result.largestShare * 100).toFixed(2).padStart(6)}`,
      );
    }
  }

  }

  // ---- what the storylines ARE, at the focus ----
  //
  // The sweep table cannot say whether a storyline is coherent; only reading
  // some can. A threshold pinned off counts alone is pinned off half the
  // evidence, and ADR-0009's own history is the argument: the 1,179-group
  // swallow was found by looking at what a storyline had absorbed, not by
  // noticing a number had moved.
  const focused = replayLinker(groups, corpusAt, { ...BASE, ...focus }, 2);
  const headline = new Map<string, string>();
  for (const row of rows) if (!headline.has(row.group_id)) headline.set(row.group_id, row.title);

  console.log(`\n=== the ${Math.min(8, focused.built.length)} largest storylines at the focus ===`);
  for (const storyline of focused.built.slice(0, 8)) {
    console.log(
      `\n[${storyline.groupIds.length} groups, ${storyline.days} days] ` +
        `profile: ${storyline.profile.slice(0, 14).join(", ")}`,
    );
    for (const groupId of storyline.groupIds.slice(0, 6)) {
      console.log(`    ${(headline.get(groupId) ?? "?").slice(0, 96)}`);
    }
  }

  // The median promoted storyline is the one a reader meets most often, so a
  // sample of ordinary ones matters as much as the head of the distribution.
  const typical = focused.built.filter((s) => s.groupIds.length === focused.p50);
  console.log(`\n=== ${Math.min(5, typical.length)} TYPICAL storylines (${focused.p50} groups) ===`);
  for (const storyline of typical.slice(0, 5)) {
    console.log(`\nprofile: ${storyline.profile.slice(0, 12).join(", ")}`);
    for (const groupId of storyline.groupIds) {
      console.log(`    ${(headline.get(groupId) ?? "?").slice(0, 96)}`);
    }
  }
} finally {
  await db.destroy();
}
