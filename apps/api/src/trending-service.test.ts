import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processSegmentJob } from "./timeline-service.js";
import {
  processSampleJob,
  readTrending,
  type TrendingDeps,
} from "./trending-service.js";
import { deriveDedupKey } from "@zammy/currents-client";
import { emptyStats, type SearchResult } from "@zammy/news-client";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  promoteStoryline,
  setStorylineLabel,
  upsertTopic,
} from "@zammy/storage";
import { fingerprintOf } from "./canonical.js";
import { createTestHarness, type TestHarness } from "./test-support.js";
import { labelWords } from "./storyline-label-merge.js";

/**
 * The landing-page cloud (ARCHITECTURE 10.1, post-6c): the first visitor after
 * the last /v2/latest-news snapshot staled triggers ONE background sample call
 * and is served the stored cloud instantly. The window rolls with `now` rather
 * than resetting at midnight (ADR-0008), so nothing here is keyed by day and
 * there is no frozen period to ask about.
 *
 * What the cloud NAMES is storylines (ADR-0013), and that changes what these
 * tests can assume: the sample no longer computes anything the cloud reads, so
 * a cloud can be non-empty before any sample has run, and a sample can succeed
 * while leaving the cloud empty — a page of unrelated latest-news articles is
 * forty provisional storylines-of-one, which is not a story between them.
 */

/** All 100 recorded /v2/latest-news sightings are published 2026-08-11. */
const NOW = new Date("2026-08-11T05:00:00.000Z");

/** A curated slice of the v2 taxonomy that the recorded feed actually carries. */
const CATEGORIES = [
  "economy_business_finance",
  "science_technology",
  "politics_government",
  "society",
  "sport",
  "general",
];

let harness: TestHarness;

/** Unique across a file's stores: one URL is one article, however often seeded. */
let seeded = 0;

afterEach(async () => {
  await harness.teardown();
});

function trendingDeps(h: TestHarness, overrides: Partial<TrendingDeps["trending"]> = {}): TrendingDeps {
  return {
    ...h.deps,
    trending: {
      sampleCategories: CATEGORIES,
      samplePages: 1,
      sampleRefreshMinutes: 60,
      windowHours: 24,
      halfLifeHours: 8,
      ...overrides,
    },
  };
}

/**
 * Store articles at chosen ages — the corpus source the sample does not supply
 * (§10.1 source 1), and the only way to put a story at a known distance from
 * `now`. Returns their ids, which are also their group ids: an article stored
 * this way is a group of one until grouping says otherwise.
 */
async function storeArticles(
  h: TestHarness,
  articles: Array<{ title: string; domain: string; ageHours: number }>,
): Promise<string[]> {
  const fingerprint = fingerprintOf({
    keywords: ["seeded"],
    language: "en",
    country: null,
    category: null,
  });
  await upsertTopic(h.deps.db, {
    fingerprint,
    keywords: ["seeded"],
    language: "en",
    country: null,
    category: null,
  });
  const ingested = await ingestSightings(h.deps.db, {
    timeZone: "UTC",
    fingerprint,
    sightings: articles.map((a) => {
      seeded += 1;
      const url = `https://${a.domain}/seeded-${seeded}`;
      return {
        id: randomUUID(),
        url,
        provider: "currents",
        providerSightingId: url,
        dedupKey: deriveDedupKey(url),
        title: a.title,
        description: null,
        author: null,
        imageUrl: null,
        language: "en",
        categories: [],
        sourceCategories: [],
        sourceDomain: a.domain,
        published: new Date(NOW.getTime() - a.ageHours * 3_600_000).toISOString(),
        raw: {},
      };
    }),
  });
  return ingested.createdArticles.map((a) => a.id);
}

/**
 * Hold the freshness lock, so a read elects no sample.
 *
 * The lock IS the cadence (§10.1), and a test about the CACHE needs the cloud
 * to be `complete`: an elected sample leaves a pending job, an in_progress
 * response is deliberately never cached, and the assertion would be about the
 * sampler rather than about the cache.
 */
async function holdSampleLock(h: TestHarness, language = "en"): Promise<void> {
  await h.redis.set(`${h.queue.name}:lock:sample:${language}`, "1", "PX", 600_000);
}

/**
 * A labelled, promoted storyline over stored articles.
 *
 * Built through the storage API rather than by driving the linker, for the
 * reason the storage suite does the same: what these tests are about is the
 * service — the lock, the cache, the window — and a linker that declined to
 * attach two synthetic headlines would make its token thresholds the subject.
 */
async function seedStoryline(
  h: TestHarness,
  label: string,
  articles: Array<{ title: string; domain: string; ageHours: number }>,
): Promise<string> {
  const groups = await storeArticles(h, articles);
  const created = await createProvisionalStoryline(h.deps.db, {
    groupId: groups[0]!,
    timeZone: "UTC",
  });
  for (const groupId of groups.slice(1)) {
    await attachGroup(h.deps.db, { storylineId: created.id, groupId, timeZone: "UTC" });
  }
  await promoteStoryline(h.deps.db, { storylineId: created.id });
  await setStorylineLabel(h.deps.db, {
    storylineId: created.id,
    label,
    labelWords: labelWords(label),
    labelAt: NOW,
    labelGroupCount: groups.length,
    labelSource: "test",
  });
  return created.id;
}

describe("the first visitor after the snapshot staled (§10.1)", () => {
  it("queues ONE single-call sample, serves instantly, and never blocks the reader", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    // The first visitor pays nothing synchronously — the whole §9 posture.
    const first = await readTrending(deps, { language: "en", limit: 50 });
    expect(harness.counting.searchCalls).toBe(0);
    expect(first.windowEnd).toBe(NOW.toISOString());
    expect(first.storylines).toEqual([]);
    expect(first.meta.ingest.state).toBe("in_progress");
    expect(first.meta.ingest.pendingJobs).toBe(1);

    // Visitor two hits the held lock and the deduped jobId: still one sample.
    const second = await readTrending(deps, { language: "en", limit: 50 });
    expect(second.meta.ingest.pendingJobs).toBe(1);

    harness.queue.startConsumer((job) =>
      job.kind === "sample"
        ? processSampleJob(deps, job)
        : processSegmentJob(harness.deps, job),
    );
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 250 },
    );

    const done = await readTrending(deps, { language: "en", limit: 50 });
    expect(done.meta.ingest.state).toBe("complete");

    // ONE /v2/latest-news call — not twelve category slices — as background.
    expect(harness.counting.searchCalls).toBe(1);
    expect(harness.counting.priorities).toEqual(["background"]);
  }, 30_000);

  it("caches per language, not per limit — a narrow read cannot shrink the cloud", async () => {
    // Reproduced live under the term cloud: `curl '/api/v1/trending?limit=4'`
    // cached a four-word body, and the landing page — which asks for 50 —
    // rendered a four-word cloud for the next fifteen minutes. The cache key
    // names a language, so what it holds has to be the whole list.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    await holdSampleLock(harness);
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 3 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 4 },
    ]);

    // A caller asking for one storyline still gets exactly one…
    const narrow = await readTrending(deps, { language: "en", limit: 1 });
    expect(narrow.storylines).toHaveLength(1);

    // …and the next reader gets the whole cloud, from that same cache entry.
    const wide = await readTrending(deps, { language: "en", limit: 50 });
    expect(wide.meta.servedFrom).toBe("cache");
    expect(wide.storylines).toHaveLength(2);
    // Still a prefix of one list, so the two agree about what leads.
    expect(wide.storylines[0]!.label).toBe(narrow.storylines[0]!.label);
    // And what leads is the most recently updated arc (ADR-0013).
    expect(wide.storylines.map((s) => s.label)).toEqual([
      "Truro Verdict",
      "Kelowna Evacuations",
    ]);
  }, 30_000);

  it("re-elects a sample once the freshness window passes — cost scales with the clock, not readers", async () => {
    harness = await createTestHarness({}, NOW);
    // 60ms freshness window: "an hour" at test speed.
    const deps = trendingDeps(harness, { sampleRefreshMinutes: 0.001 });

    harness.queue.startConsumer((job) =>
      job.kind === "sample"
        ? processSampleJob(deps, job)
        : processSegmentJob(harness.deps, job),
    );

    await readTrending(deps, { language: "en", limit: 50 });
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(1);

    // The cache is cleared to prove it is the LOCK holding the cadence, not
    // the response cache.
    await harness.redis.del(`${harness.queue.name}:trending:en`);
    await new Promise((r) => setTimeout(r, 80)); // let the 60ms lock expire

    const later = await readTrending(deps, { language: "en", limit: 50 });
    expect(later.meta.ingest.state).toBe("in_progress"); // next snapshot warming
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(2);
  }, 30_000);
});

describe("the sample is a write path, so it groups what it creates (§14.3)", () => {
  it("tokenizes every article it ingests, making it groupable and a candidate", async () => {
    // The sampler shipped for one release ingesting straight into `articles`
    // with no grouping pass. An article stored without tokens can never join a
    // group AND is invisible as a candidate to everything ingested after it —
    // and this is the most syndication-dense source we have, one latest-news
    // page spanning every category and outlet. It matters more now than it did:
    // grouping is what runs the linker, so an untokenized article cannot reach
    // a storyline, which is the only thing the cloud can name.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    await processSampleJob(deps, { kind: "sample", language: "en" });

    const rows = await harness.deps.db
      .selectFrom("articles")
      .select(["id", "title", "title_tokens", "group_id"])
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    const untokenized = rows.filter(
      // A headline of pure stopwords legitimately tokenizes to nothing; every
      // other article must carry the tokens the next arrival matches against.
      (row) => row.title_tokens.length === 0 && row.title.split(/\s+/).length > 3,
    );
    expect(untokenized).toEqual([]);
    // Every article is in a group, its own until something joins it.
    expect(rows.every((row) => row.group_id !== null)).toBe(true);

    // And every group is in a storyline, provisional until a second joins it —
    // which is what makes the sample a candidate source rather than a dead end.
    const orphans = await harness.deps.db
      .selectFrom("articles")
      .leftJoin("storyline_groups", "storyline_groups.group_id", "articles.group_id")
      .select("articles.id")
      .where("storyline_groups.storyline_id", "is", null)
      .execute();
    expect(orphans).toEqual([]);
  }, 30_000);

  it("clears the cache it invalidated, so the next poll sees what the sample grew", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    await holdSampleLock(harness);
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);

    // A settled, non-empty cloud caches for the §10.4 ~15 minutes…
    await readTrending(deps, { language: "en", limit: 50 });
    expect((await readTrending(deps, { language: "en", limit: 50 })).meta.servedFrom).toBe(
      "cache",
    );

    // …and the sample's own tail drops it rather than letting a reader wait out
    // the TTL to see the storylines it just fed.
    await processSampleJob(deps, { kind: "sample", language: "en" });
    expect((await readTrending(deps, { language: "en", limit: 50 })).meta.servedFrom).toBe(
      "store",
    );
  }, 30_000);
});

describe("the window rolls (§10.1, ADR-0008)", () => {
  it("covers the last TREND_WINDOW_HOURS from now, and drops what has aged out", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    // Two storylines, both breadth-gated by two outlets each. The fresh one
    // moved 8–9 hours ago, which at 05:00 UTC is YESTERDAY'S calendar day —
    // the case the frozen-day design got wrong and the reason the landing page
    // went thin every morning. The stale one last moved 30 hours ago: outside
    // the rolling window, and outside any reading of "today".
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 30 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 31 },
    ]);

    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    expect(cloud.storylines.map((s) => s.label)).toEqual(["Kelowna Evacuations"]);

    // The response says which 24 hours it describes, and there is no `day`.
    const start = new Date(cloud.windowStart).getTime();
    const end = new Date(cloud.windowEnd).getTime();
    expect(end).toBe(NOW.getTime());
    expect(end - start).toBe(24 * 3_600_000);
  }, 30_000);

  it("rolls without a recompute: a storyline that gains an article moves at once", async () => {
    // Under the term cloud the aggregate was replaced by the sampler, so a
    // late-arriving article waited for the next sample to count. The cloud is a
    // query now (ADR-0013): the window's contents ARE the answer.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    const kelowna = await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 20 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 21 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 3 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 4 },
    ]);

    const before = await readTrending(deps, { language: "en", limit: 50 });
    expect(before.storylines.map((s) => s.label)).toEqual([
      "Truro Verdict",
      "Kelowna Evacuations",
    ]);

    // One more article on the older arc, published minutes ago.
    const [fresh] = await storeArticles(harness, [
      { title: "Kelowna Evacuation Order Widened", domain: "c.com", ageHours: 0.2 },
    ]);
    await attachGroup(harness.deps.db, {
      storylineId: kelowna,
      groupId: fresh!,
      timeZone: "UTC",
    });

    // Cache cleared, no sample run, nothing recomputed: the order has changed.
    await harness.redis.del(`${harness.queue.name}:trending:en`);
    const after = await readTrending(deps, { language: "en", limit: 50 });
    expect(after.storylines.map((s) => s.label)).toEqual([
      "Kelowna Evacuations",
      "Truro Verdict",
    ]);
    expect(after.storylines[0]!.windowArticles).toBe(3);
  }, 30_000);
});

describe("the click's search (§10.5, ADR-0014)", () => {
  it("carries the label's grounded words as `query`, not the label itself", async () => {
    // The bug this closes, end to end: the cloud drew "Jason Arday plagiarism
    // controversy" and clicking it searched all four words, which upstream ANDs
    // against body text and answered with nothing — while three articles on
    // that very arc sat in the store. The word still READS as its label; what a
    // click spends is the part of it the coverage actually says.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    const storyline = await seedStoryline(harness, "Jason Arday plagiarism controversy", [
      { title: "Academic Who Accused Jason Arday Suspended", domain: "bbc.co.uk", ageHours: 1 },
      { title: "Jason Arday Book Released With No Mention", domain: "dailymail.com", ageHours: 2 },
    ]);
    // Set directly: what is under test is that the read carries the profile out
    // and the service turns it into a query. How a profile comes to hold these
    // tokens is `refreshProfileTokens`' own business, and tested with it.
    await harness.deps.db
      .updateTable("storylines")
      .set({
        profile_tokens: ["academic", "arday", "cambridge", "jason", "professor", "university"],
      })
      .where("id", "=", storyline)
      .execute();

    const cloud = await readTrending(deps, { language: "en", limit: 50 });

    expect(cloud.storylines[0]!.label).toBe("Jason Arday plagiarism controversy");
    expect(cloud.storylines[0]!.query).toBe("jason arday");
    // Two terms, so `canonicalize` mints a topic upstream can answer AND the
    // keywords stay a subset of `profile_tokens` — which is what makes the
    // stored arc surface as a pill even on a run that fetches nothing.
    expect(cloud.storylines[0]!.query.split(" ")).toHaveLength(2);
  }, 30_000);

  it("falls back to the label when a storyline has no profile at all", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 2 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 3 },
    ]);

    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    expect(cloud.storylines[0]!.query).toBe("Truro Verdict");
  }, 30_000);
});

describe("the ranking (§10.3, ADR-0014)", () => {
  it("leads with the widely-covered arc over the one that moved last", async () => {
    // The complaint that produced ADR-0014: the board's reddest, largest words
    // were its least-covered storylines, because a single-article arc that
    // landed at 16:48 outranked a 17-article one from the same window.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    await seedStoryline(harness, "Trade Deal", [
      { title: "Trade Deal Signed After Late Talks", domain: "a.com", ageHours: 4 },
      { title: "Markets Rise On The Trade Deal", domain: "b.com", ageHours: 5 },
      { title: "Unions Criticise The Trade Deal", domain: "c.com", ageHours: 5.5 },
      { title: "Trade Deal Text Published In Full", domain: "d.com", ageHours: 6 },
      { title: "What The Trade Deal Changes", domain: "e.com", ageHours: 6.5 },
      { title: "Trade Deal Reaction From Ottawa", domain: "f.com", ageHours: 7 },
    ]);
    await seedStoryline(harness, "Champagne Harvest Climate Impact", [
      { title: "Champagne Harvest Starts Early Again", domain: "g.com", ageHours: 0.2 },
      { title: "Growers Watch The Champagne Harvest", domain: "h.com", ageHours: 0.3 },
    ]);

    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    expect(cloud.storylines.map((s) => s.label)).toEqual([
      "Trade Deal",
      "Champagne Harvest Climate Impact",
    ]);
    // Recency is still reported per word — the palette reads it, so it has to
    // survive an ordering that is no longer recency (§10.5).
    expect(Date.parse(cloud.storylines[1]!.lastUpdated)).toBeGreaterThan(
      Date.parse(cloud.storylines[0]!.lastUpdated),
    );
  }, 30_000);

  it("refuses an arc no second newsroom covered inside the window", async () => {
    // Broadly covered over three weeks, one article from one outlet today.
    // ADR-0013's arc-wide gate admitted this; the window's gate does not.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    const quiet = await seedStoryline(harness, "Long Running Inquiry", [
      { title: "Inquiry Opens Into The Contract", domain: "a.com", ageHours: 300 },
      { title: "Second Witness Called At The Inquiry", domain: "b.com", ageHours: 250 },
      { title: "Inquiry Hears From The Regulator", domain: "c.com", ageHours: 200 },
    ]);
    const [today] = await storeArticles(harness, [
      { title: "Inquiry Resumes After The Recess", domain: "a.com", ageHours: 1 },
    ]);
    await attachGroup(harness.deps.db, {
      storylineId: quiet,
      groupId: today!,
      timeZone: "UTC",
    });

    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    expect(cloud.storylines).toEqual([]);
  }, 30_000);
});

describe("one word per label (§10.2)", () => {
  it("keeps the highest-ranked claimant when two arcs are named the same thing", async () => {
    // Labels are deliberately non-unique (ADR-0011) and the dev archive holds
    // three called "Trump Administration". A pill has room for the date
    // qualifier that tells them apart; a cloud would simply draw the same word
    // twice, at two sizes, in two colours, both running the same search.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    await seedStoryline(harness, "Hormuz Strait Crisis", [
      { title: "Tanker Struck In The Hormuz Strait", domain: "a.com", ageHours: 18 },
      { title: "Insurers Withdraw From Hormuz Routes", domain: "b.com", ageHours: 19 },
    ]);
    const fresher = await seedStoryline(harness, "hormuz strait crisis", [
      { title: "Second Tanker Hit Near Hormuz", domain: "c.com", ageHours: 2 },
      { title: "Convoy Escorts Ordered For Hormuz", domain: "d.com", ageHours: 3 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 6 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 7 },
    ]);

    const cloud = await readTrending(deps, { language: "en", limit: 50 });

    // The word appears once, spelled as its winning claimant spells it, and the
    // arc it points at is that claimant — not the namesake, whose articles are
    // not folded in either. Equal volume here, so the decay picks the fresher.
    expect(cloud.storylines.map((s) => s.label)).toEqual([
      "hormuz strait crisis",
      "Truro Verdict",
    ]);
    expect(cloud.storylines[0]!.id).toBe(fresher);
    expect(cloud.storylines[0]!.windowArticles).toBe(2);
  }, 30_000);

  it("gives the word to the better-covered namesake, not merely the later one", async () => {
    // What the ranking bought here (ADR-0014): of two arcs called the same
    // thing, the word should belong to the one several newsrooms are actually
    // covering. Under a pure recency sort a two-article namesake that moved
    // twenty minutes later took it.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    const covered = await seedStoryline(harness, "Climate Change", [
      { title: "Climate Change Report Lands In Geneva", domain: "a.com", ageHours: 3 },
      { title: "Ministers Respond To Climate Change Data", domain: "b.com", ageHours: 3.2 },
      { title: "Climate Change Costs Revised Upward", domain: "c.com", ageHours: 3.4 },
      { title: "Cities Plan For Climate Change Heat", domain: "d.com", ageHours: 3.6 },
      { title: "Climate Change Talks Set For October", domain: "e.com", ageHours: 3.8 },
      { title: "Farmers On Climate Change Rainfall", domain: "f.com", ageHours: 4 },
    ]);
    await seedStoryline(harness, "climate change", [
      { title: "Climate Change Panel Names New Chair", domain: "g.com", ageHours: 2 },
      { title: "Climate Change Grant Awarded In Perth", domain: "h.com", ageHours: 2.2 },
    ]);

    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    expect(cloud.storylines).toHaveLength(1);
    expect(cloud.storylines[0]!.id).toBe(covered);
    expect(cloud.storylines[0]!.windowArticles).toBe(6);
  }, 30_000);
});

describe("the sample waits for the names it started (§10.1)", () => {
  /**
   * Loosened exactly as `grouping-service.test.ts` loosens it, and for the same
   * reason: a test database holds a dozen articles, where every shared token is
   * rare and no mass reaches 20. What is under test is the WIRING — that the
   * sample job holds the label tail — not the production thresholds.
   */
  const LINKER = {
    enabled: true,
    rules: {
      anchorMaxShare: 0.5,
      anchorDfFloor: 4,
      massThreshold: 2,
      dormancyDays: 90,
      dormantStrictness: 1.5,
    },
    mergeBridges: 2,
    coherenceGate: false,
    narrowRetrieval: false,
    storyDf: { windowDays: 14, timeZone: "UTC" },
    timeZone: "UTC",
  };

  /**
   * A corpus for rarity to mean anything, then one story in two groups — the
   * syndicated core and an angle piece that names it only in its description.
   * The second group is what promotes the storyline, which is what fires the
   * labeller. Lifted from `grouping-service.test.ts`, re-dated to sit inside
   * this file's window: every one is published before NOW, or the cloud's
   * `published < to` bound would exclude the story this test is about.
   */
  const PAGES: Array<{ domain: string; title: string; published: string; description?: string }> = [
    { domain: "filler0.example", title: "Volcano erupts near coastal village", published: "2026-08-10T20:10:00.000Z" },
    { domain: "filler1.example", title: "Chess prodigy wins continental crown", published: "2026-08-10T20:11:00.000Z" },
    { domain: "filler2.example", title: "Rare orchid blooms in botanical garden", published: "2026-08-10T20:12:00.000Z" },
    { domain: "filler3.example", title: "Ferry operators trim winter schedule", published: "2026-08-10T20:13:00.000Z" },
    { domain: "filler4.example", title: "Museum unveils dinosaur exhibit", published: "2026-08-10T20:14:00.000Z" },
    {
      domain: "wireone.example",
      title: "Champlain bridge closure strands commuters",
      published: "2026-08-11T02:00:00.000Z",
      description: "Traffic chaos as the Champlain bridge shuts for emergency repairs",
    },
    {
      domain: "angle.example",
      title: "Commuters furious over sudden shutdown",
      published: "2026-08-11T03:00:00.000Z",
      description: "The Champlain bridge closure has stranded thousands of commuters",
    },
  ];

  /**
   * One sighting per page, so the sample's page loop reproduces the arrival
   * order a real feed has. Ingesting all seven at once would make the corpus
   * arrive in the same batch as the story measured against it.
   */
  function serveOnePerPage(h: TestHarness): void {
    let served = 0;
    h.counting.latestNews = async (): Promise<SearchResult> => {
      const page = PAGES[served];
      served += 1;
      const url = `https://${page!.domain}/page-${served}`;
      return {
        sightings: [
          {
            id: `10000000-0000-4000-8000-${String(served).padStart(12, "0")}`,
            url,
            provider: "currents",
            providerSightingId: url,
            dedupKey: deriveDedupKey(url),
            title: page!.title,
            description: page!.description ?? null,
            author: null,
            imageUrl: null,
            language: "en",
            categories: [],
            sourceCategories: [],
            sourceDomain: page!.domain,
            published: page!.published,
            raw: {},
          },
        ],
        requestedAt: NOW,
        rawCount: 1,
        isLastPage: served >= PAGES.length,
        pageSize: 20,
        normalization: { ...emptyStats(), received: 1, kept: 1 },
        quota: null,
        adjustments: [],
      };
    };
  }

  it("holds the cache until the labeller has named what the linker promoted", async () => {
    harness = await createTestHarness(
      { grouping: { enabled: true, threshold: 0.5, timeZone: "UTC", linker: LINKER } },
      NOW,
    );
    serveOnePerPage(harness);
    await holdSampleLock(harness);

    // The model call, held open: this is the window the bug lived in — the
    // seconds between "the linker promoted a storyline" and "the storyline has
    // a name the cloud query can see".
    let releaseModel = (): void => {};
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let generateCalls = 0;

    const deps: TrendingDeps = {
      ...trendingDeps(harness, { samplePages: PAGES.length }),
      labeler: {
        generator: {
          generate: async () => {
            generateCalls += 1;
            await modelGate;
            return { ok: true as const, text: "Champlain Bridge Closure" };
          },
        },
        sampleSize: 10,
        driftFactor: 2,
        now: () => harness.clock.now(),
      },
    };

    // A settled, non-empty cloud from yesterday's leftovers, cached for the
    // §10.4 fifteen minutes — the entry the sample must not clear too early.
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);
    await readTrending(deps, { language: "en", limit: 50 });
    const cacheKey = `${harness.queue.name}:trending:en`;
    expect(await harness.redis.exists(cacheKey)).toBe(1);

    const job = processSampleJob(deps, { kind: "sample", language: "en" });
    let settled = false;
    void job.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(generateCalls).toBeGreaterThan(0), {
      timeout: 20_000,
      interval: 25,
    });

    // THE REGRESSION. The linker fired the labeller and dropped the promise, so
    // the job used to return here — clearing the cache and reopening it while
    // the promoted storyline was still nameless. The next reader saw a cloud
    // without it, found `state` "complete" because the job was done, and cached
    // that for fifteen minutes. On the dev archive that cost sixteen of
    // nineteen storylines and left a three-word landing page for the hour.
    expect(settled).toBe(false);
    expect(await harness.redis.exists(cacheKey)).toBe(1);

    releaseModel();
    await job;

    // Only now, with the name written, is the stale entry dropped…
    expect(await harness.redis.exists(cacheKey)).toBe(0);

    // …and the cloud the next reader builds carries what the sample grew.
    const after = await readTrending(deps, { language: "en", limit: 50 });
    expect(after.meta.servedFrom).toBe("store");
    expect(after.storylines.map((s) => s.label)).toContain("Champlain Bridge Closure");
  }, 60_000);
});
