import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  createProvisionalStoryline,
  promoteStoryline,
  readStoryline,
} from "@zammy/storage";
import type { GenerateRequest, GenerateResult } from "./gemini.js";
import { resolveFormation, type FormationDeps } from "./storyline-formation.js";
import { nameStoryline, type LabelerDeps } from "./storyline-naming.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The ONE writer of a storyline's label columns, pinned from both of the doors
 * that reach it (`storyline-naming.ts`).
 *
 * These tests exist because of a hole the two-writer arrangement left open. A
 * label is five columns that mean nothing apart, and until this module existed
 * `storyline-formation.ts` re-issued its own copy of the same five-field write.
 * If that copy had stopped setting `labelWords`, every storyline the coherence
 * gate forms would have become unreachable by search — label surfacing
 * (ADR-0011, as amended) silently off for exactly those arcs — and the whole
 * suite would still have been green: no test read the column on that path, and
 * a null label writes `[]` there legitimately.
 *
 * So the five columns are asserted as ONE object, and the SAME object is
 * asserted for both triggers. A write that goes quiet in one field fails; a
 * second writer that reappears and disagrees fails; and nothing here can be
 * satisfied by reading the label back through the same code that wrote it,
 * because the assertions read the table.
 */

let harness: TestHarness;
let db: TestHarness["deps"]["db"];
let counter = 0;

const ZONE = "UTC";
const NOW = new Date("2026-08-14T12:00:00.000Z");

/** The one name both paths produce, and the row it must leave behind. */
const NAME = "Maple Ridge Bear Attack";
const NAMED_ROW = {
  label: NAME,
  // Folded once, by the writer, into the corpus's own spelling — the field the
  // formation path could have dropped in silence.
  label_words: ["maple", "ridge", "bear", "attack"],
  label_at: NOW,
  label_source: "gemini-test",
};

/** Every label column, read off the table rather than through a mapper. */
async function labelRow(storylineId: string) {
  return db
    .selectFrom("storylines")
    .select(["label", "label_words", "label_at", "label_group_count", "label_source"])
    .where("id", "=", storylineId)
    .executeTakeFirstOrThrow();
}

/** A generator that answers with whatever the test says, and counts the asking. */
function saying(text: string) {
  const asked = { count: 0 };
  return {
    asked,
    generator: {
      generate: async (_request: GenerateRequest): Promise<GenerateResult> => {
        asked.count += 1;
        return { ok: true, text };
      },
    },
  };
}

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
             storyline_formation_refusals, story_token_days, story_corpus_days,
             articles cascade
  `.execute(db);
});

/** One article in its own group. */
async function seedGroup(title: string): Promise<string> {
  counter += 1;
  const row = await db
    .insertInto("articles")
    .values({
      dedup_key: randomBytes(32),
      url: `https://fixture.example/naming-${counter}`,
      title,
      description: null,
      language: "en",
      categories: [],
      source_category: [],
      source_domain: "fixture.example",
      published: NOW,
      latest_seen: NOW,
      sighting_count: 1,
    })
    .returning("group_id")
    .executeTakeFirstOrThrow();
  return row.group_id;
}

/** A promoted, never-labelled storyline of two groups — a drift candidate. */
async function promotedPair(): Promise<string> {
  const first = await seedGroup("Bear shot after girl attacked in Maple Ridge");
  const storyline = await createProvisionalStoryline(db, { groupId: first, timeZone: ZONE });
  const second = await seedGroup("Conservation officers search for Maple Ridge bear");
  await attachGroup(db, { storylineId: storyline.id, groupId: second, timeZone: ZONE });
  await promoteStoryline(db, { storylineId: storyline.id });
  return storyline.id;
}

/** A withheld formation: the winner's storyline-of-one, and the arriving group. */
async function pendingPair() {
  const winnerGroup = await seedGroup("Bear shot after girl attacked in Maple Ridge");
  const winner = await createProvisionalStoryline(db, {
    groupId: winnerGroup,
    timeZone: ZONE,
  });
  const arrivingGroup = await seedGroup("Conservation officers search for Maple Ridge bear");
  const arriving = await createProvisionalStoryline(db, {
    groupId: arrivingGroup,
    timeZone: ZONE,
  });
  return {
    winnerId: winner.id,
    arrivingId: arriving.id,
    pending: {
      winnerId: winner.id,
      groupId: arrivingGroup,
      partnerGroupId: winnerGroup,
    },
  };
}

const labeler = (overrides: Partial<LabelerDeps> = {}): LabelerDeps => ({
  db,
  generator: null,
  modelId: "gemini-test",
  sampleSize: 10,
  driftFactor: 2,
  now: () => NOW,
  ...overrides,
});

const formation = (overrides: Partial<FormationDeps> = {}): FormationDeps => ({
  ...labeler(),
  timeZone: ZONE,
  ...overrides,
});

describe("the five-field write, from both doors", () => {
  it("writes all five when the labeler names a drifting storyline", async () => {
    const id = await promotedPair();
    const model = saying(NAME);

    const outcome = await nameStoryline(labeler({ generator: model.generator }), {
      storylineId: id,
      trigger: "drift",
    });

    expect(outcome).toMatchObject({ label: NAME, source: "model", groupCount: 2 });
    expect(await labelRow(id)).toEqual({ ...NAMED_ROW, label_group_count: 2 });
  });

  it("writes all five when the coherence gate forms and names one", async () => {
    // The same five values from the other door, and deliberately the SAME
    // expected object: a formation is a promotion, so what it records about the
    // name cannot differ from what a promotion records.
    const { winnerId, pending } = await pendingPair();
    const model = saying(NAME);

    const result = await resolveFormation(
      formation({ generator: model.generator }),
      pending,
    );

    expect(result).toMatchObject({ kind: "formed", labelled: true });
    // One call bought the verdict AND the name (ADR-0011's amendment); handing
    // the name to the writer must not buy a second one.
    expect(model.asked.count).toBe(1);
    expect(await labelRow(winnerId)).toEqual({ ...NAMED_ROW, label_group_count: 2 });
  });

  it("writes all five from the gate's bigram floor, without asking twice", async () => {
    // No model at all: the gate forms ungated and the writer falls back. The
    // provenance column is the one that must differ, and `label_words` is still
    // the folded label — the field a second writer would have been free to
    // forget.
    const { winnerId, pending } = await pendingPair();

    await resolveFormation(formation({ generator: null }), pending);

    expect(await labelRow(winnerId)).toEqual({
      label: "Maple Ridge",
      label_words: ["maple", "ridge"],
      label_at: NOW,
      label_group_count: 2,
      label_source: "bigram",
    });
  });
});

describe("a storyline with no coverage left", () => {
  /**
   * Retention took the member articles out from under a storyline whose group
   * rows survive it. There is nothing to show a model and nothing for the
   * bigram extractor to read, so no name can come out of the call — and the
   * resolved rule is that nothing is written either. Stamping the drift
   * baseline would record a judgement nobody made and hold the row nameless
   * until its membership doubled; the label columns stay untouched instead, so
   * the next pass over a storyline whose coverage came back can still name it.
   */
  async function stripCoverage(): Promise<void> {
    await sql`delete from articles`.execute(db);
  }

  it("writes nothing, and spends no model call, on the labeler's path", async () => {
    const id = await promotedPair();
    await stripCoverage();
    const model = saying(NAME);

    const outcome = await nameStoryline(labeler({ generator: model.generator }), {
      storylineId: id,
      trigger: "promotion",
    });

    expect(outcome).toMatchObject({ label: null, source: "none", groupCount: 2 });
    expect(model.asked.count).toBe(0);
    expect(await labelRow(id)).toEqual({
      label: null,
      label_words: [],
      label_at: null,
      label_group_count: null,
      label_source: null,
    });
  });

  it("writes nothing on the formation path either — and still FORMS", async () => {
    // The same input reached the other writer and got the other answer: it had
    // no empty-members branch, so it stamped the baseline on a null label. The
    // formation itself is not in question — the merge and the promotion stand,
    // because losing a storyline is a much larger failure than losing a name.
    const { winnerId, pending } = await pendingPair();
    // Grown since the linker looked, which is what carries an empty-coverage
    // pair past `resolveFormation`'s own "no coverage" guard and into the
    // write. The verdict is rightly not sought for a join to a real arc.
    await db
      .insertInto("storyline_groups")
      .values({ storyline_id: winnerId, group_id: await seedGroup("A third angle") })
      .execute();
    await stripCoverage();

    const result = await resolveFormation(formation({ generator: saying(NAME).generator }), pending);

    expect(result).toMatchObject({ kind: "formed", labelled: false });
    expect((await readStoryline(db, winnerId))?.status).toBe("active");
    expect(await labelRow(winnerId)).toEqual({
      label: null,
      label_words: [],
      label_at: null,
      label_group_count: null,
      label_source: null,
    });
  });
});
