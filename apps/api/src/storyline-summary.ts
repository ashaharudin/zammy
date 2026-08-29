import type { SummaryMember, SummaryQuarter } from "@zammy/storage";

/**
 * The prompts and the contract for the historical preserve (ADR-0022,
 * docs/STORYLINE-SUMMARIES.md) — the pure half, mirroring `storyline-label.ts`.
 *
 * A summary is ONE SENTENCE about what happened in a span of a storyline's
 * coverage. The contract is deliberately narrower than a label's in one way and
 * looser in another: mechanically it is length plus sentence count (there is no
 * grounding check, because a sentence's overlap with its sources is not a signal
 * the way a three-word label's is), and semantically it asks for the EVENTS
 * rather than for the coverage — "the pause held through the afternoon", never
 * "several outlets reported on the pause".
 *
 * As with the label, the wording iterates on live output and the contract does
 * not: `validateSummary` enforces exactly what the rules below promise, and
 * nothing it cannot check is promised twice.
 */

/**
 * The cap, in characters.
 *
 * Characters and not tokens or words, for the same reason the label's contract
 * counts words: this is the unit a reader of a stored row can check. 240 is
 * about two lines of prose — long enough for "who did what, and what came of
 * it", short enough that a model padding its way through a slow news quarter
 * runs into the wall rather than filling the column.
 */
export const SUMMARY_MAX_CHARS = 240;

/** How much of an article's description reaches the prompt. The labeler's 200. */
const DESCRIPTION_CHARS = 200;

/**
 * Words that end in a period without ending a sentence.
 *
 * This list is the difference between a working contract and one that rejects
 * every summary mentioning a government: "U.S. officials paused the wall" has a
 * period, a space and a capital letter in the middle of ONE sentence, and a
 * naive boundary test reads that as two. The single-letter and dotted-initialism
 * cases are handled structurally in `sentenceCount`; these are the ones that are
 * only knowable as vocabulary.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "hon", "st", "mt", "ft",
  "jr", "sr", "gen", "col", "sgt", "capt", "lt", "sen", "rep", "gov",
  "pres", "supt", "det", "insp", "cmdr", "adm",
  "inc", "ltd", "co", "corp", "dept", "univ", "assn",
  "vs", "etc", "approx", "est", "no", "fig", "al",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec",
]);

/** The quarter's own name and the hours it covers, for the prompt's first line. */
export function describeSegment(segment: SummaryQuarter): string {
  switch (segment) {
    case "night":
      return "night (00:00-06:00 UTC)";
    case "morning":
      return "morning (06:00-12:00 UTC)";
    case "afternoon":
      return "afternoon (12:00-18:00 UTC)";
    case "evening":
      return "evening (18:00-24:00 UTC)";
  }
}

/** The rules block, identical for every prompt here — one contract, one wording. */
const RULES = [
  "Rules:",
  `- Exactly ONE sentence, at most ${SUMMARY_MAX_CHARS} characters.`,
  "- Say what HAPPENED. Do not describe the coverage itself: no 'reports say',",
  "  'articles describe', 'headlines focus on'.",
  "- Name the people, places and organisations involved rather than referring to",
  "  'the story' or 'the situation'.",
  "- No preamble, no heading, no bullet, no quotation marks around it.",
  "- Reply with the sentence alone and nothing else.",
];

/** `The story is called "X".`, or nothing when the arc has no label yet. */
function labelLine(label: string | null): string[] {
  // The label is three words and costs nothing, and without it a quarter
  // holding one headline gets summarized as if it were a standalone item
  // rather than a turn in a running story. What is deliberately NOT here is
  // the previous quarter's summary: chaining would let one bad sentence
  // poison every later one and would stop the quarters being independently
  // recomputable, which is exactly what the settling window needs them to be.
  return label ? [`The running story is called "${label}".`] : [];
}

function renderMembers(members: readonly SummaryMember[]): string {
  return members
    .map((member, index) => {
      const description = (member.description ?? "").replaceAll(/\s+/g, " ").trim();
      const trimmed =
        description.length > DESCRIPTION_CHARS
          ? `${description.slice(0, DESCRIPTION_CHARS)}…`
          : description;
      return `${index + 1}. ${member.title}${trimmed ? `\n   ${trimmed}` : ""}`;
    })
    .join("\n");
}

/** One quarter of one day. */
export function buildSegmentSummaryPrompt(input: {
  label: string | null;
  dayKey: string;
  segment: SummaryQuarter;
  members: readonly SummaryMember[];
}): string {
  return [
    `These headlines are one news story's coverage from the ${describeSegment(input.segment)}` +
      ` of ${input.dayKey}, oldest first.`,
    ...labelLine(input.label),
    "",
    renderMembers(input.members),
    "",
    "Summarise what happened during that window in one sentence.",
    "",
    ...RULES,
  ].join("\n");
}

/**
 * The whole day, from the quarters' own sentences.
 *
 * This is the cheap half of the design and the reason the day summary is not a
 * second read of the articles: four sentences is ~150 tokens against ~3,000 for
 * the day's coverage, and a day summary built from the quarters beneath it
 * cannot contradict them.
 */
export function buildDayFromSegmentsPrompt(input: {
  label: string | null;
  dayKey: string;
  segments: ReadonlyArray<{ segment: SummaryQuarter; summary: string }>;
}): string {
  return [
    `These are summaries of each part of ${input.dayKey} (UTC) in one news story, in order.`,
    ...labelLine(input.label),
    "",
    input.segments
      .map((entry) => `${describeSegment(entry.segment)}: ${entry.summary}`)
      .join("\n"),
    "",
    "Summarise the whole day in one sentence.",
    "",
    ...RULES,
  ].join("\n");
}

/**
 * The whole day, from its articles.
 *
 * The fallback path, and it exists for exactly one reason: a day old enough that
 * Google News has dropped the pubDate TIME from its articles has no honest
 * quarters to summarise (89.4% of those rows are stamped midnight US Pacific),
 * so the backfill writes the day sentence alone and there are no segment
 * summaries to build it from. It is also what a day whose every quarter was
 * refused falls back to.
 */
export function buildDayFromArticlesPrompt(input: {
  label: string | null;
  dayKey: string;
  members: readonly SummaryMember[];
}): string {
  return [
    `These headlines are one news story's coverage from ${input.dayKey} (UTC), oldest first.`,
    ...labelLine(input.label),
    "",
    renderMembers(input.members),
    "",
    "Summarise what happened that day in one sentence.",
    "",
    ...RULES,
  ].join("\n");
}

/**
 * Is what came back usable? Returns the cleaned sentence, or null.
 *
 * Two of the three clauses are mechanical and enforced here — one sentence, at
 * most 240 characters. The third — "say what happened, not what was reported" —
 * is not checkable and is deliberately left to the prompt, exactly as
 * `validateLabel` leaves "name the event, not the entity". A regex over
 * "reports" would reject a sentence about a report and accept a paraphrase of
 * the coverage that avoided the word.
 *
 * What it DOES clean is the wrapper, because that is presentation rather than
 * content and refusing it would spend a model call to reject a correct answer
 * wearing a hat. A chat-tuned model returns `**Summary:** "the pause held."`
 * often enough that treating it as a failure would make the failure the common
 * case — and unlike a label, where the wrapper words would BE the label, here
 * the sentence underneath is intact and unambiguous.
 */
export function validateSummary(raw: string): string | null {
  let text = raw.replaceAll(/\s+/g, " ").trim();
  if (!text) return null;

  // Strip in a loop: real output nests these — a bullet inside bold inside a
  // heading — and one pass leaves whichever layer happened to be outermost.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text
      .replace(/^[-*•>]+\s*/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^(?:\*\*|__|\*|_)+/, "")
      .replace(/(?:\*\*|__|\*|_)+$/, "")
      .replace(
        /^(?:summary|day summary|overall|overall summary|night|morning|afternoon|evening)\s*[:\-–—]\s*/i,
        "",
      )
      .replace(/^["'“‘]+/, "")
      .replace(/["'”’]+$/, "")
      .trim();
    if (text === before) break;
  }

  if (!text) return null;
  if (text.length > SUMMARY_MAX_CHARS) return null;
  if (sentenceCount(text) !== 1) return null;
  return text;
}

/**
 * How many sentences, guarding against the two ways a period lies.
 *
 * A boundary is a terminator followed by whitespace and something that starts a
 * sentence. The guards are on the token BEFORE the terminator:
 *
 *  - a single letter — `J. D. Vance` — is an initial;
 *  - a dotted initialism — the `U.S` of `U.S.` — is an abbreviation;
 *  - a known abbreviation (`Mr`, `Inc`, `vs`) is one by vocabulary alone.
 *
 * Nothing here tries to be a sentence tokenizer. It has one job: do not reject a
 * correct one-sentence answer that happens to name a country.
 */
export function sentenceCount(text: string): number {
  if (!text.trim()) return 0;
  let boundaries = 0;
  // The token before the terminator, the terminator, optional closing quote or
  // bracket, whitespace, then something a sentence can start with.
  const pattern = /(\S*?)([.!?])["'”’)\]]*\s+(?=["'“‘(]*[A-Z0-9])/g;
  for (const match of text.matchAll(pattern)) {
    const word = match[1] ?? "";
    if (/^[A-Za-z]$/.test(word)) continue;
    if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word)) continue;
    if (NON_TERMINAL_ABBREVIATIONS.has(word.toLowerCase().replace(/[^a-z]/g, ""))) continue;
    boundaries += 1;
  }
  return boundaries + 1;
}
