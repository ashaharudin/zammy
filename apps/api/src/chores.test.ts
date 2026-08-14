import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  createProvisionalStoryline,
  mergeStorylines,
  promoteStoryline,
  readStoryline,
  setStorylineLabel,
} from "@zammy/storage";
import { runDormancyChore, runStorylineLabelChore, type ChoreDeps } from "./chores.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The nightly chores that keep `storylines.status` honest (ADR-0011, WP2).
 *
 * Dormancy is computed dynamically by the linker, from a storyline's last
 * coverage — that is what gates the linking bar and it is not what these tests
 * are about. The COLUMN is the read side's representation of the same fact, and
 * until this sweep existed it said `active` for every storyline the database had
 * ever held, five-month-old ones included.
 */

const NOW = new Date("2026-08-14T03:00:00.000Z");
const TZ = { timeZone: "UTC" };

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
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges, articles cascade
  `.execute(db);
});

const deps = (): ChoreDeps => ({
  db,
  config: {
    retentionDays: 400,
    baselineWindowDays: 30,
    storyDfWindowDays: 14,
    storylineDormancyDays: 90,
    timeZone: "UTC",
  },
  now: () => NOW,
  log: { info: () => {} },
});

let nextArticle = 0;

/** One group, as an article in storage: day slots are derived from members. */
async function group(publishedAt: string): Promise<string> {
  nextArticle += 1;
  const { rows } = await sql<{ id: string }>`
    insert into articles (
      dedup_key, url, title, description, language, categories, source_category,
      published, latest_seen, sighting_count, story_tokens
    ) values (
      decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
      ${`https://example.test/${nextArticle}`}, 'Hurricane Fausto nears Hawaii', null,
      'en', '{}', '{}', ${publishedAt}, ${publishedAt}, 1, '{fausto,hawaii}'
    ) returning id
  `.execute(db);
  return rows[0]!.id;
}

/** A promoted storyline whose coverage is the days given. */
async function storyline(days: string[]): Promise<string> {
  const groups = await Promise.all(days.map((day) => group(day)));
  const born = await createProvisionalStoryline(db, { groupId: groups[0]!, ...TZ });
  for (const groupId of groups.slice(1)) {
    await attachGroup(db, { storylineId: born.id, groupId, ...TZ });
  }
  await promoteStoryline(db, { storylineId: born.id });
  return born.id;
}

const MARCH = "2026-03-02T09:00:00.000Z";
const YESTERDAY = "2026-08-13T09:00:00.000Z";

describe("the nightly dormancy sweep", () => {
  it("marks a storyline whose last coverage is past the window dormant", async () => {
    const march = await storyline([MARCH, "2026-03-03T09:00:00.000Z"]);

    const report = await runDormancyChore(deps());

    expect(report.dormant).toBe(1);
    expect((await readStoryline(db, march))?.status).toBe("dormant");
  });

  it("leaves a storyline covered inside the window active", async () => {
    const live = await storyline([MARCH, YESTERDAY]);

    const report = await runDormancyChore(deps());

    // Measured from the LATEST coverage, not the first: an arc that began in
    // March and ran until yesterday is long, not quiet.
    expect(report.dormant).toBe(0);
    expect((await readStoryline(db, live))?.status).toBe("active");
  });

  it("leaves provisionals and aliases alone — neither has a lifecycle to mark", async () => {
    const provisional = await createProvisionalStoryline(db, {
      groupId: await group(MARCH),
      ...TZ,
    });
    const winner = await storyline([MARCH]);
    const loser = await createProvisionalStoryline(db, { groupId: await group(MARCH), ...TZ });
    await promoteStoryline(db, { storylineId: loser.id });
    await mergeStorylines(db, { winnerId: winner, loserId: loser.id, ...TZ });

    const report = await runDormancyChore(deps());

    // A provisional storyline-of-one is a timeline slot, not a story that can
    // fall quiet; a merged UUID is a pointer, and a status on it describes
    // nothing. Only the survivor is marked.
    expect(report.dormant).toBe(1);
    expect((await readStoryline(db, provisional.id))?.status).toBe("provisional");
    expect((await readStoryline(db, loser.id))?.status).toBe("active");
    expect((await readStoryline(db, winner))?.status).toBe("dormant");
  });
});

describe("the nightly label pass", () => {
  /** A generator that answers whatever the test says, and counts the asks. */
  function saying(text: string) {
    const asks: number[] = [];
    return {
      calls: () => asks.length,
      generate: async () => {
        asks.push(1);
        return { ok: true as const, text };
      },
    };
  }

  const labeler = (generator: { generate: () => Promise<{ ok: true; text: string }> }) => ({
    generator,
    sampleSize: 10,
    driftFactor: 2,
    now: () => NOW,
  });

  it("refreshes a label whose storyline has doubled since it was written", async () => {
    // The drift trigger (ADR-0011), which is a question asked of the row rather
    // than an event — so it belongs to a pass, and until now the only pass was
    // an operator typing `pnpm label:storylines`.
    const id = await storyline([YESTERDAY, YESTERDAY]);
    await setStorylineLabel(db, {
      storylineId: id,
      label: "Fausto Hawaii",
      labelAt: new Date("2026-08-01T00:00:00.000Z"),
      labelGroupCount: 2,
    });
    for (const day of [YESTERDAY, YESTERDAY]) {
      await attachGroup(db, { storylineId: id, groupId: await group(day), ...TZ });
    }

    const generator = saying("Hurricane Fausto");
    const report = await runStorylineLabelChore({ ...deps(), labeler: labeler(generator) });

    expect(report.model).toBe(1);
    expect((await readStoryline(db, id))?.label).toBe("Hurricane Fausto");
  });

  it("spends nothing on storylines whose labels still describe them", async () => {
    const id = await storyline([YESTERDAY, YESTERDAY]);
    await setStorylineLabel(db, {
      storylineId: id,
      label: "Fausto Hawaii",
      labelAt: new Date("2026-08-01T00:00:00.000Z"),
      labelGroupCount: 2,
    });

    const generator = saying("Hurricane Fausto");
    const report = await runStorylineLabelChore({ ...deps(), labeler: labeler(generator) });

    // A nightly pass that re-asked for every promoted storyline would turn a
    // storyline-volume cost into a nightly one.
    expect(generator.calls()).toBe(0);
    expect(report.skipped).toBe(1);
    expect((await readStoryline(db, id))?.label).toBe("Fausto Hawaii");
  });

  it("names what the live tail never reached — a crash, a deploy, a 503", async () => {
    const id = await storyline([YESTERDAY, YESTERDAY]);

    const report = await runStorylineLabelChore({
      ...deps(),
      labeler: labeler(saying("Hurricane Fausto")),
    });

    // It doubles as the repair pass: promoted, label-less, and nothing on the
    // live path is ever going to offer it again.
    expect(report.model).toBe(1);
    expect((await readStoryline(db, id))?.label).toBe("Hurricane Fausto");
  });
});
