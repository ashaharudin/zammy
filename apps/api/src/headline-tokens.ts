import { STOPWORDS } from "./stopwords.js";
import { PAST_FORMS, VERB_FORMS } from "./verb-lexicon.js";

/**
 * The headline tokenizer, and the two pieces of evidence read off a corpus of
 * headlines: which words are NAMES, and which are verbs. Pure — every corpus
 * and knob arrives as an argument.
 *
 * This was `term-scoring.ts` until the cloud stopped being made of terms
 * (ADR-0013). What went with the terms was the scorer — the df/baseline/decay
 * arithmetic and the unigram-subsumption rule, all of which existed to rank
 * extracted phrases against each other. What stayed is everything that had
 * OTHER readers all along, and the reason each of them needs this exact
 * tokenizer rather than one of its own:
 *
 *  - **Article grouping** (§14.3) compares headlines. A second regex would
 *    re-acquire the probe's `cve-` bug independently, and two tokenizers
 *    disagreeing about what a word is would make grouping and labelling
 *    disagree about what a story is.
 *  - **Storyline labels** (`bigram-label.ts`) fall back to a bigram drawn from
 *    a storyline's own coverage when the model is unavailable, and the label
 *    they draw has to clear the same name-and-not-a-predicate bar the cloud's
 *    terms once did — which is why the propriety and verb gates survive the
 *    scorer that used to call them.
 *  - **The label-agreement merge** asks whether two labels name the same thing.
 *
 * The one probe finding that is still load-bearing here is tokenization:
 * identifiers must stay WHOLE so they can be dropped whole. Shredding
 * `CVE-2026-1234` into a `cve-` fragment is what put that fragment at rank #1
 * in the naive probe (§10.2), and grouping would inherit the same bug verbatim.
 */

/**
 * The content-bearing tokens of a text, in order, duplicates included.
 *
 * Exported because article grouping (§14.3) compares headlines and must use
 * THIS tokenizer rather than its own: a second regex would re-acquire the
 * `cve-` bug independently, and two tokenizers disagreeing about what a word
 * is would make grouping and labelling disagree about what a story is.
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
 * Proper-noun evidence from case in RUNNING TEXT (ADR-0006). Headlines are
 * often Title Case, so a capital there proves nothing on its own — but a
 * generic word will betray itself in lowercase somewhere in the corpus's
 * prose, and a name never will. A term qualifies when it is capitalized at
 * least once mid-sentence and NEVER seen lowercase. Conservative by
 * construction: a name that only ever opens sentences fails the test and
 * waits for a corpus that uses it mid-sentence.
 *
 * Exported, and typed to the two fields it actually reads, because the
 * storyline phrase (`storyline-phrase.ts`) runs the verb gate below over a
 * corpus of one slot's members — the same evidence, a much smaller corpus.
 *
 * `fold` is for callers whose terms are not surface forms. Corpus tokens are
 * folded on the way into the sets and the term is folded when it is asked, so
 * both sides meet on one spelling. Without it a caller asking with singularized
 * words — the label merge, whose labels arrive through `normalizeLabel` — can
 * never get a `true` for a name ending in `s`: "Hamas" is recorded as `hamas`
 * and asked for as `hama`. Defaults to the identity, because a caller holding
 * surface forms wants the surface comparison: folding conflates a name with the
 * common word that would disqualify it, which refuses rather than admits, and
 * that is the safe direction only where refusing is cheap.
 */
export function properNounEvidence(
  corpus: readonly { title: string; description: string | null }[],
  fold: (token: string) => string = (token) => token,
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
          // `keepable` before `fold`, the order `contentTokens` uses: the
          // stopword list is written in surface forms.
          if (!keepable(lower)) return;
          const folded = fold(lower);
          if (/^\p{Ll}/u.test(token)) {
            seenLowercase.add(folded);
          } else if (index > 0 && /^\p{Lu}/u.test(token)) {
            capitalizedMidSentence.add(folded);
          }
        });
      }
    }
  }

  return (term) => {
    const folded = fold(term);
    return capitalizedMidSentence.has(folded) && !seenLowercase.has(folded);
  };
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
export function isVerb(
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
