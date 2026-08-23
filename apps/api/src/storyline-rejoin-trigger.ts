import type { Kysely } from "kysely";
import { readLinkableGroups, type Database } from "@zammy/storage";
import { linkGroup, type LinkOutcome, type LinkerConfig } from "./storyline-linker.js";

/**
 * Re-offer a group to the linker because the group's OWN membership changed.
 *
 * The gap this closes is one `groupCreatedArticles` opens by design. The linker
 * is offered SEEDED groups only, on the grounds that an article joining an
 * existing group inherited that group's storylines — which is true about
 * membership and false about QUALIFICATION. A group speaks through its majority
 * vocabulary (`groupProfile`), `readLinkableGroups` re-aggregates every member's
 * `story_tokens` on each read, and the majority of two members is not the
 * majority of one: the enlarged group can carry tokens it did not carry when the
 * linker last judged it, and nothing was ever going to ask again. The nightly
 * sweep re-offers it eventually, so this is the same decision earlier — except
 * for one class, which the sweep covers WORSE rather than merely later: a group
 * whose candidate set never changed and whose own profile did is invisible to
 * any storyline-change filter, and the only signal that it moved is the
 * grouping write itself.
 *
 * Nothing here is a second decision. `linkGroup` is the whole of it — same
 * profile, same corpus, same thresholds, same `ownGroups > 1` guard, and
 * therefore the same ONE lifetime retroactive arc per group that stops a
 * repeated offer walking a four-qualifier group into all four arcs. This trigger
 * changes when the question is asked, never whether.
 *
 * Publication order, because `linkSeededGroups` is ordered for the same reason
 * (§7.4): within one batch a replay must reach the same assignment.
 *
 * Never throws, and never for one group's sake either. It runs on the tail
 * `groupCreatedArticles` starts and drops (`void tail`), alongside labels that
 * cost ~8s each — the contract `storyline-label-service.ts` states, for the
 * reason it states it: a dropped promise that rejects is an unhandled rejection
 * on a path no reader is waiting on.
 */
export async function reofferJoinedGroups(
  deps: {
    db: Kysely<Database>;
    config: LinkerConfig;
    log?: { warn: (obj: object, msg: string) => void };
  },
  /** Groups an arriving article JOINED — `groupArticle`'s non-null return. */
  groupIds: readonly string[],
): Promise<LinkOutcome[]> {
  if (!deps.config.enabled || groupIds.length === 0) return [];

  // One offer per group however many of a batch's articles landed in it. The
  // decision reads the group's membership as it now stands, so asking twice
  // would spend a corpus read and a candidate scan to reach the same verdict.
  const ids = [...new Set(groupIds)];

  const outcomes: LinkOutcome[] = [];
  try {
    // `onlyGroupIds` rather than the keyset: these groups are scattered through
    // the archive by publication date — an article can join a group a fortnight
    // old — so there is no cursor that reaches them, which is the case that
    // argument exists for. The read also re-aggregates the enlarged membership,
    // which is the whole point of asking again.
    const groups = await readLinkableGroups(deps.db, {
      onlyGroupIds: ids,
      limit: ids.length,
    });
    for (const group of groups) {
      try {
        outcomes.push(
          await linkGroup(deps, {
            groupId: group.groupId,
            memberTokens: group.memberTokens,
            language: group.language,
            published: group.published,
          }),
        );
      } catch (error) {
        deps.log?.warn(
          { err: error, groupId: group.groupId },
          "re-offer after membership change failed for one group; the nightly sweep is its retry",
        );
      }
    }
  } catch (error) {
    // The read itself. One log line rather than a throw: the groups are grouped,
    // the articles are paged, and the sweep offers them again tonight.
    deps.log?.warn(
      { err: error, groups: ids.length },
      "re-offer after membership change could not read its groups; the nightly sweep is its retry",
    );
  }
  return outcomes;
}
