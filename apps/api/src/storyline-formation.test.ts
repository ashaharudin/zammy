import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createProvisionalStoryline,
  readFormationRefusals,
  readGroupStorylines,
  readStoryline,
  readStorylineDays,
} from "@zammy/storage";
import type { GenerateRequest, GenerateResult } from "./gemini.js";
import { resolveFormation, resolvePendingFormations, type FormationDeps } from "./storyline-formation.js";
import { createTestHarness, type TestHarness } from "./test-support.js";
import { linkGroup, type LinkerConfig, type LinkOutcome } from "./storyline-linker.js";
import { labelLinkedStorylines } from "./storyline-label-service.js";

/**
 * Resolving a deferred formation (ADR-0011's amendment) against real Postgres.
 *
 * These are the tests that matter most in the gate, because this is the only
 * place a model's answer *removes* something a reader would otherwise see. The
 * three outcomes are asserted separately and the middle one — "the model did not
 * answer" — is the one production depends on: the archive's key has a 500-request
 * DAILY ceiling, so silence must form the storyline, not dissolve it.
 */

let harness: TestHarness;
let db: TestHarness["deps"]["db"];
let counter = 0;

const ZONE = "UTC";
const NOW = new Date("2026-08-14T12:00:00.000Z");

beforeAll(async () => {
  harness = await createTestHarness();
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

/** A generator that answers with whatever the test says, no HTTP involved. */
function saying(text: string) {
  return {
    generate: async (_request: GenerateRequest): Promise<GenerateResult> => ({
      ok: true,
      text,
    }),
  };
}

/** A generator that cannot be reached — quota, timeout, a 503. */
function unavailable(reason = "http 429") {
  return {
    generate: async (_request: GenerateRequest): Promise<GenerateResult> => ({
      ok: false,
      reason,
    }),
  };
}

const deps = (overrides: Partial<FormationDeps> = {}): FormationDeps => ({
  db,
  generator: null,
  modelId: "gemini-test",
  sampleSize: 10,
  timeZone: ZONE,
  now: () => NOW,
  ...overrides,
});

/** One article in its own group, and the provisional storyline it seeds. */
async function seedGroup(title: string): Promise<{ groupId: string; storylineId: string }> {
  counter += 1;
  const row = await db
    .insertInto("articles")
    .values({
      dedup_key: randomBytes(32),
      url: `https://fixture.example/${counter}`,
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
    .returning(["id", "group_id"])
    .executeTakeFirstOrThrow();
  const storyline = await createProvisionalStoryline(db, {
    groupId: row.group_id,
    timeZone: ZONE,
  });
  return { groupId: row.group_id, storylineId: storyline.id };
}

/** The winner (the earlier group's storyline) and the arriving group. */
async function pendingPair(winnerTitle: string, arrivingTitle: string) {
  const winner = await seedGroup(winnerTitle);
  const arriving = await seedGroup(arrivingTitle);
  return {
    winner,
    arriving,
    pending: {
      winnerId: winner.storylineId,
      groupId: arriving.groupId,
      partnerGroupId: winner.groupId,
    },
  };
}

describe("an explicit refusal", () => {
  it("leaves the two groups apart and records the refusal", async () => {
    // The archive's `73dbc49f`: two unrelated shootings sharing `off-duty` and
    // `fatally`, every token threshold satisfied.
    const { winner, arriving, pending } = await pendingPair(
      "Off-duty police officer fatally shot outside Pa. lounge",
      "Family of L.A. father fatally shot by off-duty ICE officer demanding justice",
    );

    const result = await resolveFormation(
      deps({ generator: saying("NOT ONE STORY") }),
      pending,
    );

    expect(result).toEqual({ kind: "refused" });
    // Nothing merged: both keep their own provisional storyline, both still render.
    expect(await readGroupStorylines(db, arriving.groupId)).toEqual([arriving.storylineId]);
    expect((await readStoryline(db, winner.storylineId))?.status).toBe("provisional");
    expect((await readStoryline(db, winner.storylineId))?.label).toBeNull();
    // And the pair is remembered, so the nightly sweep cannot re-ask for ever.
    expect(await readFormationRefusals(db, arriving.groupId)).toEqual(
      new Set([winner.groupId]),
    );
  });

  it("records the refusal symmetrically", async () => {
    const { winner, arriving, pending } = await pendingPair("Cleansing routine", "Skin routine");

    await resolveFormation(deps({ generator: saying("NOT ONE STORY") }), pending);

    // Whichever group is re-offered first must find the refusal.
    expect(await readFormationRefusals(db, winner.groupId)).toEqual(
      new Set([arriving.groupId]),
    );
  });
});

describe("a usable name", () => {
  it("performs the merge, promotes, and labels from the SAME reply", async () => {
    const { winner, arriving, pending } = await pendingPair(
      "Bear shot after girl attacked in Maple Ridge",
      "Conservation officers search for bear after Maple Ridge girl attacked",
    );

    const result = await resolveFormation(
      deps({ generator: saying("Maple Ridge Bear Attack") }),
      pending,
    );

    expect(result).toMatchObject({ kind: "formed", labelled: true });
    const storyline = await readStoryline(db, winner.storylineId);
    expect(storyline?.status).toBe("active");
    expect(storyline?.label).toBe("Maple Ridge Bear Attack");
    // One model call produced BOTH the permission and the name — no second call.
    expect(storyline?.labelSource).toBe("gemini-test");
    // The arriving group is re-homed, and its own UUID still resolves (alias).
    expect(await readGroupStorylines(db, arriving.groupId)).toEqual([winner.storylineId]);
    expect((await readStoryline(db, arriving.storylineId))?.mergedInto).toBe(
      winner.storylineId,
    );
  });

  it("recomputes the day slots the merge implies", async () => {
    const { winner, pending } = await pendingPair("Maple Ridge bear", "Maple Ridge bear search");

    await resolveFormation(deps({ generator: saying("Maple Ridge Bear Attack") }), pending);

    expect(await readStorylineDays(db, winner.storylineId)).not.toHaveLength(0);
  });
});

describe("no usable verdict — the pre-gate outcome", () => {
  it("FORMS the storyline when the model is unavailable", async () => {
    // The load-bearing case. The dev key's ceiling is 500 requests a day and the
    // labelling campaign exhausts it; a gate that read a 429 as a refusal would
    // dissolve storylines on a quiet Tuesday rather than on evidence.
    const { winner, arriving, pending } = await pendingPair(
      "Maple Ridge bear",
      "Maple Ridge bear search",
    );

    const result = await resolveFormation(deps({ generator: unavailable() }), pending);

    expect(result).toMatchObject({ kind: "formed", labelled: false });
    expect((await readStoryline(db, winner.storylineId))?.status).toBe("active");
    expect(await readGroupStorylines(db, arriving.groupId)).toEqual([winner.storylineId]);
    expect(await readFormationRefusals(db, arriving.groupId)).toEqual(new Set());
  });

  it("falls back to the bigram label, as a promotion always has", async () => {
    const { winner, pending } = await pendingPair(
      "Maple Ridge bear attacked girl",
      "Maple Ridge bear attacked girl again",
    );

    await resolveFormation(deps({ generator: unavailable() }), pending);

    const storyline = await readStoryline(db, winner.storylineId);
    expect(storyline?.labelSource).toBe("bigram");
    expect(storyline?.label).not.toBeNull();
  });

  it("FORMS the storyline when the answer breaks the contract", async () => {
    // An ungrounded or chatty answer is a formatting failure, not a judgement
    // that the coverage is unrelated. Conflating the two is how a gate starts
    // dissolving storylines nobody asked it about.
    const { winner, pending } = await pendingPair("Maple Ridge bear", "Maple Ridge bear search");

    const result = await resolveFormation(
      deps({ generator: saying("These appear to be two separate incidents entirely.") }),
      pending,
    );

    expect(result).toMatchObject({ kind: "formed" });
    expect((await readStoryline(db, winner.storylineId))?.status).toBe("active");
  });

  it("FORMS the storyline when no model is configured at all", async () => {
    const { winner, pending } = await pendingPair("Maple Ridge bear", "Maple Ridge bear search");

    const result = await resolveFormation(deps({ generator: null }), pending);

    expect(result).toMatchObject({ kind: "formed" });
    expect((await readStoryline(db, winner.storylineId))?.status).toBe("active");
  });
});

describe("no longer a formation", () => {
  it("performs it WITHOUT a verdict once the winner has grown", async () => {
    // A concurrent arrival got there first, so this is now a join to a real arc —
    // and the verdict wrongly refuses 43% of those. It must not be asked.
    const { winner, pending } = await pendingPair("Maple Ridge bear", "Maple Ridge bear search");
    const third = await seedGroup("Maple Ridge bear third angle");
    await db
      .insertInto("storyline_groups")
      .values({ storyline_id: winner.storylineId, group_id: third.groupId })
      .execute();

    let asked = 0;
    const counting = {
      generate: async (): Promise<GenerateResult> => {
        asked += 1;
        return { ok: true, text: "NOT ONE STORY" };
      },
    };
    const result = await resolveFormation(deps({ generator: counting }), pending);

    expect(asked).toBe(0);
    expect(result).toMatchObject({ kind: "formed" });
  });

  it("writes nothing when the partner group changed underneath it", async () => {
    const { winner, arriving, pending } = await pendingPair("A story", "Another story");
    const other = await seedGroup("A third story");
    // A group merge moved the winner's identity onto a different group: the pair
    // a verdict would be about is not the pair the linker judged.
    await sql`
      update storyline_groups set group_id = ${other.groupId}
      where storyline_id = ${winner.storylineId}::uuid
    `.execute(db);

    const result = await resolveFormation(deps({ generator: saying("NOT ONE STORY") }), pending);

    expect(result).toMatchObject({ kind: "moot" });
    expect(await readFormationRefusals(db, arriving.groupId)).toEqual(new Set());
  });
});

describe("resolvePendingFormations", () => {
  const outcome = (pending: LinkOutcome["pendingFormation"]): LinkOutcome => ({
    groupId: pending!.groupId,
    storylineId: "",
    attached: false,
    attachedTo: [],
    promoted: [],
    bridged: [],
    merged: [],
    pendingFormation: pending,
  });

  it("resolves each pending formation and ignores outcomes without one", async () => {
    const refused = await pendingPair("Cleansing routine", "Skin care routine");
    const formed = await pendingPair("Maple Ridge bear", "Maple Ridge bear search");

    const results = await resolvePendingFormations(deps({ generator: saying("NOT ONE STORY") }), [
      outcome(refused.pending),
      { ...outcome(formed.pending), pendingFormation: undefined },
    ]);

    expect(results.get(refused.pending.winnerId)).toEqual({ kind: "refused" });
    expect(results.has(formed.pending.winnerId)).toBe(false);
    expect((await readStoryline(db, formed.winner.storylineId))?.status).toBe("provisional");
  });

  it("never throws when one formation fails", async () => {
    // The caller does not await this tail, so a rejection is a process-level
    // event for what is at worst one storyline that did not form.
    const exploding = {
      generate: async (): Promise<GenerateResult> => {
        throw new Error("boom");
      },
    };
    const { pending } = await pendingPair("A story", "Another story");

    await expect(
      resolvePendingFormations(deps({ generator: exploding }), [outcome(pending)]),
    ).resolves.toBeInstanceOf(Map);
  });
});

describe("the tail actually resolves them (the wiring, not the rule)", () => {
  const GATED: LinkerConfig = {
    enabled: true,
    rules: {
      anchorMaxShare: 0.002,
      anchorDfFloor: 10,
      massThreshold: 20,
      dormancyDays: 90,
      dormantStrictness: 1.5,
    },
    mergeBridges: 2,
    coherenceGate: true,
    storyDf: { windowDays: 14, timeZone: ZONE },
    timeZone: ZONE,
  };

  /** Two real arrivals through the real linker, gated. */
  async function deferThroughLinker() {
    const day = "2026-08-14";
    await db
      .insertInto("story_corpus_days")
      .values({ day, language: "en", articles: 16_000 })
      .execute();
    const tokens = ["fausto", "hawaii", "surf", "swell", "genevieve"];
    await db
      .insertInto("story_token_days")
      .values(tokens.map((token) => ({ day, language: "en", token, df: 20 })))
      .execute();

    const made: LinkOutcome[] = [];
    for (let index = 0; index < 2; index += 1) {
      counter += 1;
      const row = await db
        .insertInto("articles")
        .values({
          dedup_key: randomBytes(32),
          url: `https://fixture.example/linked-${counter}`,
          title: tokens.join(" "),
          description: null,
          language: "en",
          categories: [],
          source_category: [],
          source_domain: "fixture.example",
          published: NOW,
          latest_seen: NOW,
          sighting_count: 1,
          story_tokens: tokens,
        })
        .returning(["id", "group_id"])
        .executeTakeFirstOrThrow();
      made.push(
        await linkGroup(
          { db, config: GATED },
          {
            groupId: row.group_id,
            memberTokens: [tokens],
            language: "en",
            published: NOW,
          },
        ),
      );
    }
    return made;
  }

  const labeler = (generator: FormationDeps["generator"]) => ({
    generator,
    modelId: "gemini-test",
    sampleSize: 10,
    driftFactor: 2,
    now: () => NOW,
  });

  it("refuses the deferred formation through labelLinkedStorylines", async () => {
    const outcomes = await deferThroughLinker();
    const pending = outcomes[1]!.pendingFormation;
    expect(pending).toBeTruthy();

    await labelLinkedStorylines(
      { db, labeler: labeler(saying("NOT ONE STORY")), formations: { timeZone: ZONE } },
      outcomes,
    );

    expect((await readStoryline(db, pending!.winnerId))?.status).toBe("provisional");
    expect(await readFormationRefusals(db, pending!.groupId)).toEqual(
      new Set([pending!.partnerGroupId]),
    );
  });

  it("forms and names it through labelLinkedStorylines", async () => {
    const outcomes = await deferThroughLinker();
    const pending = outcomes[1]!.pendingFormation!;

    await labelLinkedStorylines(
      { db, labeler: labeler(saying("Hurricane Fausto Hawaii")), formations: { timeZone: ZONE } },
      outcomes,
    );

    const storyline = await readStoryline(db, pending.winnerId);
    expect(storyline?.status).toBe("active");
    expect(storyline?.label).toBe("Hurricane Fausto Hawaii");
    expect(await readGroupStorylines(db, pending.groupId)).toEqual([pending.winnerId]);
  });

  it("leaves the formation pending when the caller declares no formations", async () => {
    // A merge recomputes day slots, so a caller that cannot say which calendar
    // must not perform one. The late-candidate sweep re-offers the pair.
    const outcomes = await deferThroughLinker();
    const pending = outcomes[1]!.pendingFormation!;

    await labelLinkedStorylines({ db, labeler: labeler(saying("NOT ONE STORY")) }, outcomes);

    expect((await readStoryline(db, pending.winnerId))?.status).toBe("provisional");
    expect(await readFormationRefusals(db, pending.groupId)).toEqual(new Set());
  });
});
