import type { SummaryMember } from "@zammy/storage";

/**
 * The prompts and the contract for the historical preserve (ADR-0023,
 * docs/STORYLINE-SUMMARIES.md) — the pure half, mirroring `storyline-label.ts`.
 *
 * A summary is ONE SENTENCE about what happened in one UTC DAY of a storyline's
 * coverage. There was a second prompt per six-hour quarter and a third that
 * wrote the day from those four sentences; ADR-0027 removed both, and what is
 * left is the one that was always the fallback — the day, from its articles.
 *
 * The contract is deliberately narrower than a label's in one way and
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
 * What the PROMPT asks for, in words.
 *
 * Words rather than characters, because a model cannot count characters and can
 * roughly count words — and asking in a unit it cannot measure is what put the
 * binding constraint somewhere neither side could see. MEASURED over the first
 * 48 live summaries (2026-08-29, `Canada US Trade War` and others): the model
 * writes to whatever limit it is given, so under a 240-CHARACTER instruction
 * **31 of 48 answers landed between 216 and 240 characters**, the longest was
 * exactly 240, and three spilled over and were refused — the tail of a
 * distribution pressed against a wall, not a set of outliers.
 *
 * 35 words is that distribution's own shape (observed 20-40, mean 32.2) stated
 * in the unit the model can act on.
 */
export const SUMMARY_MAX_WORDS = 35;

/**
 * The cap, in characters — the BACKSTOP now, not the target.
 *
 * Characters here and words in the prompt, deliberately: a stored row is checked
 * in the unit a reader can check exactly, and the model is asked in the unit it
 * can approximate. They are related by the measured 6.69 characters per word, so
 * 35 words is about 234 characters and this cap is about 45 — a model would have
 * to overshoot its instruction by nearly a third before the wall is reached.
 *
 * That headroom is the whole change. At 240 the cap WAS the instruction, badly
 * expressed, and every refusal it produced was a sentence one or two words too
 * long that a retry could not fix (temperature 0 replays it; see
 * `storyline-summary-service.ts`). At 300 a refusal means the answer is genuinely
 * not one sentence about one day.
 */
export const SUMMARY_MAX_CHARS = 300;

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
  // Honorifics and ranks. The military and diplomatic ones are here because
  // this corpus is news: `Maj. Gen. Smith took command.` is one sentence, and a
  // missing entry does not merely lose that summary — temperature is 0, so all
  // three attempts return the identical sentence, fail the identical check, and
  // retire the span with a null summary for ever.
  "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "hon", "st", "mt", "ft",
  "jr", "sr", "gen", "maj", "brig", "col", "sgt", "capt", "cpl", "pvt", "lt",
  "cmdr", "adm", "sen", "rep", "gov", "sec", "amb", "pres", "supt", "det",
  "insp", "messrs",
  // Organisations and places.
  "inc", "ltd", "co", "corp", "dept", "univ", "assn", "bros",
  "ave", "blvd", "rd", "sq",
  // Everything else that ends in a period without ending a sentence.
  "vs", "etc", "approx", "est", "no", "fig", "al", "min", "max",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec",
]);

/** The rules block. One contract, one wording — and now one prompt. */
const RULES = [
  "Rules:",
  `- Exactly ONE sentence, at most ${SUMMARY_MAX_WORDS} words.`,
  "- Say what HAPPENED. Do not describe the coverage itself: no 'reports say',",
  "  'articles describe', 'headlines focus on'.",
  "- Name the people, places and organisations involved rather than referring to",
  "  'the story' or 'the situation'.",
  "- No preamble, no heading, no bullet, no quotation marks around it.",
  "- Reply with the sentence alone and nothing else.",
];

/** `The story is called "X".`, or nothing when the arc has no label yet. */
function labelLine(label: string | null): string[] {
  // The label is three words and costs nothing, and without it a thin day gets
  // summarized as if its headlines were standalone items rather than a turn in
  // a running story. What is deliberately NOT here is the PREVIOUS day's
  // sentence: chaining would let one bad sentence poison every later one, and
  // would stop a day being recomputable on its own — which is exactly what the
  // settling window needs it to be.
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

/**
 * The whole day, from its articles. The only prompt there is (ADR-0027).
 *
 * It used to be the fallback — for a day past the pubDate cliff, whose articles
 * carry no honest time of day, and for a day whose every quarter was refused.
 * Removing the quarters promoted it, and nothing about the prompt itself had to
 * change: it always took a day's articles and asked for a day's sentence.
 *
 * What DID change is how much it is shown. Under the quarters a busy day
 * reached the model as four samples of eight and the day sentence was written
 * over their four answers; now this one call carries the day, which is why its
 * sample is `SUMMARY_DAY_SAMPLE` and not the eight a quarter got.
 */
export function buildDaySummaryPrompt(input: {
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
 * The markers a chat-tuned model wraps an answer in.
 *
 * Emphasis and quotation are handled by the same three rules below because they
 * fail the same way: each is a wrapper when it is BALANCED around the whole
 * answer and part of the sentence when it is not, and a strip that cannot tell
 * the difference quietly stores `The pause_ held` or
 * `We will not yield," said Kim, adding "never.` for ever.
 */
const WRAPPERS: ReadonlyArray<{ open: string; close: string }> = [
  { open: "**", close: "**" },
  { open: "__", close: "__" },
  { open: "*", close: "*" },
  { open: "_", close: "_" },
  { open: '"', close: '"' },
  { open: "'", close: "'" },
  { open: "\u201c", close: "\u201d" },
  { open: "\u2018", close: "\u2019" },
];

/**
 * A leading bullet or list number.
 *
 * `*` only when whitespace follows it: `* The pause held` is a bullet and
 * `*The pause held*` is emphasis, and the two are one character apart.
 */
function stripBullet(text: string): string {
  return text.replace(/^(?:[-\u2022>]+|\*(?=\s))\s*/, "").replace(/^\d+[.)]\s+/, "");
}

/**
 * `Summary:`, however the model decorated it.
 *
 * The emphasis markers are matched HERE rather than stripped beforehand,
 * because `**Summary**:` puts one of them between the word and the colon —
 * strip the leading `**` first and the heading no longer matches its own
 * regex, and what gets stored is `Summary**: the pause held`. All three real
 * forms (`**Summary:**`, `**Summary**:`, `Summary:`) are one pattern.
 *
 * The word list is deliberately short. The SEGMENT names are not in it: "Evening
 * — the talks collapsed." is a correct answer whose first word is part of the
 * sentence, and so is "Overall — the ceasefire held." Only the words that
 * cannot plausibly open a sentence about the news belong here.
 */
const EMPHASIS = "(?:\\*\\*|__|\\*|_)*";
const HEADING = new RegExp(
  `^${EMPHASIS}\\s*(?:summary|day summary|overall summary)\\s*${EMPHASIS}\\s*[:\\-\u2013\u2014]\\s*${EMPHASIS}\\s*`,
  "i",
);

function stripHeading(text: string): string {
  return text.replace(HEADING, "");
}

/**
 * One layer of balanced wrapping, and NOTHING unbalanced.
 *
 * Two shapes count as wrapping the whole answer: `"…"` and `"…".` — the
 * terminator sits inside the quotes or outside them, and a model does both. What
 * does not count is a delimiter that appears again inside, which is the test
 * that keeps a quoted quotation intact.
 */
function unwrapDelimiters(text: string): string {
  for (const { open, close } of WRAPPERS) {
    if (!text.startsWith(open)) continue;
    for (const tail of ["", ".", "!", "?"]) {
      const suffix = close + tail;
      // `>=`, not `>`: an EMPTY wrapper — `""`, which is what a heading strip
      // leaves of `**Summary:** ""` — must unwrap to nothing and be refused,
      // rather than surviving as a two-character "sentence".
      if (text.length < open.length + suffix.length) continue;
      if (!text.endsWith(suffix)) continue;
      const inner = text.slice(open.length, text.length - suffix.length);
      // A second occurrence means these are quotation marks in a sentence, not
      // a wrapper round one.
      if (inner.includes(open) || inner.includes(close)) continue;
      return `${inner.trim()}${tail}`;
    }
  }
  return text;
}

/**
 * Is what came back usable? Returns the cleaned sentence, or null.
 *
 * Two of the three clauses are mechanical and enforced here — one sentence, and
 * a length backstop. Note that the backstop is not what the PROMPT asks for:
 * the prompt bounds words, this bounds characters, and the gap between them is
 * headroom for a model that counts words approximately and characters not at
 * all. The third — "say what happened, not what was reported" —
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

  // Stripped in a loop, because real output NESTS these — a bullet outside bold
  // outside a heading outside a quote — and one pass removes whichever layer
  // happened to be outermost.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = unwrapDelimiters(stripHeading(stripBullet(text))).trim();
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
