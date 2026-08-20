import { labelWords } from "./storyline-label-merge.js";

/**
 * The search a cloud word runs (ARCHITECTURE 10.5, ADR-0014).
 *
 * ADR-0013 made the cloud the one place in the app where a storyline's LABEL is
 * executed as a search, and that reversal is kept — a click has to mint a topic
 * and spend an upstream call, or the landing page teaches the demand-driven loop
 * nothing (§9.3). What it did was run the label *verbatim*, and that is what
 * broke: `canonicalize` splits on whitespace, upstream ANDs the terms and
 * matches them against body text we never receive (PROBE-FINDINGS 3), so a
 * four-word label is four conjunctive terms and returns nothing at all.
 *
 * Measured on the dev archive, every label-shaped query a reader clicked:
 *
 *     {arday, controversy, jason, plagiarism}   -> 0 articles
 *     {detention, family, hashemi, ice}         -> 0 articles
 *     {lunar, pollution, space}                 -> 0 articles
 *     {haka, ma'a, nonu, solo}                  -> 1 article
 *
 * against 100-300 for the ordinary two-word searches in the same table. The
 * labeler is asked for the 2-5 words that NAME AN EVENT (ADR-0011), so it
 * writes prose — "controversy", "detention", "pursuit" — and prose is exactly
 * what a headline matcher will not conjoin with the proper nouns beside it.
 *
 * So the cloud searches **the searchable part of the label**: the label's own
 * words, folded, that the arc's coverage actually says. "Jason Arday plagiarism
 * controversy" becomes `jason arday`; "Lindsay Clancy murder trial" becomes
 * `lindsay clancy`. Nothing is invented and nothing is looked up — the profile
 * is on the row the cloud read already returned.
 */

/**
 * How many terms a cloud click may spend.
 *
 * Two, because upstream is conjunctive and the probe measured how fast that
 * bites: `bitcoin` 20 results, `volcano` 20, `bitcoin volcano` 1. Two words
 * drawn from ONE story co-occur where those two do not, but a third is a third
 * chance for the body text to disagree, and the third word of a label is where
 * the prose starts ("...plagiarism", "...pursuit", "...dispute").
 *
 * It cuts the other way too, which is the half worth noticing: fewer keywords
 * makes `findSurfacedStorylines`' containment test (search keywords ⊆
 * `profile_tokens`) EASIER to satisfy, and every term here is drawn from that
 * same profile. So the click that spends an upstream call also surfaces the arc
 * it came from as a pill, out of machinery that already existed — which is how
 * a reader reaches the three stored Jason Arday articles even on the run where
 * upstream returns nothing.
 */
export const CLOUD_QUERY_TERMS = 2;

/**
 * The label's words that its own coverage says, in label order, capped.
 *
 * Label order rather than rarity: labels are written subject-first, so the
 * leading words are the naming ones and the trailing words are the prose. That
 * is a property of the labeler's prompt, and it is free — the alternative,
 * ranking the candidates by `story_token_df`, would put the trailing corpus on
 * the cloud's request path to re-derive an ordering the label already carries.
 *
 * `labelWords` is the fold, and specifically NOT a second regex here: it exists
 * because label words and corpus words must arrive at the same spelling for the
 * same word, and it has already paid for the lesson ("Dillard's" reaching
 * `dillard'` on one side and `dillard` on the other). `profile_tokens` hold the
 * corpus spelling, so membership is the whole test — a label word the tokenizer
 * would have thrown away (a stopword, a bare digit, an identifier fragment)
 * simply is not in the profile, and drops out without this file knowing why.
 *
 * Two fallbacks, in order, and both are for storylines that should not exist:
 *
 *  - **No label word survives** — the label shares nothing with the coverage it
 *    names. Search the profile's own leading tokens instead: headline words with
 *    no claim to name the event still beat prose that cannot be matched at all.
 *  - **An empty profile** — `refreshProfileTokens` keeps a labelled, promoted
 *    storyline's profile non-empty, and a merged-away one is excluded upstream
 *    of here, so this is unreachable rather than merely unlikely. It returns the
 *    label, which is ADR-0013's behaviour: no better answer exists, and an empty
 *    query would be a 400 from `canonicalize` on a word the reader can see.
 */
export function cloudQuery(input: {
  label: string;
  profileTokens: readonly string[];
}): string {
  const profile = new Set(input.profileTokens);
  const grounded = labelWords(input.label).filter((word) => profile.has(word));
  const terms = [...new Set(grounded.length > 0 ? grounded : input.profileTokens)];
  return terms.length > 0 ? terms.slice(0, CLOUD_QUERY_TERMS).join(" ") : input.label;
}
