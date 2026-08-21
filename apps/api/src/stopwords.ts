/**
 * The stopword list for term scoring (ARCHITECTURE 10.3) — "a real stopword
 * list, not a hand-rolled set".
 *
 * Base: the Snowball English stopword list (snowballstem.org, public domain),
 * verbatim. Extension: generic NEWS vocabulary the probe showed surviving
 * plain stopwording — "earlier", "found", "read", "says" ranked among the top
 * terms of an 80-article sample, and no general-English list catches them
 * because they are only stopwords IN NEWS. The extension is the shipped
 * day-one substitute for the rolling baseline, which needs a week of history
 * before it can do this job statistically (§10.3).
 *
 * A second class joined it later (`WIRE_AND_DESK`, below): the words a newsroom
 * writes about the article rather than about the story. Those defeat the
 * breadth gate instead of merely surviving frequency, so they need naming
 * separately (ADR-0007).
 *
 * This list is the shared tokenizer's vocabulary, not the cloud's alone —
 * `contentTokens` feeds article grouping too, so any edit here changes what
 * `headlineTokens` emits and MUST bump `TOKENIZER_VERSION` (ADR-0005).
 */

const SNOWBALL_ENGLISH = [
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your",
  "yours", "yourself", "yourselves", "he", "him", "his", "himself", "she",
  "her", "hers", "herself", "it", "its", "itself", "they", "them", "their",
  "theirs", "themselves", "what", "which", "who", "whom", "this", "that",
  "these", "those", "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an",
  "the", "and", "but", "if", "or", "because", "as", "until", "while", "of",
  "at", "by", "for", "with", "about", "against", "between", "into", "through",
  "during", "before", "after", "above", "below", "to", "from", "up", "down",
  "in", "out", "on", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "any",
  "both", "each", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very", "s", "t",
  "can", "will", "just", "don", "should", "now",
];

/**
 * Weekdays and months: grammatically proper nouns, so the §10.3 propriety
 * gate cannot catch them — "Wednesday" is capitalized and never lowercase,
 * yet is exactly as generic in news as "yesterday".
 */
const CALENDAR = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec",
];

/**
 * Wire services, honorifics, mastheads and desk furniture — the words a
 * newsroom puts in a headline ABOUT the article rather than about the story.
 *
 * They are not generic news vocabulary in the §10.3 sense: they are structural.
 * `LOS ANGELES (AP) —` opens a wire story whatever it is about, so `ap` clears
 * the `df_domains >= 2` breadth gate the moment two outlets carry AP copy —
 * not because two newsrooms independently chose the word, which is the only
 * thing that gate is evidence for. And the propriety gate cannot help: `AP`,
 * `Rep.` and `CEO` are capitalized every time they appear and never seen
 * lowercase, which is exactly the shape of a name.
 *
 * Measured over the recorded fixtures: this list removes `angeles ap`, `ceo`,
 * `rep` and `weekly` from the cloud at both corpus sizes, plus `daily` at 141
 * articles (33 → 28 terms at 141, 51 → 47 at 183 — at 183 `daily` has already
 * fallen to the propriety gate). It removes nothing else, admits nothing, and
 * moves no article pair across the ADR-0005 grouping bar.
 *
 * What is deliberately NOT here: `deal`, `file`, `files`, `review`, `share`.
 * Each has a junk instance ("Daily Deal", "file photo") and a real one (`iran
 * deal`, `epstein files`), and the junk instance is already caught by the
 * masthead word beside it.
 */
const WIRE_AND_DESK = [
  // Agencies, as they appear in datelines and credits. `rci` is absent on
  // purpose: its only appearance in the corpora is a Malaysian Royal
  // Commission of Inquiry — the subject of the story, not the byline.
  "ap", "afp", "reuters", "upi", "pti", "ians",
  // Honorifics and title abbreviations.
  "rep", "reps", "sen", "sens", "gov", "govs", "mp", "mps",
  "dr", "mr", "mrs", "ms", "jr", "sr", "sgt", "capt", "lt", "col", "gen",
  // Roles, which name the speaker rather than the story.
  "ceo", "cfo", "coo", "cto", "editor", "editors", "correspondent",
  "columnist", "reporter", "reporters", "journalist", "journalists",
  "spokesman", "spokeswoman", "spokesperson",
  // Cadence: mastheads and recurring-column furniture.
  "daily", "weekly", "monthly",
  // Promo and caption furniture.
  "newsletter", "newsletters", "subscribe", "sponsored", "advertisement",
  "advertisements", "photo", "photos", "getty",
  // Desk labels.
  "exclusive", "opinion", "analysis", "interview", "interviews",
  "recap", "roundup", "explainer", "editorial",
];

/**
 * `new` stays, and the cost of keeping it is known: a stopword BREAKS an n-gram
 * run rather than being skipped over, so `new york`, `new zealand` and `new
 * delhi` are unreachable at any n, with `york` and `zealand` standing in.
 *
 * Removing it was measured and refused (ADR-0007). The gain is zero on every
 * recorded corpus, and the mechanism that would deliver it is the same one that
 * costs: the propriety gate admits a phrase on `.some()`, so `new` never has to
 * qualify — one name beside it is enough. `new gaza` then suppresses `gaza`
 * through the subsumption rule, replacing a real term with a narrower one that
 * leaves as two ANDed keywords. And on the grouping side the gate does not
 * apply at all: `keepable` is what `headlineTokens` filters through, so a
 * frequent token returning to the vocabulary can only raise Jaccard and can
 * push a pair across the two-token floor.
 *
 * The rescue this left open — a phrase-position rule on the propriety gate —
 * has since been measured and refused (ADR-0007, amendment). `new york` and
 * `new trump` are the same shape, so a positional rule admits both or refuses
 * both; what separates them is coverage, in the subsumption rule.
 */
const NEWS_EXTENSION = [
  ...CALENDAR,
  ...WIRE_AND_DESK,
  "report", "reports", "reported", "reportedly", "say", "says", "said",
  "saying", "told", "tells", "announced", "announces", "revealed", "reveals",
  "found", "earlier", "read", "watch", "video", "live", "breaking", "latest",
  "update", "updates", "updated", "news", "new", "today", "yesterday",
  "tomorrow", "week", "month", "year", "day", "days", "time", "times",
  "first", "last", "next", "top", "best", "worst", "big", "biggest", "major",
  "amid", "among", "across", "despite", "via", "per", "could", "would",
  "may", "might", "must", "shall", "get", "gets", "got", "getting", "make",
  "makes", "made", "making", "take", "takes", "took", "taking", "see",
  "seen", "sees", "know", "known", "way", "ways", "back", "still", "also",
  "yet", "even", "one", "two", "three", "many", "much", "like", "well",
  "man", "woman", "people", "us", "here's", "what's", "why's", "how's",
];

export const STOPWORDS: ReadonlySet<string> = new Set([
  ...SNOWBALL_ENGLISH,
  ...NEWS_EXTENSION,
]);

/**
 * The function-word half of the list, alone.
 *
 * `STOPWORDS` mixes two things a caller sometimes needs apart: grammar ("of",
 * "than", "the") and desk furniture ("times", "video", "man"). Attribution
 * stripping needs the first and must not read the second — "The Korea Times"
 * is an outlet naming itself, and `times` being furniture in a HEADLINE says
 * nothing about that. Everything that tokenizes still reads `STOPWORDS`.
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(SNOWBALL_ENGLISH);
