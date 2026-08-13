import { loadConfig } from "@zammy/config";
import { createDb } from "@zammy/storage";
import { zonedDayKey } from "./app-day.js";
import {
  headlineFigures,
  headlineTokens,
  rankedMatches,
  type GroupCandidate,
} from "./grouping.js";
import {
  clusterStorylines,
  storyDayDf,
  storyTokens,
  type StorylineGroup,
} from "./storyline.js";

/**
 * `pnpm measure:storylines [--days=N]` — the ADR-0009 measurement pass.
 *
 * Read-only. Before merge-repair or storyline thresholds are pinned, this
 * replays both decisions over the live corpus and reports what each WOULD do —
 * the posture ADR-0005 set (measure on live data, then choose), and the
 * explicit acceptance condition the feature was designed under: no number
 * ships unmeasured (§14.3's post-mortem).
 *
 * Two simulations, in dependency order:
 *
 *  1. **Merge-repair**: for every article, re-run today's grouping decision
 *     (`rankedMatches`, the production function — not a reimplementation) and
 *     union the groups its matches span. A match across two groups is bridge
 *     evidence the split should not exist.
 *  2. **Storylines**: over the repaired groups, evaluate the anchor+mass rule
 *     for a grid of (anchorMaxDf, massThreshold) and report slot compression,
 *     size distributions, and the specific cases the design was argued from
 *     (the 2026-08-13 Leavitt day; figure-contradicting merges as the
 *     chaining canary).
 */

interface Row {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  language: string | null;
  published: Date;
}

const args = new Set(process.argv.slice(2));
const daysArg = [...args].find((arg) => arg.startsWith("--days="));
const days = daysArg ? Number(daysArg.slice("--days=".length)) : 31;
if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

const GRID: { anchorMaxShare: number; massThreshold: number }[] = [];
for (const anchorMaxShare of [0.03, 0.05, 0.08]) {
  for (const massThreshold of [6, 8, 10, 12]) GRID.push({ anchorMaxShare, massThreshold });
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

/** Union-find over string keys; path-halving, no ranks — corpora are small. */
class Unions {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x && this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    if (!this.parent.has(x)) this.parent.set(x, x);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function figuresContradict(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const figure of a) if (b.has(figure)) return false;
  return true;
}

try {
  const from = new Date(Date.now() - days * 86_400_000);
  const rows: Row[] = await db
    .selectFrom("articles")
    .select(["id", "group_id", "title", "description", "language", "published"])
    .where("published", ">=", from)
    .orderBy("published", "asc")
    .orderBy("id", "asc")
    .execute();

  // ---- bucket by (APP_TIMEZONE day, language) — grouping's own bounds ----
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${zonedDayKey(row.published, config.APP_TIMEZONE)}|${row.language ?? "∅"}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  let groupsBefore = 0;
  let groupsAfterRepair = 0;
  let repairMerges = 0;
  let repairMultiMulti = 0;
  let repairContradictions = 0;
  const repairSamples: string[] = [];

  // Per bucket: repaired group of every article, for the storyline pass.
  const repairedByBucket = new Map<string, Map<string, string>>(); // articleId → repaired group root

  for (const [key, bucket] of buckets) {
    const tokens = bucket.map((row) => headlineTokens(row.title));
    const index = new Map<string, number[]>();
    tokens.forEach((set, i) => {
      for (const token of set) {
        const list = index.get(token);
        if (list) list.push(i);
        else index.set(token, [i]);
      }
    });

    const unions = new Unions();
    const groupIds = new Set<string>();
    const memberCount = new Map<string, number>();
    for (const row of bucket) {
      groupIds.add(row.group_id);
      memberCount.set(row.group_id, (memberCount.get(row.group_id) ?? 0) + 1);
      unions.find(row.group_id);
    }
    groupsBefore += groupIds.size;

    for (let i = 0; i < bucket.length; i += 1) {
      const row = bucket[i]!;
      const seen = new Set<number>();
      const candidates: GroupCandidate[] = [];
      for (const token of tokens[i]!) {
        for (const j of index.get(token) ?? []) {
          if (j === i || seen.has(j)) continue;
          seen.add(j);
          const other = bucket[j]!;
          candidates.push({
            id: other.id,
            groupId: other.group_id,
            titleTokens: tokens[j]!,
            title: other.title,
            published: other.published,
          });
        }
      }
      const matches = rankedMatches(
        { tokens: tokens[i]!, figures: headlineFigures(row.title) },
        candidates,
        { threshold: config.GROUPING_SIMILARITY_THRESHOLD },
      );
      for (const match of matches) {
        if (match.groupId === row.group_id) continue;
        const bothMulti =
          (memberCount.get(match.groupId) ?? 0) > 1 && (memberCount.get(row.group_id) ?? 0) > 1;
        if (unions.find(match.groupId) !== unions.find(row.group_id)) {
          if (bothMulti) repairMultiMulti += 1;
          if (repairSamples.length < 40) {
            repairSamples.push(
              `  [${key}] "${row.title.slice(0, 70)}" ⇄ "${match.title.slice(0, 70)}"`,
            );
          }
        }
        unions.union(row.group_id, match.groupId);
      }
    }

    const roots = new Set<string>();
    const byRoot = new Map<string, Row[]>();
    const repaired = new Map<string, string>();
    for (const row of bucket) {
      const root = unions.find(row.group_id);
      roots.add(root);
      repaired.set(row.id, root);
      const list = byRoot.get(root);
      if (list) list.push(row);
      else byRoot.set(root, [row]);
    }
    repairedByBucket.set(key, repaired);
    groupsAfterRepair += roots.size;
    repairMerges += groupIds.size - roots.size;

    // Canary: a repaired component holding two articles whose headline figures
    // contradict is the marketbeat failure shape resurfacing transitively.
    for (const members of byRoot.values()) {
      if (members.length < 2) continue;
      const figures = members.map((m) => headlineFigures(m.title));
      let contradicted = false;
      for (let i = 0; i < figures.length && !contradicted; i += 1) {
        for (let j = i + 1; j < figures.length; j += 1) {
          if (figuresContradict(figures[i]!, figures[j]!)) {
            contradicted = true;
            break;
          }
        }
      }
      if (contradicted) repairContradictions += 1;
    }
  }

  console.log(`articles: ${rows.length} over ${buckets.size} day-language buckets`);
  console.log(
    `merge-repair: ${groupsBefore} groups → ${groupsAfterRepair} (${repairMerges} merged; ` +
      `${repairMultiMulti} multi↔multi bridge edges; ${repairContradictions} components with contradicting figures)`,
  );
  console.log("sample bridge edges:");
  for (const line of repairSamples.slice(0, 20)) console.log(line);

  // ---- storyline sweep over repaired groups: hub-and-spoke, never unions ----
  console.log("\nstoryline sweep (hub-and-spoke over repaired groups):");
  console.log("anchorShare  massThreshold  slots→storylines  largest  p99size");

  const bucketGroups = new Map<
    string,
    { groups: StorylineGroup[]; df: Map<string, number>; size: number; titlesByGroup: Map<string, string[]> }
  >();
  for (const [key, bucket] of buckets) {
    const repaired = repairedByBucket.get(key)!;
    const byRoot = new Map<string, { tokens: string[][]; titles: string[]; publishedMs: number }>();
    for (const row of bucket) {
      const root = repaired.get(row.id)!;
      const entry = byRoot.get(root) ?? {
        tokens: [],
        titles: [],
        publishedMs: Number.POSITIVE_INFINITY,
      };
      entry.tokens.push(storyTokens(row.title, row.description));
      entry.titles.push(row.title);
      entry.publishedMs = Math.min(entry.publishedMs, row.published.getTime());
      byRoot.set(root, entry);
    }
    const groups: StorylineGroup[] = [...byRoot.entries()].map(([id, entry]) => ({
      id,
      memberTokens: entry.tokens,
      publishedMs: entry.publishedMs,
    }));
    const df = storyDayDf(
      [...byRoot.values()].flatMap((entry) => entry.tokens),
    );
    bucketGroups.set(key, {
      groups,
      df,
      size: bucket.length,
      titlesByGroup: new Map([...byRoot.entries()].map(([id, e]) => [id, e.titles])),
    });
  }

  for (const rules of GRID) {
    let slots = 0;
    let storylines = 0;
    const sizes: number[] = [];
    let largest = 0;
    let largestKey = "";
    for (const [key, { groups, df, size }] of bucketGroups) {
      const assignment = clusterStorylines(groups, df, size, rules);
      slots += groups.length;
      const perHub = new Map<string, number>();
      for (const hub of assignment.values()) perHub.set(hub, (perHub.get(hub) ?? 0) + 1);
      storylines += perHub.size;
      for (const clusterSize of perHub.values()) {
        sizes.push(clusterSize);
        if (clusterSize > largest) {
          largest = clusterSize;
          largestKey = key;
        }
      }
    }
    sizes.sort((a, b) => a - b);
    const p99 = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.99))] ?? 0;
    console.log(
      `${String(rules.anchorMaxShare).padEnd(11)}  ${String(rules.massThreshold).padEnd(13)}  ` +
        `${slots}→${storylines}  ${largest} (${largestKey})  ${p99}`,
    );
  }

  // ---- the argued cases, in detail ----
  const leavittKey = [...buckets.keys()].find(
    (key) => key.startsWith("2026-08-13") && key.endsWith("|en"),
  );
  if (leavittKey) {
    const { groups, df, size, titlesByGroup } = bucketGroups.get(leavittKey)!;
    const mentions = (root: string) =>
      (titlesByGroup.get(root) ?? []).some((title) => /leavitt/i.test(title));
    console.log(`\nLeavitt day (${leavittKey}): ${size} articles, ${groups.length} repaired groups`);
    console.log(`  (day-df of "leavitt": ${df.get("leavitt") ?? 0})`);

    for (const rules of GRID) {
      const assignment = clusterStorylines(groups, df, size, rules);
      const leavittHubs = new Set<string>();
      for (const group of groups) {
        if (mentions(group.id)) leavittHubs.add(assignment.get(group.id)!);
      }
      const hubCount = new Set(assignment.values()).size;
      const biggestLeavitt = [...leavittHubs]
        .map((hub) => [...assignment.values()].filter((h) => h === hub).length)
        .sort((a, b) => b - a)[0];
      console.log(
        `  A≤${rules.anchorMaxShare} M≥${rules.massThreshold}: leavitt-titled groups in ` +
          `${leavittHubs.size} storyline(s); biggest carries ${biggestLeavitt} groups; day has ${hubCount} storylines`,
      );
    }

    // The chosen-candidate view, verbose: what exactly joins the big cluster.
    for (const rules of [
      { anchorMaxShare: 0.05, massThreshold: 8 },
      { anchorMaxShare: 0.05, massThreshold: 10 },
    ]) {
      const assignment = clusterStorylines(groups, df, size, rules);
      const hubTally = new Map<string, string[]>();
      for (const [groupId, hub] of assignment) {
        const list = hubTally.get(hub);
        if (list) list.push(groupId);
        else hubTally.set(hub, [groupId]);
      }
      const leavittHub = [...hubTally.entries()]
        .filter(([, members]) => members.some(mentions))
        .sort((a, b) => b[1].length - a[1].length)[0];
      if (!leavittHub) continue;
      console.log(`\n  A≤${rules.anchorMaxShare} M≥${rules.massThreshold} — leavitt storyline members:`);
      for (const member of leavittHub[1]) {
        console.log(`    ${member === leavittHub[0] ? "HUB " : "     "}${(titlesByGroup.get(member) ?? [])[0]?.slice(0, 90)}`);
      }
    }
  }
} finally {
  await db.destroy();
}
