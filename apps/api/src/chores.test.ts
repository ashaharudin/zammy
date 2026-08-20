import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  createProvisionalStoryline,
  mergeStorylines,
  promoteStoryline,
  readGroupStorylines,
  readStoryline,
  setStorylineLabel,
} from "@zammy/storage";
import {
  runDormancyChore,
  runLateCandidateChore,
  runStorylineLabelChore,
  type ChoreDeps,
} from "./chores.js";
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
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             story_token_days, story_corpus_days, articles cascade
  `.execute(db);
});

const deps = (): ChoreDeps => ({
  db,
  config: {
    retentionDays: 400,
    storyDfWindowDays: 14,
    storylineDormancyDays: 90,
    timeZone: "UTC",
  },
  now: () => NOW,
  log: { info: () => {}, warn: () => {} },
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
      // An earlier model wrote it — provenance, which `readLabelCandidates`
      // deliberately does not filter on (the labeler decides). Omitted until
      // the tests were type-checked (§12).
      labelSource: "gemini-2.9-flash",
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
      // An earlier model wrote it — provenance, which `readLabelCandidates`
      // deliberately does not filter on (the labeler decides). Omitted until
      // the tests were type-checked (§12).
      labelSource: "gemini-2.9-flash",
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

  it("reaches a dormant storyline — going quiet must not strand it unlabelled", async () => {
    // The nightly job runs dormancy FIRST, so an old promoted-but-unlabelled
    // storyline is stamped dormant minutes before this pass looks. An
    // active-only candidate set would skip it forever — and an unlabelled
    // storyline can never surface, dormant marker or not.
    const march = await storyline([MARCH, "2026-03-03T09:00:00.000Z"]);
    await runDormancyChore(deps());

    const report = await runStorylineLabelChore({
      ...deps(),
      labeler: labeler(saying("Hurricane Fausto")),
    });

    expect(report.model).toBe(1);
    expect(await readStoryline(db, march)).toMatchObject({
      status: "dormant",
      label: "Hurricane Fausto",
    });
  });
});

describe("the nightly late-candidate sweep", () => {
  /**
   * The thresholds are loosened for a corpus of five articles, as the linker's
   * own tests loosen theirs: what is under test is which groups the sweep OFFERS
   * and what one offer does, not the production bar.
   */
  const LINKER = {
    enabled: true,
    rules: {
      anchorMaxShare: 0.5,
      anchorDfFloor: 4,
      massThreshold: 1,
      dormancyDays: 90,
      dormantStrictness: 1.5,
    },
    mergeBridges: 2,
    // Off, which is the pre-gate path these tests have been taking all along:
    // the field was absent until the tests were type-checked (§12) and read
    // as falsy. The one test that is ABOUT the gate spreads this and sets true.
    coherenceGate: false,
    storyDf: { windowDays: 14, timeZone: "UTC" },
    timeZone: "UTC",
  };

  /** A corpus for the day the coverage is on, so rarity means something. */
  async function seedCorpus(day: string): Promise<void> {
    await db
      .insertInto("story_corpus_days")
      .values({ day, language: "en", articles: 100 })
      .execute();
    await db
      .insertInto("story_token_days")
      .values(
        ["fausto", "hawaii"].map((token) => ({ day, language: "en", token, df: 4 })),
      )
      .execute();
  }

  it("pulls a group into a storyline that formed after it", async () => {
    // The behaviour ADR-0011 promises and nothing delivered: `attachGroup` had
    // no production caller, and the chronological backfill decides Monday's
    // group before Wednesday's storyline exists.
    await seedCorpus("2026-08-13");
    const early = await storyline([YESTERDAY, YESTERDAY]);
    const later = await storyline([YESTERDAY, YESTERDAY]);
    const earlyGroups = await db
      .selectFrom("storyline_groups")
      .select("group_id")
      .where("storyline_id", "=", early)
      .execute();

    const report = await runLateCandidateChore({ ...deps(), linker: LINKER });

    expect(report.offered).toBe(4);
    expect(report.attachedTo).toBeGreaterThan(0);
    // The group kept its home and gained the other arc.
    const homes = await readGroupStorylines(db, earlyGroups[0]!.group_id);
    expect(homes).toContain(early);
    expect(homes).toContain(later);
  });

  it("offers only the trailing window, so a night's work is bounded", async () => {
    await seedCorpus("2026-08-13");
    await seedCorpus("2026-03-02");
    await storyline([YESTERDAY, YESTERDAY]);
    const march = await group(MARCH);
    const marchStoryline = await createProvisionalStoryline(db, { groupId: march, ...TZ });

    const report = await runLateCandidateChore({ ...deps(), linker: LINKER });

    // A full-archive replay every night is the thing this is not: the df window
    // is the same fortnight the linker measures rarity against, so a candidate
    // older than the corpus that would judge it is not a candidate.
    expect(report.offered).toBe(2);
    expect(await readGroupStorylines(db, march)).toEqual([marchStoryline.id]);
  });

  it("resolves a formation it re-offered and the gate withheld", async () => {
    // A withheld formation is the one outcome that changes nothing tonight —
    // no attach, no merge; the merge IS the thing withheld — so a filter on
    // "did it change something" silently drops it from the labelling pass.
    // That pass holds the only production caller of `resolvePendingFormations`
    // this sweep has, and this sweep is the promised retry for a formation the
    // ingest tail lost: dropped here, the pair is re-withheld and re-dropped
    // every night, forever.
    await seedCorpus("2026-08-13");
    const a = await group(YESTERDAY);
    const b = await group(YESTERDAY);
    const bornA = await createProvisionalStoryline(db, { groupId: a, ...TZ });
    const bornB = await createProvisionalStoryline(db, { groupId: b, ...TZ });
    const generate = async () => ({ ok: true as const, text: "Hurricane Fausto" });

    const report = await runLateCandidateChore({
      ...deps(),
      linker: { ...LINKER, coherenceGate: true },
      labeler: { generator: { generate }, sampleSize: 10, driftFactor: 2, now: () => NOW },
    });

    // Both singletons were offered, both offers withheld the same formation,
    // and the labelling pass then performed it: one real storyline holding
    // both groups, wearing the verdict's name.
    expect(report.offered).toBe(2);
    const homesA = await readGroupStorylines(db, a);
    expect(homesA).toHaveLength(1);
    expect(await readGroupStorylines(db, b)).toEqual(homesA);
    expect([bornA.id, bornB.id]).toContain(homesA[0]);
    expect(await readStoryline(db, homesA[0]!)).toMatchObject({
      status: "active",
      label: "Hurricane Fausto",
    });
  });

  it("labels what it changed, the way the ingest path labels what IT changed", async () => {
    // A sweep attach or merge is the same event as a live one; without this,
    // the identical change keeps a stale label at 4am and gets a fresh one at
    // noon, for no reason a reader could see.
    await seedCorpus("2026-08-13");
    const early = await storyline([YESTERDAY, YESTERDAY]);
    const later = await storyline([YESTERDAY, YESTERDAY]);
    const generate = async () => ({ ok: true as const, text: "Hurricane Fausto" });

    const report = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      labeler: { generator: { generate }, sampleSize: 10, driftFactor: 2, now: () => NOW },
    });

    expect(report.attachedTo).toBeGreaterThan(0);
    // The arc the sweep grew was labelled in the same night's pass.
    const labels = await Promise.all([readStoryline(db, early), readStoryline(db, later)]);
    expect(labels.some((row) => row?.label === "Hurricane Fausto")).toBe(true);
  });
});
