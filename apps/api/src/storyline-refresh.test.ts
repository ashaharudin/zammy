import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  mergeStorylines,
  promoteStoryline,
  readTopic,
  recordCoverage,
  setStorylineLabel,
  upsertTopic,
} from "@zammy/storage";
import { canonicalize, WINDOW_SNAP_MS, type CanonicalizeResult } from "./canonical.js";
import { groupCreatedArticles } from "./grouping-service.js";
import { ingestJobId } from "./ingest-queue.js";
import { labelWords } from "./storyline-label-merge.js";
import { queueStorylineRefresh } from "./timeline-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * Opening a storyline queues one background top-up of what its own coverage
 * says (ADR-0017) — the demand-driven contribution ADR-0016 gave up when a
 * cloud word stopped running a search.
 *
 * Nothing here spends an upstream call, and that is half the contract: the
 * counting client's `searchCalls` is asserted at zero throughout, because the
 * caller is a fire-and-forget POST beside a route transition and a reader must
 * never wait on it. The other half is that a click enqueues AT MOST ONE job and
 * that two clicks a moment apart enqueue the same one.
 *
 * Storyline state is built with the storage primitives directly rather than by
 * running the linker, the same choice `storyline-timeline.test.ts` makes and for
 * the same reason: what is under test is the plan, and a membership arranged by
 * hand is one whose expected job can be written down.
 */

/**
 * Deliberately OFF the 15-minute grid, so the snap that keeps a job's content
 * address stable is visible rather than incidental. A grid-aligned clock would
 * let the snapping be deleted with every test still green.
 */
const NOW = new Date("2026-08-10T12:07:30.000Z");
const GRID = new Date(Math.floor(NOW.getTime() / WINDOW_SNAP_MS) * WINDOW_SNAP_MS);
const TZ = { timeZone: "UTC" };

/** The shipped grouping config with the linker off — membership is set by hand. */
function linkerOff(): TestHarness["deps"]["config"]["grouping"] {
  return {
    enabled: true,
    threshold: 0.5,
    timeZone: "UTC",
    linker: {
      enabled: false,
      rules: {
        anchorMaxShare: 0.002,
        anchorDfFloor: 10,
        massThreshold: 20,
        dormancyDays: 90,
        dormantStrictness: 1.5,
      },
      mergeBridges: 2,
      coherenceGate: false,
      narrowRetrieval: false,
      maxBridgingQualifiers: undefined,
      storyDf: { windowDays: 14, timeZone: "UTC" },
      timeZone: "UTC",
    },
  };
}

let harness: TestHarness;
let db: TestHarness["deps"]["db"];

beforeAll(async () => {
  harness = await createTestHarness({ grouping: linkerOff() }, NOW);
  db = harness.deps.db;
});

afterAll(async () => {
  await harness.teardown();
});

beforeEach(async () => {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             articles, topic_articles, topic_coverage, topics, sightings cascade
  `.execute(db);
});

let uuid = 0;
function sighting(input: {
  domain: string;
  title: string;
  published: string;
  language?: string | null;
}): Sighting {
  uuid += 1;
  const url = `https://${input.domain}/${uuid}`;
  return {
    id: `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    title: input.title,
    description: null,
    author: null,
    imageUrl: null,
    language: input.language === undefined ? "en" : input.language,
    categories: [],
    sourceCategories: [],
    sourceDomain: input.domain,
    published: input.published,
    raw: {},
  };
}

const MONDAY = "2026-08-10T09:00:00.000Z";

/**
 * One promoted, labelled storyline over two groups — the shape a reader can
 * actually click. Returns its UUID.
 */
async function seedStoryline(
  options: { label?: string | null; language?: string | null } = {},
): Promise<string> {
  const fingerprint = randomBytes(32).toString("hex");
  await upsertTopic(db, { fingerprint, keywords: ["seed"], language: "en" });
  const ingested = await ingestSightings(db, {
    ...TZ,
    fingerprint,
    sightings: [
      sighting({
        domain: "a.example",
        title: "Hurricane Fausto nears Hawaii",
        published: MONDAY,
        ...(options.language !== undefined ? { language: options.language } : {}),
      }),
      sighting({
        domain: "b.example",
        title: "Fausto strengthens off Hawaii coast",
        published: MONDAY,
        ...(options.language !== undefined ? { language: options.language } : {}),
      }),
    ],
  });
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
  for (const groupId of groups.slice(1)) {
    await attachGroup(db, { storylineId: storyline.id, groupId, ...TZ });
  }
  await promoteStoryline(db, { storylineId: storyline.id });
  const label = options.label === undefined ? "Hurricane Fausto Hawaii Landfall" : options.label;
  if (label !== null) {
    await setStorylineLabel(db, {
      storylineId: storyline.id,
      label,
      labelWords: labelWords(label),
      labelAt: NOW,
      labelGroupCount: groups.length,
      labelSource: "test",
    });
  }
  return storyline.id;
}

/**
 * The route's own canonicalizer, minus the reference lookup: every language the
 * suite uses is declared here, so a canonicalize failure is a real one rather
 * than a fixture's language table changing under the test.
 */
function canonicalizer(
  now: Date = NOW,
): (input: { keywords: string; language: string | undefined }) => CanonicalizeResult {
  return ({ keywords, language }) =>
    canonicalize(
      { q: keywords, language },
      {
        reference: {
          languages: new Set(["en", "ms"]),
          regions: new Set(),
          categories: new Set(),
        },
        defaultLanguage: "en",
        lookbackDays: 30,
        now,
      },
    );
}

function refresh(storylineId: string, now: Date = NOW) {
  const deps = now === NOW ? harness.deps : { ...harness.deps, now: () => now };
  return queueStorylineRefresh(deps, { storylineId, canonicalize: canonicalizer(now) });
}

describe("what a click asks for", () => {
  it("asks upstream for the label's words that the arc's own coverage says", async () => {
    const storylineId = await seedStoryline();

    const outcome = await refresh(storylineId);

    // "Hurricane Fausto Hawaii Landfall" grounded against the profile and
    // capped at two (`cloudQuery`, ADR-0014) — label order, so the naming words
    // win and "landfall" (which the headlines do not say) never enters.
    expect(outcome.status).toBe("queued");
    if (outcome.status !== "queued") return;
    expect(outcome.keywords).toEqual(["fausto", "hurricane"]); // canonical form: sorted
    expect(outcome.storylineId).toBe(storylineId);
  });

  it("mints the topic, so the consumer can recover what the fingerprint means", async () => {
    const storylineId = await seedStoryline();

    const outcome = await refresh(storylineId);
    if (outcome.status !== "queued") throw new Error(outcome.status);

    // §9.1: a queued segment carries only the fingerprint.
    const topic = await readTopic(db, outcome.fingerprint);
    expect(topic?.keywords).toEqual(["fausto", "hurricane"]);
    expect(topic?.language).toBe("en");
  });

  it("takes the language from the arc's articles, not from a default", async () => {
    const storylineId = await seedStoryline({ language: "ms" });

    const outcome = await refresh(storylineId);
    if (outcome.status !== "queued") throw new Error(outcome.status);

    // The cloud is English-only (§10.1), so the reader's own chip cannot be
    // trusted to name the arc's language; the coverage can.
    const topic = await readTopic(db, outcome.fingerprint);
    expect(topic?.language).toBe("ms");
  });

  it("falls back to the configured default when the coverage names no language", async () => {
    const storylineId = await seedStoryline({ language: null });

    const outcome = await refresh(storylineId);
    if (outcome.status !== "queued") throw new Error(outcome.status);

    const topic = await readTopic(db, outcome.fingerprint);
    expect(topic?.language).toBe("en");
  });

  it("searches the profile's own tokens for a storyline whose labelling failed", async () => {
    // Label-less is renderable (ADR-0011) and therefore clickable, so it must
    // be refreshable — otherwise exactly the arcs whose labelling failed are
    // the ones left to go stale.
    const storylineId = await seedStoryline({ label: null });

    const outcome = await refresh(storylineId);
    if (outcome.status !== "queued") throw new Error(outcome.status);
    expect(outcome.keywords.length).toBe(2);
    expect(outcome.keywords.every((word) => word.length > 0)).toBe(true);
  });

  it("never spends an upstream call on the request path", async () => {
    const storylineId = await seedStoryline();

    await refresh(storylineId);

    // The whole point of queueing: the click is a route transition, not a wait.
    expect(harness.counting.searchCalls).toBe(0);
  });
});

describe("how much a click may queue", () => {
  it("queues the newest gap slice and nothing else for a cold topic", async () => {
    const storylineId = await seedStoryline();

    const outcome = await refresh(storylineId);
    if (outcome.status !== "queued") throw new Error(outcome.status);

    // §9.4's "backfill is never automatic", applied to a click: 30 days of
    // missing history is worth one 7-day slice of freshness, not five calls.
    expect(outcome.job.kind).toBeUndefined();
    expect(new Date(outcome.job.to).getTime()).toBe(GRID.getTime());
    expect(new Date(outcome.job.from).getTime()).toBe(GRID.getTime() - 7 * 86_400_000);
    expect(await harness.queue.pendingCount(outcome.fingerprint)).toBe(1);
  });

  it("two clicks a moment apart are one job: the plan is made on the grid", async () => {
    const storylineId = await seedStoryline();

    const first = await refresh(storylineId);
    // Ten seconds later, still inside the same quarter-hour. Against the live
    // clock every endpoint would have moved by 10s and this would be a second
    // job — a second upstream call — for the same ask.
    const second = await refresh(storylineId, new Date(NOW.getTime() + 10_000));

    if (first.status !== "queued" || second.status !== "queued") throw new Error("not queued");
    expect(ingestJobId(second.job)).toBe(ingestJobId(first.job));
    expect(await harness.queue.pendingCount(first.fingerprint)).toBe(1);
  });

  it("queues nothing while the trailing edge is inside the staleness tier", async () => {
    const storylineId = await seedStoryline();
    const cold = await refresh(storylineId);
    if (cold.status !== "queued") throw new Error(cold.status);

    // Coverage to 30s ago: a live window's tier is 60s (`freshnessTtlMs`), so
    // the arc is fresh and a second reader's click costs one Redis read.
    await recordCoverage(db, cold.fingerprint, {
      from: new Date(NOW.getTime() - 31 * 86_400_000),
      to: new Date(NOW.getTime() - 30_000),
    });

    const outcome = await refresh(storylineId);

    expect(outcome.status).toBe("fresh");
    expect(harness.counting.searchCalls).toBe(0);
  });

  it("queues a leading-edge top-up once the trailing edge goes stale", async () => {
    const storylineId = await seedStoryline();
    const cold = await refresh(storylineId);
    if (cold.status !== "queued") throw new Error(cold.status);
    const coverageUpper = new Date(NOW.getTime() - 5 * 60_000);
    await recordCoverage(db, cold.fingerprint, {
      from: new Date(NOW.getTime() - 31 * 86_400_000),
      to: coverageUpper,
    });

    const outcome = await refresh(storylineId);
    if (outcome.status !== "queued") throw new Error(outcome.status);

    // A top-up, not a segment: its identity omits the upper edge, so a click a
    // minute later asks for the same thing (§6.4).
    expect(outcome.job.kind).toBe("topup");
    expect(new Date(outcome.job.from).getTime()).toBe(coverageUpper.getTime());
    const later = await refresh(storylineId, new Date(NOW.getTime() + 60_000));
    if (later.status !== "queued") throw new Error(later.status);
    expect(ingestJobId(later.job)).toBe(ingestJobId(outcome.job));
  });
});

describe("a UUID that is not the arc it names", () => {
  it("follows the alias chain to the survivor", async () => {
    const storylineId = await seedStoryline();
    const loser = await seedStoryline({ label: "Unrelated Arc" });
    // The loser keeps its UUID as an alias (ADR-0011), and every page rendered
    // before the merge still holds it.
    await mergeStorylines(db, { winnerId: storylineId, loserId: loser, ...TZ });

    const outcome = await refresh(loser);

    if (outcome.status === "unknown") throw new Error("alias not followed");
    expect(outcome.storylineId).toBe(storylineId);
  });

  it("reports a UUID this database has never held", async () => {
    expect((await refresh(randomUUID())).status).toBe("unknown");
  });
});
