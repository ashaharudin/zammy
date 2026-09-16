import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/currents-client";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  mergeStorylines,
  promoteStoryline,
  setStorylineLabel,
  upsertTopic,
  writeStorylineDaySummary,
} from "@zammy/storage";
import { groupCreatedArticles } from "./grouping-service.js";
import { labelWords } from "./storyline-label-merge.js";
import { extractStorylineId, renderStorylinePage, SITE_ORIGIN } from "./render-storyline.js";
import { storylineBar } from "./storyline-bar.js";
import { createReadHarness, type ReadTestHarness } from "./test-support.js";

/**
 * A minimal stand-in for `apps/web/dist/index.html`, carrying only the tags
 * `render-storyline.ts` rewrites. Literal rather than read off disk: this
 * suite has no reason to depend on `apps/web` having been built, and pinning
 * the shape here is itself the check that the real file still has it —
 * `render-storyline.test.ts`'s own comment on `setAttr` says what happens if
 * it does not (the tag is left untouched, not a throw).
 */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>Zammy — trace any story back to where it started</title>
    <meta name="description" content="Trace any story back to where it started." />
    <link rel="canonical" href="https://www.zammy.info/" />
    <meta property="og:url" content="https://www.zammy.info/" />
    <meta property="og:title" content="Zammy — trace any story back to where it started" />
    <meta property="og:description" content="Trace any story back to where it started." />
    <meta name="twitter:title" content="Zammy — trace any story back to where it started" />
    <meta name="twitter:description" content="Trace any story back to where it started." />
  </head>
  <body>
    <div id="root"></div>
    <p id="rail-status" class="sr-only" role="status" aria-live="polite"></p>
  </body>
</html>
`;

const TZ = { timeZone: "UTC" };
const NOW = new Date("2026-08-13T22:00:00.000Z");
const MONDAY = "2026-08-10T09:00:00.000Z";
const TUESDAY = "2026-08-11T09:00:00.000Z";

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

/** Ingest and group sightings under a throwaway topic, then hand back their group ids. */
async function seedGroups(sightings: Sighting[]): Promise<string[]> {
  const fingerprint = sightings.map((s) => s.dedupKey).join("").padEnd(64, "0").slice(0, 64);
  await upsertTopic(db, { fingerprint, keywords: ["storm"], language: "en" });
  const ingested = await ingestSightings(db, { plane: "search", ...TZ, fingerprint, sightings });
  await groupCreatedArticles(
    { db, config: harness.deps.config.grouping },
    ingested.createdArticles,
  );
  const rows = await db
    .selectFrom("articles")
    .select(["group_id", "published"])
    .distinct()
    .orderBy("published", "asc")
    .execute();
  return [...new Set(rows.map((row) => row.group_id))];
}

/** A promoted, labelled storyline over the given groups. */
async function storylineOf(groupIds: string[], label: string): Promise<string> {
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

describe("extractStorylineId", () => {
  const UUID = "0192f3c4-5d6e-7f80-9123-456789abcdef";

  it("reads the uuid out of a path with a slug", () => {
    expect(extractStorylineId(`/storyline/${UUID}/hurricane-fausto`)).toBe(UUID);
  });

  it("reads the uuid out of a bare path with no slug", () => {
    expect(extractStorylineId(`/storyline/${UUID}`)).toBe(UUID);
    expect(extractStorylineId(`/storyline/${UUID}/`)).toBe(UUID);
  });

  it("lowercases the id, since the stored form always is", () => {
    expect(extractStorylineId(`/storyline/${UUID.toUpperCase()}/x`)).toBe(UUID);
  });

  it("ignores a query string riding along on the request path", () => {
    expect(extractStorylineId(`/storyline/${UUID}/x?utm_source=test`)).toBe(UUID);
  });

  it("refuses a path segment that is not a storyline uuid", () => {
    // Inverting the `STORYLINE_UUID.test` guard would let ADR-0010's bigint
    // seed shape (or any other string) through as though it named a storyline.
    expect(extractStorylineId("/storyline/23905")).toBeNull();
  });

  it("refuses a path this function does not own at all", () => {
    expect(extractStorylineId("/")).toBeNull();
    expect(extractStorylineId("/sitemap.xml")).toBeNull();
  });
});

describe("renderStorylinePage", () => {
  it("404s a path that names no storyline", async () => {
    const result = await renderStorylinePage(harness.deps, {
      path: "/storyline/not-a-uuid",
      template: TEMPLATE,
    });
    expect(result.status).toBe(404);
    expect(result.body).toContain("Storyline not found");
  });

  it("404s a well-formed uuid this database never held", async () => {
    const result = await renderStorylinePage(harness.deps, {
      path: "/storyline/00000000-0000-4000-8000-000000000000/anything",
      template: TEMPLATE,
    });
    expect(result.status).toBe(404);
    expect(result.headers["cache-control"]).toContain("s-maxage=60");
  });

  it("renders the storyline's title, canonical, description, and headlines", async () => {
    const groups = await seedGroups([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(groups, "Hurricane Fausto");
    await writeStorylineDaySummary(db, {
      storylineId: storyline,
      dayKey: "2026-08-11",
      segment: "day",
      summary: "Fausto weakened as it moved past the islands.",
      articleCount: 2,
      label: "Hurricane Fausto",
      modelId: "test-model",
      attempts: 0,
      segmented: true,
      generatedAt: NOW,
    });

    const result = await renderStorylinePage(harness.deps, {
      path: `/storyline/${storyline}/whatever-slug`,
      template: TEMPLATE,
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("<title>Hurricane Fausto — Zammy</title>");
    expect(result.body).toContain(
      `<link rel="canonical" href="${SITE_ORIGIN}/storyline/${storyline}/hurricane-fausto" />`,
    );
    expect(result.body).toContain('property="og:title" content="Hurricane Fausto — Zammy"');
    // The day's own sentence, not a headline, is what the description leads
    // with (ADR-0023's arc IS the original content here).
    expect(result.body).toContain('content="Fausto weakened as it moved past the islands."');
    expect(result.body).toContain("<h1>Hurricane Fausto</h1>");
    expect(result.body).toContain("Fausto weakened as it moved past the islands.");
    expect(result.body).toContain('href="https://a.example/1"');
    expect(result.body).toContain("Hurricane Fausto nears Hawaii");
    // `#root` in the SOURCE stays empty (`railAnnouncer.test.ts`); this is the
    // built COPY, held in memory, and it is meant to carry content.
    expect(result.body).not.toContain('<div id="root"></div>');
  });

  it("escapes markup in a label, a headline and a day summary", async () => {
    // Every string on this page is upstream text — a label a model wrote from
    // a headline, a headline an outlet wrote, a summary written from both.
    // None of it is ours, and all of it lands in HTML we generate by hand.
    const groups = await seedGroups([
      sighting({
        domain: "a.example",
        title: `<script>alert("xss")</script> & "quoted"`,
        published: MONDAY,
      }),
    ]);
    const storyline = await storylineOf(groups, "<b>Bold</b> Storyline");
    await writeStorylineDaySummary(db, {
      storylineId: storyline,
      dayKey: "2026-08-10",
      segment: "day",
      summary: `A summary with <em>tags</em> & an ampersand.`,
      articleCount: 1,
      label: "<b>Bold</b> Storyline",
      modelId: "test-model",
      attempts: 0,
      segmented: true,
      generatedAt: NOW,
    });

    const result = await renderStorylinePage(harness.deps, {
      path: `/storyline/${storyline}/x`,
      template: TEMPLATE,
    });

    expect(result.status).toBe(200);
    // Not one raw angle bracket from any of the three reaches the document.
    expect(result.body).not.toContain("<script>");
    expect(result.body).not.toContain("<b>Bold</b>");
    expect(result.body).not.toContain("<em>tags</em>");
    expect(result.body).toContain("&lt;b&gt;Bold&lt;/b&gt; Storyline");
    expect(result.body).toContain("&lt;script&gt;");
    expect(result.body).toContain("&amp;");
  });

  it("survives a dollar sign in the text, which String.replace would otherwise read", async () => {
    // The regression this file did not have. `escapeHtml` turns `'` into
    // `&#39;`, so `$'` arrives at the injection point as `$&#39;` — a `$&`,
    // which a STRING replacement expands to the matched text. `injectBody`
    // would have grown a second `<div id="root">` inside the page and
    // `injectHead` a nested `<title>`; both take a replacer FUNCTION now.
    const groups = await seedGroups([
      sighting({ domain: "a.example", title: `Oil at $' a barrel, say traders`, published: MONDAY }),
    ]);
    const storyline = await storylineOf(groups, `Crude $" Rally`);

    const result = await renderStorylinePage(harness.deps, {
      path: `/storyline/${storyline}/x`,
      template: TEMPLATE,
    });

    expect(result.status).toBe(200);
    // One root div, one title, and no fragment of the template folded into
    // either — the three shapes a `$&` substitution actually produces here.
    expect([...result.body.matchAll(/<div id="root">/g)]).toHaveLength(1);
    expect([...result.body.matchAll(/<title>/g)]).toHaveLength(1);
    expect(result.body).toContain("Oil at $&#39; a barrel, say traders");
    expect(result.body).toContain("<title>Crude $&quot; Rally — Zammy</title>");
  });

  it("301s a merged (aliased) uuid to the survivor's own canonical path", async () => {
    const groups = await seedGroups([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens", published: TUESDAY }),
    ]);
    const winner = await storylineOf([groups[0]!], "Pacific Storms");
    const loser = await createProvisionalStoryline(db, { groupId: groups[1]!, ...TZ });
    await mergeStorylines(db, { winnerId: winner, loserId: loser.id, ...TZ });

    const result = await renderStorylinePage(harness.deps, {
      path: `/storyline/${loser.id}/whatever-the-old-slug-was`,
      template: TEMPLATE,
    });

    expect(result.status).toBe(301);
    expect(result.headers.location).toBe(`${SITE_ORIGIN}/storyline/${winner}/pacific-storms`);
  });

  it("never redirects a request that already names the survivor", async () => {
    // The 301 branch is `resolved !== id`; inverting that (or dropping the
    // check) would send every direct hit on a live storyline's own canonical
    // URL bouncing through a redirect to itself.
    const groups = await seedGroups([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(groups, "Fausto");

    const result = await renderStorylinePage(harness.deps, {
      path: `/storyline/${storyline}/fausto`,
      template: TEMPLATE,
    });

    expect(result.status).toBe(200);
  });
});
