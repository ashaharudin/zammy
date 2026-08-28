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
 * name), and no function word except a leading article or one the segment's own
 * capitalization vouches for (`isNameCased`), because attribution reads "The
 * Korea Times" or "The Times of India" and a headline's tail reads "and faster
 * than expected".
 * Peeling repeats, because the edition sits between the headline and the site
 * ("- National | Globalnews.ca"), and stops before it could eat the headline:
 * `MIN_HEADLINE_WORDS` words must survive, and at most
 * `MAX_ATTRIBUTION_SEGMENTS` segments come off per call.
 *
 * The shape rule buys its cheapness with false positives, and they are measured
 * rather than assumed: it peels a short verbless tail that reads like a name
 * ("- a stunning upset"), and since version 9 it peels a Title Case one too
 * ("- Board of Peace"). What that costs, counted against the dev archive, is in
 * `isNameCased`.
 *
 * What it deliberately does NOT do is consult `source_domain`. Matching the
 * segment against the outlet's own domain would be the precise rule — and it
 * would have to be threaded through `headlineTokens`, `storyTokens`,
 * `PhraseArticle` and two storage reads to get here. The shape rule needs
 * nothing, and it is measurable: what it drops is countable against the live
 * archive, and so is what it wrongly drops — see `isNameCased` for version 9's
 * count of both.
 *
 * A domain rule now exists ELSEWHERE and is deliberately not reused here: G1's
 * `deriveAltKey` folds a `source_domain`, and reconciling this shape rule with
 * that domain one was considered and refused as a wider change than the peel
 * needs. Two rules, two purposes; the tokenizer still reads only the title.
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
 * The only function words an outlet's own name opens with, whatever its case.
 * A masthead that carries one INSIDE it — "the Globe and Mail", "The Times of
 * India" — needs `isNameCased` instead, which is what version 9 added.
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
 * "Globalnews.ca" and "Winnipeg" are all taken. Since version 9 a function word
 * INSIDE the segment is survivable too, but only for a segment `isNameCased`
 * vouches for: "The Times of India" is taken, "top of the table" is still not.
 */
function isAttribution(segment: string): boolean {
  const words = countWords(segment);
  if (words === 0 || words > MAX_ATTRIBUTION_WORDS) return false;

  const tokens = splitTokens(segment.toLowerCase());
  // Nothing but digits and punctuation — a timestamp tail. It donates no
  // tokens either way, so leave it alone rather than guess.
  if (tokens.length === 0) return false;

  const named = isNameCased(segment);
  return tokens.every((token, index) => {
    if (VERB_FORMS.has(token) || PAST_FORMS.has(token)) return false;
    // A leading ARTICLE is how outlets write their own names ("The Korea
    // Times"); a function word anywhere else is prose ("and faster than
    // expected", "top of the table") unless the segment's capitalization says
    // otherwise. This reads grammar rather than the whole stopword list,
    // because half that list is desk furniture — `times` and `news` are
    // furniture in a headline and an outlet's NAME here.
    //
    // Articles only, not every function word at index 0. Exempting the whole
    // class peeled "- some quiet relief" and "- an unexpected reversal", which
    // are headline tails; no outlet is named "Some ...".
    if (index === 0) return ARTICLES.has(token) || !FUNCTION_WORDS.has(token);
    return !FUNCTION_WORDS.has(token) || named;
  });
}

/**
 * Does this segment's own CAPITALIZATION say it is a name?
 *
 * The discriminator version 9 added, and the one the blind-spot note above
 * `ARTICLES` used to say could not be had. "The Times of India", "Moss and
 * Fog", "Council on Foreign Relations" and "Den of Geek" are mastheads that
 * carry a function word in the middle, so the grammar rule refuses them and the
 * outlet's chrome enters the vocabulary — the same failure `stripSourceAttribution`
 * exists to stop, only spelled with an `of` in it.
 *
 * A name capitalizes its content words and lowercases its connectives, and
 * prose does not: "Times of India" against "top of the table". So the test is
 * that every token is EITHER capitalized OR a function word written in
 * lowercase. `FUNCTION_WORDS` holds lowercase spellings only, so testing the
 * token AS WRITTEN is what separates the connective in "Times of India" from
 * the name's own word in "WORLD OF BUZZ" and "Law The Podcast" — the second
 * pair have to carry a capital like any other word, and do.
 *
 * A question mark disqualifies the segment outright, and that carve-out is
 * measured rather than tasteful: Title Case is also how a stock-tip desk writes
 * its own headline tail, and "- Time to Buy?", "- Still a Buy?", "- Opportunity
 * or Trap?" and "| BJP Set for Showdown?" were 9 of the 17 titles this rule
 * first got wrong. `!` is NOT in the carve-out — "Yahoo!" is a masthead — and
 * no title in the archive needed it.
 *
 * **The question mark is a PROXY, not the discriminator.** What is actually
 * being refused is Title Case stock-tip prose; the interrogative is only how
 * this archive spelled it, and the declarative form is unguarded — "- Still a
 * Buy" peels, because `buy` sits in `PAST_ONLY_LEMMAS` and so is not a
 * `VERB_FORMS` entry that would refuse it. That hole is pinned in the tests
 * rather than closed: no title in the archive is that shape, and closing it
 * needs a wider rule than sixty-three rows can justify. Do not read `?` as the
 * discriminator and widen the rule on that reading.
 *
 * **What it costs, counted on the dev archive (2026-08-28, 32,279 articles).**
 * 63 titles peel differently; 55 of those are chrome and 8 are the headline's
 * own words. The eight, by the TITLE they sit in, because a false positive
 * nobody listed is a false positive nobody can weigh — and because naming the
 * tail rather than the row leaves the count uncheckable:
 *
 *  - "... arsenals — Board of Peace" (TASS, and the Gaza board is the story)
 *  - "... as Funds Seek Exit Routes - Ares Management (NYSE:A"
 *  - "Force is the only language West understands – Carl Zha to RT"
 *  - "Osun Guber: Help Gov Adeleke prepare ... - Hope Uzodimma to Davido"
 *  - "CEBL on CBC: Finals - Game # 1 - Winnipeg at Brampton"
 *  - three Oregonian obituary datelines ("... - Newberg, OR - The Oregonian")
 *
 * The datelines are arguably chrome too — peeling them is what stops two
 * obituaries attaching to an Oregon poisoning arc — which is why the honest
 * count is 55 right, 5 wrong, 3 argued.
 *
 * **The blast radius of one title is three tokens.** 112 title tokens go in
 * total, over 62 rows: 22 rows lose one, 30 lose two, 10 lose three, and
 * nothing loses four. Same shape on `story_tokens` — 23 / 19 / 6 over 48 rows.
 * The ten three-token rows are six chrome ones ("Council on Foreign Relations"
 * twice, "Conservative Party of Canada", "Office for National Statistics",
 * "USC Viterbi | School of Engineering", "Investors Should Contact SueWallSt")
 * and FOUR of the five false positives above, which is the whole of the tail
 * risk in one line.
 *
 * A restricted list of masthead connectives (`of`/`and`/`on`/`for`, dropping
 * `to` and `at`) would take three of those five. It is not taken: it trades a
 * grammar rule for a hand-kept table fitted to sixty-three rows, and it would
 * lose "Letters to the Editor" with them.
 *
 * Case is Latin-shaped, and scripts without case fall through to `false` —
 * `\p{Lu}` is empty for Arabic or CJK, so a segment in one is refused and the
 * peel is left where it was. Refusing is the safe direction here.
 */
function isNameCased(segment: string): boolean {
  if (/\?\s*$/u.test(segment)) return false;
  const named = splitTokens(segment).filter((token) => !FUNCTION_WORDS.has(token));
  return named.length > 0 && named.every((token) => /^\p{Lu}/u.test(token));
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
      // The corpus spelling, which is a folded one: an accent here is a way for
      // the same name to fail to match itself, and almost nothing reads a token
      // back to a reader (`foldDiacritics` names the one thing that does — the
      // bigram fallback label — and why that trade is taken).
      const token = foldDiacritics(trimWordPunctuation(chunk));
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
 * Drop the diacritics off a LATIN word, so a name the corpus accents and a
 * label that does not are one word.
 *
 * The third instance of the lesson `trimWordPunctuation` above is the first two
 * of, and it arrived the same way — from the archive rather than from reasoning.
 * A headline says "super El Niño", so the corpus holds `niño`; the labeler wrote
 * "Super El Nino", which folds to `nino`; and no comparison in the system can
 * see that those are the same name. Measured consequences, all silent:
 *
 *  - `cloudQuery` drops the arc's own naming word from its grounded terms.
 *  - A reader typing "nino" — which is what a keyboard produces — misses the
 *    arc entirely, because `findSurfacedStorylines` tests containment against
 *    `profile_tokens`.
 *  - Two arcs labelled "El Niño Forecast" and "El Nino Forecast" do not agree,
 *    so the label-agreement merge never fires on them.
 *  - Label grounding (`storyline-label.ts`) accepts or refuses a label on
 *    whether its OTHER words happen to be in the coverage.
 *
 * **Latin only, and by the base character rather than by a character list.**
 * `\p{Mn}` is not a decoration everywhere it appears: Devanagari's virama is one,
 * and stripping it changes what a word says rather than how it is spelled. Since
 * a topic may be in any language upstream serves (§6.1), the fold is narrowed to
 * marks sitting on a Latin letter, which is exactly the alphabet where an
 * accent is the same word carelessly typed. NFC on the way out because NFD
 * decomposes Hangul into conjoining jamo, which are not marks and so survive
 * the strip — without recomposing, a Korean token would come back as a
 * different string than it went in as.
 *
 * It conflates where a Latin language means the accent — Vietnamese tone marks
 * carry the word, and `sẽ`/`sé`/`se` become one token. Accepted, and it is the
 * cheap direction: conflation costs recall inside one language, and the split it
 * replaces cost every arc whose label lost a tilde.
 *
 * **What "by the base character" does not reach**, counted on the archive after
 * the version-8 migration ran, because a boundary nobody measured is a boundary
 * nobody knows the size of:
 *
 *  - **Atomic Latin letters.** `ł`, `ø`, `ð`, `æ`, `ı`, `đ` do not decompose —
 *    they are letters in their own right, not accented ones — so `wojtyła`,
 *    `nordsjælland`, `białystok`, `yatırımlar` and `suðurne` stay split from
 *    their ASCII spellings. Six articles. Reaching them needs the hand-kept
 *    transliteration table this function exists to avoid, and `ł` really is a
 *    different letter from `l` to a Pole, so the table would be making a
 *    judgement rather than undoing a typo.
 *  - **The ʻokina.** `hawaiʻi` keeps U+02BB, a modifier LETTER rather than a
 *    mark, so it is split from `hawaii`. Two articles. The tokenizer already
 *    folds U+2019 and U+02BC to ASCII `'` (version 5); U+02BB belongs in that
 *    list rather than in this function, and is left for the day it costs more
 *    than two rows.
 *
 * Non-Latin scripts are untouched as designed, and the archive shows what that
 * preserves: CJK tokens (`台灣產經新聞網`), Greek (`δt`) and Arabic all arrive
 * intact.
 *
 * NOT folded into `trimWordPunctuation`, despite both being "the fold": that one
 * also spells a label word for a READER (`LabelWord.surface`, and the "gaza
 * crisi" lesson behind it), and a placeholder proposing `nino` for an arc whose
 * headlines all say Niño is the same class of mistake one step smaller. The
 * corpus spelling folds; the surface does not.
 *
 * **One reader does see the folded spelling, and it is worth naming rather than
 * leaving the sentence above sounding absolute.** `bigramLabel` draws its
 * candidates from `contentTokenPairs` — these tokens — and Title Cases them into
 * `storylines.label`, so the DETERMINISTIC fallback label of an accented-name arc
 * reads "Turkiye Ankara" where the headlines say Türkiye. The model's own labels
 * are untouched (they arrive as text and keep their accents through
 * `LabelWord.surface`), so this is the arcs the model could not name.
 *
 * Left as-is, deliberately. Undoing it needs a surface corpus on the labelling
 * path — `story_tokens` carries one spelling per word and it is the folded one —
 * which is the cost ADR-0014 declined for the ordering question and would decline
 * again for a diacritic on a fallback label. Weighed against it: 108 names in the
 * archive stop being two words. Recorded because the placement above was argued
 * from "nothing reads a `story_tokens` entry back to a reader", and that premise
 * is false rather than merely imprecise.
 */
export function foldDiacritics(token: string): string {
  return token
    .normalize("NFD")
    .replaceAll(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .normalize("NFC");
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
