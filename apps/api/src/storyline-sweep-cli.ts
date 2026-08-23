import { loadConfig } from "@zammy/config";
import { zonedDayKey } from "./app-day.js";
import { storyTokens } from "./storyline.js";
import {
  replayHybrid,
  replayLinker,
  replayWithReoffers,
  type ReplayGroup,
  type ReplayResult,
  type ReplayVariant,
} from "./storyline-replay.js";
import type { Corpus, LinkRules } from "./storyline-link.js";
import { readJudgedStorylines, scoreJudged, type JudgedStoryline } from "./storyline-judged.js";
import { createConfiguredDb, maxBridgingQualifiers } from "./wiring.js";

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
const db = createConfiguredDb(config);
const TZ = config.APP_TIMEZONE;
const WINDOW = config.STORYLINE_DF_WINDOW_DAYS;
/**
 * The retrieval the replay models, from the same flag the service reads
 * (`STORYLINE_NARROW_RETRIEVAL`). Not an argument of this CLI: the point of the
 * sweep is that it pins thresholds against the candidate set production will
 * judge, so a `--narrow` override would be a way to certify numbers nothing runs.
 * Flip the env var, and the grid below describes the mode that is deployed.
 */
const NARROW = config.STORYLINE_NARROW_RETRIEVAL;
/**
 * The bridge bound the replay models by DEFAULT, from the same flag the service
 * reads (`STORYLINE_MAX_BRIDGING_QUALIFIERS`; `undefined` is unbounded).
 *
 * Same reasoning as `NARROW` — a grid that describes a bound nothing is running
 * certifies nothing — with one difference that matters for the option table:
 * `--variant=cap:N` DOES override it. Pricing a bound the configuration does not
 * have is the entire purpose of that table, and the override is explicit in the
 * run's own header, so it cannot be mistaken for the deployed mode the way a
 * silent default could.
 */
const CONFIGURED_BOUND = maxBridgingQualifiers(config);
/**
 * The configured bound as a variant, for the grids below — which take no
 * `--variant` and must still describe the deployed decision, exactly as they
 * take `NARROW` rather than a flag. Empty when the bound is off, which is the
 * default and why the committed grid keeps reproducing.
 */
const GRID_VARIANT: ReplayVariant =
  CONFIGURED_BOUND === undefined ? {} : { maxBridgingQualifiers: CONFIGURED_BOUND };

try {
  const from = new Date(Date.now() - days * 86_400_000);

  // ---- the corpus, as groups ----
  const rows = await db
    .selectFrom("articles")
    .select([
      "id",
      "group_id",
      "title",
      "description",
      "language",
      "published",
      "source_domain",
    ])
    .where("published", ">=", from)
    .orderBy("published", "asc")
    .orderBy("id", "asc")
    .execute();

  const byGroup = new Map<string, ReplayGroup & { memberTokens: string[][] }>();
  for (const row of rows) {
    const existing = byGroup.get(row.group_id);
    const tokens = storyTokens(row.title, row.description);
    // The group's domain is the first alphabetically, so a group with several
    // counts as ONE source rather than as several — see `ReplayGroup`.
    const domain = row.source_domain ?? "";
    if (existing) {
      existing.memberTokens.push(tokens);
      if (domain !== "" && (existing.sourceDomain === "" || domain < existing.sourceDomain)) {
        existing.sourceDomain = domain;
      }
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
      sourceDomain: domain,
    });
  }
  const groups = [...byGroup.values()];
  console.log(
    `${rows.length} articles in ${groups.length} groups over ${days} days ` +
      `(timezone ${TZ}, df window ${WINDOW}d, retrieval ` +
      `${NARROW ? "anchor-eligible, cap 4000" : "whole profile, cap 200"}, configured ` +
      `bridge bound ${CONFIGURED_BOUND === undefined ? "UNBOUNDED" : `top-${CONFIGURED_BOUND}`})`,
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

  // ---- the grid, and the bar every focused run below is measured at ----
  const SHARES = [0.001, 0.002, 0.003, 0.005, 0.01, 0.02];
  const MASSES = [8, 12, 16, 20, 25];
  const BASE = { anchorDfFloor: 10, dormancyDays: 90, dormantStrictness: 1.5 };
  const focus = {
    anchorMaxShare: Number(flag("share") ?? 0.01),
    massThreshold: Number(flag("mass") ?? 16),
  };

  const headline = new Map<string, string>();
  for (const row of rows) if (!headline.has(row.group_id)) headline.set(row.group_id, row.title);

  /** The largest arcs, printed to be READ. A table cannot judge coherence. */
  const readArcs = (result: ReplayResult, count: number, headlines: number): void => {
    for (const storyline of result.built.slice(0, count)) {
      console.log(
        `\n[${storyline.groupIds.length} groups, ${storyline.days} days` +
          `${storyline.capShaped ? ", CAP-SHAPED" : ""}] ` +
          `profile: ${storyline.profile.slice(0, 16).join(", ")}`,
      );
      for (const groupId of storyline.groupIds.slice(0, headlines)) {
        console.log(`    ${(headline.get(groupId) ?? "?").slice(0, 100)}`);
      }
    }
  };

  // ---- the variant under test, for every branch below ----
  //
  // Comma-separated, because the answer may well be a combination and pricing
  // one requires running one — `cap:2,days,birth-bridges`. Parsed ONCE, above
  // the branches, so `--reoffer` and `--hybrid` cannot come to mean different
  // things by the same flag: the two are the same decision at different offer
  // rates, and a variant that applied to only one of them would make them
  // incomparable exactly where the comparison is the point.
  const variantName = flag("variant") ?? "base";
  const parts = variantName.split(",");
  const cap = parts.find((part) => part.startsWith("cap:"));
  const independence = parts.find((part) => part === "days" || part === "domains");
  // `cap:N` overrides the configured bound; with no `cap:` part the run models
  // whatever `STORYLINE_MAX_BRIDGING_QUALIFIERS` is set to, so an unqualified
  // `--variant=base` describes the deployed mode rather than a hypothetical.
  // `cap:0` is how a run asks for UNBOUNDED against a configured bound, which
  // is what reproducing the committed option table needs once the flag is on.
  if (cap !== undefined && !/^cap:\d+$/.test(cap)) {
    console.error(`--variant cap must be a non-negative integer, got \`${cap}\``);
    process.exit(1);
  }
  const configuredCap = cap === undefined ? CONFIGURED_BOUND : Number(cap.slice(4)) || undefined;
  const variant: ReplayVariant = {
    ...(configuredCap !== undefined ? { maxBridgingQualifiers: configuredCap } : {}),
    ...(independence !== undefined ? { independence: independence as "days" | "domains" } : {}),
    ...(parts.includes("birth-bridges") ? { bridgeOffers: "first" as const } : {}),
  };
  const unknown = parts.filter(
    (part) =>
      part !== "base" &&
      part !== "birth-bridges" &&
      part !== "days" &&
      part !== "domains" &&
      !part.startsWith("cap:"),
  );
  if (unknown.length > 0) {
    console.error(`unknown --variant part(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  // ---- K, re-measured against a replay that RE-OFFERS ----
  //
  // The measurement `STORYLINE_LATE_CANDIDATE_SWEEP`,
  // `STORYLINE_REOFFER_JOINED_GROUPS` and
  // `STORYLINE_LATE_CANDIDATE_CHANGED_ONLY` are all gated on. Everything below
  // this line reports a TRAJECTORY rather than an endpoint, because a converged
  // number cannot tell "settled" from "still climbing when the run stopped" —
  // which is the mistake VERCEL-PHASE-0-FINDINGS §2.6 records being made twice.
  const reoffer = flag("reoffer");
  if (reoffer !== undefined) {
    if (reoffer !== "interleaved" && reoffer !== "posthoc") {
      console.error("--reoffer must be `interleaved` or `posthoc`");
      process.exit(1);
    }
    const passes = Number(flag("passes") ?? 8);
    const ks = (flag("k") ?? "2").split(",").map(Number);
    const cascade = args.includes("--cascade");
    // `--capped-build=200` builds the archive under the pre-#117 retrieval and
    // then sweeps it corrected — §2.6's experiment, and the only way to tell a
    // threshold problem from a backlog drain.
    const cappedBuild = flag("capped-build");
    const fidelity = {
      cascadeMerges: cascade,
      ...(cappedBuild !== undefined ? { cappedRetrievalLimit: Number(cappedBuild) } : {}),
    };
    console.log(
      `\n=== K against a re-offering replay: ${reoffer}, variant ${variantName}` +
        `${cascade ? ", cascade+repoint" : ""}` +
        `${cappedBuild !== undefined ? `, archive built at cap ${cappedBuild}` : ""} ` +
        `(share=${focus.anchorMaxShare}, mass=${focus.massThreshold}, retrieval ` +
        `${NARROW ? "NARROWED" : "BROAD"}) ===`,
    );
    console.log(
      "The birth-only replay at this bar is the calibration; every row below " +
        "is the SAME decision offered more than once.",
    );
    // Named in the header AND here, because `STORYLINE_NARROW_RETRIEVAL` now
    // defaults to FALSE (PR #128) and these numbers were taken with it ON. A
    // reader who assumes today's default reads the whole table backwards.
    console.log(
      `retrieval: ${
        NARROW
          ? "anchor-eligible probe, cap 4,000 — STORYLINE_NARROW_RETRIEVAL=true, NOT the default"
          : "whole-profile probe, cap 200 — STORYLINE_NARROW_RETRIEVAL=false, today's default"
      }`,
    );
    // Printed for the same reason, and it is the reason `cap:0` exists: the
    // bound changes what every row below means, and a reader who assumes the
    // default reads a bounded table as the baseline.
    console.log(
      `bridge bound: ${
        configuredCap === undefined
          ? "UNBOUNDED — STORYLINE_MAX_BRIDGING_QUALIFIERS=0, today's default"
          : `top-${configuredCap} qualifiers may bridge` +
            `${cap === undefined ? " — from STORYLINE_MAX_BRIDGING_QUALIFIERS" : " — from --variant"}`
      }`,
    );

    for (const k of ks) {
      console.log(`\n--- K=${k} ---`);
      // `offered` rides in the label, so it is not a column here.
      console.log(
        "pass                           live-sl  promoted  LARGEST  share%  " +
          "merges(+new)  retro  pairs  bridges   p50 p90 p99   2-4   5-9 10-19 20-49 50-99  100+",
      );
      let previousMerges = 0;
      const line = (label: string, result: ReplayResult): void => {
        const delta = result.merges - previousMerges;
        previousMerges = result.merges;
        const buckets = result.sizeBuckets
          .map((bucket) => String(bucket.count).padStart(5))
          .join(" ");
        console.log(
          `${label.padEnd(30)} ${String(result.storylines).padStart(7)}  ` +
            `${String(result.promoted).padStart(8)}  ${String(result.largestStoryline).padStart(7)}  ` +
            `${(result.largestShare * 100).toFixed(2).padStart(6)}  ` +
            `${String(result.merges).padStart(6)}(+${String(delta).padStart(4)})  ` +
            `${String(result.retroAttached).padStart(5)}  ` +
            `${String(result.bridgedPairs).padStart(5)}  ${String(result.bridgeObservations).padStart(7)}  ` +
            `${String(result.p50).padStart(4)}${String(result.p90).padStart(4)}${String(result.p99).padStart(4)}  ` +
            buckets,
        );
      };

      // The birth-only state first, so every trajectory below has the pass-0
      // it departs from — and so the calibration is on the same page as the
      // number it calibrates.
      line(
        `0 birth-only${cappedBuild !== undefined ? ` (cap ${cappedBuild})` : ""}`,
        replayLinker(groups, corpusAt, { ...BASE, ...focus }, k, NARROW, fidelity, variant),
      );
      previousMerges = 0;

      const final = replayWithReoffers(groups, corpusAt, { ...BASE, ...focus }, k, NARROW, {
        mode: reoffer,
        windowDays: WINDOW,
        passes,
        fidelity,
        variant,
        onPass: (pass, label, result) => line(`${pass} ${label}`, result),
      });
      console.log(`     judged: ${judgedColumns(final)}   (${JUDGED_HEADER.trim()})`);

      const toRead = Number(flag("read") ?? 0);
      if (toRead > 0) {
        console.log(`\n=== the ${Math.min(toRead, final.built.length)} largest arcs at K=${k} ===`);
        readArcs(final, toRead, Number(flag("headlines") ?? 8));
      }
    }
    // Explicit, because `process.exit` below would skip the `finally` that
    // closes the pool.
    await db.destroy();
    process.exit(0);
  }

  // ---- the hybrid: a cap-built archive, then corrected BIRTHS ----
  //
  // §2.7 step 1. `--reoffer=posthoc --capped-build=200` prices the same starting
  // state under sweep re-offers and converges at 4,668; this offers the
  // corrected retrieval at the BIRTH path's rate instead — a day's new groups,
  // once each, no sweep — which is what production would walk if the flag were
  // turned on, since all three re-offer flags are off.
  if (args.includes("--hybrid")) {
    const cappedBuild = flag("capped-build");
    const k = Number(flag("k") ?? config.STORYLINE_MERGE_BRIDGES);
    const cascade = !args.includes("--no-cascade");

    // The day keys the corpus actually holds, so the switch lands on a day that
    // exists rather than on a date that happens to be N days back.
    const dayKeys = [...new Set(groups.map((group) => group.dayKey))].sort();
    const switchAfter = Number(flag("switch-after") ?? 7);
    const switchOn =
      flag("switch-on") ?? dayKeys[Math.max(0, dayKeys.length - switchAfter)] ?? "";
    const corrected = dayKeys.filter((day) => day >= switchOn);
    if (corrected.length === 0) {
      console.error(`--switch-on=${switchOn} is after the last day in the corpus`);
      process.exit(1);
    }

    console.log(
      `\n=== §2.7 the hybrid: cap-built archive, then corrected BIRTHS ===\n` +
        `build: ${
          cappedBuild === undefined
            ? "NO CAP — the from-scratch control, same days on one instrument"
            : `whole-profile probe, ${cappedBuild}-row cut APPLIED (pre-#117)`
        }\n` +
        `after ${switchOn} (${corrected.length} of ${dayKeys.length} days): ` +
        `${NARROW ? "anchor-eligible probe, cap 4,000 reported not applied" : "UNCHANGED — the flag-off control, cap stays applied"}\n` +
        `birth-only: every group offered exactly ONCE, no sweep — ` +
        `K=${k}${cascade ? ", cascade+repoint modelled" : ", cascade NOT modelled"}, ` +
        `variant ${variantName}` +
        `${
          configuredCap === undefined
            ? " (bridge cross-product UNBOUNDED)"
            : ` (at most ${configuredCap} qualifiers may bridge)`
        }\n` +
        // Named in the header because `--share`/`--mass` default to the
        // operator's exploration focus (0.01/16) and NOT to the shipped bar
        // (0.002/20) — a trajectory read against the wrong bar is off by an
        // order of magnitude, which is a mistake this measurement made once.
        `bar: share=${focus.anchorMaxShare}, mass=${focus.massThreshold}` +
        `${
          focus.anchorMaxShare === config.STORYLINE_ANCHOR_MAX_SHARE &&
          focus.massThreshold === config.STORYLINE_MASS_THRESHOLD_V2
            ? " — the PINNED bar"
            : ` — NOT the pinned bar (${config.STORYLINE_ANCHOR_MAX_SHARE}/${config.STORYLINE_MASS_THRESHOLD_V2})`
        }`,
    );
    if (!NARROW && cappedBuild !== undefined) {
      console.log(
        "STORYLINE_NARROW_RETRIEVAL=false, so this run is the CONTROL: the cap " +
          "and the broad probe are a pair and do not come apart at the switch.",
      );
    }
    console.log(
      "\nday        phase  born  live-sl  promoted  LARGEST  share%  merges(+new)  " +
        "fused cap/mix/new  →cap   pairs  bridges   p50 p90 p99   2-4   5-9 10-19 20-49 50-99  100+",
    );

    let previousMerges = 0;
    const final = replayHybrid(groups, corpusAt, { ...BASE, ...focus }, k, NARROW, {
      ...(cappedBuild !== undefined ? { cappedRetrievalLimit: Number(cappedBuild) } : {}),
      switchOn,
      fidelity: { cascadeMerges: cascade },
      variant,
      onDay: (day, result) => {
        const delta = result.merges - previousMerges;
        previousMerges = result.merges;
        const buckets = result.sizeBuckets
          .map((bucket) => String(bucket.count).padStart(5))
          .join(" ");
        console.log(
          `${day.dayKey}  ${day.phase.padEnd(5)} ${String(day.born).padStart(5)}  ` +
            `${String(result.storylines).padStart(7)}  ${String(result.promoted).padStart(8)}  ` +
            `${String(result.largestStoryline).padStart(7)}  ` +
            `${(result.largestShare * 100).toFixed(2).padStart(6)}  ` +
            `${String(result.merges).padStart(6)}(+${String(delta).padStart(4)})  ` +
            `${String(result.fusedCapShaped).padStart(6)}/${String(result.fusedMixed).padStart(4)}/` +
            `${String(result.fusedFresh).padStart(4)}  ` +
            `${String(result.attachedToCapShaped).padStart(5)}  ` +
            `${String(result.bridgedPairs).padStart(5)}  ${String(result.bridgeObservations).padStart(7)}  ` +
            `${String(result.p50).padStart(4)}${String(result.p90).padStart(4)}${String(result.p99).padStart(4)}  ` +
            buckets,
        );
      },
    });

    // The attribution, spelled out — §2.7's mechanism is that the corrected
    // retrieval FUSES arcs the cap created, and "merges happened" cannot tell
    // that from ordinary linking. A from-scratch run cannot produce a
    // cap/cap merge at all, so that column is the hybrid's own content.
    const postSwitch = final.fusedCapShaped + final.fusedMixed + final.fusedFresh;
    console.log(
      `\npost-switch merges: ${postSwitch} — ${final.fusedCapShaped} fused two ` +
        `cap-shaped arcs, ${final.fusedMixed} one, ${final.fusedFresh} neither. ` +
        `${final.attachedToCapShaped} groups ATTACHED to a cap-shaped arc (growth, not fusion).`,
    );
    console.log(
      `candidate cap: ${final.cappedGroups} of ${groups.length} groups exceeded the ` +
        `configured row limit at the offer they were judged on`,
    );
    console.log(`     judged: ${judgedColumns(final)}   (${JUDGED_HEADER.trim()})`);

    const toRead = Number(flag("read") ?? 0);
    if (toRead > 0) {
      console.log(`\n=== the ${Math.min(toRead, final.built.length)} largest arcs ===`);
      readArcs(final, toRead, Number(flag("headlines") ?? 8));
    }
    await db.destroy();
    process.exit(0);
  }

  // ---- the sweep ----
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
      const result = replayLinker(groups, corpusAt, rules, 2, NARROW, {}, GRID_VARIANT);
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
  if (!focusOnly) {
  console.log(`\nbridge count K (share=${focus.anchorMaxShare}, mass=${focus.massThreshold}):`);
  console.log("K   storylines  promoted  merges  LARGEST  share%");
  for (const k of [1, 2, 3, 4]) {
    const result = replayLinker(groups, corpusAt, { ...BASE, ...focus }, k, NARROW, {}, GRID_VARIANT);
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
        NARROW,
        {},
        GRID_VARIANT,
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
  const focused = replayLinker(groups, corpusAt, { ...BASE, ...focus }, 2, NARROW, {}, GRID_VARIANT);

  // What the grid above does NOT model: the service cuts the candidate set at a
  // row limit and this harness does not, so a non-zero count here means the
  // numbers were certified against a set production would have truncated. That
  // silence is how the pre-2026-08-22 cap hid — 99% of groups, unreported. Zero
  // is the narrowed retrieval's censused answer over the whole dev window.
  console.log(
    `\ncandidate cap: ${focused.cappedGroups} of ${groups.length} groups exceeded the ` +
      `${NARROW ? "4,000" : "200"}-row limit the service would apply` +
      `${focused.cappedGroups > 0 ? " — the grid above is NOT what production judges" : ""}`,
  );

  console.log(`\n=== the ${Math.min(8, focused.built.length)} largest storylines at the focus ===`);
  readArcs(focused, 8, 6);

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
