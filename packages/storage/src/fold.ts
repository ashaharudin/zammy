import type { Sighting } from "@zammy/news-client";

/**
 * The fold — **which article a sighting belongs to, and what it is entitled to
 * say about it** (ARCHITECTURE 7.4, ADR-0002).
 *
 * Two decisions, and neither needs a database to MAKE. `ingest.ts` still needs
 * one to fetch the candidates and to apply the result, and the two things
 * Postgres uniquely does — `ON CONFLICT (dedup_key)` arbitrating a concurrent
 * insert, the savepoint fencing the alt-key race — stay there. What moved here
 * is the part that is a rule rather than an arithmetic:
 *
 *  - `chooseArticle` — the precedence and the refusal. **URL key beats an
 *    own-day alt key beats a neighbour, and two neighbours naming different
 *    articles is a refusal** (ADR-0018, ADR-0022).
 *  - `fieldAuthority` — what one sighting may hand over. **The earliest
 *    emission wins every field it is ENTITLED to, and entitlement is per-field**
 *    (ADR-0021).
 *
 * ## Why this is a module rather than a shape in the SQL
 *
 * It was welded into the statements that performed it: the precedence lived in
 * `findArticleCandidates`'s `order by (dedup_key = …) desc, (alt_key = …) desc`,
 * and the entitlement in ten hand-written `case when … then … else … end` lines
 * that had to agree with each other by inspection. Both are truth tables the
 * ADRs state in prose, and a truth table asserted through a throwaway Postgres
 * database is asserted at one sample per database.
 *
 * The failure that makes this worth doing is the one ADR-0002 and ADR-0018
 * exist to prevent, and it does not raise: a wrong fold silently merges two
 * different articles into one, or splits one into two, and nothing surfaces it.
 * A decision expressible as a table should be asserted as one.
 *
 * `fold-differential.test.ts` is what says the re-expression is faithful — it
 * replays the OLD SQL and the decisions below over the same candidate sets and
 * the same articles, and it is kept for the next change to either rule.
 */

/**
 * One row the fold could resolve onto: an `articles` row whose `dedup_key` or
 * `alt_key` matched something in the probe.
 *
 * The two keys travel as the hex they are stored as, so the decision below can
 * say WHICH arm matched rather than being handed a pre-chewed boolean by the
 * query. That is the difference between a candidate and a verdict, and keeping
 * it on this side is what lets the truth table be exercised without a database.
 */
export interface ArticleCandidate {
  id: string;
  /**
   * `published` as it stands BEFORE the arriving sighting — what makes
   * `ingestSightings`' storyline guard free, since the alternative is asking the
   * row again after the fold.
   */
  published: Date;
  group_id: string;
  /** `articles.dedup_key`, hex. Unique across `articles`. */
  dedupKey: string;
  /** `articles.alt_key`, hex — null for a row identified by URL alone. */
  altKey: string | null;
}

/**
 * The keys ONE sighting may be resolved against (ADR-0018, ADR-0022).
 *
 * `altKeyMatches` is `altKeyProbe`'s output, verbatim: one key for every
 * sighting that has one, three for a bare-dated one whose own fields re-derive
 * the key it carries, and **none at all when `altKey` is null**. Its first
 * element is the sighting's own day, and that ordering is load-bearing — see
 * `chooseArticle`.
 *
 * **It can arrive DEGRADED and the decision must not assume otherwise.** A
 * bare-dated sighting whose `altKeyProbeIsConsistent` check fails falls back to
 * the single stored key, which is the behaviour before the widening existed. So
 * "three keys" is a property of the probe rather than of the flag, and nothing
 * below reads `publishedIsDateOnly`: a one-key probe resolves exactly as a
 * never-widened one does, which is what makes the degradation a return to the
 * old path rather than a guess.
 */
export interface FoldProbe {
  /** sha256 of the canonical URL, hex — the primary identity. */
  dedupKey: string;
  /** `altKeyProbe(sighting)`, own day first. Empty when there is no alt key. */
  altKeyMatches: readonly string[];
}

/**
 * What the fold decided.
 *
 * `refuse` and `mint` both end in an insert, and they are named apart anyway
 * because they are different facts: `mint` is "no row answers to any of these
 * keys", and `refuse` is "the fallback found candidates and declined them". One
 * is the ordinary case and the other is the shape ADR-0022 prices and accepts,
 * so a caller that ever wants to count them can.
 */
export type FoldVerdict =
  | { kind: "match"; article: ArticleCandidate; by: MatchArm }
  | { kind: "refuse" }
  | { kind: "mint" };

/**
 * Which arm of ADR-0018's ordering named the row. Reported because the
 * savepoint fence's soundness is a claim about exactly this: a lost alt-key
 * race raises on the key that was INSERTED, which is always the own-day key, so
 * the winner is found by `own-day` and never by a refusable arm (ADR-0022).
 */
export type MatchArm = "url" | "own-day" | "neighbour";

/**
 * Pick the article a sighting belongs to — **URL key → own-day alt key →
 * a single neighbour → refuse** (ADR-0018, ADR-0022).
 *
 * The ordering is the whole design and is not an implementation detail. Titles
 * drift and URLs do not, so a `(domain, title, day)` key consulted FIRST would
 * split an article whose headline was edited between two emissions — a
 * regression URL identity does not have. Consulted SECOND, it can only ever
 * catch a URL that has never been seen before, which is exactly the case URL
 * identity was already failing: 411 rows of the production archive (1.1%) are
 * one story filed under several URLs.
 *
 * ## The second tier, and why a neighbour loses to the own day
 *
 * `altKeyProbe` hands one key for every sighting but a bare-dated one, which
 * gets its own day plus the two adjacent ones (ADR-0022). A match on the
 * sighting's OWN day beats a match on a neighbour because the own-day key is the
 * provider's own assertion and a neighbour is this system's allowance for the
 * fact that the assertion is a date and the archive holds a clock reading.
 *
 * ## And why BOTH neighbours matching is a refusal rather than a tie-break
 *
 * `dedup_key` and `alt_key` are each unique, so a match on the URL key or on
 * the own-day key names exactly one row and there is nothing to break a tie
 * about. The only ambiguous shape is the own day matching NOTHING while both
 * neighbours match — and since `alt_key` is one column per row, two neighbour
 * keys matching is necessarily two different articles. Picking either would
 * fold a Tuesday instalment onto Monday's row and Tuesday's article would never
 * be minted at all — losing an article, which ADR-0002 settles as the worse
 * error against showing a duplicate. So the fallback is refused and the sighting
 * mints its own row under its own day, exactly as it did before the widening
 * existed.
 *
 * **This is a tie-break's replacement, NOT a defence against the
 * recurring-column risk, and it must not be read as one.** The damaging shape
 * for a daily column is ONE neighbour matching, not two — a column running every
 * day has an instalment on each side only where the archive happens to hold both
 * — and one neighbour matching is exactly the shape all 23 recovered folds have,
 * so it cannot be refused without giving the whole widening back. Counted over
 * the four desk columns ADR-0022 names, of the 40 days where a bare-dated
 * instalment would find no own-day article, this refuses **2 and folds 38**. The
 * exposure is accepted and measured, not closed; see ADR-0022.
 *
 * The refusal costs nothing measured: over the 1,749 bare-date sightings the dev
 * archive holds, the widened set matched articles on more than one day **0
 * times**. It is a guard for a shape that is reachable rather than observed.
 *
 * ## What it assumes about `candidates`, and what it does not
 *
 * It assumes only that they are every row matching the probe — the caller's
 * query is a retrieval, and this is the whole of the decision over what it
 * returned. **Order is not part of the input contract for any reachable shape**:
 * both keys are unique, so at most one candidate answers the URL arm and at most
 * one answers the own-day arm, and the neighbour arm resolves on the SET of ids
 * rather than on a position. `findArticleCandidates` hands them over in `id`
 * order anyway, because a limit over an unordered read is a different article on
 * different days and that failure would be silent.
 */
export function chooseArticle(
  candidates: readonly ArticleCandidate[],
  probe: FoldProbe,
): FoldVerdict {
  // The URL key first, and unconditionally: it is unique on `articles`, so this
  // names at most one row, and in the rare case where one row matches by URL and
  // a DIFFERENT row matches by alt key — a title that has since drifted onto
  // another article's key — this is the one that is taken.
  const byUrl = candidates.find((row) => row.dedupKey === probe.dedupKey);
  if (byUrl) return { kind: "match", article: byUrl, by: "url" };

  // `altKeyMatches[0]` is the sighting's own day, or nothing at all when the
  // sighting carries no alt key. A candidate's `altKey` is nullable, so the
  // comparison has to be against a key that exists: `null === undefined` is
  // false in TypeScript, but leaving the tier in for a probe with no keys would
  // read as though a keyless sighting could match a keyless row.
  const ownDay = probe.altKeyMatches[0];
  if (ownDay !== undefined) {
    const byOwnDay = candidates.find((row) => row.altKey === ownDay);
    if (byOwnDay) return { kind: "match", article: byOwnDay, by: "own-day" };
  }

  if (candidates.length === 0) return { kind: "mint" };

  // Only neighbours are left. One article is the fold this widening exists for;
  // two is the recurring-column signature, and the header says why that refuses.
  // Counted over ids rather than over rows because that is what the SQL this
  // replaces counted, and the two differ if a row is ever returned twice.
  const ids = new Set(candidates.map((row) => row.id));
  if (ids.size > 1) return { kind: "refuse" };
  return { kind: "match", article: candidates[0]!, by: "neighbour" };
}

/**
 * What an arriving sighting may hand over to the article it folded onto, beyond
 * being counted (ADR-0021).
 *
 * A DESCRIPTION rather than an instruction: it says what this sighting is
 * entitled to, and `ingest.ts` renders that into one `UPDATE`. The two claims
 * are kept beside the scope they produce because they are not the same kind of
 * thing — the claims are what the ADAPTER asserted, and the scope is what this
 * system does about it.
 */
export interface FieldAuthority {
  /**
   * **This sighting's timestamp is a real publication time**, so it may move
   * `published` and `latest_seen` — and, because it can drag an article earlier,
   * the group's keyset position and its storylines' day slots with them.
   *
   * False for a sighting whose provider sent a bare DATE. Such a sighting is
   * stored, carries its own timestamp on its own row, and is counted: it is a
   * real observation of a real article and is recorded as one. What it may not
   * do is redefine an article somebody else timed properly.
   */
  movesTheClock: boolean;
  /**
   * **This is the newsroom's own record rather than an aggregator's rendering of
   * it.** False for an aggregator's copy, whose `url` is a redirect it cannot
   * resolve and whose display fields are its own chrome.
   */
  firstHand: boolean;
  /** Which fields an EARLIER emission of this sighting may hand over. */
  handsOver: HandoverScope;
}

/**
 * The three entitlements a sighting can carry, from a 2×2 of claims.
 *
 *  - `all` — ADR-0002 unchanged: the earliest emission wins every display
 *    field, and `provider` with them. What every adapter but Google News sends,
 *    and what every row predating the two flags carries.
 *  - `provider-only` — an aggregator's copy with an honest clock. It really did
 *    see the article and really did see it when it says, so the timestamp fold
 *    and `provider` stand; the nine display fields do not, because a `CBM…`
 *    redirect and a ` - Outlet` headline are not the better record even when
 *    they genuinely came first. Measured: 9 of the 12 URL losses in the
 *    leading-edge run were exactly this case (ADR-0021).
 *  - `nothing` — a bare date. It hands over nothing at all, `provider`
 *    included, because the comparison every handover is gated on reads a
 *    timestamp whose inputs are known to be fabricated. One degraded field
 *    would otherwise recruit all the others.
 *
 * The 2×2 collapses to three because `movesTheClock` dominates: a first-hand
 * bare date and an aggregator's bare date both hand over nothing, since the
 * EARLIER test they would fire on is neutralized before either is consulted.
 */
export type HandoverScope = "all" | "provider-only" | "nothing";

/**
 * Read the two claims an adapter made about its own sighting (ADR-0021).
 *
 * Both are absent on every adapter but Google News and on every row predating
 * them, so `!== true` is the whole of the guard and the untouched path behaves
 * exactly as it did. Written that way rather than as `=== false` on purpose:
 * the fields are optional, and "absent" has to mean "a first-hand record with an
 * honest clock" for every adapter that never heard of them.
 *
 * **Nothing here can enforce that an adapter sets either one.**
 * `finalizeSighting` takes `unknown`, so an object literal gets no compile-time
 * push. The mitigation is `zammy_sightings_stamped_total` and the structured log
 * field beside it, read INVERTED — a `date_only` share falling to zero means the
 * detector stopped matching, not that the provider improved (ADR-0021). And
 * since ADR-0022 the same flag is load-bearing in the opposite direction as
 * well, as the PERMISSION that widens the lookup, so a broken detector now
 * loses a fold as well as gaining a bad handover.
 */
export function fieldAuthority(
  sighting: Pick<Sighting, "publishedIsDateOnly" | "isAggregatorCopy">,
): FieldAuthority {
  const movesTheClock = sighting.publishedIsDateOnly !== true;
  const firstHand = sighting.isAggregatorCopy !== true;
  return {
    movesTheClock,
    firstHand,
    handsOver: !movesTheClock ? "nothing" : firstHand ? "all" : "provider-only",
  };
}

/**
 * The nine `articles` columns ADR-0002's display handover governs — the ones an
 * earlier FIRST-HAND emission takes over, and an aggregator's copy does not.
 *
 * Stated here, once, so the fold's own rule names its own fields. `ingest.ts`
 * maps each to the sighting field it takes its value from, and the mapping is
 * typed against this list, so a column added to the handover without a value —
 * or a value written for a column the ADR does not govern — is a type error
 * rather than a silently unwritten field.
 *
 * **Four columns are deliberately absent, and each for its own reason.**
 * `published` and `latest_seen` fold by `least`/`greatest` rather than being
 * handed over, and they are gated on `movesTheClock` alone. `provider` IS handed
 * over, on the EMISSION test rather than the first-hand one: which upstream
 * reported the earliest emission is a fact about the emission, not a rendering
 * of the article, and `articles.provider` is documented as exactly that — so an
 * article can read `google-news` while every field a reader sees is the
 * newsroom's. And `sighting_count` is outside every guard: the observation
 * happened whatever its timestamp is worth.
 *
 * `dedup_key` and `alt_key` are absent for a third reason, and it is IDENTITY
 * rather than entitlement: they are minted once and never rewritten, so they
 * are not in the handover at all. See `insertArticle`.
 */
export const DISPLAY_HANDOVER_COLUMNS = [
  "url",
  "title",
  "description",
  "author",
  "image_url",
  "language",
  "categories",
  "source_category",
  "source_domain",
] as const;

/** One of the nine columns above. */
export type DisplayHandoverColumn = (typeof DISPLAY_HANDOVER_COLUMNS)[number];
