import { FUNCTION_WORDS, STOPWORDS } from "./stopwords.js";
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
 * Content-bearing bigrams that stood NEXT TO EACH OTHER in the source text —
 * as opposed to `contentTokens(text)`, whose stopword filtering fabricates
 * adjacency: "Royals reportedly agree to a deal" filters to `royals, agree,
 * deal`, so a caller walking that array for adjacent pairs reads "agree deal"
 * as a bigram the headline never wrote — "to a" sat between them (issue
 * #100). The bigram label (`bigram-label.ts`) is exactly that caller, so it
 * needs pairs computed over the full token stream, before filtering, kept
 * only when both sides survive it.
 *
 * Punctuation fabricates adjacency the same way, and has to be excluded by the
 * same rule. The tokenizer DISCARDS its delimiters, so "Ukraine, Russia talks"
 * leaves `ukraine` sitting next to `russia` in the token stream with nothing
 * to show that a comma stood between them — and unlike "agree deal" the
 * proper-noun gate cannot catch it, because both halves really are names. So
 * pairs are drawn from RUNS (see `tokenRuns`) rather than from the flat
 * stream: two words are adjacent only if nothing but whitespace separated
 * them.
 */
export function contentTokenPairs(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const run of tokenRuns(text.toLowerCase())) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const first = run[i]!;
      const second = run[i + 1]!;
      if (keepable(first) && keepable(second)) pairs.push([first, second]);
    }
  }
  return pairs;
}

/**
 * The OUTLET's name, peeled off the end of a headline.
 *
 * Currents ships a title as the outlet wrote its own `<title>` tag, attribution
 * and all: "Manitoba beekeepers feeling sting of potential 50 per cent tariff -
 * Winnipeg | Globalnews.ca". Left in, those trailing words are tokens like any
 * other, and they are the WORST tokens the corpus holds — every Global News
 * Winnipeg article carries `winnipeg`, `globalnew` and `ca` whatever it is
 * about, so any two of them arrive at the storyline linker already sharing
 * three tokens. Measured against the dev archive's trailing fortnight to
 * 2026-08-21 (N=14,416): those three plus `manitoba` are worth mass 19.88
 * against a floor of 20, which is to say a Global News dateline is one
 * coincidence short of a storyline. That is how
 * ten unrelated Manitoba stories — an abduction, a drug bust, a training
 * grenade, two drowned toddlers, beekeepers and a tariff — became one arc
 * labelled "Manitoba Beekeepers". 459 titles in that archive carry the
 * Globalnews.ca suffix; 272 live storyline profiles were built on `globalnew`.
 *
 * This is not the linker's threshold being wrong. It is boilerplate entering
 * the vocabulary, so it is fixed where the vocabulary is made.
 *
 * The rule peels a trailing segment only while it is ATTRIBUTION-SHAPED, which
 * is deliberately narrower than "sits after a dash": at most
 * `MAX_ATTRIBUTION_WORDS` words, no verb form (the ADR-0006 lexicon again — a
 * segment that STATES something is the headline's own tail, not the outlet's
 * name), and no function word except a leading article, because attribution
 * reads "The Korea Times" and a headline's tail reads "and faster than
 * expected".
 * Peeling repeats, because the edition sits between the headline and the site
 * ("- National | Globalnews.ca"), and stops before it could eat the headline:
 * `MIN_HEADLINE_WORDS` words must survive, and at most
 * `MAX_ATTRIBUTION_SEGMENTS` segments come off per call.
 *
 * The shape rule buys its cheapness with both kinds of error, and both are
 * measured rather than assumed. It keeps mastheads with an internal function
 * word ("the Globe and Mail" — see `ARTICLES`), and it peels a short verbless
 * tail that reads like a name ("- a stunning upset"). The second costs two
 * tokens on one article; the first leaves that outlet's chrome exactly where it
 * was.
 *
 * What it deliberately does NOT do is consult `source_domain`. Matching the
 * segment against the outlet's own domain would be the precise rule — and it
 * would have to be threaded through `headlineTokens`, `storyTokens`,
 * `PhraseArticle` and two storage reads to get here. The shape rule needs
 * nothing, and it is measurable: what it drops is countable against the live
 * archive, and what it wrongly drops costs two tokens on one article.
 */
export function stripSourceAttribution(title: string): string {
  let headline = title.trim();
  for (let peeled = 0; peeled < MAX_ATTRIBUTION_SEGMENTS; peeled += 1) {
    // Greedy head, so this splits on the LAST delimiter: attribution is peeled
    // from the right, one segment at a time.
    const split = /^(.*\S)\s+[|\-\u2013\u2014]\s+(\S.*)$/u.exec(headline);
    if (split === null) break;
    const head = split[1]!;
    if (!isAttribution(split[2]!)) break;
    // A headline is never entirely attribution. Two words is the floor rather
    // than three because "Bitcoin Rise - Reuters" is a real shape and Reuters
    // is not part of the story.
    if (countWords(head) < MIN_HEADLINE_WORDS) break;
    headline = head.trim();
  }
  return headline;
}

/** Editions nest one deep in practice ("- Toronto | Globalnews.ca"); three is slack. */
const MAX_ATTRIBUTION_SEGMENTS = 3;
/** "Arkansas Democrat Gazette" is three; "Honolulu Star-Advertiser" is two. */
const MAX_ATTRIBUTION_WORDS = 4;
/** What must survive the peel. */
const MIN_HEADLINE_WORDS = 2;
/**
 * The only function words an outlet's own name opens with. A masthead that
 * carries one INSIDE it — "the Globe and Mail", "The Times of India" — is
 * refused by the rule above and survives into the vocabulary. That is the
 * shape rule's known blind spot, left as-is: the discriminator that would
 * catch it is the segment's own capitalization, and admitting `and`/`of`
 * anywhere would take "top of the table" and "and faster than expected" with
 * it. Consulting `source_domain` remains the precise fix, at the plumbing cost
 * the module comment describes.
 */
const ARTICLES: ReadonlySet<string> = new Set(["a", "an", "the"]);

function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

/**
 * Is this trailing segment the outlet naming itself, rather than the end of the
 * headline?
 *
 * Sampled against the live archive's one-off dash tails, which is where the
 * false positives would come from: "he has a bad record with them", "Uganda
 * remain top of the table", "just a year after suffering a stroke" and "and
 * faster than expected" are all refused — by length, by the verb lexicon, by
 * the function-word rule — while "The Telegraph", "Motley Fool", "EE Times",
 * "Globalnews.ca" and "Winnipeg" are all taken.
 */
function isAttribution(segment: string): boolean {
  const words = countWords(segment);
  if (words === 0 || words > MAX_ATTRIBUTION_WORDS) return false;

  const tokens = splitTokens(segment.toLowerCase());
  // Nothing but digits and punctuation — a timestamp tail. It donates no
  // tokens either way, so leave it alone rather than guess.
  if (tokens.length === 0) return false;

  return tokens.every((token, index) => {
    if (VERB_FORMS.has(token) || PAST_FORMS.has(token)) return false;
    // A leading ARTICLE is how outlets write their own names ("The Korea
    // Times"); a function word anywhere else is prose ("and faster than
    // expected", "top of the table"). This reads grammar rather than the whole
    // stopword list, because half that list is desk furniture — `times` and
    // `news` are furniture in a headline and an outlet's NAME here.
    //
    // Articles only, not every function word at index 0. Exempting the whole
    // class peeled "- some quiet relief" and "- an unexpected reversal", which
    // are headline tails; no outlet is named "Some ...".
    if (index === 0) return ARTICLES.has(token) || !FUNCTION_WORDS.has(token);
    return !FUNCTION_WORDS.has(token);
  });
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
  return tokenRuns(text).flat();
}

/**
 * The same tokens, grouped by what SEPARATED them. A run holds words that
 * nothing but whitespace stood between; anything else — a comma, a dash, a
 * period, a bracket, a quote — starts a new one.
 *
 * `splitTokens` flattens this away, because a caller counting words does not
 * care what sat between them. `contentTokenPairs` does care: a comma is as
 * good as a stopword at making two unrelated words look like a phrase, and it
 * leaves even less trace, since the delimiter is discarded rather than
 * filtered.
 *
 * Splitting on the outer class and then on whitespace is exactly equivalent to
 * splitting once on the union of the two, so the tokens are the same tokens,
 * only partitioned. The one thing the union hides is a chunk that is nothing
 * BUT wrapping punctuation: the spaced hyphen in "Bitcoin Rise - Reuters" is
 * a separator, not a word that happened to vanish, so it ends the run too.
 */
function tokenRuns(text: string): string[][] {
  const runs: string[][] = [];
  const segments = text
    .normalize("NFKC")
    // NFKC does not fold a typographic apostrophe (U+2019, and the modifier
    // letter U+02BC some sources use instead) to ASCII "'" — left alone, the
    // split below treats it as a word boundary and shreds "doesn't" into
    // "doesn" + "t".
    .replaceAll(/[’ʼ]/g, "'")
    .split(/[^\p{L}\p{N}'\-\s]+/u);

  for (const segment of segments) {
    let run: string[] = [];
    for (const chunk of segment.split(/\s+/u)) {
      const token = trimWordPunctuation(chunk);
      if (token.length > 0) {
        run.push(token);
      } else if (chunk.length > 0 && run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

/**
 * Strip the punctuation that WRAPS a word rather than belongs to it: edge quotes
 * and hyphens first, then a possessive `'s`.
 *
 * Exported, and the only definition of this fold, because two callers must arrive
 * at the same spelling for the same word and once did not. This file folds CORPUS
 * words; the label-agreement merge folds LABEL words (`normalizeLabel`). The
 * corpus reduced "Dillard's" to `dillard` here, while the label reached `dillard'`
 * there — `singular` drops the final `s` and leaves the apostrophe stranded — so
 * `properNounEvidence` was asked for a token the corpus could never hold and
 * refused a real name as no name at all. Measured on the dev archive: two arcs of
 * one earnings story, both labelled "Dillard's Tariff Refund Earnings", refused
 * with "no grounded name" while `dillard` sat capitalized in the coverage.
 *
 * The same trap waits for a plural possessive — "Workers' Rights" leaves
 * `workers'` — which is why the edge strip runs here too and not only the `'s`.
 */
export function trimWordPunctuation(token: string): string {
  return token.replaceAll(/^['-]+|['-]+$/g, "").replace(/'s$/iu, "");
}

/**
 * Proper-noun evidence from case in RUNNING TEXT (ADR-0006). Headlines are
 * often Title Case, so a capital there proves nothing on its own — but a
 * generic word will betray itself in lowercase somewhere in the corpus's
 * prose, and a name never will. A term qualifies when it is capitalized at
 * least once mid-sentence IN PROSE and NEVER seen lowercase. Conservative by
 * construction: a name that only ever opens sentences fails the test and
 * waits for a corpus that uses it mid-sentence, and a corpus that is Title
 * Case throughout yields no evidence at all rather than promoting every word
 * in it.
 *
 * Exported, and typed to the two fields it actually reads, because the
 * storyline phrase (`storyline-phrase.ts`) runs the verb gate below over a
 * corpus of one slot's members — the same evidence, a much smaller corpus.
 *
 * `minMembers` is how a caller asks for MORE than one member's word. "At least
 * one mid-sentence capital, never lowercase" is nearly free on a corpus of two
 * or three articles, and it is free in exactly one shape: a press release that
 * repeats its own Title Case headline inside its body. "GIGABYTE Brings AORUS
 * INFINITY to Gamescom 2026" reappears mid-description, the sentence split
 * glues it to the prose that follows, and one article has both capitalized
 * `brings` and a lowercase word to prove the segment is prose — so a verb the
 * lexicon holds is promoted to a name on one article's self-quotation.
 * Counting MEMBERS rather than occurrences is what separates that from
 * corroboration; an article echoing itself is one source. Defaults to 1, which
 * is every existing caller: the grounding test the bigram label and the
 * label-agreement merge run wants the cheap answer, because there refusing
 * costs a real label outright. The bigram label's VERB gate is the one caller
 * that asks for two, and `bigram-label.ts` records what that measured.
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
): (term: string, minMembers?: number) => boolean {
  const capitalizedMidSentence = new Map<string, Set<number>>();
  const seenLowercase = new Set<string>();

  for (const [member, article] of corpus.entries()) {
    for (const text of [stripSourceAttribution(article.title), article.description ?? ""]) {
      // Capitalization at a sentence start proves nothing, so split on
      // sentence-ish punctuation and ignore each segment's first token.
      for (const segment of text.split(/[.!?;:…]+\s+/)) {
        const tokens = splitTokens(segment);
        // Neither does capitalization in a TITLE CASE segment, where every
        // content word wears a capital whatever it is. Dropping only the
        // sentence-initial capital is not enough to catch that: in "Second
        // Quarter Eps Estimate Revised Again" the words after the first are
        // all mid-segment capitals, so every one of them would qualify as a
        // name and the gate would admit exactly the vocabulary pairs it
        // exists to refuse. What makes a capital mean something is a segment
        // that would have shown a common word LOWERCASE, so evidence is taken
        // only from segments that show at least one — running prose.
        const isProse = tokens.some(
          (token, index) =>
            index > 0 && keepable(token.toLowerCase()) && /^\p{Ll}/u.test(token),
        );
        tokens.forEach((token, index) => {
          const lower = token.toLowerCase();
          // `keepable` before `fold`, the order `contentTokens` uses: the
          // stopword list is written in surface forms.
          if (!keepable(lower)) return;
          const folded = fold(lower);
          if (/^\p{Ll}/u.test(token)) {
            seenLowercase.add(folded);
          } else if (isProse && index > 0 && /^\p{Lu}/u.test(token)) {
            const members = capitalizedMidSentence.get(folded);
            if (members) members.add(member);
            else capitalizedMidSentence.set(folded, new Set([member]));
          }
        });
      }
    }
  }

  return (term, minMembers = 1) => {
    const folded = fold(term);
    if (seenLowercase.has(folded)) return false;
    return (capitalizedMidSentence.get(folded)?.size ?? 0) >= minMembers;
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
 *    same evidence that admitted them. How MUCH evidence is the caller's to
 *    decide — `isProperNoun` is injected, and the bigram label hands in a
 *    stricter predicate here than it uses for grounding, because overruling
 *    the lexicon is the expensive direction (see `properNounEvidence`).
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
