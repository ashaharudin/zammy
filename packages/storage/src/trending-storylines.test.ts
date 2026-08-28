import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { migrateToLatest } from "./migrator.js";
import {
  attachGroup,
  createProvisionalStoryline,
  promoteStoryline,
  setStorylineLabel,
} from "./storylines.js";
import { readTrendingStorylines } from "./trending-storylines.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";
import type { SightingPlane } from "./database.js";

/**
 * The wordcloud read (ARCHITECTURE 10.4, ADR-0013, ADR-0014): the storylines
 * several newsrooms covered inside the rolling window, busiest and freshest
 * first.
 *
 * Real Postgres, because the whole thing is one aggregate — a windowed join for
 * the recency and the window count, a lateral for the arc's size and breadth,
 * the breadth gate in a `having`, and a decay in the `order by`. A fake would
 * agree with every one of these assertions and with none of the SQL.
 */

const ZONE = "UTC";
/**
 * One EMISSION of a fixture article: who reported it, and why we asked.
 *
 * These two used to be one field. The fixtures below built sightings from a
 * list of provider names, because the shipped rule was a provider list — and
 * that is exactly what ADR-0019 says cannot survive one provider serving two
 * roles. Splitting the fixture is what lets the tests state the rule the query
 * now enforces: the same provider id appears on both sides of the predicate,
 * and only the plane decides.
 *
 * `plane: null` is a real and important value here, not a convenience. Every
 * sighting written before migration 0022 carries it, and it must COUNT — the
 * whole dev archive does.
 */
const DEEPENING_PROVIDER = "google-news";

interface Emission {
  /** Defaults to `"currents"`. Never the thing the predicate reads. */
  provider?: string;
  plane: SightingPlane | null;
}
const NOW = new Date("2026-08-17T12:00:00.000Z");
const WINDOW = { from: new Date("2026-08-16T12:00:00.000Z"), to: NOW };
/** ADR-0008's default, so the arithmetic below is the shipped arithmetic. */
const HALF_LIFE_HOURS = 8;

let counter = 0;

describe("readTrendingStorylines", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
  });

  afterAll(async () => {
    await harness.drop();
  });

  beforeEach(async () => {
    // `articles cascade` takes `sightings` with it (the FK is ON DELETE CASCADE),
    // but naming it keeps the reset legible now that sightings are load-bearing.
    await sql`
      truncate storylines, storyline_groups, storyline_days, articles, sightings cascade
    `.execute(harness.db);
  });

  /**
   * One article, in its own group unless told otherwise, with one sighting per
   * entry in `emissions` — earliest first, since `articles.provider` is defined
   * as the provider of the EARLIEST sighting (migration 0013) and the read now
   * asks a question that only means something against real sighting rows.
   *
   * Defaulting to one `search` emission rather than to no sightings at all is
   * the point: an article nobody reported is not a state ingest can produce, and
   * a fixture that produced it would let the plane predicate pass every test by
   * excluding everything.
   */
  const article = async (input: {
    published: string;
    domain: string;
    groupId?: string;
    language?: string | null;
    emissions?: readonly Emission[];
  }): Promise<string> => {
    counter += 1;
    const emissions: readonly Emission[] = input.emissions ?? [{ plane: "search" }];
    const dedupKey = randomBytes(32);
    const row = await harness.db
      .insertInto("articles")
      .values({
        dedup_key: dedupKey,
        url: `https://${input.domain}/${counter}`,
        title: `Fixture ${counter}`,
        description: null,
        author: null,
        image_url: null,
        language: input.language === undefined ? "en" : input.language,
        categories: [],
        source_category: [],
        source_domain: input.domain,
        published: new Date(input.published),
        latest_seen: new Date(input.published),
        sighting_count: emissions.length,
        provider: emissions[0]!.provider ?? "currents",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    for (const [index, emission] of emissions.entries()) {
      const provider = emission.provider ?? "currents";
      await harness.db
        .insertInto("sightings")
        .values({
          id: randomUUID(),
          article_id: row.id,
          dedup_key: dedupKey,
          published: new Date(input.published),
          // Ordered, so "earliest sighting" is the first of `emissions`.
          first_seen_at: new Date(Date.parse(input.published) + index * 60_000),
          provider,
          // `never` on the UPDATE side of the column type, and non-null on the
          // INSERT side, so a NULL-plane row — the whole pre-0022 archive —
          // cannot be built through the builder. Raw SQL is what a fixture for
          // history has to use, and the cast is what makes the intent loud.
          ...(emission.plane === null
            ? { plane: sql<never>`null` }
            : { plane: emission.plane }),
          raw: JSON.stringify({ fixture: counter, provider }),
        })
        .execute();
    }

    if (input.groupId !== undefined) {
      await harness.db
        .updateTable("articles")
        .set({ group_id: input.groupId })
        .where("id", "=", row.id)
        .execute();
    }
    return row.id;
  };

  /**
   * A labelled, promoted storyline over the given articles — one group each,
   * which is what the linker produces for stories no two outlets ran at the
   * same URL. Built through the storage API rather than the linker: what is
   * under test is the read, and driving the linker would make its token
   * thresholds the subject.
   */
  const storyline = async (
    label: string,
    articles: readonly {
      published: string;
      domain: string;
      emissions?: readonly Emission[];
    }[],
  ): Promise<string> => {
    const groups = await Promise.all(articles.map((a) => article(a)));
    const created = await createProvisionalStoryline(harness.db, {
      groupId: groups[0]!,
      timeZone: ZONE,
    });
    for (const groupId of groups.slice(1)) {
      await attachGroup(harness.db, { storylineId: created.id, groupId, timeZone: ZONE });
    }
    await promoteStoryline(harness.db, { storylineId: created.id });
    await setStorylineLabel(harness.db, {
      storylineId: created.id,
      label,
      // What `labelWords` (apps/api) would fold this label to. Spelled out
      // rather than imported: storage cannot reach the fold, and inventing a
      // second one here is the exact duplication `label_words` exists to
      // prevent. Safe for these fixtures because their labels are plain ASCII
      // words with no plural, possessive or punctuation, where the fold is just
      // the lowercase split; the fold itself is pinned in apps/api.
      labelWords: label.toLowerCase().split(" "),
      labelAt: NOW,
      labelGroupCount: groups.length,
      labelSource: "test",
    });
    return created.id;
  };

  const read = () =>
    readTrendingStorylines(harness.db, {
      language: "en",
      ...WINDOW,
      halfLifeHours: HALF_LIFE_HOURS,
      limit: 50,
    });

  it("breaks a tie in volume by recency", async () => {
    await storyline("Older Arc", [
      { published: "2026-08-17T02:00:00.000Z", domain: "a.com" },
      { published: "2026-08-16T22:00:00.000Z", domain: "b.com" },
    ]);
    await storyline("Fresher Arc", [
      { published: "2026-08-17T11:30:00.000Z", domain: "a.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "b.com" },
    ]);

    const cloud = await read();
    expect(cloud.map((s) => s.label)).toEqual(["Fresher Arc", "Older Arc"]);
    expect(cloud[0]!.lastUpdated.toISOString()).toBe("2026-08-17T11:30:00.000Z");
  });

  it("ranks a busier arc over a fresher one within a half-life", async () => {
    // The failure ADR-0014 was written for: under a pure recency sort the
    // one-article storyline that moved most recently led the board, and the
    // storyline several newsrooms were actually covering sat far down it in
    // cool blue. 6 * 0.5^(1.5/8) = 5.27 against 2 * 0.5^0 = 2.
    await storyline("Widely Covered", [
      { published: "2026-08-17T06:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T07:00:00.000Z", domain: "b.com" },
      { published: "2026-08-17T08:00:00.000Z", domain: "c.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "d.com" },
      { published: "2026-08-17T10:00:00.000Z", domain: "e.com" },
      { published: "2026-08-17T10:30:00.000Z", domain: "f.com" },
    ]);
    await storyline("Just Landed", [
      { published: "2026-08-17T11:59:00.000Z", domain: "a.com" },
      { published: "2026-08-17T11:58:00.000Z", domain: "b.com" },
    ]);

    expect((await read()).map((s) => s.label)).toEqual(["Widely Covered", "Just Landed"]);
  });

  it("lets the decay overturn volume once the busier arc is old enough", async () => {
    // The other half of the same knob, and the reason the ordering is a decay
    // rather than "volume, then recency": yesterday's big story must not hold
    // the top of the board for the rest of the window. Twenty-two hours at an
    // 8-hour half-life leaves 8 * 0.5^(22/8) = 1.19 against 2 * 0.5^0 = 2.
    await storyline("Yesterday's Story", [
      { published: "2026-08-16T13:00:00.000Z", domain: "a.com" },
      { published: "2026-08-16T13:10:00.000Z", domain: "b.com" },
      { published: "2026-08-16T13:20:00.000Z", domain: "c.com" },
      { published: "2026-08-16T13:30:00.000Z", domain: "d.com" },
      { published: "2026-08-16T13:40:00.000Z", domain: "e.com" },
      { published: "2026-08-16T13:50:00.000Z", domain: "f.com" },
      { published: "2026-08-16T13:55:00.000Z", domain: "g.com" },
      { published: "2026-08-16T14:00:00.000Z", domain: "h.com" },
    ]);
    await storyline("This Hour", [
      { published: "2026-08-17T11:59:00.000Z", domain: "a.com" },
      { published: "2026-08-17T11:58:00.000Z", domain: "b.com" },
    ]);

    expect((await read()).map((s) => s.label)).toEqual(["This Hour", "Yesterday's Story"]);
  });

  it("counts the WINDOW's articles for size and the whole arc separately", async () => {
    // An arc that began well before the window and gained two articles inside
    // it: the cloud sizes the word on what happened, and still says how big
    // the story is.
    await storyline("Long Running Arc", [
      { published: "2026-08-10T09:00:00.000Z", domain: "a.com" },
      { published: "2026-08-11T09:00:00.000Z", domain: "b.com" },
      { published: "2026-08-17T08:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T10:00:00.000Z", domain: "c.com" },
    ]);

    const [only] = await read();
    expect(only!.windowArticles).toBe(2);
    expect(only!.windowSources).toBe(2); // the gate: a.com and c.com, inside
    expect(only!.size).toBe(4);
    expect(only!.sourceCount).toBe(3); // arc-wide breadth, reported not gated
  });

  it("drops a storyline whose coverage all aged out of the window", async () => {
    await storyline("Aged Out", [
      { published: "2026-08-14T09:00:00.000Z", domain: "a.com" },
      { published: "2026-08-15T09:00:00.000Z", domain: "b.com" },
    ]);

    expect(await read()).toEqual([]);
  });

  it("gates on two source domains (the Jenkins-burst class)", async () => {
    // Four articles, one outlet, inside the window: a run of near-identical
    // advisories is not what several newsrooms are covering (PROBE-FINDINGS 6b).
    await storyline("Single Outlet Advisories", [
      { published: "2026-08-17T08:00:00.000Z", domain: "loud.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "loud.com" },
      { published: "2026-08-17T10:00:00.000Z", domain: "loud.com" },
      { published: "2026-08-17T11:00:00.000Z", domain: "loud.com" },
    ]);
    await storyline("Two Newsrooms", [
      { published: "2026-08-17T07:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T07:30:00.000Z", domain: "b.com" },
    ]);

    expect((await read()).map((s) => s.label)).toEqual(["Two Newsrooms"]);
  });

  it("measures that gate over the WINDOW, not over the arc (ADR-0014)", async () => {
    // The behaviour change. This arc is broadly covered — eleven outlets over
    // three weeks — and today it gained one article, from one of them. ADR-0013
    // asked the gate about the story and let it through; asked about the window,
    // the honest answer is that several newsrooms are not covering this now.
    await storyline("Broad Arc, Quiet Today", [
      { published: "2026-07-28T09:00:00.000Z", domain: "a.com" },
      { published: "2026-07-29T09:00:00.000Z", domain: "b.com" },
      { published: "2026-08-01T09:00:00.000Z", domain: "c.com" },
      { published: "2026-08-17T11:00:00.000Z", domain: "a.com" },
    ]);

    expect(await read()).toEqual([]);
  });

  it("refuses provisional, unlabelled and merged-away storylines", async () => {
    // Provisional: a storyline-of-one is the ordinary timeline slot, not a
    // story to name as a topic of the day.
    const provisional = await createProvisionalStoryline(harness.db, {
      groupId: await article({ published: "2026-08-17T11:00:00.000Z", domain: "a.com" }),
      timeZone: ZONE,
    });
    await setStorylineLabel(harness.db, {
      storylineId: provisional.id,
      label: "Provisional Arc",
      labelWords: ["provisional", "arc"],
      labelAt: NOW,
      labelGroupCount: 1,
      labelSource: "test",
    });

    // Unlabelled: promoted, covered, and with no word to draw.
    const unlabelled = await storyline("Temporarily Named", [
      { published: "2026-08-17T10:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T10:30:00.000Z", domain: "b.com" },
    ]);
    await setStorylineLabel(harness.db, {
      storylineId: unlabelled,
      label: null,
      labelWords: [],
      labelAt: NOW,
      labelGroupCount: 2,
      labelSource: null,
    });

    // An alias: a pointer, whose coverage the survivor already carries.
    const alias = await storyline("Merged Away", [
      { published: "2026-08-17T09:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T09:30:00.000Z", domain: "b.com" },
    ]);
    const survivor = await storyline("The Survivor", [
      { published: "2026-08-17T08:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T08:30:00.000Z", domain: "b.com" },
    ]);
    await harness.db
      .updateTable("storylines")
      .set({ merged_into: survivor })
      .where("id", "=", alias)
      .execute();

    expect((await read()).map((s) => s.label)).toEqual(["The Survivor"]);
  });

  it("refuses a bigram label, and keeps one whose provenance predates the column", async () => {
    // The cloud is the one place a label's words are executed as a search
    // (ADR-0013/0014), so a label that names vocabulary rather than an event
    // mints a topic for a story that does not exist.
    const bigram = await storyline("Investing Com", [
      { published: "2026-08-17T11:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T11:10:00.000Z", domain: "b.com" },
    ]);
    await setStorylineLabel(harness.db, {
      storylineId: bigram,
      label: "Investing Com",
      labelWords: ["investing", "com"],
      labelAt: NOW,
      labelGroupCount: 2,
      labelSource: "bigram",
    });

    // Provenance predating migration 0011 is UNKNOWN, not disqualifying. This
    // is the case a bare `label_source <> 'bigram'` would silently drop, since
    // that comparison is NULL for this row — over half the cloud in the dev
    // archive. It is the reason the predicate is written with `coalesce`.
    const preMigration = await storyline("Tropical Storm Lala", [
      { published: "2026-08-17T10:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T10:10:00.000Z", domain: "b.com" },
    ]);
    await harness.db
      .updateTable("storylines")
      .set({ label: "Tropical Storm Lala", label_source: null, label_at: NOW })
      .where("id", "=", preMigration)
      .execute();

    expect((await read()).map((s) => s.label)).toEqual(["Tropical Storm Lala"]);
  });

  it("scopes to the language of the COVERAGE, not of the storyline", async () => {
    // A storyline is not language-scoped — nothing about an event is — so it
    // appears in the cloud of every language that covered it, sized by that
    // language's articles.
    // Each language needs its own two newsrooms: the breadth gate is applied
    // to the window AFTER the language filter (ADR-0014), so a storyline is
    // held to "several newsrooms are covering this" once per cloud it appears
    // in, not once for the story as a whole.
    const groups = await Promise.all([
      article({ published: "2026-08-17T11:00:00.000Z", domain: "a.com", language: "en" }),
      article({ published: "2026-08-17T10:45:00.000Z", domain: "d.com", language: "en" }),
      article({ published: "2026-08-17T10:00:00.000Z", domain: "b.com", language: "de" }),
      article({ published: "2026-08-17T09:00:00.000Z", domain: "c.com", language: "de" }),
    ]);
    const created = await createProvisionalStoryline(harness.db, {
      groupId: groups[0]!,
      timeZone: ZONE,
    });
    for (const groupId of groups.slice(1)) {
      await attachGroup(harness.db, { storylineId: created.id, groupId, timeZone: ZONE });
    }
    await promoteStoryline(harness.db, { storylineId: created.id });
    await setStorylineLabel(harness.db, {
      storylineId: created.id,
      label: "Bilingual Arc",
      labelWords: ["bilingual", "arc"],
      labelAt: NOW,
      labelGroupCount: 4,
      labelSource: "test",
    });

    const german = await readTrendingStorylines(harness.db, {
      language: "de",
      ...WINDOW,
      halfLifeHours: HALF_LIFE_HOURS,
      limit: 50,
    });
    expect(german).toHaveLength(1);
    expect(german[0]!.windowArticles).toBe(2);
    expect(german[0]!.windowSources).toBe(2); // b.com and c.com — the German half
    expect(german[0]!.lastUpdated.toISOString()).toBe("2026-08-17T10:00:00.000Z");
    // The arc's own size and breadth are language-blind: they describe the story.
    expect(german[0]!.size).toBe(4);
    expect(german[0]!.sourceCount).toBe(4);

    const english = await read();
    expect(english[0]!.windowArticles).toBe(2);
    expect(english[0]!.windowSources).toBe(2); // a.com and d.com — the English half
    expect(english[0]!.size).toBe(4);
  });

  it("counts only what the DISCOVERY plane saw, and still reports the whole arc", async () => {
    // The load-bearing rule of the discovery/deepening design: the plane that
    // measures is the plane that is not steered. All six surfaces of the query
    // in one fixture — an arc three quarters of whose window coverage arrived
    // from a plane the cloud itself would have pointed at.
    await storyline("Deepened Arc", [
      { published: "2026-08-17T08:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "b.com" },
      { published: "2026-08-17T10:00:00.000Z", domain: "x.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:00:00.000Z", domain: "y.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      // Newer than every Currents article, and from a fourth outlet: the two
      // steering channels a volume-only fix would leave wide open.
      { published: "2026-08-17T11:45:00.000Z", domain: "z.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      // Outside the window, so it reaches the arc figures and nothing else.
      { published: "2026-08-10T09:00:00.000Z", domain: "c.com" },
    ]);

    const [only] = await read();
    // (1) volume and (2) window breadth: the two Currents articles, and the two
    // outlets that filed them. Not 5 and not 5.
    expect(only!.windowArticles).toBe(2);
    expect(only!.windowSources).toBe(2);
    // (6) recency: the newest CURRENTS article, not the newest article. Without
    // this the arc re-ranks on a deepening article's timestamp alone, and the
    // browser paints it the colour of something that just moved.
    expect(only!.lastUpdated.toISOString()).toBe("2026-08-17T09:00:00.000Z");
    // (4) and (5): the arc as the store holds it, every plane, deliberately
    // whole — six articles from six outlets is what a click on this word
    // delivers, and "N in all" is a promise about that timeline.
    expect(only!.size).toBe(6);
    expect(only!.sourceCount).toBe(6);
  });

  it("counts GNews, because a fan-out provider is not a steered one", async () => {
    // The round-1 defect, pinned. Reading the rule as "provider = currents"
    // rather than "not fetched at the cloud's instruction" discards a provider
    // that is in the discovery plane by ADR-0012's own construction: every
    // search and breadth sample fans out to GNews alongside Currents, so its
    // articles are here because a reader asked, not because a word was on the
    // board. Measured cost of getting this wrong, against production over a
    // 168h window: 412 storylines' volume moved, 411 storylines' breadth moved,
    // and 140 storylines dropped out of the cloud entirely.
    //
    // A storyline whose window coverage is entirely GNews is therefore a
    // storyline the cloud should carry, on two real newsrooms.
    await storyline("GNews Only", [
      { published: "2026-08-17T10:00:00.000Z", domain: "a.com", emissions: [{ provider: "gnews", plane: "breadth" }] },
      { published: "2026-08-17T11:00:00.000Z", domain: "b.com", emissions: [{ provider: "gnews", plane: "breadth" }] },
    ]);

    const [only] = await read();
    expect(only!.label).toBe("GNews Only");
    expect(only!.windowArticles).toBe(2);
    expect(only!.windowSources).toBe(2);
    expect(only!.lastUpdated.toISOString()).toBe("2026-08-17T11:00:00.000Z");
  });

  it("refuses a storyline the discovery plane did not see inside the window", async () => {
    // (3), and the sharpest of the six: Google News answers a label with 20–82
    // domains, so a two-newsroom bar is not a bar at all on an arc it touched.
    // Two deepening-plane outlets clear the arithmetic and must still fail —
    // there is no evidence here that several newsrooms are covering this now,
    // only evidence that we went and fetched it.
    await storyline("Fetched, Not Covered", [
      { published: "2026-08-17T10:00:00.000Z", domain: "x.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:00:00.000Z", domain: "y.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
    ]);
    await storyline("Genuinely Covered", [
      { published: "2026-08-17T07:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T07:30:00.000Z", domain: "b.com" },
    ]);

    expect((await read()).map((s) => s.label)).toEqual(["Genuinely Covered"]);
  });

  it("does not let fetched volume outrank an arc the discovery plane covered", async () => {
    // The feedback loop, as a ranking. Unguarded, "Fetched Hard" scores
    // 8 * 0.5^(10min/8h) = 7.9 against 4 * 0.5^(1.5/8) = 3.5 and leads the
    // board — which is the rich-get-richer step: it leads because it was
    // fetched, and leading is what gets it fetched again. Counting only what
    // Currents saw leaves it 2 * 0.5^(5.5/8) = 1.2, behind on both terms.
    await storyline("Fetched Hard", [
      { published: "2026-08-17T06:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T06:30:00.000Z", domain: "b.com" },
      { published: "2026-08-17T11:00:00.000Z", domain: "p.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:10:00.000Z", domain: "q.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:20:00.000Z", domain: "r.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:30:00.000Z", domain: "s.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:40:00.000Z", domain: "t.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
      { published: "2026-08-17T11:50:00.000Z", domain: "u.com", emissions: [{ provider: DEEPENING_PROVIDER, plane: "deepening" }] },
    ]);
    await storyline("Actually Covered", [
      { published: "2026-08-17T07:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T08:00:00.000Z", domain: "b.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "c.com" },
      { published: "2026-08-17T10:30:00.000Z", domain: "d.com" },
    ]);

    expect((await read()).map((s) => s.label)).toEqual(["Actually Covered", "Fetched Hard"]);
  });

  it("counts an article an unsteered fetch saw SECOND, not first", async () => {
    // The nameable case that decides between the two implementations. The cheap
    // predicate is a column on `articles`, no join — but migration 0013 defines
    // `articles.provider` as the provider of the EARLIEST sighting, and any
    // denormalized plane would have to follow the same rule. For an article the
    // deepening plane reported first and a reader's search reported later that
    // column says "deepening" about an article a reader plainly asked for, and
    // drops it from a count it belongs in.
    //
    // No row in the store can be in this state yet: nothing has written a plane
    // at all. The ORDERING is not hypothetical though — the dev archive holds 33
    // articles one provider reported first and another also saw — so this
    // becomes a live defect on the day the deepening plane ingests, which is
    // exactly when nobody will be looking at it.
    await storyline("Seen Second", [
      {
        published: "2026-08-17T11:00:00.000Z",
        domain: "a.com",
        emissions: [
          { provider: DEEPENING_PROVIDER, plane: "deepening" },
          { provider: "currents", plane: "search" },
        ],
      },
      { published: "2026-08-17T10:00:00.000Z", domain: "b.com" },
    ]);

    // The article really does carry the deepening provider in that column, and
    // its earliest sighting really is the deepening one — so this pins the
    // distinction rather than merely exercising a code path that happens to
    // agree.
    const earliest = await harness.db
      .selectFrom("articles")
      .select(["provider", "source_domain"])
      .where("source_domain", "=", "a.com")
      .executeTakeFirstOrThrow();
    expect(earliest.provider).toBe(DEEPENING_PROVIDER);

    const [only] = await read();
    expect(only!.label).toBe("Seen Second");
    expect(only!.windowArticles).toBe(2);
    expect(only!.windowSources).toBe(2);
    expect(only!.lastUpdated.toISOString()).toBe("2026-08-17T11:00:00.000Z");
  });

  it("counts a sighting with NO plane, because that is the whole archive", async () => {
    // The trap `is distinct from` exists for, pinned at the smallest scale.
    // Every sighting written before migration 0022 carries `plane = NULL`,
    // because no single value describes history and the migration refused to
    // invent one. Under a bare `plane <> \'deepening\'` the comparison is NULL,
    // a NULL predicate filters the row out, and the cloud is EMPTY — measured
    // on a clone of the dev archive over a 168h window, 0 storylines against
    // 136 under the shipped form, which is also byte-identical to what the
    // provider list returned.
    //
    // Two rows for one article, and the mix is deliberate: history plus a
    // deepening sighting is the state every arc that existed before this phase
    // enters the moment it is first deepened. It must still count.
    await storyline("Pre-Plane Arc", [
      { published: "2026-08-17T10:00:00.000Z", domain: "a.com", emissions: [{ plane: null }] },
      {
        published: "2026-08-17T11:00:00.000Z",
        domain: "b.com",
        emissions: [
          { plane: null },
          { provider: DEEPENING_PROVIDER, plane: "deepening" },
        ],
      },
    ]);

    const [only] = await read();
    expect(only!.label).toBe("Pre-Plane Arc");
    expect(only!.windowArticles).toBe(2);
    expect(only!.windowSources).toBe(2);
  });

  it("honours the limit, keeping the top of the ranking", async () => {
    for (const hour of ["06", "07", "08"]) {
      await storyline(`Arc ${hour}`, [
        { published: `2026-08-17T${hour}:00:00.000Z`, domain: "a.com" },
        { published: `2026-08-17T${hour}:30:00.000Z`, domain: "b.com" },
      ]);
    }

    const top = await readTrendingStorylines(harness.db, {
      language: "en",
      ...WINDOW,
      halfLifeHours: HALF_LIFE_HOURS,
      limit: 2,
    });
    // Equal volume, so the decay alone separates them and the limit is still a
    // prefix of the one ranking every other caller sees (§10.4).
    expect(top.map((s) => s.label)).toEqual(["Arc 08", "Arc 07"]);
  });
});
