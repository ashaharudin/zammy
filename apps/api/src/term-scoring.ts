import { STOPWORDS } from "./stopwords.js";
import { PAST_FORMS, VERB_FORMS } from "./verb-lexicon.js";

/**
 * Term extraction and scoring for the landing-page cloud (ARCHITECTURE 10.2,
 * 10.3). Pure: the corpus, the baseline and every knob arrive as arguments.
 *
 * The probe ran naive document-frequency over a live 80-article sample and
 * got `cve-, earlier, jenkins, plugin, …` — three distinct failures, so three
 * mechanisms are REQUIRED here, not polish: the df_domains >= 2 gate, the
 * rolling baseline, and tokenization that drops identifiers whole instead of
 * shredding them into fragments that rank #1.
 */

export interface CorpusArticle {
  title: string;
  description: string | null;
  sourceDomain: string | null;
}

export interface ScoredTerm {
  term: string;
  isBigram: boolean;
  /** Distinct ARTICLES — the displayed number and the size input (§10.3). */
  dfArticles: number;
  /** Distinct source domains — the breadth gate. */
  dfDomains: number;
  score: number;
}

export interface ScoreOptions {
  /** Baseline smoothing. Explicitly expected to need tuning (§10.3). */
  k?: number;
  /** Max articles one domain may contribute to the SCORE's df (§10.3). */
  perDomainCap?: number;
  /** Breadth gate: minimum distinct domains for a term to exist at all. */
  minDomains?: number;
}

const DEFAULTS: Required<ScoreOptions> = { k: 3, perDomainCap: 3, minDomains: 2 };

/**
 * Headline terms for one article: distinct unigrams and bigrams over
 * title + description — body text is unavailable (§2), and headlines are
 * dense with topical nouns, so this works better than it sounds (§10.2).
 */
export function extractTerms(article: CorpusArticle): Set<string> {
  const tokens = tokenize(`${article.title} ${article.description ?? ""}`);
  const terms = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!keepable(token)) continue;
    terms.add(token);
    // Bigrams only over ADJACENT survivors: "climate policy" is a topic,
    // "climate the" is noise the unigram pass already refused.
    const next = tokens[i + 1];
    if (next !== undefined && keepable(next)) terms.add(`${token} ${next}`);
  }
  return terms;
}

/**
 * score(term) = sqrt(df_domains) × capped_df_articles / (baseline_7d + k)
 *
 * `df_articles` is counted over ARTICLES, never sightings — the 50×-repeated
 * link-roundup would otherwise weight its headline 50 times (§10.3). The
 * returned `dfArticles` stays the TRUE count (it is what users see); the
 * per-domain cap applies only inside the score, damping single-outlet floods
 * that the domain gate alone lets through.
 *
 * Every term must additionally carry a PROPER NOUN (§10.3): the day-one
 * cloud otherwise fills with generic vocabulary ("community", "finally")
 * that the baseline needs a week of history to suppress. One name anchors a
 * phrase — "michigan senate" is a topic — but two common words adjacent are
 * not ("slipped away", "gas flows").
 */
export function scoreTerms(
  corpus: readonly CorpusArticle[],
  baseline: ReadonlyMap<string, number>,
  options: ScoreOptions = {},
): ScoredTerm[] {
  const { k, perDomainCap, minDomains } = { ...DEFAULTS, ...options };
  const isProperNoun = properNounEvidence(corpus);

  const stats = new Map<
    string,
    { articles: number; byDomain: Map<string, number>; unknownDomain: number }
  >();

  for (const article of corpus) {
    for (const term of extractTerms(article)) {
      let entry = stats.get(term);
      if (!entry) {
        entry = { articles: 0, byDomain: new Map(), unknownDomain: 0 };
        stats.set(term, entry);
      }
      entry.articles += 1;
      if (article.sourceDomain) {
        entry.byDomain.set(
          article.sourceDomain,
          (entry.byDomain.get(article.sourceDomain) ?? 0) + 1,
        );
      } else {
        entry.unknownDomain += 1;
      }
    }
  }

  const scored: ScoredTerm[] = [];
  for (const [term, entry] of stats) {
    const words = term.split(" ");
    if (!words.some(isProperNoun)) continue;
    if (words.some((word, index) => isVerb(word, index, isProperNoun))) continue;
    const dfDomains = entry.byDomain.size;
    if (dfDomains < minDomains) continue;

    let cappedDf = Math.min(entry.unknownDomain, perDomainCap);
    for (const count of entry.byDomain.values()) {
      cappedDf += Math.min(count, perDomainCap);
    }

    scored.push({
      term,
      isBigram: term.includes(" "),
      dfArticles: entry.articles,
      dfDomains,
      score: (Math.sqrt(dfDomains) * cappedDf) / ((baseline.get(term) ?? 0) + k),
    });
  }

  // A unigram subsumed by a surviving bigram is the same story twice: every
  // "Ben Carroll" headline also produced "ben", so the cloud showed both.
  // Keep only the phrase — it is the more specific name for the topic.
  const bigramWords = new Set<string>();
  for (const { term, isBigram } of scored) {
    if (isBigram) for (const word of term.split(" ")) bigramWords.add(word);
  }
  const deduped = scored.filter((t) => t.isBigram || !bigramWords.has(t.term));

  // Deterministic order: score, then breadth, then the term itself — the
  // cloud must not reshuffle between identical recomputes (§10.5).
  return deduped.sort(
    (a, b) =>
      b.score - a.score || b.dfArticles - a.dfArticles || a.term.localeCompare(b.term),
  );
}

/**
 * The content-bearing tokens of a text, in order, duplicates included.
 *
 * Exported because article grouping (§14.3) compares headlines and must use
 * THIS tokenizer rather than its own: a second regex would re-acquire the
 * `cve-` bug independently, and two tokenizers disagreeing about what a word
 * is would make the cloud and the timeline disagree about what a story is.
 */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter(keepable);
}

/**
 * Tokens keep internal hyphens/apostrophes so identifiers stay WHOLE and can
 * be dropped whole: the probe's regex shredded CVE-2026-1234 into a `cve-`
 * fragment that ranked #1 (§10.2). Anything containing a digit is filtered —
 * identifiers, versions, years — as is anything short or stopworded.
 */
function tokenize(text: string): string[] {
  return splitTokens(text.toLowerCase());
}

function splitTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((token) => token.replaceAll(/^['-]+|['-]+$/g, "").replace(/'s$/iu, ""))
    .filter((token) => token.length > 0);
}

/**
 * Proper-noun evidence from case in RUNNING TEXT (§10.3). Headlines are
 * often Title Case, so a capital there proves nothing on its own — but a
 * generic word will betray itself in lowercase somewhere in the corpus's
 * prose, and a name never will. A term qualifies when it is capitalized at
 * least once mid-sentence and NEVER seen lowercase. Conservative by
 * construction: a name that only ever opens sentences fails the test and
 * waits for a corpus that uses it mid-sentence.
 */
function properNounEvidence(
  corpus: readonly CorpusArticle[],
): (term: string) => boolean {
  const capitalizedMidSentence = new Set<string>();
  const seenLowercase = new Set<string>();

  for (const article of corpus) {
    for (const text of [article.title, article.description ?? ""]) {
      // Capitalization at a sentence start proves nothing, so split on
      // sentence-ish punctuation and ignore each segment's first token.
      for (const segment of text.split(/[.!?;:…]+\s+/)) {
        const tokens = splitTokens(segment);
        tokens.forEach((token, index) => {
          const lower = token.toLowerCase();
          if (!keepable(lower)) return;
          if (/^\p{Ll}/u.test(token)) {
            seenLowercase.add(lower);
          } else if (index > 0 && /^\p{Lu}/u.test(token)) {
            capitalizedMidSentence.add(lower);
          }
        });
      }
    }
  }

  return (term) => capitalizedMidSentence.has(term) && !seenLowercase.has(term);
}

/**
 * Is this word of a phrase a VERB — does the phrase state something rather
 * than name something? One name anchors a phrase, but a name plus a verb is a
 * headline with its middle removed: "graham advances", "trump slipped",
 * "leaving turkey" are events reported ABOUT a topic, never the topic, and
 * they lead nowhere when clicked.
 *
 * Decided lexically (see verb-lexicon.ts), because morphology cannot do it:
 * "medicaid funding" and "patriot games" wear the same -ing and -s as "giving"
 * and "advances". What the lexicon encodes is which lemmas nominalize.
 *
 * Two guards keep it from eating real names:
 *
 *  - A word with proper-noun evidence is never read as a verb. Corpus case
 *    outranks the lexicon, so "Ken Burns" and "Patriot Games" survive on the
 *    same evidence that admitted them.
 *  - A past participle counts only AFTER the first word. In front it is a
 *    modifier — "armed forces", "planned parenthood", "displaced families" —
 *    whereas nothing follows a name as a participle except a predicate.
 */
function isVerb(
  word: string,
  index: number,
  isProperNoun: (term: string) => boolean,
): boolean {
  if (isProperNoun(word)) return false;
  return VERB_FORMS.has(word) || (index > 0 && PAST_FORMS.has(word));
}

function keepable(token: string): boolean {
  return token.length >= 2 && !/\d/.test(token) && !STOPWORDS.has(token);
}
