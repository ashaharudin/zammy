import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  deriveAltKey,
  deriveDedupKey,
  emptyStats,
  type NewsClient,
  type SearchParams,
  type QuotaView,
  type SearchResult,
  type Sighting,
} from "@zammy/news-client";
import {
  attachGroup,
  ingestSightings,
  readStorylineCoverage,
  readTrendingStorylines,
  promoteStoryline,
  createProvisionalStoryline,
  setStorylineLabel,
  upsertTopic,
  type TrendingStoryline,
} from "@zammy/storage";
import { WINDOW_SNAP_MS } from "./canonical.js";
import { groupCreatedArticles } from "./grouping-service.js";
import { ingestJobId } from "./ingest-queue.js";
import { labelWords } from "./storyline-label-merge.js";
import { processDeepenJob, queueStorylineDeepening } from "./timeline-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The deepening plane, end to end (ADR-0019, plan §G5): a click on a storyline
 * fetches for THAT ARC, what comes back joins it by provenance, no storyline is
 * formed, and the cloud that chose the arc does not move.
 *
 * Those four are the phase's "done when", and the third is the one worth
 * insisting on with real rows rather than reasoning: G2 landed the ranker
 * isolation while it was a no-op, and this is the first place in the codebase
 * where it is not one. A test that only asserted the plane column would pass on
 * a predicate that excluded nothing.
 *
 * The deepening provider is a STUB rather than the fixture Google News client,
 * and the choice is about what is under test. `FixtureGoogleNewsClient` replays
 * two captured feeds whose items are fixed in subject and in time; what this
 * file needs is control over the three things the planner reacts to — which
 * articles came back, whether the page was truncated, and how many calls were
 * spent. The adapter's own behaviour is covered where it lives
 * (`packages/google-news-client`), and this stub deliberately reproduces the two
 * properties of it the planner depends on: `isLastPage` is `rawCount < 100`, and
 * the sightings carry a publisher `sourceDomain` rather than `news.google.com`.
 */

/** Off the 15-minute grid, so a snapped span is visible rather than incidental. */
const NOW = new Date("2026-08-10T12:07:30.000Z");
const GRID = new Date(Math.floor(NOW.getTime() / WINDOW_SNAP_MS) * WINDOW_SNAP_MS);
const TZ = { timeZone: "UTC" };
const DEEPEN_SPAN_MS = 7 * 86_400_000;

/** The provider id the real adapter reports, so coverage rows are keyed as they will be. */
const DEEPENING_PROVIDER = "google-news";

let uuid = 0;

function sighting(input: {
  domain: string;
  title: string;
  published: string;
  provider?: string;
  /** Google News writes the outlet's DISPLAY name into the title; Currents does not. */
  displayName?: string;
  /** ADR-0021's two claims, which only the deepening provider ever makes. */
  isAggregatorCopy?: boolean;
  publishedIsDateOnly?: boolean;
}): Sighting {
  uuid += 1;
  const url = `https://${input.domain}/${uuid}`;
  const title = input.displayName ? `${input.title} - ${input.displayName}` : input.title;
  return {
    id: `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
    url,
    provider: input.provider ?? "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(input.domain, title, input.published),
    title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: input.domain,
    ...(input.isAggregatorCopy === undefined
      ? {}
      : { isAggregatorCopy: input.isAggregatorCopy }),
    ...(input.publishedIsDateOnly === undefined
      ? {}
      : { publishedIsDateOnly: input.publishedIsDateOnly }),
    published: input.published,
    raw: {},
  };
}

/**
 * A deepening provider whose answers a test dictates.
 *
 * `queries` is the assertion surface that matters most: the plan's first bullet
 * is that this plane sends the FULL LABEL rather than `cloudQuery`'s grounded
 * pair, and the only place that is observable is what reaches `search`.
 */
class StubDeepeningClient implements NewsClient {
  readonly provider = DEEPENING_PROVIDER;
  readonly coverageProvider = DEEPENING_PROVIDER;
  readonly limits = {
    maxPageSize: 100,
    maxRetrievableResults: 100,
    maxLookbackDays: 730,
    maxRangeDays: 730,
  };
  readonly queries: SearchParams[] = [];
  /** What the next call returns. Replaced per test. */
  next: Sighting[] = [];
  /** Raw count upstream reported, which is what decides `isLastPage`. */
  nextRawCount: number | null = null;

  async search(params: SearchParams): Promise<SearchResult> {
    this.queries.push(params);
    const rawCount = this.nextRawCount ?? this.next.length;
    return {
      sightings: this.next,
      requestedAt: new Date(),
      rawCount,
      // The adapter's own rule: 100 items means the cap truncated the window,
      // and there is no page 2 to ask for.
      isLastPage: rawCount < 100,
      pageSize: 100,
      normalization: { ...emptyStats(), received: rawCount, kept: this.next.length },
      quota: null,
      adjustments: [],
    };
  }

  async quota(): Promise<QuotaView> {
    return {
      dailyRemaining: Number.POSITIVE_INFINITY,
      burstRemaining: Number.POSITIVE_INFINITY,
      resetAt: null,
      // Null forever, and not a stub's shortcut: this provider sends no
      // rate-limit header at all, so the real client reports the same.
      observed: null,
    };
  }

  async close(): Promise<void> {}
}

let harness: TestHarness;
let db: TestHarness["deps"]["db"];
let stub: StubDeepeningClient;

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
             storyline_coverage, articles, topic_articles, topic_coverage,
             topics, sightings cascade
  `.execute(db);
  stub = new StubDeepeningClient();
  harness.deps.deepening = stub;
});

/**
 * One promoted, labelled arc a reader can click, over two Currents articles
 * whose headline words the label is drawn from — so the confidence gate passes
 * for the reason it exists, rather than by luck.
 */
async function seedArc(label = "Hurricane Fausto Hawaii"): Promise<string> {
  const fingerprint = randomBytes(32).toString("hex");
  await upsertTopic(db, { fingerprint, keywords: ["seed"], language: "en" });
  const ingested = await ingestSightings(db, {
    plane: "search",
    ...TZ,
    fingerprint,
    sightings: [
      sighting({
        domain: "a.example",
        title: "Hurricane Fausto nears Hawaii",
        published: "2026-08-10T09:00:00.000Z",
      }),
      sighting({
        domain: "b.example",
        title: "Hawaii braces as Hurricane Fausto approaches",
        published: "2026-08-10T09:30:00.000Z",
      }),
    ],
  });
  expect(ingested.createdArticles).toHaveLength(2);
  // Grouping, because `story_tokens` are written here and `profile_tokens` are
  // derived from them — and the confidence gate reads the profile. A hand-set
  // profile would let the gate pass on a vocabulary no tokenizer produced.
  await groupCreatedArticles(
    { db, config: harness.deps.config.grouping },
    ingested.createdArticles,
  );

  const rows = await db
    .selectFrom("articles")
    .select("group_id")
    .distinct()
    .orderBy("group_id", "asc")
    .execute();
  const groups = rows.map((row) => row.group_id);
  const storyline = await createProvisionalStoryline(db, { groupId: groups[0]!, ...TZ });
  // Both groups, so the arc has the two distinct newsrooms the cloud's gate
  // wants and the reads below are about the deepening plane rather than about
  // `MIN_SOURCE_DOMAINS`. `attachGroup` is what re-derives the profile.
  for (const groupId of groups.slice(1)) {
    await attachGroup(db, { storylineId: storyline.id, groupId, ...TZ });
  }
  await promoteStoryline(db, { storylineId: storyline.id });
  await setStorylineLabel(db, {
    storylineId: storyline.id,
    label,
    labelWords: labelWords(label),
    labelAt: NOW,
    labelGroupCount: groups.length,
    labelSource: "test",
  });
  return storyline.id;
}

const cloud = async (): Promise<TrendingStoryline[]> =>
  readTrendingStorylines(db, {
    language: "en",
    from: new Date(NOW.getTime() - 24 * 3_600_000),
    to: NOW,
    halfLifeHours: 8,
    limit: 50,
  });

describe("a click deepens the arc it opened", () => {
  it("plans one grid-snapped span against the arc's own coverage", async () => {
    const storylineId = await seedArc();

    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });

    expect(outcome.status).toBe("queued");
    if (outcome.status !== "queued") throw new Error("unreachable");
    // The FULL LABEL, not `cloudQuery`'s grounded pair. Probed live 2026-08-27:
    // a four-word label returned 100 items over 63 domains against the pair's
    // 92 over 55, because this provider does not AND terms against body text.
    expect(outcome.keywords).toBe("Hurricane Fausto Hawaii");
    // Snapped at BOTH edges, so a quarter-hour of clicks is one job rather than
    // one job per click — `ingestJobId` derives the address from these exact
    // endpoints.
    expect(outcome.job.to).toBe(GRID.toISOString());
    expect(outcome.job.from).toBe(new Date(GRID.getTime() - DEEPEN_SPAN_MS).toISOString());
    // Nothing is fetched on the request path. A click must not wait on
    // ingestion it is not going to be shown.
    expect(stub.queries).toHaveLength(0);
  });

  it("gives two clicks a quarter-hour apart the same job", async () => {
    const storylineId = await seedArc();
    const first = await queueStorylineDeepening(harness.deps, { storylineId });
    // Inside the same quarter-hour: NOW is 12:07:30 and the next grid line is
    // 12:15:00, so a minute later is the same snapped span. Advancing past the
    // line would mint a different job, which is correct and is what the snap
    // BOUNDS rather than eliminates.
    harness.clock.advance(60_000);
    const second = await queueStorylineDeepening(harness.deps, { storylineId });
    harness.clock.advance(-60_000);

    if (first.status !== "queued" || second.status !== "queued") {
      throw new Error(`expected two queued outcomes, got ${first.status}/${second.status}`);
    }
    expect(ingestJobId(second.job)).toBe(ingestJobId(first.job));
  });

  it("sends the label, ingests on the deepening plane, and records the span", async () => {
    const storylineId = await seedArc();
    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });
    if (outcome.status !== "queued") throw new Error(`expected queued, got ${outcome.status}`);

    stub.next = [
      sighting({
        domain: "c.example",
        title: "Fausto strengthens to category four",
        published: "2026-08-10T10:00:00.000Z",
        provider: DEEPENING_PROVIDER,
        displayName: "The C Example",
      }),
    ];

    await processDeepenJob(harness.deps, outcome.job);

    // One call, carrying the label verbatim and unsplit — word order is part of
    // a phrase query, and the topic identity's sorted keyword set is a different
    // string that cannot stand in for it.
    expect(stub.queries).toHaveLength(1);
    expect(stub.queries[0]!.keywords).toEqual(["Hurricane Fausto Hawaii"]);
    expect(stub.queries[0]!.startDate?.toISOString()).toBe(outcome.job.from);

    const sightings = await db
      .selectFrom("sightings")
      .select(["plane", "provider"])
      .where("provider", "=", DEEPENING_PROVIDER)
      .execute();
    expect(sightings).toEqual([{ plane: "deepening", provider: DEEPENING_PROVIDER }]);

    // Coverage against the ARC and this PROVIDER, not against a topic.
    const covered = await readStorylineCoverage(db, storylineId, DEEPENING_PROVIDER);
    expect(covered).toHaveLength(1);
    expect(covered[0]!.from.toISOString()).toBe(outcome.job.from);
    expect(covered[0]!.to.toISOString()).toBe(outcome.job.to);
    // And nothing at all in `topic_coverage`: a deepening fetch has no topic
    // span to claim, which is the whole of what the repoint moved.
    const topicCoverage = await sql<{ n: string }>`select count(*) as n from topic_coverage`.execute(db);
    expect(Number(topicCoverage.rows[0]!.n)).toBe(0);
  });

  it("attaches what it fetched to the arc that fetched it, and forms no storyline", async () => {
    const storylineId = await seedArc();
    const before = await sql<{ n: string }>`select count(*) as n from storylines`.execute(db);

    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });
    if (outcome.status !== "queued") throw new Error(`expected queued, got ${outcome.status}`);
    stub.next = [
      sighting({
        domain: "c.example",
        title: "Fausto strengthens to category four",
        published: "2026-08-10T10:00:00.000Z",
        provider: DEEPENING_PROVIDER,
      }),
      sighting({
        domain: "d.example",
        title: "Shelters open across Maui and Oahu",
        published: "2026-08-10T10:30:00.000Z",
        provider: DEEPENING_PROVIDER,
      }),
    ];
    await processDeepenJob(harness.deps, outcome.job);

    // **The hard constraint.** Left on the ordinary path each of these seeds a
    // group, the linker births a provisional storyline for it, and a second
    // group promotes one — which is how 100 items per arc becomes an arc
    // inventory nobody asked for and a labelling queue behind it.
    const after = await sql<{ n: string }>`select count(*) as n from storylines`.execute(db);
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));

    // And they are IN the arc that fetched them, by provenance rather than by
    // the linker's judgement.
    const members = await sql<{ title: string }>`
      select a.title from storyline_groups sg
        join articles a on a.group_id = sg.group_id
       where sg.storyline_id = ${storylineId}
       order by a.title
    `.execute(db);
    expect(members.rows.map((row) => row.title)).toContain("Fausto strengthens to category four");
    expect(members.rows.map((row) => row.title)).toContain("Shelters open across Maui and Oahu");
  });

  it("leaves the cloud that chose the arc exactly where it was", async () => {
    // G2's isolation, under real conditions rather than as a no-op — the phase's
    // own "done when", and the first time in this codebase the predicate
    // excludes a row that exists.
    const storylineId = await seedArc();
    const before = await cloud();
    expect(before).toHaveLength(1);

    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });
    if (outcome.status !== "queued") throw new Error(`expected queued, got ${outcome.status}`);
    stub.next = [
      // Six outlets and every one of them NEWER than the arc's own coverage:
      // the two channels a volume-only fix leaves open are breadth and recency,
      // and both are aimed at here.
      ...["c", "d", "e", "f", "g", "h"].map((letter, index) =>
        sighting({
          domain: `${letter}.example`,
          title: `Fausto update ${letter}`,
          published: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
          provider: DEEPENING_PROVIDER,
        }),
      ),
    ];
    await processDeepenJob(harness.deps, outcome.job);

    const after = await cloud();

    // Every number the ranking reads is untouched: volume, breadth, and the
    // recency that drives both the decay and the colour channel. Six newer
    // articles from six outlets went in and moved none of them.
    expect(after).toHaveLength(1);
    expect(after[0]!.windowArticles).toBe(before[0]!.windowArticles);
    expect(after[0]!.windowSources).toBe(before[0]!.windowSources);
    expect(after[0]!.lastUpdated).toEqual(before[0]!.lastUpdated);
    expect(after[0]!.windowArticles).toBe(2);
    expect(after[0]!.windowSources).toBe(2);

    // Not vacuous: the articles really are in the arc, and they really are
    // newer than everything the ranking counted.
    const arcSize = await sql<{ n: string }>`
      select count(distinct a.id) as n from storyline_groups sg
        join articles a on a.group_id = sg.group_id
       where sg.storyline_id = ${storylineId}
    `.execute(db);
    expect(Number(arcSize.rows[0]!.n)).toBe(8);

    // And `size` DID move, from 2 to 8, which is the honest half of
    // `trending-storylines.ts`'s split: the ranking is discovery-plane only,
    // but "N in all" is a promise about what a click delivers and the timeline
    // holds every plane. A version of this test that asserted the whole row
    // unchanged would be asserting a bug.
    expect(before[0]!.size).toBe(2);
    expect(after[0]!.size).toBe(8);
    expect(after[0]!.sourceCount).toBe(8);
  });
});

describe("the stamp-quality counter, which is the only alarm on a silent detector", () => {
  it("labels a fetch's items by whether the provider timed them", async () => {
    // ADR-0021's enforcement story rests on this counter and on the log line
    // beside it, because NOTHING can force an adapter to set
    // `publishedIsDateOnly` — `finalizeSighting` takes an `unknown` — and a
    // provider that changed its convention would simply stop matching, silently.
    // So the mapping from the flag to the label is asserted rather than assumed.
    const storylineId = await seedArc();
    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });
    if (outcome.status !== "queued") throw new Error(`expected queued, got ${outcome.status}`);

    stub.next = [
      sighting({
        domain: "d.example",
        title: "Dated by the provider, not timed",
        published: "2026-08-10T07:00:00.000Z",
        provider: DEEPENING_PROVIDER,
        isAggregatorCopy: true,
        publishedIsDateOnly: true,
      }),
      sighting({
        domain: "e.example",
        title: "Timed properly",
        published: "2026-08-10T11:41:03.000Z",
        provider: DEEPENING_PROVIDER,
        isAggregatorCopy: true,
      }),
    ];

    // Deltas, not absolutes: the registry is per-harness but this file drives
    // several fetches through it, so a total would encode test order.
    const stamped = async (stamp: string): Promise<number> => {
      const metrics = (await harness.metrics.registry.getMetricsAsJSON()) as Array<{
        name: string;
        values: Array<{ value: number; labels: Record<string, string> }>;
      }>;
      return (
        metrics
          .find((m) => m.name === "zammy_sightings_stamped_total")
          ?.values.find(
            (v) => v.labels.provider === DEEPENING_PROVIDER && v.labels.stamp === stamp,
          )?.value ?? 0
      );
    };
    const before = { dated: await stamped("date_only"), timed: await stamped("clock") };

    await processDeepenJob(harness.deps, outcome.job);

    expect((await stamped("date_only")) - before.dated).toBe(1);
    expect((await stamped("clock")) - before.timed).toBe(1);
  });
});

describe("what the deepening plane refuses to spend on", () => {
  it("refuses an arc whose label its own coverage does not say", async () => {
    // The confidence gate. A model label that shares no word with the arc's
    // vocabulary is one we cannot state the subject of — and on this plane a
    // wrong subject is not a wasted call, it is an attachment.
    const storylineId = await seedArc("Bolivian Lithium Referendum");

    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });

    expect(outcome.status).toBe("ungrounded");
    expect(stub.queries).toHaveLength(0);
  });

  it("spends nothing at all with no deepening provider configured", async () => {
    // The shipped state: `GOOGLE_NEWS_ENABLED` is false, `createGoogleNewsClient`
    // refuses to build, and this whole path is absent rather than present and
    // throwing.
    const storylineId = await seedArc();
    delete harness.deps.deepening;

    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });

    expect(outcome.status).toBe("unavailable");
  });

  it("queues nothing while this provider's coverage of the arc is fresh", async () => {
    const storylineId = await seedArc();
    const first = await queueStorylineDeepening(harness.deps, { storylineId });
    if (first.status !== "queued") throw new Error("expected queued");
    await processDeepenJob(harness.deps, first.job);

    const second = await queueStorylineDeepening(harness.deps, { storylineId });

    expect(second.status).toBe("fresh");
    expect(stub.queries).toHaveLength(1);
  });

  it("records no coverage for a span the item cap truncated", async () => {
    // `isLastPage` is `rawCount < 100` on this provider and a FULL page means
    // the cap cut the window, not that it finished. There is no page 2 to ask
    // for, so the honest answer is to record nothing and leave the gap open —
    // recording it would mark a span fetched that was only partly seen, which is
    // the permanent silent loss `topic_coverage` is written to avoid.
    const storylineId = await seedArc();
    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });
    if (outcome.status !== "queued") throw new Error("expected queued");

    stub.nextRawCount = 100;
    stub.next = [
      sighting({
        domain: "c.example",
        title: "Fausto strengthens to category four",
        published: "2026-08-10T10:00:00.000Z",
        provider: DEEPENING_PROVIDER,
      }),
    ];
    await processDeepenJob(harness.deps, outcome.job);

    // The article is stored — a truncated page is still real coverage of the
    // world, and dropping it would waste the call.
    const stored = await db
      .selectFrom("sightings")
      .select("id")
      .where("provider", "=", DEEPENING_PROVIDER)
      .execute();
    expect(stored).toHaveLength(1);
    // The CLAIM is what is withheld.
    expect(await readStorylineCoverage(db, storylineId, DEEPENING_PROVIDER)).toEqual([]);
    // So the next click re-plans the same gap rather than treating it as done.
    expect((await queueStorylineDeepening(harness.deps, { storylineId })).status).toBe("queued");
  });

  it("drops a delivered job whose arc has since lost its grounding", async () => {
    // The label and the profile both move between enqueue and delivery — the
    // labeler runs on a dropped tail, the profile is re-derived on every attach
    // — so the gate is asked again about the arc as it stands. An arc we can no
    // longer state the subject of is one we must not attach to.
    const storylineId = await seedArc();
    const outcome = await queueStorylineDeepening(harness.deps, { storylineId });
    if (outcome.status !== "queued") throw new Error("expected queued");

    await setStorylineLabel(db, {
      storylineId,
      label: "Bolivian Lithium Referendum",
      labelWords: labelWords("Bolivian Lithium Referendum"),
      labelAt: NOW,
      labelGroupCount: 2,
      labelSource: "test",
    });

    await processDeepenJob(harness.deps, outcome.job);

    expect(stub.queries).toHaveLength(0);
    expect(await readStorylineCoverage(db, storylineId, DEEPENING_PROVIDER)).toEqual([]);
  });
});
