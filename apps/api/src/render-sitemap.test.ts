import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/currents-client";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  promoteStoryline,
  setStorylineLabel,
  upsertTopic,
} from "@zammy/storage";
import { groupCreatedArticles } from "./grouping-service.js";
import { labelWords } from "./storyline-label-merge.js";
import { storylineBar } from "./storyline-bar.js";
import { buildSitemap, type SitemapDeps } from "./render-sitemap.js";
import { SITE_ORIGIN } from "./render-storyline.js";
import { createReadHarness, type ReadTestHarness } from "./test-support.js";

const TZ = { timeZone: "UTC" };
const NOW = new Date("2026-08-13T22:00:00.000Z");
const RECENT = "2026-08-13T20:00:00.000Z";

let harness: ReadTestHarness;
let db: ReadTestHarness["deps"]["db"];

beforeAll(async () => {
  harness = await createReadHarness(
    { grouping: { enabled: true, threshold: 0.5, timeZone: "UTC", linker: storylineBar({ enabled: false }) } },
    NOW,
  );
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

let uuidCounter = 0;
function sighting(input: { domain: string; title: string; published: string }): Sighting {
  uuidCounter += 1;
  const url = `https://${input.domain}/${uuidCounter}`;
  return {
    id: `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(input.domain, input.title, input.published),
    title: input.title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: input.domain,
    published: input.published,
    raw: {},
  };
}

/**
 * A promoted, labelled, TRENDING storyline: two member groups from two
 * distinct source domains, both published inside the window — the breadth
 * gate `readTrendingStorylines` enforces (`MIN_SOURCE_DOMAINS`).
 */
async function trendingStoryline(label: string, domainPrefix: string): Promise<string> {
  const sightings = [
    sighting({ domain: `${domainPrefix}-a.example`, title: `${label} update one`, published: RECENT }),
    sighting({ domain: `${domainPrefix}-b.example`, title: `${label} update two`, published: RECENT }),
  ];
  const fingerprint = sightings.map((s) => s.dedupKey).join("").padEnd(64, "0").slice(0, 64);
  await upsertTopic(db, { fingerprint, keywords: ["storm"], language: "en" });
  const ingested = await ingestSightings(db, { plane: "search", ...TZ, fingerprint, sightings });
  await groupCreatedArticles(
    { db, config: harness.deps.config.grouping },
    ingested.createdArticles,
  );
  const rows = await db
    .selectFrom("articles")
    .select(["group_id"])
    .distinct()
    .execute();
  const groupIds = [...new Set(rows.map((row) => row.group_id))];

  const first = await createProvisionalStoryline(db, { groupId: groupIds[0]!, ...TZ });
  for (const groupId of groupIds.slice(1)) {
    await attachGroup(db, { storylineId: first.id, groupId, ...TZ });
  }
  await promoteStoryline(db, { storylineId: first.id });
  await setStorylineLabel(db, {
    storylineId: first.id,
    label,
    labelWords: labelWords(label),
    labelAt: NOW,
    labelGroupCount: groupIds.length,
    labelSource: "test",
  });
  return first.id;
}

function deps(overrides: Partial<SitemapDeps> = {}): SitemapDeps {
  return {
    db,
    now: () => NOW,
    defaultLanguage: "en",
    trending: { windowHours: 48, halfLifeHours: 8 },
    ...overrides,
  };
}

describe("buildSitemap", () => {
  it("always lists the home page, even with nothing trending", async () => {
    const xml = await buildSitemap(deps());
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    // No <lastmod> on the home entry, matching the static file this replaces.
    expect(xml).not.toMatch(new RegExp(`<loc>${SITE_ORIGIN}/</loc>\\s*<lastmod>`));
  });

  it("lists a trending storyline with its canonical path and lastmod", async () => {
    const storyline = await trendingStoryline("Hurricane Fausto", "fausto");

    const xml = await buildSitemap(deps());

    expect(xml).toContain(`<loc>${SITE_ORIGIN}/storyline/${storyline}/hurricane-fausto</loc>`);
    expect(xml).toContain(`<lastmod>${RECENT.replace(".000Z", ".000Z")}</lastmod>`);
  });

  it("produces well-formed XML with the sitemap namespace", async () => {
    await trendingStoryline("Hurricane Fausto", "fausto");
    const xml = await buildSitemap(deps());
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("</urlset>");
  });

  it("excludes a storyline with only one source domain in the window", async () => {
    // The breadth gate (`MIN_SOURCE_DOMAINS`) is `readTrendingStorylines`'s
    // own, exercised here rather than re-asserted: this test is really about
    // the sitemap NOT overriding what the cloud already decided is worth
    // surfacing, by calling the same function `/api/v1/trending` calls rather
    // than a looser query of its own.
    const sightings = [
      sighting({ domain: "solo.example", title: "Solo Story one", published: RECENT }),
      sighting({ domain: "solo.example", title: "Solo Story two", published: RECENT }),
    ];
    const fingerprint = sightings.map((s) => s.dedupKey).join("").padEnd(64, "0").slice(0, 64);
    await upsertTopic(db, { fingerprint, keywords: ["storm"], language: "en" });
    const ingested = await ingestSightings(db, { plane: "search", ...TZ, fingerprint, sightings });
    await groupCreatedArticles(
      { db, config: harness.deps.config.grouping },
      ingested.createdArticles,
    );
    const rows = await db.selectFrom("articles").select(["group_id"]).distinct().execute();
    const groupIds = [...new Set(rows.map((row) => row.group_id))];
    const first = await createProvisionalStoryline(db, { groupId: groupIds[0]!, ...TZ });
    for (const groupId of groupIds.slice(1)) await attachGroup(db, { storylineId: first.id, groupId, ...TZ });
    await promoteStoryline(db, { storylineId: first.id });
    await setStorylineLabel(db, {
      storylineId: first.id,
      label: "Solo Story",
      labelWords: labelWords("Solo Story"),
      labelAt: NOW,
      labelGroupCount: groupIds.length,
      labelSource: "test",
    });

    const xml = await buildSitemap(deps());
    expect(xml).not.toContain("solo-story");
  });
});
