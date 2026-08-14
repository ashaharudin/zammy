import { singular } from "./grouping.js";
import { storyTokens } from "./storyline.js";
import { contentTokens, isVerb, properNounEvidence } from "./term-scoring.js";

/**
 * The STORYLINE PHRASE: the two-word phrase a slot's whole coverage shares,
 * offered beside the rail as a search for the story itself (§8.1).
 *
 * It exists because a storyline is the one place in this product where we know
 * several articles are one story and can say what the story is called. It is
 * NOT a cloud term (§10.3, CONTEXT.md): a term competes for a slot in the
 * wordcloud and must therefore carry a proper noun, while this phrase is
 * already anchored — by the storyline the reader is looking at — and "police
 * chiefs" or "medicaid funding" name a story perfectly well. Requiring a name
 * here would leave most storylines unlabelled for no gain.
 *
 * The one gate it does keep is ADR-0006's verb lexicon. A phrase that STATES
 * something rather than NAMES something — "chiefs urge", "trump slipped" — is
 * a headline with its middle removed, and it leads nowhere when clicked; that
 * argument is about clicking, so it applies here more than anywhere.
 *
 * ## What makes the click honest
 *
 * The click opens a topic on two ANDed keywords (§6.2 sorts them, so word
 * order does not survive it — ADR-0007). So the phrase is only worth offering
 * if the storyline's own articles are inside the result set it promises, and
 * that is a CONSTRUCTION here, not a hope: both words must appear in every
 * article the slot shows, so the seeded attach (ADR-0010) — which admits only
 * articles carrying every keyword — cannot leave one of them out.
 */

/** The two fields the phrase is derived from. Any article shape satisfies it. */
export interface PhraseArticle {
  title: string;
  description: string | null;
}

/**
 * The phrase for one slot, or null when the slot's coverage shares no
 * two adjacent words the headline also uses.
 *
 * `headline` is the article the card shows and `coverage` is everything else
 * the reader is being offered under it. Candidates come from the HEADLINE's
 * TITLE alone: the chip sits beside that card, so a phrase lifted out of the
 * words next to it reads as a label rather than as a machine's summary.
 */
export function storylinePhrase(
  headline: PhraseArticle,
  coverage: readonly PhraseArticle[],
): string | null {
  if (coverage.length === 0) return null;

  const corpus = [headline, ...coverage];

  // The "every article carries it" test runs over SINGULARIZED tokens, the
  // same fold grouping applies (`chiefs` and `chief` are one word when asking
  // whether two articles are about one thing) — and, decisively, the same fold
  // the seeded attach applies to the keywords when it matches `story_tokens`.
  // Test one way and match the other and the promise above stops holding.
  const shared = sharedTokens(corpus.map((article) => storyTokens(article.title, article.description)));
  if (shared.size === 0) return null;

  const isProperNoun = properNounEvidence(corpus);
  // Adjacency per article, so a phrase can be ranked by how much of the
  // coverage actually says it — the description gets its say, as it does in
  // the storyline layer itself, but its tokens never run on from the title's.
  const sequences = corpus.map((article) => [
    contentTokens(article.title),
    contentTokens(article.description ?? ""),
  ]);

  let best: { phrase: string; support: number; position: number } | null = null;
  const title = sequences[0]![0]!;
  for (let i = 0; i + 1 < title.length; i += 1) {
    const first = title[i]!;
    const second = title[i + 1]!;
    if (!shared.has(singular(first)) || !shared.has(singular(second))) continue;
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

  return best?.phrase ?? null;
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

/** The tokens EVERY article carries. Empty for an empty corpus. */
function sharedTokens(tokenSets: readonly (readonly string[])[]): Set<string> {
  const first = tokenSets[0];
  if (!first) return new Set();
  let shared = new Set(first);
  for (const tokens of tokenSets.slice(1)) {
    const next = new Set(tokens);
    shared = new Set([...shared].filter((token) => next.has(token)));
    if (shared.size === 0) break;
  }
  return shared;
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
