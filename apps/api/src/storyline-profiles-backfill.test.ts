import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachGroup, createProvisionalStoryline } from "@zammy/storage";
import { backfillStorylineProfiles } from "./storyline-profiles-backfill.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The ADR-0026 profile backfill.
 *
 * Tested rather than trusted because it is a DEPLOYMENT STEP: the rule change
 * moves no membership, so until this runs the archive keeps profiles derived the
 * old way, and `profile_tokens` is what candidate retrieval overlaps against.
 * A backfill that silently skips a page is a rule that silently did not ship.
 *
 * What has to be true is narrower than "it writes": the pass must reach every
 * live row across page boundaries, report what it changed, and be safe to run
 * twice — an operator who interrupts it resumes with `after` and must not have
 * to reason about what the interrupted page did.
 */

const NOW = new Date("2026-08-14T03:00:00.000Z");
const TZ = { timeZone: "UTC" };
const PUBLISHED = "2026-08-13T09:00:00.000Z";

let harness: TestHarness;
let db: TestHarness["deps"]["db"];

beforeAll(async () => {
  harness = await createTestHarness({}, NOW);
  db = harness.deps.db;
});

afterAll(async () => {
  await harness.teardown();
});

beforeEach(async () => {
  await sql`truncate storylines, storyline_groups, storyline_days, articles cascade`.execute(db);
});

let nextArticle = 0;

/** One group, as an article in storage. */
async function group(tokens: string[]): Promise<string> {
  nextArticle += 1;
  const { rows } = await sql<{ id: string }>`
    insert into articles (
      dedup_key, url, title, description, language, categories, source_category,
      published, latest_seen, sighting_count, story_tokens
    ) values (
      decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
      ${`https://example.test/${nextArticle}`}, ${tokens.join(" ")}, null,
      'en', '{}', '{}', ${PUBLISHED}, ${PUBLISHED}, 1, ${tokens}
    ) returning id
  `.execute(db);
  return rows[0]!.id;
}

/** A two-group arc, with its profile forced back to the pre-ADR-0026 union. */
async function unionShapedArc(first: string[], second: string[]): Promise<string> {
  const seed = await group(first);
  const arc = await createProvisionalStoryline(db, { groupId: seed, ...TZ });
  await attachGroup(db, { storylineId: arc.id, groupId: await group(second), ...TZ });
  // The state the archive is actually in: rows written by the OLD rule, which
  // no longer exists to write them. Forced, because the point of the pass is
  // that nothing re-derives these on its own.
  await db
    .updateTable("storylines")
    .set({ profile_tokens: [...new Set([...first, ...second])].sort() })
    .where("id", "=", arc.id)
    .execute();
  return arc.id;
}

const profileOf = async (storylineId: string): Promise<string[]> =>
  (
    await db
      .selectFrom("storylines")
      .select("profile_tokens")
      .where("id", "=", storylineId)
      .executeTakeFirstOrThrow()
  ).profile_tokens;

const run = (options: { batch: number; after?: string | null }) =>
  backfillStorylineProfiles({ db }, options);

describe("the ADR-0026 profile backfill", () => {
  it("re-derives a union-shaped two-group arc down to its consensus", async () => {
    const arc = await unionShapedArc(["fausto", "hawaii"], ["fausto", "swell"]);
    expect(await profileOf(arc)).toEqual(["fausto", "hawaii", "swell"]);

    const result = await run({ batch: 100 });

    expect(await profileOf(arc)).toEqual(["fausto"]);
    expect(result).toEqual({ scanned: 1, narrowed: 1, widened: 0, unchanged: 0 });
  });

  it("reaches every row across page boundaries", async () => {
    // The defect a one-page fixture cannot see. Five arcs at a batch of two is
    // three pages with a short last one, and the keyset has to carry across all
    // of them — a backfill that stops at the first page still reports success.
    const arcs = [];
    for (let i = 0; i < 5; i += 1) {
      arcs.push(await unionShapedArc(["fausto", `only${i}`], ["fausto", `other${i}`]));
    }

    const result = await run({ batch: 2 });

    expect(result.scanned).toBe(5);
    expect(result.narrowed).toBe(5);
    for (const arc of arcs) expect(await profileOf(arc)).toEqual(["fausto"]);
  });

  it("never widens, which is the guard rather than a statistic", async () => {
    // ADR-0026's support requirement is pointwise at or above the old one, so
    // the new profile is a subset of the old and no row can gain a token. A
    // three-group arc is where the floor is inert and the majority already
    // demanded two: it must come out untouched.
    const seed = await group(["mars", "lander"]);
    const arc = await createProvisionalStoryline(db, { groupId: seed, ...TZ });
    await attachGroup(db, { storylineId: arc.id, groupId: await group(["mars", "lander"]), ...TZ });
    await attachGroup(db, { storylineId: arc.id, groupId: await group(["mars", "photos"]), ...TZ });
    const before = await profileOf(arc.id);

    const result = await run({ batch: 100 });

    expect(await profileOf(arc.id)).toEqual(before);
    expect(result.widened).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it("is idempotent, so an interrupted run is safe to repeat", async () => {
    await unionShapedArc(["fausto", "hawaii"], ["fausto", "swell"]);
    await run({ batch: 100 });

    const second = await run({ batch: 100 });

    expect(second).toEqual({ scanned: 1, narrowed: 0, widened: 0, unchanged: 1 });
  });

  it("resumes an id-ordered scan after the row an interrupted run last logged", async () => {
    await unionShapedArc(["fausto", "hawaii"], ["fausto", "swell"]);
    await unionShapedArc(["genevieve", "surf"], ["genevieve", "swell"]);
    const ids = (
      await db.selectFrom("storylines").select("id").orderBy("id").execute()
    ).map((row) => row.id);

    const resumed = await run({ batch: 100, after: ids[0] });

    // Exclusive: the row named by `after` is the one already done.
    expect(resumed.scanned).toBe(ids.length - 1);
  });
});
