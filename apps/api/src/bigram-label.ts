import { singular } from "./grouping.js";
import {
  contentTokenPairs,
  isVerb,
  properNounEvidence,
  stripSourceAttribution,
} from "./headline-tokens.js";

/**
 * The BIGRAM LABEL: two adjacent words lifted from a storyline's headlines,
 * Title Cased, and the deterministic floor under ADR-0011's labeler.
 *
 * It is what a storyline is called when the model is unavailable, refuses, or
 * returns something the contract rejects. It cannot meet the label bar and is
 * not meant to: ADR-0011 measured that "police chiefs" names a story
 * adequately and names an EVENT not at all, which is the whole reason the
 * model exists. This is the floor, not the target.
 *
 * Three gates stand between a phrase and the label — two from the contract the
 * model itself has to pass, one this extractor's own. ADR-0006's
 * verb lexicon: a phrase that STATES something rather than NAMES something —
 * "chiefs urge", "trump slipped" — is a headline with its middle removed, and
 * a label has to be a name. And proper-noun evidence (issue #100): a bigram is
 * grounded in the coverage by construction — every word in it came FROM the
 * coverage — so the shape-and-vocabulary contract cannot tell "fort hood" from
 * "second quarter" or "eps estimate", both of which pass it just as cleanly.
 * Requiring a word with `properNounEvidence`, not mere Title Case, is the one
 * clause of the real contract a two-word phrase can actually be held to.
 *
 * The third gate is `minSupport`, and it is about the STORYLINE rather than the
 * phrase: past a handful of members, a phrase only one headline says means the
 * coverage has no shared vocabulary — a formation problem wearing a naming
 * problem's clothes — and the extractor declines rather than pick a spokesman
 * for a pile.
 *
 * Refusing is cheap here: a null label still renders (ADR-0011, "Labels").
 *
 * It began as ADR-0010's read-time storyline PHRASE, which was a search: two
 * words the whole slot shared, clicked to open a topic on them. The
 * containment rule existed to keep that search a superset of the slot, and
 * ADR-0011 retired it with the phrase-as-query — a label opens by UUID, so
 * nothing requires its words to appear in any article. What survives is the
 * extractor.
 */

/** The two fields a label is derived from. Any article shape satisfies it. */
export interface PhraseArticle {
  title: string;
  description: string | null;
}

/**
 * Callers must pass the articles OLDEST FIRST. The tie-break below resolves on
 * the earliest member, and it reads that from array position rather than a date,
 * so the order is a precondition rather than a preference — a reversed array
 * names the arc after its newest arrival, which is the instability the
 * tie-break was changed to remove. `selectLabelMembers` already sorts this way,
 * and it is what both production callers hand in.
 */

/**
 * The same extractor, FREED FROM THE CONTAINMENT RULE — the storyline labeler's
 * fallback when Gemini is unavailable, refuses, or breaks its contract
 * (ADR-0011, "Labels").
 *
 * Containment existed to keep a promise that is now dead. ADR-0010 made the
 * phrase *the query*: clicking it ran a search, so the search had to contain
 * the slot the reader clicked, so both words had to appear in every article.
 * Clicking a LABEL opens the storyline by UUID; the words never execute. With
 * the guarantee goes the yield ceiling it imposed — 9 phrases from 46 eligible
 * slots — and a fallback that produces nothing for four storylines in five is
 * not a fallback.
 *
 * What is kept is everything that was about QUALITY rather than about the
 * promise: the verb gate (ADR-0006 — a label that states something is a
 * headline with its middle removed), the proper-noun requirement (issue #100
 * — a bigram grounded in the coverage is not thereby a name), the singular
 * fold, and support-weighted ranking — now with a floor under the support as
 * well as a ranking by it. Candidates now come from every member's
 * title, not one headline's, because there is no card for this phrase to sit
 * beside; it names the whole storyline. Title Case on the way out, because
 * this one is display, not a query.
 *
 * It cannot meet the label bar and is not meant to. ADR-0011 measured that:
 * "police chiefs" names a story adequately and names an EVENT not at all, which
 * is why the model exists. This is the floor, not the target.
 */
export function bigramLabel(articles: readonly PhraseArticle[]): string | null {
  if (articles.length === 0) return null;
  const phrase = bestBigram(articles, articles.map((_, index) => index));
  return phrase === null ? null : titleCase(phrase);
}

/**
 * The extractor. `candidateTitles` picks which articles' TITLES may donate a
 * phrase; descriptions never do — they support a phrase, they do not propose
 * one.
 *
 * That asymmetry is worth holding in mind at the support floor: support counts a
 * MEMBER whose title or description says the phrase, so "only one headline says
 * it" is the motivating case rather than the exact test — one headline plus a
 * second member's description also clears the floor. Deliberate, and the same
 * reading the storyline layer takes of a description, but it means the floor
 * proves shared vocabulary across the coverage, not across its headlines.
 */
function bestBigram(
  corpus: readonly PhraseArticle[],
  candidateTitles: readonly number[],
): string | null {
  // Headlines without the outlet's name on the end. Without this the extractor
  // proposes the dateline: "Globalnews Ca" is a real label in the dev archive,
  // on a real six-group storyline.
  const headlines = corpus.map((article) => stripSourceAttribution(article.title));
  // `corpus`, not `headlines`: `properNounEvidence` strips its own input, and
  // the peel is capped per call, so handing it an already-peeled title made the
  // two sides disagree about the headline whenever a title carried more than
  // `MAX_ATTRIBUTION_SEGMENTS` delimiters — the evidence gate would then judge
  // a shorter string than the pair extractor had read.
  const isProperNoun = properNounEvidence(corpus);
  // The same evidence read at two bars, because the two gates below fail in
  // opposite directions. GROUNDING asks "is either word a name?" and a wrong
  // `false` there refuses a good label outright, so it takes the cheap answer.
  // The VERB gate uses it to OVERRULE the lexicon, and a wrong `true` there
  // admits the clause the lexicon had already caught — so it asks for more
  // than one member's word (`VERB_OVERRIDE_MEMBERS`).
  const isEstablishedName = (term: string): boolean =>
    isProperNoun(term, VERB_OVERRIDE_MEMBERS);
  // Adjacency per article, so a phrase can be ranked by how much of the
  // coverage actually says it — the description gets its say, as it does in
  // the storyline layer itself, but its tokens never run on from the title's.
  // Pairs, not tokens: a bigram must have stood next to its two words in the
  // SOURCE text, not merely have survived the stopword filter beside them
  // (issue #100 — "royals reportedly agree to a deal" is not "agree deal").
  const sequences = corpus.map((article, index) => [
    contentTokenPairs(headlines[index]!),
    contentTokenPairs(article.description ?? ""),
  ]);

  const needed = minSupport(corpus.length);

  let best: Candidate | null = null;
  for (const index of candidateTitles) {
    const titlePairs = sequences[index]?.[0];
    if (!titlePairs) continue;
    for (let position = 0; position < titlePairs.length; position += 1) {
      const [first, second] = titlePairs[position]!;
      // `sanction sanctions` folds to one word repeated: a phrase, but not two.
      if (singular(first) === singular(second)) continue;
      if (isVerb(first, 0, isEstablishedName)) continue;
      if (isVerb(second, 1, isEstablishedName)) continue;
      // A bigram lifted from the coverage is grounded in it by construction —
      // that proves nothing. Require the corpus's own case evidence that one
      // of its words is a NAME, or the phrase is a vocabulary pair ("second
      // quarter", "eps estimate") wearing the same shape as one (issue #100).
      if (!isProperNoun(first) && !isProperNoun(second)) continue;

      const candidate = {
        phrase: `${first} ${second}`,
        support: sequences.filter((texts) =>
          texts.some((pairs) => hasAdjacentPair(pairs, first, second)),
        ).length,
        position,
        member: index,
      };
      // A phrase ONE headline of many says is that headline's subject, not the
      // storyline's name (see `minSupport`).
      if (candidate.support < needed) continue;
      if (best === null || beats(candidate, best)) best = candidate;
    }
  }

  return best?.phrase ?? null;
}

/**
 * How many MEMBERS must show a word capitalized mid-prose before its case may
 * overrule the verb lexicon.
 *
 * The override exists for "Ken Burns" and "Patriot Games" — real names the
 * lexicon holds as verbs — and on a storyline of two or three articles the
 * evidence it wants is nearly free. Free in one shape especially: a press
 * release quoting its own Title Case headline inside its body, which is how
 * `Gigabyte Brings` outranked the lexicon's `brings` on ONE article's
 * self-quotation. An article echoing itself is one source, so the bar is
 * counted in members.
 *
 * Two, measured over 3,471 live multi-group storylines (2026-08-21) relabelled
 * offline from their own coverage. Raising the bar from one to two moves 13
 * labels: it refuses nine clauses (`Gigabyte Brings`, `Jpmorgan Warns`, `Apple
 * Wants`, `Market Wakes`, `Paramount Mulling`, `Showrooms Coming`, `Bounce
 * Fades`, `Erc Oks`, `Senate Oks`), improves one (`Keeping Score` → `Aoc
 * Woke`), swaps two on storylines that are piles either way, and costs one
 * real name — `Flying Eagles` → `Eagles Cruise`, where the team name was
 * carried by a single member and the phrase that replaced it is a clause the
 * lexicon does not hold (`cruise` is a noun as often as a verb; see
 * verb-lexicon.ts on the asymmetric cost).
 *
 * Not three. A third member costs `Justin Rose` — a golfer, saved today by the
 * override against `rose` in IRREGULAR_PAST — and buys nothing: it is the only
 * label that moves, and it moves to `Memphis Bucking`.
 */
const VERB_OVERRIDE_MEMBERS = 2;

/** "fort hood" → "Fort Hood". A label is read, not typed into a search box. */
function titleCase(phrase: string): string {
  return phrase.replaceAll(/(^|[\s-])(\p{L})/gu, (_, lead: string, letter: string) =>
    `${lead}${letter.toUpperCase()}`,
  );
}

interface Candidate {
  phrase: string;
  support: number;
  position: number;
  /** Index in the corpus, which `selectLabelMembers` hands over oldest first. */
  member: number;
}

/**
 * The support floor: how much of the coverage must say a phrase before it may
 * name the whole storyline.
 *
 * One headline out of two saying something is ordinary — two outlets word one
 * story differently, and 46% of two-member samples in the dev archive have no
 * phrase in common at all. One headline out of TEN is a different claim: it
 * says the coverage has no shared vocabulary, which is not a naming problem
 * but a FORMATION problem, and the extractor should decline rather than pick a
 * spokesman for a pile. This is how "Manitoba Beekeepers" came to name an
 * abduction, a drug bust, a training grenade and two drowned toddlers: ten
 * members, ten candidate phrases, every one of them said once, the winner
 * decided by alphabetical order.
 *
 * Measured over 3,792 live multi-group storylines (2026-08-21), which is what
 * pinned the threshold at five rather than three: a support-1 winner occurs in
 * 49% of three-member samples and 7% of ten-member ones, so requiring two
 * below five members refuses the ordinary case, while requiring it at five
 * costs 4.6 points of yield (92.9% → 88.3%) and withdraws 56 of the 360 bigram
 * labels live today. Refusing is cheap: a null label still renders (ADR-0011).
 */
/**
 * `members` is the SAMPLE handed to `bigramLabel`, not the storyline's size —
 * every caller passes `selectLabelMembers(members, STORYLINE_LABEL_SAMPLE)`. A
 * sample configured below `SUPPORT_FLOOR_AT_MEMBERS` therefore turns the floor
 * off, however large the arc behind it; the config's own doc records that.
 */
function minSupport(members: number): number {
  return members >= SUPPORT_FLOOR_AT_MEMBERS ? 2 : 1;
}

/** At five, not past it: a five-member sample already needs two headlines. */
const SUPPORT_FLOOR_AT_MEMBERS = 5;

/**
 * More of the coverage saying it wins; then the EARLIEST member's headline,
 * because an arc is named by what it started as; then the phrase nearer the
 * front of that headline, which is where a headline puts its subject; then the
 * phrase itself, so a replayed read reaches the same label (§7.4's replay
 * discipline).
 *
 * The order of the middle two is the fix, not decoration. Alphabetical order
 * used to break every tie position could not, which made the label a lottery
 * among equally-supported phrases AND an unstable one: measured over the
 * archive's 2,795 labelled storylines, removing one arrival changes the name
 * 21.4% of the time under alphabetical order and 14.2% under earliest-member.
 * The origin is the one member `selectLabelMembers` pins into every sample, so
 * a tie resolved on it survives the next arrival; a tie resolved on the
 * alphabet is re-run against whatever vocabulary shows up next.
 */
function beats(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.support !== incumbent.support) return candidate.support > incumbent.support;
  if (candidate.member !== incumbent.member) return candidate.member < incumbent.member;
  if (candidate.position !== incumbent.position) return candidate.position < incumbent.position;
  return candidate.phrase < incumbent.phrase;
}
/** Does one of these true-adjacency pairs run `first` straight into `second`, under the fold? */
function hasAdjacentPair(
  pairs: readonly (readonly [string, string])[],
  first: string,
  second: string,
): boolean {
  const a = singular(first);
  const b = singular(second);
  return pairs.some(([x, y]) => singular(x) === a && singular(y) === b);
}
