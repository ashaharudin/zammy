import { describe, expect, it } from "vitest";
import {
  chooseArticle,
  fieldAuthority,
  type ArticleCandidate,
  type FoldProbe,
  type HandoverScope,
  type MatchArm,
} from "./fold.js";

/**
 * The fold's two truth tables, as tables (ADR-0018, ADR-0021, ADR-0022).
 *
 * These used to be asserted end-to-end, through a throwaway Postgres database
 * per describe block — which asserts a truth table at one sample per database
 * and prices every additional row at a migration. They are decisions over
 * domain values, so they are asserted as decisions here, exhaustively, and the
 * end-to-end path keeps its own tests in `ingest.test.ts`.
 *
 * **The expected column is hand-written from the ADRs, not computed.** A table
 * whose expectations were derived would agree with the implementation by
 * construction; what makes this worth having is that a reader can check each row
 * against the prose. `fold-differential.test.ts` is the other half of the same
 * claim, and it is the one that needs Postgres: it replays the SQL these
 * decisions were lifted out of, over the same inputs.
 */

/** A key that is a key, since nothing here hashes anything. */
const key = (label: string): string => `${label}-key`;

const URL_KEY = key("url");
const OWN_DAY = key("own-day");
const PREV_DAY = key("prev-day");
const NEXT_DAY = key("next-day");
/** An alt key the probe never asks for — what the `U` row below carries. */
const DRIFTED = key("drifted");

/**
 * The rows an archive can put in front of one probe (ADR-0018, ADR-0022).
 *
 *  - `U`  answers the URL key and carries an alt key of its own that the probe
 *         never asks for. The ADR-0018 shape where the URL and the fallback
 *         point at DIFFERENT articles, which is the whole reason for an order.
 *  - `UO` answers the URL key AND the own-day key: one row, both keys. Mutually
 *         exclusive with `U` and with `O`, since a row holds one of each.
 *  - `O`  answers the sighting's OWN day, under a URL never seen before — the
 *         411 production duplicates in one row.
 *  - `M`  answers the D-1 neighbour; `P` the D+1 one. Reachable only for a
 *         bare-dated sighting, and never for the same row: `alt_key` is one
 *         column, so two neighbour keys matching is two different articles.
 */
const ROWS = {
  U: { id: "10", dedupKey: URL_KEY, altKey: DRIFTED },
  UO: { id: "11", dedupKey: URL_KEY, altKey: OWN_DAY },
  O: { id: "20", dedupKey: key("o-url"), altKey: OWN_DAY },
  M: { id: "30", dedupKey: key("m-url"), altKey: PREV_DAY },
  P: { id: "40", dedupKey: key("p-url"), altKey: NEXT_DAY },
} as const;
type Slot = keyof typeof ROWS;

const candidate = (slot: Slot): ArticleCandidate => ({
  id: ROWS[slot].id,
  published: new Date("2026-08-25T12:00:00.000Z"),
  group_id: ROWS[slot].id,
  dedupKey: ROWS[slot].dedupKey,
  altKey: ROWS[slot].altKey,
});

/**
 * Which of the archive's rows the RETRIEVAL would return for a probe: every row
 * answering the URL key or any key in the probe.
 *
 * Here rather than in the table because it is not the decision — it is the
 * `where` clause `findArticleCandidates` runs, and a table that listed the
 * retrieved subset per row would be asserting the query rather than the rule.
 * The query itself is asserted against Postgres in the differential harness.
 */
function retrieved(archive: readonly Slot[], probe: FoldProbe): ArticleCandidate[] {
  return archive
    .filter((slot) => {
      const row = ROWS[slot];
      return (
        row.dedupKey === probe.dedupKey ||
        probe.altKeyMatches.includes(row.altKey)
      );
    })
    .map(candidate)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** Every probe width `altKeyProbe` can produce (see its `filter`). */
const PROBES = {
  /** `altKey === null` — a source-truncated title, no source domain. */
  none: [],
  /** One key: every sighting that is not bare-dated, and every DEGRADED one. */
  single: [OWN_DAY],
  /** A bare date one of whose neighbours folded to nothing, or to its own key. */
  two: [OWN_DAY, NEXT_DAY],
  /** The widened set ADR-0022 exists for. */
  widened: [OWN_DAY, PREV_DAY, NEXT_DAY],
} as const;
type ProbeWidth = keyof typeof PROBES;

const probeFor = (width: ProbeWidth): FoldProbe => ({
  dedupKey: URL_KEY,
  altKeyMatches: PROBES[width],
});

/** What one row of the table says the fold does. */
type Outcome = MatchArm | "refuse" | "mint";

/**
 * **The precedence, whole.** Every reachable archive shape against every probe
 * width — 20 × 4, nothing sampled.
 *
 * Read a row as: "the archive holds these rows; a sighting arrives with a probe
 * this wide; the fold does this." Every expectation is from the ADRs:
 *
 *  - **URL first, always** (ADR-0018). The `U` column is `url` at every width,
 *    including where the drifted alt key names another row entirely. Titles
 *    drift and URLs do not.
 *  - **The own day beats a neighbour** (ADR-0022): the own-day key is the
 *    provider's own assertion; a neighbour is this system's allowance for the
 *    fact that the assertion is a date.
 *  - **A key outside the probe is not a match.** `M` under a `two` probe is
 *    `mint`, not `neighbour` — the D-1 key was never asked for. This is the
 *    degradation column: a probe that narrows resolves as a never-widened one
 *    does, which is what makes `altKeyProbe`'s fallback a return to the old path.
 *  - **One neighbour folds; two refuse** (ADR-0022). `M+P` under `widened` is
 *    the recurring-column signature, and refusing it mints the instalment under
 *    its own day. `M` or `P` alone is the shape all 23 recovered folds have, so
 *    it folds — refusing it would give the whole widening back.
 *  - **`none` reaches nothing but the URL.** A keyless sighting takes the
 *    pre-ADR-0018 path in full.
 */
const PRECEDENCE: Array<[Slot[], Record<ProbeWidth, Outcome>]> = [
  [[], { none: "mint", single: "mint", two: "mint", widened: "mint" }],
  [["P"], { none: "mint", single: "mint", two: "neighbour", widened: "neighbour" }],
  [["M"], { none: "mint", single: "mint", two: "mint", widened: "neighbour" }],
  [["M", "P"], { none: "mint", single: "mint", two: "neighbour", widened: "refuse" }],
  [["O"], { none: "mint", single: "own-day", two: "own-day", widened: "own-day" }],
  [["O", "P"], { none: "mint", single: "own-day", two: "own-day", widened: "own-day" }],
  [["O", "M"], { none: "mint", single: "own-day", two: "own-day", widened: "own-day" }],
  [["O", "M", "P"], { none: "mint", single: "own-day", two: "own-day", widened: "own-day" }],
  [["U"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "P"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "M"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "M", "P"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "O"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "O", "P"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "O", "M"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["U", "O", "M", "P"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["UO"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["UO", "P"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["UO", "M"], { none: "url", single: "url", two: "url", widened: "url" }],
  [["UO", "M", "P"], { none: "url", single: "url", two: "url", widened: "url" }],
];

describe("chooseArticle — URL key, then the own day, then one neighbour", () => {
  it("covers every reachable archive shape exactly once", () => {
    // The table is the coverage claim, so the claim is checked: 16 free subsets
    // of {U, O, M, P} plus the four where the URL row IS the own-day row. A
    // shape missing from it would otherwise be a silent gap.
    expect(PRECEDENCE).toHaveLength(20);
    expect(new Set(PRECEDENCE.map(([archive]) => archive.join("+"))).size).toBe(20);
  });

  for (const [archive, expected] of PRECEDENCE) {
    const label = archive.join("+") || "an empty archive";
    for (const width of Object.keys(PROBES) as ProbeWidth[]) {
      it(`${label}, probed ${width}: ${expected[width]}`, () => {
        const probe = probeFor(width);
        const verdict = chooseArticle(retrieved(archive, probe), probe);

        expect(verdict.kind === "match" ? verdict.by : verdict.kind).toBe(expected[width]);

        // And the row is the one the arm names, not merely SOME row: an arm
        // reported right over a row chosen wrong is the silent merge this whole
        // module exists to prevent.
        if (verdict.kind !== "match") return;
        if (verdict.by === "url") {
          expect(verdict.article.dedupKey).toBe(probe.dedupKey);
        } else if (verdict.by === "own-day") {
          expect(verdict.article.altKey).toBe(probe.altKeyMatches[0]);
        } else {
          expect(probe.altKeyMatches.slice(1)).toContain(verdict.article.altKey);
        }
      });
    }
  }

  /**
   * ADR-0018's flagship case, stated as prose because the table cannot say WHY:
   * an outlet edits a headline into something another story on the same day
   * already said, so one row matches by URL and a DIFFERENT row matches by alt
   * key. URLs are stable and titles drift, so the URL is what this must believe.
   */
  it("takes the URL match when the URL and the alt key point at different rows", () => {
    const probe: FoldProbe = { dedupKey: URL_KEY, altKeyMatches: [DRIFTED] };
    const verdict = chooseArticle([candidate("U"), candidate("O")], probe);
    expect(verdict).toMatchObject({ kind: "match", by: "url" });
    expect(verdict.kind === "match" && verdict.article.id).toBe(ROWS.U.id);
  });

  /**
   * The refusal, and what it costs: the instalment mints its own row under its
   * own day. Picking either neighbour would file Tuesday's sighting against
   * Monday's and Tuesday's article would never be minted at all — losing an
   * article, which ADR-0002 settles as the worse error against a visible
   * duplicate.
   */
  it("refuses the fallback when both neighbours match and the own day does not", () => {
    const probe = probeFor("widened");
    expect(chooseArticle([candidate("M"), candidate("P")], probe)).toEqual({ kind: "refuse" });
  });

  /**
   * `refuse` and `mint` are different facts and the same consequence, and the
   * distinction is only worth having if it is exact: an EMPTY candidate set is
   * never a refusal, however wide the probe.
   */
  it("mints rather than refuses when nothing matched at all", () => {
    for (const width of Object.keys(PROBES) as ProbeWidth[]) {
      expect(chooseArticle([], probeFor(width))).toEqual({ kind: "mint" });
    }
  });

  /**
   * A row identified by URL ALONE — `alt_key` null, which is what every article
   * was before ADR-0018 and what a source-truncated title still mints — resolves
   * by the URL arm at every probe width.
   *
   * This is the case the SQL's `coalesce(alt_key = $1, false)` was written for:
   * `null = $1` is NULL rather than false, so such a row came back with a `null`
   * under a `boolean` type, and the old code read correctly only because
   * `by_url` short-circuited ahead of it. The re-expression must not depend on
   * that short-circuit, and the arm it reports is what says it does not.
   */
  it("resolves a row carrying no alt key at all by the URL arm", () => {
    const keyless: ArticleCandidate = { ...candidate("U"), altKey: null };
    for (const width of Object.keys(PROBES) as ProbeWidth[]) {
      const verdict = chooseArticle([keyless], probeFor(width));
      expect(verdict).toMatchObject({ kind: "match", by: "url" });
    }
  });

  /**
   * The fence's soundness is a claim about which ARM matched, so the arm is
   * reported: a lost alt-key race raises on the key that was INSERTED, which is
   * always `altKeyProbe`'s first element, so the winner answers the own-day arm
   * and the refusal is never reached from the fence (ADR-0022).
   */
  it("names the own-day arm for the row a lost alt-key race would find", () => {
    const probe = probeFor("widened");
    const verdict = chooseArticle([candidate("O")], probe);
    expect(verdict).toMatchObject({ kind: "match", by: "own-day" });
  });
});

/**
 * **The entitlement, whole** (ADR-0021). Two claims an adapter makes about its
 * own sighting, and the 2×2 collapses to three scopes because `movesTheClock`
 * dominates: it neutralizes the EARLIER test every handover fires on, so a
 * first-hand bare date hands over exactly as little as an aggregator's bare date.
 *
 * The claims are written as the adapter writes them — an ABSENT flag rather than
 * `false` — because that is what every adapter but Google News sends and what
 * every stored row predating them carries. A table that wrote `false` would not
 * exercise the path production runs on.
 */
const ENTITLEMENT: Array<{
  dateOnly: true | undefined;
  aggregator: true | undefined;
  movesTheClock: boolean;
  firstHand: boolean;
  handsOver: HandoverScope;
}> = [
  // Neither flag: ADR-0002 unchanged, which is every adapter but one.
  {
    dateOnly: undefined,
    aggregator: undefined,
    movesTheClock: true,
    firstHand: true,
    handsOver: "all",
  },
  // An aggregator's copy with an honest clock — the leading-edge regime, where
  // 9 of the 12 measured URL losses sat and a timestamp gate catches nothing.
  {
    dateOnly: undefined,
    aggregator: true,
    movesTheClock: true,
    firstHand: false,
    handsOver: "provider-only",
  },
  // A bare date from a FIRST-HAND provider. Unobserved — no such adapter exists
  // — and it is in the table because the rule must not depend on that: one
  // degraded field would otherwise recruit all the others.
  {
    dateOnly: true,
    aggregator: undefined,
    movesTheClock: false,
    firstHand: true,
    handsOver: "nothing",
  },
  // Both, which is what Google News past about eight days actually sends.
  {
    dateOnly: true,
    aggregator: true,
    movesTheClock: false,
    firstHand: false,
    handsOver: "nothing",
  },
];

describe("fieldAuthority — what a sighting is entitled to hand over", () => {
  it("covers the 2×2 exactly once", () => {
    expect(ENTITLEMENT).toHaveLength(4);
  });

  for (const row of ENTITLEMENT) {
    const label = `dateOnly=${String(row.dateOnly)} aggregator=${String(row.aggregator)}`;
    it(`${label} hands over ${row.handsOver}`, () => {
      expect(
        fieldAuthority({
          ...(row.dateOnly === undefined ? {} : { publishedIsDateOnly: row.dateOnly }),
          ...(row.aggregator === undefined ? {} : { isAggregatorCopy: row.aggregator }),
        }),
      ).toEqual({
        movesTheClock: row.movesTheClock,
        firstHand: row.firstHand,
        handsOver: row.handsOver,
      });
    });
  }

  /**
   * `!== true` rather than `=== false` is the whole of the guard, and it has to
   * be: both fields are optional so that every adapter predating them keeps its
   * old behaviour. An explicit `false` must therefore read the same as absent.
   */
  it("reads an explicit false exactly as it reads an absent flag", () => {
    expect(fieldAuthority({ publishedIsDateOnly: false, isAggregatorCopy: false })).toEqual(
      fieldAuthority({}),
    );
  });
});
