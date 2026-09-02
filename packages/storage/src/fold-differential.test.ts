import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  altKeyProbe,
  altKeyProbeIsConsistent,
  deriveAltKey,
  deriveDedupKey,
  type Sighting,
} from "@zammy/news-client";
import { hexToBytea, type Database } from "./database.js";
import { chooseArticle, fieldAuthority, type FoldProbe } from "./fold.js";
import { findArticleCandidates, foldSet } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * **The differential guard on the fold.**
 *
 * `fold.ts` re-expressed two decisions that used to live inside the SQL that
 * performed them: the article precedence, which was `findArticle`'s
 * `order by (dedup_key = …) desc, (alt_key = …) desc` plus the branch under it,
 * and the per-field entitlement, which was ten hand-written
 * `case when … then … else … end` lines in one `UPDATE`.
 *
 * **A diff cannot prove that equivalent, and the failure it would hide does not
 * raise.** This is the archive's write path on a live database: a wrong fold
 * silently merges two different articles into one, or splits one into two, and
 * nothing surfaces it — the exact failure ADR-0002 and ADR-0018 exist to
 * prevent, and one no re-run repairs. So both rules are replayed here against
 * the statements they replace, over the same rows, and every outcome is
 * compared.
 *
 * ## Transcribed, never imported
 *
 * `chooseTheOldWay` and `foldTheOldWay` below are verbatim transcriptions of
 * `main`'s SQL — the ordering, the `by_url`/`by_own_day` selects, the `limit 4`,
 * the eleven SET lines. A harness that called the new module on both sides would
 * compare it against itself, which is the trap this shape exists to avoid. They
 * are deliberately NOT refactored, NOT deduplicated against each other, and NOT
 * tidied: their only job is to still say what `main` said.
 *
 * ## What is covered, exhaustively rather than by sampling
 *
 * **The precedence** — every reachable candidate-set shape, crossed with every
 * probe width `altKeyProbe` can produce. 20 archive shapes × 4 probes = 80
 * cases, each seeded into real rows under real unique indexes and resolved by
 * both implementations.
 *
 * **The entitlement** — `movesTheClock` × `firstHand` × (incoming earlier /
 * later / equal) = 12 cases, each applied to two byte-identical articles and
 * compared over all thirteen columns the statement writes.
 *
 * **The degraded probe**, which is the one input the new decision cannot trust:
 * `altKeyProbe` takes a structurally-constructible `Sighting` and falls back to
 * the single stored key when its consistency check fails, so a bare-dated
 * sighting does NOT always arrive with the widened set.
 *
 * **Keep this after it passes.** Its job then is the next change to either rule:
 * it is the only thing in the tree that will say "you changed the fold" before
 * production does.
 */

/** A syntactically valid, deterministic 64-hex key from any label. */
function key(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/**
 * ONE database for both halves of this file.
 *
 * Every case here needs a real Postgres — the old implementation is SQL, and
 * comparing it against anything else is the whole point — but none of them needs
 * a database OF ITS OWN: each case works in its own key namespace, so 80
 * candidate sets and 19 folded articles share one archive under the same live
 * unique indexes they will meet in production.
 */
let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
  await migrateToLatest(harness.db);
});

afterAll(async () => {
  await harness.drop();
});

/* ------------------------------------------------------------------ *
 * PART 1 — the precedence and the refusal (ADR-0018, ADR-0022)
 * ------------------------------------------------------------------ */

/**
 * `main`'s `findArticle`, transcribed: both keys in one statement, the two
 * precedence tiers in the `order by`, and the refusal read off `rows[0]`.
 *
 * Kept exactly as it was, comments included where they carry the claim being
 * checked, so a reader can diff this against `git show origin/main` rather than
 * against a paraphrase.
 */
async function chooseTheOldWay(
  trx: Kysely<Database>,
  dedupKey: Buffer,
  altKeyMatches: readonly Buffer[],
): Promise<{ id: string; published: Date; group_id: string } | undefined> {
  const [ownDay] = altKeyMatches;
  const rows = await trx
    .selectFrom("articles")
    .select((eb) => [
      "id",
      "published",
      "group_id",
      eb("dedup_key", "=", dedupKey).as("by_url"),
      // `coalesce`, because `alt_key` is nullable and `null = $1` is NULL, not
      // false.
      ...(ownDay === undefined
        ? [sql<boolean>`false`.as("by_own_day")]
        : [sql<boolean>`coalesce(alt_key = ${ownDay}, false)`.as("by_own_day")]),
    ])
    .where((eb) =>
      ownDay === undefined
        ? eb("dedup_key", "=", dedupKey)
        : eb.or([eb("dedup_key", "=", dedupKey), eb("alt_key", "in", [...altKeyMatches])]),
    )
    .orderBy(sql`(dedup_key = ${dedupKey})`, "desc")
    .$if(ownDay !== undefined, (qb) => qb.orderBy(sql`(alt_key = ${ownDay!})`, "desc"))
    .orderBy("id", "asc")
    .limit(4)
    .execute();

  const best = rows[0];
  if (best === undefined) return undefined;
  if (best.by_url || best.by_own_day) return best;
  return new Set(rows.map((row) => row.id)).size === 1 ? best : undefined;
}

/**
 * The rows an archive shape puts in front of the probe.
 *
 *  - `U`  a row answering the URL key, carrying an alt key of its own that the
 *         probe never asks for — the ADR-0018 shape where the URL and the
 *         fallback point at DIFFERENT articles.
 *  - `UO` one row answering the URL key AND the own-day key. Mutually exclusive
 *         with both `U` and `O`, since a row has one of each key.
 *  - `O`  a row answering the sighting's OWN day, under a URL never seen.
 *  - `M`  a row answering the D-1 neighbour. `P`, the D+1 one.
 */
type Slot = "U" | "UO" | "O" | "M" | "P";

/** Every probe width `altKeyProbe` can hand over (see its `filter`). */
const PROBES = ["none", "single", "two", "widened"] as const;
type ProbeWidth = (typeof PROBES)[number];

/**
 * Every reachable archive shape: the free subsets of {U, O, M, P}, plus the ones
 * where the URL row and the own-day row are ONE row.
 *
 * 16 + 4 = 20. Nothing is sampled and nothing is omitted — a shape absent from
 * this list is a shape the two unique indexes make unconstructible, and Part 1's
 * seeding would fail rather than skip it.
 */
function archiveShapes(): Slot[][] {
  const free: Slot[][] = [];
  for (const u of [false, true]) {
    for (const o of [false, true]) {
      for (const m of [false, true]) {
        for (const p of [false, true]) {
          const shape: Slot[] = [];
          if (u) shape.push("U");
          if (o) shape.push("O");
          if (m) shape.push("M");
          if (p) shape.push("P");
          free.push(shape);
        }
      }
    }
  }
  const merged: Slot[][] = [];
  for (const m of [false, true]) {
    for (const p of [false, true]) {
      const shape: Slot[] = ["UO"];
      if (m) shape.push("M");
      if (p) shape.push("P");
      merged.push(shape);
    }
  }
  return [...free, ...merged];
}

describe("the precedence and the refusal, old SQL against the new decision", () => {
  const shapes = archiveShapes();

  /**
   * One case, in its own key namespace so all 80 can share one archive: the keys
   * a case probes are derived from its own index, so no case can see another's
   * rows even though every row lives in the same table under the same indexes.
   */
  const seed = async (namespace: string, shape: readonly Slot[]) => {
    const urlKey = key(`${namespace}:url`);
    const ownDay = key(`${namespace}:own-day`);
    const prev = key(`${namespace}:prev-day`);
    const next = key(`${namespace}:next-day`);

    const rows: Array<{ dedup: string; alt: string | null; slot: Slot }> = shape.map((slot) => {
      switch (slot) {
        case "U":
          return { slot, dedup: urlKey, alt: key(`${namespace}:u-own-alt`) };
        case "UO":
          return { slot, dedup: urlKey, alt: ownDay };
        case "O":
          return { slot, dedup: key(`${namespace}:o-url`), alt: ownDay };
        case "M":
          return { slot, dedup: key(`${namespace}:m-url`), alt: prev };
        case "P":
          return { slot, dedup: key(`${namespace}:p-url`), alt: next };
      }
    });

    const ids = new Map<Slot, string>();
    for (const row of rows) {
      const inserted = await harness.db
        .insertInto("articles")
        .values({
          dedup_key: hexToBytea(row.dedup),
          alt_key: row.alt === null ? null : hexToBytea(row.alt),
          url: `https://example.com/${namespace}/${row.slot}`,
          title: `${namespace} ${row.slot}`,
          published: new Date("2026-08-25T12:00:00.000Z"),
          latest_seen: new Date("2026-08-25T12:00:00.000Z"),
          categories: [],
          source_category: [],
          sighting_count: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      ids.set(row.slot, inserted.id);
    }

    return { urlKey, ownDay, prev, next, ids };
  };

  const probeFor = (
    width: ProbeWidth,
    keys: { urlKey: string; ownDay: string; prev: string; next: string },
  ): FoldProbe => {
    switch (width) {
      case "none":
        return { dedupKey: keys.urlKey, altKeyMatches: [] };
      case "single":
        return { dedupKey: keys.urlKey, altKeyMatches: [keys.ownDay] };
      case "two":
        return { dedupKey: keys.urlKey, altKeyMatches: [keys.ownDay, keys.next] };
      case "widened":
        return {
          dedupKey: keys.urlKey,
          altKeyMatches: [keys.ownDay, keys.prev, keys.next],
        };
    }
  };

  /**
   * The whole cross product in one test, because a disagreement anywhere in it
   * is one finding rather than eighty: what matters is WHICH inputs disagree,
   * and a per-case `it` would report the first and hide the rest.
   *
   * Every case is compared on the resolved article ID — the only thing the
   * caller acts on — and on the three fields the old lookup returned, since
   * `published` and `group_id` feed the storyline guard and a swapped row would
   * be visible there and nowhere else.
   */
  it("agrees on every reachable candidate set and every probe width", async () => {
    const disagreements: string[] = [];
    let compared = 0;

    for (const [index, shape] of shapes.entries()) {
      for (const width of PROBES) {
        const namespace = `case-${index}-${width}`;
        const seeded = await seed(namespace, shape);
        const probe = probeFor(width, seeded);

        const old = await chooseTheOldWay(
          harness.db,
          hexToBytea(probe.dedupKey),
          probe.altKeyMatches.map(hexToBytea),
        );
        const now = chooseArticle(
          await findArticleCandidates(harness.db, probe),
          probe,
        );

        const oldId = old?.id;
        const newId = now.kind === "match" ? now.article.id : undefined;
        compared += 1;

        if (oldId !== newId) {
          disagreements.push(
            `${shape.join("+") || "empty"} / ${width}: old=${oldId ?? "none"} new=${newId ?? now.kind}`,
          );
          continue;
        }
        if (old !== undefined && now.kind === "match") {
          if (
            old.published.toISOString() !== now.article.published.toISOString() ||
            old.group_id !== now.article.group_id
          ) {
            disagreements.push(`${shape.join("+")} / ${width}: same id, different row fields`);
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
    // The cross product actually ran. A harness that silently enumerated nothing
    // would pass the assertion above.
    expect(compared).toBe(80);
  });

  /**
   * The candidate ORDER is not part of the decision's input contract, which is
   * what makes the `order by` the retrieval keeps a determinism device rather
   * than a hidden second copy of the precedence.
   *
   * Asserted by shuffling every candidate set the cross product produces and
   * re-deciding: both keys are unique, so at most one row answers the URL arm
   * and at most one the own-day arm, and the neighbour arm resolves on a SET of
   * ids. If any of that were untrue, a permutation would change the verdict.
   */
  it("does not depend on the order the candidates arrive in", async () => {
    for (const [index, shape] of shapes.entries()) {
      for (const width of PROBES) {
        const namespace = `order-${index}-${width}`;
        const seeded = await seed(namespace, shape);
        const probe = probeFor(width, seeded);
        const candidates = await findArticleCandidates(harness.db, probe);
        const forward = chooseArticle(candidates, probe);
        const backward = chooseArticle([...candidates].reverse(), probe);
        expect(backward).toEqual(forward);
      }
    }
  });

  /**
   * The `limit 4` cannot truncate, which is the argument that lets the
   * precedence leave the `order by`: the URL key names at most one row and the
   * probe's at most three alt keys name at most three more.
   *
   * Asserted rather than argued, on the shape that reaches the ceiling — a URL
   * row plus three alt-key rows on three different days — because if a fifth row
   * were ever reachable, an `id`-ordered limit could cut the decisive one and
   * this whole refactor would be wrong.
   */
  it("never has more than four candidates to decide over", async () => {
    const namespace = "ceiling";
    const seeded = await seed(namespace, ["U", "O", "M", "P"]);
    const probe = probeFor("widened", seeded);
    const candidates = await findArticleCandidates(harness.db, probe);
    expect(candidates).toHaveLength(4);
    // And the retrieval's own order, which decides nothing but must be total.
    expect([...candidates].map((row) => row.id)).toEqual(
      [...candidates].map((row) => row.id).sort((a, b) => Number(a) - Number(b)),
    );
  });

  /**
   * **The degraded probe.** `altKeyProbe` re-derives the two neighbours from the
   * sighting's OWN stored fields, and falls back to the single stored key when
   * that re-derivation does not reproduce the key the sighting carries
   * (`altKeyProbeIsConsistent`). Candidate 4's `deriveArticleIdentity` closed the
   * DOMAIN axis of that check but not the title or published ones, and
   * `altKeyProbe` takes a structurally-constructible `Sighting` besides.
   *
   * So a bare-dated sighting does NOT always arrive with three keys, and the
   * decision must behave under one exactly as a never-widened lookup does. Both
   * halves are asserted: that the probe really does degrade, and that the fold's
   * verdict on the degraded probe is the SINGLE-key verdict rather than the
   * widened one — over the same archive that would have folded it onto a
   * neighbour had the probe held.
   */
  it("resolves a degraded probe exactly as a single-key one, never as a widened one", async () => {
    const domain = "degraded.example";
    const title = "Overnight ferry service resumes";
    const ownDayIso = "2026-08-22T07:00:00.000Z";
    const neighbourIso = "2026-08-21T23:30:00.000Z";

    // The archive holds the story on the PREVIOUS day only — the shape ADR-0022
    // widens the lookup to catch.
    const neighbour = await harness.db
      .insertInto("articles")
      .values({
        dedup_key: hexToBytea(deriveDedupKey("https://degraded.example/ferry-neighbour")),
        alt_key: hexToBytea(deriveAltKey(domain, title, neighbourIso)!),
        url: "https://degraded.example/ferry-neighbour",
        title,
        published: new Date(neighbourIso),
        latest_seen: new Date(neighbourIso),
        categories: [],
        source_category: [],
        sighting_count: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const bare = (over: Partial<Sighting>): Sighting => ({
      id: "00000000-0000-4000-8000-0000000d0000",
      url: "https://news.google.example/rss/articles/CBMiDEGRADED",
      provider: "google-news",
      providerSightingId: "CBMiDEGRADED",
      dedupKey: deriveDedupKey("https://news.google.example/rss/articles/CBMiDEGRADED"),
      altKey: deriveAltKey(domain, title, ownDayIso),
      title,
      description: null,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: domain,
      published: ownDayIso,
      publishedIsDateOnly: true,
      raw: {},
      ...over,
    });

    // Intact: three keys, and the widened lookup reaches the neighbour.
    const intact = bare({});
    expect(altKeyProbeIsConsistent(intact)).toBe(true);
    expect(altKeyProbe(intact)).toHaveLength(3);
    const widenedProbe: FoldProbe = {
      dedupKey: intact.dedupKey,
      altKeyMatches: altKeyProbe(intact),
    };
    const widened = chooseArticle(
      await findArticleCandidates(harness.db, widenedProbe),
      widenedProbe,
    );
    expect(widened).toMatchObject({ kind: "match", by: "neighbour" });
    expect(widened.kind === "match" && widened.article.id).toBe(neighbour.id);

    // Degraded: the sighting was KEYED on a headline it did not STORE, so
    // re-deriving from its own stored fields does not reproduce the key it
    // carries and the probe falls back to that one key. This is the live shape
    // of the risk rather than an invented one — `deriveArticleIdentity` closed
    // the DOMAIN axis of the check, and `title` and `published` still travel
    // into `finalizeSighting` beside the identity rather than inside it, so an
    // adapter that stripped a headline before storing it while keying on the raw
    // one breaks exactly this way.
    const degraded = bare({
      altKey: deriveAltKey(domain, `Raw wire headline: ${title}`, ownDayIso),
    });
    expect(altKeyProbeIsConsistent(degraded)).toBe(false);
    expect(altKeyProbe(degraded)).toEqual([degraded.altKey]);

    const degradedProbe: FoldProbe = {
      dedupKey: degraded.dedupKey,
      altKeyMatches: altKeyProbe(degraded),
    };
    const oldWay = await chooseTheOldWay(
      harness.db,
      hexToBytea(degradedProbe.dedupKey),
      degradedProbe.altKeyMatches.map(hexToBytea),
    );
    const newWay = chooseArticle(
      await findArticleCandidates(harness.db, degradedProbe),
      degradedProbe,
    );

    // Both agree, and both MINT: the own-day key names nothing, and a one-key
    // probe has no neighbour to fall back to. Identical to the pre-widening
    // behaviour, which is what makes the degradation a return to the old path.
    expect(oldWay).toBeUndefined();
    expect(newWay).toEqual({ kind: "mint" });
  });
});

/* ------------------------------------------------------------------ *
 * PART 2 — the per-field entitlement (ADR-0002, ADR-0021)
 * ------------------------------------------------------------------ */

/** Every column the fold's UPDATE writes, in the order it is compared. */
const WRITTEN_COLUMNS = [
  "url",
  "title",
  "description",
  "author",
  "image_url",
  "language",
  "categories",
  "source_category",
  "source_domain",
  "provider",
  "published",
  "latest_seen",
  "sighting_count",
] as const;

/**
 * `main`'s fold UPDATE, transcribed: the two derived predicates and all eleven
 * SET lines, exactly as they were written out.
 *
 * The duplication with `foldSet` is the point of the file. Do not deduplicate
 * it, and do not "improve" it — its only job is to still say what `main` said.
 */
async function foldTheOldWay(
  db: Kysely<Database>,
  articleId: string,
  sighting: Sighting,
  published: Date,
): Promise<void> {
  const movesTheClock = sighting.publishedIsDateOnly !== true;
  const firstHand = sighting.isAggregatorCopy !== true;

  const earlier = movesTheClock ? sql`${published} < published` : sql`false`;
  const earlierFirstHand = firstHand ? earlier : sql`false`;

  await db
    .updateTable("articles")
    .set({
      sighting_count: sql`sighting_count + 1`,
      published: movesTheClock ? sql`least(published, ${published})` : sql`published`,
      latest_seen: movesTheClock ? sql`greatest(latest_seen, ${published})` : sql`latest_seen`,
      url: sql`case when ${earlierFirstHand} then ${sighting.url} else url end`,
      title: sql`case when ${earlierFirstHand} then ${sighting.title} else title end`,
      description: sql`case when ${earlierFirstHand} then ${sighting.description} else description end`,
      author: sql`case when ${earlierFirstHand} then ${sighting.author} else author end`,
      image_url: sql`case when ${earlierFirstHand} then ${sighting.imageUrl} else image_url end`,
      language: sql`case when ${earlierFirstHand} then ${sighting.language} else language end`,
      categories: sql`case when ${earlierFirstHand} then ${sighting.categories}::text[] else categories end`,
      source_category: sql`case when ${earlierFirstHand} then ${sighting.sourceCategories}::text[] else source_category end`,
      source_domain: sql`case when ${earlierFirstHand} then ${sighting.sourceDomain} else source_domain end`,
      provider: sql`case when ${earlier} then ${sighting.provider} else provider end`,
    })
    .where("id", "=", articleId)
    .execute();
}

describe("the per-field entitlement, old SET lines against the new render", () => {

  /** The article as it stands BEFORE the fold: every governed column populated. */
  const STORED = {
    url: "https://outlet.example.com/the-newsrooms-record",
    title: "The newsroom's own headline",
    description: "Crews worked through the night.",
    author: "Jane Reporter",
    image_url: "https://outlet.example.com/hero.jpg",
    language: "en",
    categories: ["world"],
    source_category: ["regional"],
    source_domain: "outlet.example.com",
    provider: "currents",
    published: new Date("2026-08-13T12:00:00.000Z"),
    latest_seen: new Date("2026-08-13T12:00:00.000Z"),
  };

  /**
   * The arriving sighting, DIFFERENT in every governed column — so a handover
   * that fires is visible on all nine and an equal outcome is never equal by
   * accident. Asserted below rather than trusted.
   */
  const arriving = (input: {
    published: string;
    isAggregatorCopy?: boolean;
    publishedIsDateOnly?: boolean;
  }): Sighting => ({
    id: "00000000-0000-4000-8000-00000000e000",
    url: "https://news.google.example/rss/articles/CBMiENTITLE?oc=5",
    provider: "google-news",
    providerSightingId: "CBMiENTITLE",
    dedupKey: deriveDedupKey("https://news.google.example/rss/articles/CBMiENTITLE?oc=5"),
    altKey: null,
    title: "The aggregator's rendering - Outlet Name",
    description: null,
    author: null,
    imageUrl: null,
    language: "de",
    categories: [],
    sourceCategories: [],
    sourceDomain: "aggregator.example",
    published: input.published,
    ...(input.isAggregatorCopy === undefined
      ? {}
      : { isAggregatorCopy: input.isAggregatorCopy }),
    ...(input.publishedIsDateOnly === undefined
      ? {}
      : { publishedIsDateOnly: input.publishedIsDateOnly }),
    raw: {},
  });

  /** Two byte-identical articles, one for each implementation to fold onto. */
  const twins = async (namespace: string): Promise<{ old: string; now: string }> => {
    const insert = async (label: string): Promise<string> => {
      const row = await harness.db
        .insertInto("articles")
        .values({
          ...STORED,
          // The only difference, and it is forced: `dedup_key` is unique. It is
          // not a column the fold writes, so it is not compared.
          dedup_key: hexToBytea(key(`${namespace}:${label}`)),
          alt_key: null,
          sighting_count: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    };
    return { old: await insert("old"), now: await insert("new") };
  };

  const readColumns = async (articleId: string) =>
    harness.db
      .selectFrom("articles")
      .select([...WRITTEN_COLUMNS])
      .where("id", "=", articleId)
      .executeTakeFirstOrThrow();

  /**
   * `movesTheClock` × `firstHand` × (incoming earlier / later / equal), against
   * all thirteen columns the statement writes.
   *
   * The two claims are expressed as the adapter expresses them — an ABSENT flag,
   * not `false` — because that is what every adapter but Google News sends and
   * what every stored row predating them carries, and `!== true` is the whole of
   * the guard. A test that wrote `false` would never exercise the path
   * production runs on.
   */
  const STAMPS = {
    earlier: "2026-08-13T08:00:00.000Z",
    equal: "2026-08-13T12:00:00.000Z",
    later: "2026-08-13T16:00:00.000Z",
  } as const;

  it("writes identical rows for every claim, every stamp and every column", async () => {
    const disagreements: string[] = [];
    let compared = 0;

    for (const dateOnly of [undefined, true] as const) {
      for (const aggregator of [undefined, true] as const) {
        for (const [when, stamp] of Object.entries(STAMPS)) {
          const namespace = `fold-${String(dateOnly)}-${String(aggregator)}-${when}`;
          const ids = await twins(namespace);
          const sighting = arriving({
            published: stamp,
            publishedIsDateOnly: dateOnly,
            isAggregatorCopy: aggregator,
          });
          const published = new Date(sighting.published);

          await foldTheOldWay(harness.db, ids.old, sighting, published);
          await harness.db
            .updateTable("articles")
            .set(foldSet(sighting, published, fieldAuthority(sighting)))
            .where("id", "=", ids.now)
            .execute();

          const [before, after] = await Promise.all([
            readColumns(ids.old),
            readColumns(ids.now),
          ]);
          for (const column of WRITTEN_COLUMNS) {
            compared += 1;
            const a = JSON.stringify(before[column]);
            const b = JSON.stringify(after[column]);
            if (a !== b) disagreements.push(`${namespace} / ${column}: old=${a} new=${b}`);
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
    expect(compared).toBe(12 * WRITTEN_COLUMNS.length);
  });

  /**
   * The differential above proves the two agree; it cannot prove they agree
   * about anything. This is what says the handover it is comparing actually
   * FIRES — the control ADR-0021's own test block leads with, for the same
   * reason: a refusal proves nothing unless the thing being refused would
   * otherwise happen.
   *
   * So: the control case (neither flag, earlier stamp) must move all nine
   * display fields off their stored values, and each of the three refusals must
   * leave a strictly larger set of them alone.
   */
  it("the cases it compares are cases where the fold changes something", async () => {
    /** The nine display columns, sorted the way `moved` reports them. */
    const DISPLAY = [
      "author",
      "categories",
      "description",
      "image_url",
      "language",
      "source_category",
      "source_domain",
      "title",
      "url",
    ];

    /** Which of the twelve non-counter columns this fold actually moved. */
    const moved = async (
      namespace: string,
      when: keyof typeof STAMPS,
      claims: { publishedIsDateOnly?: true; isAggregatorCopy?: true },
    ) => {
      const ids = await twins(namespace);
      const sighting = arriving({ published: STAMPS[when], ...claims });
      await foldTheOldWay(harness.db, ids.old, sighting, new Date(sighting.published));
      const row = await readColumns(ids.old);
      return WRITTEN_COLUMNS.filter(
        (column) =>
          column !== "sighting_count" &&
          JSON.stringify(row[column]) !== JSON.stringify(STORED[column]),
      )
        .map(String)
        .sort();
    };

    // ADR-0002 unchanged, on an earlier stamp: the whole display handover, plus
    // `provider` and `published`. `latest_seen` is absent because `greatest`
    // cannot move an article's last sighting BACKWARDS — which is why the later
    // stamp below is the case that exercises it.
    expect(await moved("control-earlier", "earlier", {})).toEqual(
      [...DISPLAY, "provider", "published"].sort(),
    );
    // A later stamp is not the earliest emission, so it hands over nothing and
    // moves `latest_seen` alone. The ordinary re-emission, and the overwhelming
    // majority of real folds.
    expect(await moved("control-later", "later", {})).toEqual(["latest_seen"]);
    // An equal stamp is not EARLIER — the test is strict — so it moves nothing.
    expect(await moved("control-equal", "equal", {})).toEqual([]);

    // An aggregator's copy with an honest, genuinely earlier clock: the nine
    // display fields hold, and the two facts about the EMISSION move. This is
    // the leading-edge regime, where 9 of the 12 measured URL losses sat and
    // where `publishedIsDateOnly` is no defence at all (ADR-0021).
    expect(await moved("aggregator-earlier", "earlier", { isAggregatorCopy: true })).toEqual(
      ["provider", "published"].sort(),
    );

    // A bare date moves NOTHING, in either direction and `provider` included —
    // `latest_seen` frozen with `published`, which ADR-0021 argues separately
    // because the earliest-emission argument does not reach it: a fabricated
    // 07:00Z boundary must not be able to claim a story was updated.
    expect(await moved("bare-earlier", "earlier", { publishedIsDateOnly: true })).toEqual([]);
    expect(await moved("bare-later", "later", { publishedIsDateOnly: true })).toEqual([]);
    expect(
      await moved("both", "earlier", { publishedIsDateOnly: true, isAggregatorCopy: true }),
    ).toEqual([]);
  });
});
