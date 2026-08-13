import type { Kysely } from "kysely";
import {
  readStorylineDay,
  setStoryline,
  type Database,
  type StorylineDayRow,
} from "@zammy/storage";
import {
  clusterStorylines,
  groupProfile,
  storyDayDf,
  storylineEvidence,
  anchorCeiling,
  type StorylineGroup,
  type StorylineRules,
} from "./storyline.js";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";

/**
 * Storylines, wired up (ADR-0009): the write-time layer that clusters a day's
 * groups around hubs, so the timeline's slot is a day's coverage of a story.
 *
 * Two entry points with ONE decision between them:
 *
 *  - `attachGroupStoryline` — the live path, once per newly-seeded group. It
 *    evaluates the group against the day's existing HUBS only and either
 *    attaches or leaves the group leading its own storyline. It never
 *    re-evaluates later: a group that grows, merges, or would now anchor
 *    differently keeps its verdict until the rebuild pass — the same
 *    one-evaluation discipline grouping itself lives by (§14.3), accepted for
 *    the same reason (a re-evaluated slot moves under live cursors).
 *  - `rebuildDayStorylines` — the canonical clustering, biggest-group-first
 *    over the finished day (`clusterStorylines`). The regroup command runs it;
 *    live attachment order-dependence heals here.
 */

export interface StorylineDeps {
  db: Kysely<Database>;
  config: {
    enabled: boolean;
    rules: StorylineRules;
    /** The calendar day the corpus is drawn from — §10.1's rule, not UTC. */
    timeZone: string;
  };
  log?: { warn: (obj: object, msg: string) => void };
}

/**
 * Decide where a batch of freshly-seeded groups belongs, against their days'
 * hubs. ONE day-corpus read per (day, language) the batch touches — an
 * upstream call creates ~8 articles, and a read per article was measured
 * blowing the §6.3 sync-fill deadline before the second upstream call.
 *
 * Reads the WHOLE day-language corpus, not just candidates: the anchor rule
 * is day-relative rarity (ADR-0009), and a narrowed read would compute a
 * different rarity than the rule means. Attaches within the batch see each
 * other through locally-updated state, so the second seeded group of a batch
 * cannot pick a hub that the first just demoted to spoke. Never throws — a
 * storyline failure must not fail the read that triggered the ingest, exactly
 * as grouping argues; the worst case is a slot standing alone until the
 * rebuild.
 */
export async function attachSeededGroups(
  deps: StorylineDeps,
  seeded: readonly { groupId: string; published: Date; language: string | null }[],
): Promise<void> {
  if (!deps.config.enabled || seeded.length === 0) return;

  const buckets = new Map<string, typeof seeded[number][]>();
  for (const group of seeded) {
    const key = `${zonedDayKey(group.published, deps.config.timeZone)}|${group.language ?? "∅"}`;
    const list = buckets.get(key);
    if (list) list.push(group);
    else buckets.set(key, [group]);
  }

  for (const groups of buckets.values()) {
    try {
      await attachBucket(deps, groups);
    } catch (error) {
      deps.log?.warn(
        { err: error, groupIds: groups.map((group) => group.groupId) },
        "storyline attach failed for one day bucket; its groups lead their own storylines",
      );
    }
  }
}

async function attachBucket(
  deps: StorylineDeps,
  seeded: readonly { groupId: string; published: Date; language: string | null }[],
): Promise<void> {
  const first = seeded[0]!;
  const day = zonedDayBounds(
    zonedDayKey(first.published, deps.config.timeZone),
    deps.config.timeZone,
  );
  const rows = await readStorylineDay(deps.db, {
    from: day.from,
    to: day.to,
    language: first.language,
  });
  if (rows.length === 0) return;

  const df = storyDayDf(rows.map((row) => row.storyTokens));
  const ceiling = anchorCeiling(rows.length, deps.config.rules);

  for (const group of seeded) {
    const mine = rows.filter((row) => row.groupId === group.groupId);
    if (mine.length === 0) continue;
    // Already attached, or already leading spokes: one evaluation only. The
    // one-hop rule is load-bearing — re-attaching a hub would drag its spokes
    // to a story they were never compared against.
    const isOwnStoryline = mine.every((row) => row.storylineId === group.groupId);
    const hasSpokes = rows.some(
      (row) => row.storylineId === group.groupId && row.groupId !== group.groupId,
    );
    if (!isOwnStoryline || hasSpokes) continue;

    const profile = groupProfile(mine.map((row) => row.storyTokens));

    // Hubs only — groups leading the storyline they are in — with each hub's
    // profile drawn from its OWN members, never its spokes (one hop).
    const hubMembers = new Map<string, StorylineDayRow[]>();
    for (const row of rows) {
      if (row.storylineId !== row.groupId || row.groupId === group.groupId) continue;
      const list = hubMembers.get(row.groupId);
      if (list) list.push(row);
      else hubMembers.set(row.groupId, [row]);
    }

    let best: { hubId: string; mass: number } | null = null;
    for (const [hubId, members] of hubMembers) {
      const evidence = storylineEvidence(
        profile,
        groupProfile(members.map((row) => row.storyTokens)),
        df,
        rows.length,
      );
      if (evidence.anchorDf > ceiling || evidence.mass < deps.config.rules.massThreshold) {
        continue;
      }
      if (!best || evidence.mass > best.mass) best = { hubId, mass: evidence.mass };
    }
    if (!best) continue;

    await setStoryline(deps.db, { groupId: group.groupId, storylineId: best.hubId });
    // The local mirror of what setStoryline just wrote, so the batch's next
    // group evaluates against the day as it now is.
    for (const row of mine) row.storylineId = best.hubId;
  }
}

/**
 * Re-cluster one day-language corpus from scratch: the canonical,
 * biggest-first assignment. Returns how many groups changed storyline.
 *
 * Every group receives an explicit assignment, so applying them in any order
 * converges — a former hub demoted to spoke has its own spokes reassigned by
 * the same pass.
 */
export async function rebuildDayStorylines(
  deps: StorylineDeps,
  window: { from: Date; to: Date; language: string | null },
): Promise<number> {
  const rows = await readStorylineDay(deps.db, window);
  if (rows.length === 0) return 0;

  const byGroup = new Map<string, StorylineDayRow[]>();
  for (const row of rows) {
    const list = byGroup.get(row.groupId);
    if (list) list.push(row);
    else byGroup.set(row.groupId, [row]);
  }

  const groups: StorylineGroup[] = [...byGroup.entries()].map(([id, members]) => ({
    id,
    memberTokens: members.map((row) => row.storyTokens),
    publishedMs: Math.min(...members.map((row) => row.published.getTime())),
  }));
  const assignment = clusterStorylines(
    groups,
    storyDayDf(rows.map((row) => row.storyTokens)),
    rows.length,
    deps.config.rules,
  );

  let changed = 0;
  for (const [groupId, storylineId] of assignment) {
    const current = byGroup.get(groupId)![0]!.storylineId;
    if (current === storylineId) continue;
    await setStoryline(deps.db, { groupId, storylineId });
    changed += 1;
  }
  return changed;
}
