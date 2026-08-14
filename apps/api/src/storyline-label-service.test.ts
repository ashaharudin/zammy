import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachGroup,
  createProvisionalStoryline,
  promoteStoryline,
  readStoryline,
} from "@zammy/storage";
import { createGeminiClient, type GenerateRequest, type GenerateResult } from "./gemini.js";
import {
  labelLinkedStorylines,
  labelStoryline,
  type LabelerDeps,
} from "./storyline-label-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The labeler end to end (ADR-0011): a real storyline in a real database, a
 * model that answers from RECORDED responses, and the two properties the rest
 * of the system leans on —
 *
 *   a failed model never fails a promotion   (the fallback always runs)
 *   the drift baseline is always stamped     (nothing is re-asked for ever)
 *
 * The generator is the only stub, and it is stubbed at the HTTP boundary
 * wherever the point is the client's behaviour, so the recorded payloads are
 * exercised rather than described.
 */

const RESPONSES = JSON.parse(
  readFileSync(new URL("../../../fixtures/gemini-label-responses.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const ZONE = "UTC";
const NOW = new Date("2026-03-05T12:00:00.000Z");

/** A generator wired to a canned HTTP response, through the real client. */
function recorded(body: unknown, status = 200) {
  const prompts: string[] = [];
  const generator = createGeminiClient({
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.example/v1beta",
    sleep: async () => {},
    fetch: async (_url, init) => {
      prompts.push(JSON.parse(init.body as string).contents[0].parts[0].text);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { generator, prompts };
}

/** A generator that answers with whatever the test says, no HTTP involved. */
function saying(text: string) {
  return {
    generate: async (_request: GenerateRequest): Promise<GenerateResult> => ({
      ok: true,
      text,
    }),
  };
}

describe("the labeler", () => {
  let harness: TestHarness;
  let counter = 0;

  const deps = (overrides: Partial<LabelerDeps> = {}): LabelerDeps => ({
    db: harness.deps.db,
    generator: null,
    sampleSize: 10,
    driftFactor: 2,
    now: () => NOW,
    ...overrides,
  });

  /** An article, optionally joined to an existing group. */
  const article = async (input: {
    title: string;
    description?: string | null;
    published: string;
    groupId?: string;
  }): Promise<string> => {
    counter += 1;
    const row = await harness.deps.db
      .insertInto("articles")
      .values({
        dedup_key: randomBytes(32),
        url: `https://fixture.example/${counter}`,
        title: input.title,
        description: input.description ?? null,
        author: null,
        image_url: null,
        language: "en",
        categories: [],
        source_category: [],
        source_domain: "fixture.example",
        published: new Date(input.published),
        latest_seen: new Date(input.published),
        sighting_count: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (input.groupId !== undefined) {
      await harness.deps.db
        .updateTable("articles")
        .set({ group_id: input.groupId })
        .where("id", "=", row.id)
        .execute();
    }
    return row.id;
  };

  /** A promoted storyline covering the Fort Hood crash, one group per day. */
  const fortHood = async (): Promise<string> => {
    const first = await article({
      title: "Helicopter crashes at Fort Hood during training",
      description: "Two crew were aboard when the aircraft went down at Fort Hood.",
      published: "2026-03-01T14:00:00.000Z",
    });
    const storyline = await createProvisionalStoryline(harness.deps.db, {
      groupId: first,
      timeZone: ZONE,
    });
    const second = await article({
      title: "Fort Hood crash investigation opens",
      description: "Investigators arrived at Fort Hood on Monday.",
      published: "2026-03-02T09:00:00.000Z",
    });
    await attachGroup(harness.deps.db, {
      storylineId: storyline.id,
      groupId: second,
      timeZone: ZONE,
    });
    await promoteStoryline(harness.deps.db, { storylineId: storyline.id });
    return storyline.id;
  };

  const load = async (id: string) => {
    const row = await readStoryline(harness.deps.db, id);
    if (!row) throw new Error(`no storyline ${id}`);
    return row;
  };

  beforeAll(async () => {
    harness = await createTestHarness({}, NOW);
  });

  afterAll(async () => {
    await harness.teardown();
  });

  /**
   * The live tail (ADR-0011's "fires at promotion, on merge, and on drift").
   *
   * What is under test is the WALK, not the labeling: which of a batch's link
   * outcomes deserve a label, under which trigger, and that a labeler having a
   * bad day cannot reach the ingest that spawned it.
   */
  describe("labelLinkedStorylines", () => {
    it("labels what a batch promoted and relabels what it merged", async () => {
      const promoted = await fortHood();
      const merged = await fortHood();

      await labelLinkedStorylines(
        { db: harness.deps.db, labeler: deps({ generator: saying("Fort Hood Crash") }) },
        [
          { groupId: "1", storylineId: promoted, attached: true, bridged: [], merged: [] },
          {
            groupId: "2",
            storylineId: "unused",
            attached: false,
            bridged: [],
            merged: [{ winnerId: merged, loserId: "gone" }],
          },
        ],
      );

      expect((await load(promoted)).label).toBe("Fort Hood Crash");
      expect((await load(merged)).label).toBe("Fort Hood Crash");
    });

    it("leaves a plain birth alone — a storyline of one has nothing to name", async () => {
      const born = await createProvisionalStoryline(harness.deps.db, {
        groupId: await article({ title: "Council approves a bridge", published: "2026-03-01T09:00:00.000Z" }),
        timeZone: ZONE,
      });

      await labelLinkedStorylines(
        { db: harness.deps.db, labeler: deps({ generator: saying("Some Label") }) },
        [{ groupId: "1", storylineId: born.id, attached: false, bridged: [], merged: [] }],
      );

      // Invisible as a storyline, so a label would be a model call spent on
      // something no reader can ever see.
      expect((await load(born.id)).label).toBeNull();
    });

    it("never throws — the ingest that spawned it is already done", async () => {
      const id = await fortHood();

      await expect(
        labelLinkedStorylines(
          {
            db: harness.deps.db,
            labeler: deps({
              generator: {
                generate: () => Promise.reject(new Error("model on fire")),
              },
            }),
          },
          [{ groupId: "1", storylineId: id, attached: true, bridged: [], merged: [] }],
        ),
      ).resolves.toBeUndefined();
    });
  });

  it("labels a promoted storyline from the model, and stamps the baseline", async () => {
    const id = await fortHood();
    const { generator, prompts } = recorded(RESPONSES.ok);

    const outcome = await labelStoryline(deps({ generator }), {
      storyline: await load(id),
      trigger: "promotion",
    });

    expect(outcome).toMatchObject({ label: "Fort Hood Crash", source: "model", groupCount: 2 });
    expect(await load(id)).toMatchObject({
      label: "Fort Hood Crash",
      labelAt: NOW,
      labelGroupCount: 2,
    });
    // Both member groups reached the prompt, oldest first.
    expect(prompts[0]).toContain("Helicopter crashes at Fort Hood");
    expect(prompts[0]!.indexOf("Helicopter crashes")).toBeLessThan(
      prompts[0]!.indexOf("investigation opens"),
    );
  });

  it("shows the model one article per group, not one per syndicated copy", async () => {
    // Forty wire copies of one story would otherwise fill every slot in the
    // prompt and the model would name the syndication rather than the story.
    const id = await fortHood();
    const groups = await harness.deps.db
      .selectFrom("storyline_groups")
      .select("group_id")
      .where("storyline_id", "=", id)
      .execute();
    for (const { group_id } of groups) {
      for (let copy = 0; copy < 4; copy += 1) {
        await article({
          title: "Wire copy: helicopter down at Fort Hood",
          description: "Syndicated.",
          published: "2026-03-01T15:00:00.000Z",
          groupId: group_id,
        });
      }
    }

    const { generator, prompts } = recorded(RESPONSES.ok);
    await labelStoryline(deps({ generator }), {
      storyline: await load(id),
      trigger: "promotion",
    });

    expect(prompts[0]!.match(/^\d+\. /gm)).toHaveLength(2);
  });

  it("relabels on a merge, whatever the membership did", async () => {
    const id = await fortHood();
    await labelStoryline(deps({ generator: saying("Fort Hood Crash") }), {
      storyline: await load(id),
      trigger: "promotion",
    });

    const outcome = await labelStoryline(
      deps({ generator: saying("Fort Hood Investigation") }),
      { storyline: await load(id), trigger: "merge" },
    );

    expect(outcome).toMatchObject({ label: "Fort Hood Investigation", source: "model" });
  });

  it("holds a label on drift until membership has doubled, then refreshes it", async () => {
    const id = await fortHood();
    await labelStoryline(deps({ generator: saying("Fort Hood Crash") }), {
      storyline: await load(id),
      trigger: "promotion",
    });

    // Third group: growth, not drift. The label stands.
    const third = await article({
      title: "Fort Hood families await answers",
      description: "Relatives gathered near Fort Hood.",
      published: "2026-03-03T09:00:00.000Z",
    });
    await attachGroup(harness.deps.db, { storylineId: id, groupId: third, timeZone: ZONE });
    const held = await labelStoryline(deps({ generator: saying("Something Else Entirely") }), {
      storyline: await load(id),
      trigger: "drift",
    });
    expect(held.source).toBe("skipped");
    expect((await load(id)).label).toBe("Fort Hood Crash");

    // Fourth: membership has doubled since the label, so the story it
    // describes is now a minority of the coverage.
    const fourth = await article({
      title: "Fort Hood inquiry names investigators",
      description: "The Fort Hood inquiry named its panel.",
      published: "2026-03-04T09:00:00.000Z",
    });
    await attachGroup(harness.deps.db, { storylineId: id, groupId: fourth, timeZone: ZONE });
    const drifted = await labelStoryline(
      deps({ generator: saying("Fort Hood Inquiry") }),
      { storyline: await load(id), trigger: "drift" },
    );

    expect(drifted).toMatchObject({ label: "Fort Hood Inquiry", source: "model" });
    expect(await load(id)).toMatchObject({ label: "Fort Hood Inquiry", labelGroupCount: 4 });
  });

  describe("when the model does not deliver", () => {
    it("falls back to the bigram extractor on an unavailable model", async () => {
      const id = await fortHood();
      const { generator } = recorded(RESPONSES.overloaded, 503);

      const outcome = await labelStoryline(deps({ generator }), {
        storyline: await load(id),
        trigger: "promotion",
      });

      expect(outcome).toMatchObject({ label: "Fort Hood", source: "bigram" });
      expect(outcome.modelFailure).toBe("http 503");
      expect((await load(id)).label).toBe("Fort Hood");
    });

    it("falls back when the answer breaks the contract, keeping what it said", async () => {
      const id = await fortHood();
      const { generator } = recorded(RESPONSES.chatty);

      const outcome = await labelStoryline(deps({ generator }), {
        storyline: await load(id),
        trigger: "promotion",
      });

      expect(outcome).toMatchObject({ label: "Fort Hood", source: "bigram" });
      // The refused text is kept: the prompt iterates on live output, and
      // refusals are the only evidence of which way to iterate.
      expect(outcome.modelFailure).toContain("contract: Sure!");
    });

    it("falls back when a name was invented rather than covered", async () => {
      const id = await fortHood();
      const { generator } = recorded(RESPONSES.invented);

      const outcome = await labelStoryline(deps({ generator }), {
        storyline: await load(id),
        trigger: "promotion",
      });

      expect(outcome).toMatchObject({ label: "Fort Hood", source: "bigram" });
      expect(outcome.modelFailure).toContain("Belgrade");
    });

    it("labels from the extractor alone when there is no API key at all", async () => {
      // The unconfigured case is the DEFAULT case: `GEMINI_API_KEY` is
      // optional, and a repo checkout with no key must still produce labels.
      const id = await fortHood();

      const outcome = await labelStoryline(deps({ generator: null }), {
        storyline: await load(id),
        trigger: "promotion",
      });

      expect(outcome).toMatchObject({ label: "Fort Hood", source: "bigram" });
      expect(outcome.modelFailure).toBe("no generator configured");
    });

    it("stamps the baseline even with no label, so it is not re-asked for ever", async () => {
      // Two headlines with no shared adjacent pair: the model is away and the
      // extractor has nothing. A storyline nobody can name is a valid state —
      // it renders label-less — but it must not be re-asked on every pass.
      const first = await article({
        title: "Rain",
        published: "2026-03-01T09:00:00.000Z",
      });
      const storyline = await createProvisionalStoryline(harness.deps.db, {
        groupId: first,
        timeZone: ZONE,
      });
      const second = await article({
        title: "Wind",
        published: "2026-03-02T09:00:00.000Z",
      });
      await attachGroup(harness.deps.db, {
        storylineId: storyline.id,
        groupId: second,
        timeZone: ZONE,
      });
      await promoteStoryline(harness.deps.db, { storylineId: storyline.id });

      const outcome = await labelStoryline(deps({ generator: null }), {
        storyline: await load(storyline.id),
        trigger: "promotion",
      });

      expect(outcome).toMatchObject({ label: null, source: "none" });
      expect(await load(storyline.id)).toMatchObject({ label: null, labelGroupCount: 2 });
      // And the next drift check leaves it alone until coverage doubles.
      const next = await labelStoryline(deps({ generator: null }), {
        storyline: await load(storyline.id),
        trigger: "drift",
      });
      expect(next.source).toBe("skipped");
    });
  });
});
