import { singular } from "./grouping.js";
import { contentTokens, isVerb, properNounEvidence } from "./headline-tokens.js";

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
 * The one gate it keeps is ADR-0006's verb lexicon. A phrase that STATES
 * something rather than NAMES something — "chiefs urge", "trump slipped" — is
 * a headline with its middle removed, and a label has to be a name.
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
 * headline with its middle removed), the singular fold, and support-weighted
 * ranking. Candidates now come from every member's title, not one headline's,
 * because there is no card for this phrase to sit beside; it names the whole
 * storyline. Title Case on the way out, because this one is display, not a
 * query.
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
 */
function bestBigram(
  corpus: readonly PhraseArticle[],
  candidateTitles: readonly number[],
): string | null {
  const isProperNoun = properNounEvidence(corpus);
  // Adjacency per article, so a phrase can be ranked by how much of the
  // coverage actually says it — the description gets its say, as it does in
  // the storyline layer itself, but its tokens never run on from the title's.
  const sequences = corpus.map((article) => [
    contentTokens(article.title),
    contentTokens(article.description ?? ""),
  ]);

  let best: { phrase: string; support: number; position: number } | null = null;
  for (const index of candidateTitles) {
    const title = sequences[index]?.[0];
    if (!title) continue;
    for (let i = 0; i + 1 < title.length; i += 1) {
      const first = title[i]!;
      const second = title[i + 1]!;
      // `sanction sanctions` folds to one word repeated: a phrase, but not two.
      if (singular(first) === singular(second)) continue;
      if (isVerb(first, 0, isProperNoun) || isVerb(second, 1, isProperNoun)) continue;

      const candidate = {
        phrase: `${first} ${second}`,
        support: sequences.filter((texts) => texts.some((text) => hasAdjacent(text, first, second))).length,
        position: i,
      };
      if (best === null || beats(candidate, best)) best = candidate;
    }
  }

  return best?.phrase ?? null;
}

/** "fort hood" → "Fort Hood". A label is read, not typed into a search box. */
function titleCase(phrase: string): string {
  return phrase.replaceAll(/(^|[\s-])(\p{L})/gu, (_, lead: string, letter: string) =>
    `${lead}${letter.toUpperCase()}`,
  );
}

/**
 * More of the coverage saying it wins; then the phrase nearer the front of the
 * headline, which is where a headline puts its subject; then the phrase
 * itself, so a replayed read reaches the same label (§7.4's replay discipline).
 */
function beats(
  candidate: { phrase: string; support: number; position: number },
  incumbent: { phrase: string; support: number; position: number },
): boolean {
  if (candidate.support !== incumbent.support) return candidate.support > incumbent.support;
  if (candidate.position !== incumbent.position) return candidate.position < incumbent.position;
  return candidate.phrase < incumbent.phrase;
}
/** Does this token sequence run `first` straight into `second`, under the fold? */
function hasAdjacent(tokens: readonly string[], first: string, second: string): boolean {
  const a = singular(first);
  const b = singular(second);
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (singular(tokens[i]!) === a && singular(tokens[i + 1]!) === b) return true;
  }
  return false;
}
