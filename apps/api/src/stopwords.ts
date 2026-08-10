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

const NEWS_EXTENSION = [
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
