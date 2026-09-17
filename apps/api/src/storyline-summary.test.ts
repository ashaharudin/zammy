import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDaySummaryPrompt,
  sentenceCount,
  validateSummary,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_WORDS,
} from "./storyline-summary.js";

/**
 * The summariser's contract (ADR-0023), against the recorded response shapes.
 *
 * The interesting half is `validateSummary`, and specifically what it must NOT
 * reject: a one-sentence answer naming a country is the common case, and a
 * naive sentence-boundary test rejects every one of them. The fixture's
 * `abbreviated` entry exists for exactly that.
 */

const RESPONSES = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/gemini-summary-responses.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>;

/** The answer text of a fixture, as `answerText` would hand it to the validator. */
function answerOf(name: string): string {
  const parts = RESPONSES[name]?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => (part as { thought?: boolean }).thought !== true)
    .map((part) => part.text ?? "")
    .join("");
}

const MEMBERS = [
  {
    title: "Wall work halted at Big Bend",
    description: "Crews stood down on Tuesday pending a federal review of the contract.",
    published: new Date("2026-08-14T07:10:00.000Z"),
    sightingCount: 9,
  },
  {
    title: "Contractor confirms Big Bend pause",
    description: null,
    published: new Date("2026-08-14T10:40:00.000Z"),
    sightingCount: 3,
  },
];

describe("validateSummary", () => {
  it("accepts the plain one-sentence answer", () => {
    expect(validateSummary(answerOf("ok"))).toBe(
      "Construction on the Big Bend border wall stayed paused as the contractor waited on a federal review.",
    );
  });

  it("strips the wrapper a chat-tuned model puts round it", () => {
    // Refusing this would spend a model call to reject a correct answer wearing
    // a hat — and unlike a label, where the wrapper words would BE the label,
    // the sentence underneath is intact.
    expect(validateSummary(answerOf("wrapped"))).toBe(
      "Construction on the Big Bend border wall stayed paused as the contractor waited on a federal review.",
    );
  });

  it("strips a nested bullet, bold and heading in one pass", () => {
    expect(validateSummary('- **Summary:** "The pause held."')).toBe("The pause held.");
  });

  it("refuses two sentences", () => {
    expect(validateSummary(answerOf("two_sentences"))).toBeNull();
  });

  it("ACCEPTS a sentence containing U.S. and Mr. — the abbreviation trap", () => {
    expect(validateSummary(answerOf("abbreviated"))).toBe(
      "U.S. Customs and Border Protection said Mr. Alvarez had signed the pause order that morning.",
    );
  });

  it("refuses an essay", () => {
    const essay = answerOf("essay");
    expect(essay.length).toBeGreaterThan(SUMMARY_MAX_CHARS);
    expect(validateSummary(essay)).toBeNull();
  });

  it("refuses empty and whitespace-only answers", () => {
    expect(validateSummary("")).toBeNull();
    expect(validateSummary("   \n  ")).toBeNull();
    // A wrapper with nothing inside it is the same nothing.
    expect(validateSummary('**Summary:** ""')).toBeNull();
  });

  it("keeps a leading time of day that is part of the sentence", () => {
    // "Evening" here is the first word of the answer, not a label on it.
    // Stripping it — as the segment names in the heading list used to — stored
    // a lowercase fragment for ever.
    expect(validateSummary("Evening — the talks collapsed.")).toBe(
      "Evening — the talks collapsed.",
    );
    expect(validateSummary("Morning brought no movement.")).toBe(
      "Morning brought no movement.",
    );
  });

  it("unwraps a quoted answer whose terminator sits outside the quotes", () => {
    expect(validateSummary('"The pause held".')).toBe("The pause held.");
    expect(validateSummary('"The pause held."')).toBe("The pause held.");
    expect(validateSummary('“The pause held.”')).toBe("The pause held.");
  });

  it("leaves a sentence that merely BEGINS and ENDS with a quotation alone", () => {
    // The lazy-unwrap version of this stored
    // `We will not yield," said Kim, adding "never.` — unbalanced quotes, for
    // ever, on a table nothing rebuilds.
    const quoted = '"We will not yield," said Kim, adding "never".';
    expect(validateSummary(quoted)).toBe(quoted);
  });

  it("strips the heading however the model decorated it", () => {
    // `**Summary**:` puts an emphasis marker BETWEEN the word and the colon.
    // Stripping the leading `**` first leaves `Summary**: …`, which then fails
    // to match the heading pattern and is stored verbatim.
    expect(validateSummary("**Summary:** The pause held.")).toBe("The pause held.");
    expect(validateSummary("**Summary**: The pause held.")).toBe("The pause held.");
    expect(validateSummary('> **Summary**: "U.S. officials paused the wall."')).toBe(
      "U.S. officials paused the wall.",
    );
    expect(validateSummary("**The pause held.**")).toBe("The pause held.");
  });

  it("leaves unbalanced emphasis inside a sentence alone", () => {
    // `_The pause_ held …` is italics on two words, not a wrapper round the
    // answer, and an unpaired strip turns it into `The pause_ held …`.
    expect(validateSummary("_The pause_ held through the afternoon.")).toBe(
      "_The pause_ held through the afternoon.",
    );
  });

  it("keeps a leading Overall that is part of the sentence", () => {
    // The same class as the segment names: only the words that cannot open a
    // sentence about the news belong in the heading list.
    expect(validateSummary("Overall — the ceasefire held through Tuesday.")).toBe(
      "Overall — the ceasefire held through Tuesday.",
    );
    expect(validateSummary("Overall summary: The ceasefire held.")).toBe(
      "The ceasefire held.",
    );
  });

  it("collapses the newlines a model formats with", () => {
    expect(validateSummary("The pause\nheld through\nthe evening.")).toBe(
      "The pause held through the evening.",
    );
  });

  it("leaves the model real headroom over what the prompt asked for", () => {
    // 35 words at the measured 6.69 characters each is ~234; the cap is ~45
    // words. A model has to overshoot its instruction by nearly a third before
    // the backstop fires, which is the difference between a refusal that means
    // "not one sentence about one day" and one that means "two words too long".
    expect(SUMMARY_MAX_CHARS).toBeGreaterThan(SUMMARY_MAX_WORDS * 7);
  });

  it("takes a sentence exactly at the cap and refuses one character more", () => {
    const atCap = `${"a".repeat(SUMMARY_MAX_CHARS - 1)}.`;
    expect(validateSummary(atCap)).toBe(atCap);
    expect(validateSummary(`${"a".repeat(SUMMARY_MAX_CHARS)}.`)).toBeNull();
  });
});

describe("sentenceCount", () => {
  it("counts a bare clause as one, terminated or not", () => {
    expect(sentenceCount("The pause held")).toBe(1);
    expect(sentenceCount("The pause held.")).toBe(1);
  });

  it("counts a real boundary", () => {
    expect(sentenceCount("The pause held. Officials said little.")).toBe(2);
    expect(sentenceCount("Did it hold? Nobody said.")).toBe(2);
  });

  it("does not count initials, initialisms or known abbreviations", () => {
    expect(sentenceCount("J. D. Vance visited the site.")).toBe(1);
    expect(sentenceCount("The U.S. Army confirmed the pause.")).toBe(1);
    expect(sentenceCount("Acme Inc. Ltd. filed the notice.")).toBe(1);
    expect(sentenceCount("Sept. 3 was the deadline.")).toBe(1);
  });

  it("knows the ranks and honorifics a news corpus is full of", () => {
    // A missing entry costs more than one summary: temperature is 0, so all
    // three attempts return the identical sentence and the span is retired.
    expect(sentenceCount("Sec. Rubio met Kim in Geneva.")).toBe(1);
    expect(sentenceCount("Maj. Gen. Smith took command of the operation.")).toBe(1);
    expect(sentenceCount("Amb. Chen delivered the note.")).toBe(1);
    expect(sentenceCount("Crews closed Ave. Rodriguez for the day.")).toBe(1);
  });

  it("still counts a boundary after a quote", () => {
    expect(sentenceCount('He called it "a pause." Work stopped anyway.')).toBe(2);
  });
});

describe("the prompt", () => {
  it("names the day and renders the members the way the labeler does", () => {
    const prompt = buildDaySummaryPrompt({
      label: "Big Bend Wall Pause",
      dayKey: "2026-08-14",
      members: MEMBERS,
    });
    expect(prompt).toContain("coverage from 2026-08-14 (UTC)");
    expect(prompt).toContain('The running story is called "Big Bend Wall Pause".');
    // Oldest first, numbered, with the description trimmed onto its own line —
    // the labeler's rendering, so one reading of "what the model sees" serves
    // both.
    expect(prompt).toContain("1. Wall work halted at Big Bend");
    expect(prompt).toContain("2. Contractor confirms Big Bend pause");
    // WORDS in the prompt, characters in the validator. A model cannot count
    // characters, and asking in a unit it cannot measure is what made the cap
    // the binding constraint instead of the backstop.
    expect(prompt).toContain(`at most ${SUMMARY_MAX_WORDS} words`);
    expect(prompt).not.toContain("characters");
  });

  it("omits the label line entirely when the arc has no label", () => {
    const prompt = buildDaySummaryPrompt({
      label: null,
      dayKey: "2026-08-14",
      members: MEMBERS,
    });
    expect(prompt).not.toContain("running story is called");
  });

  it("says nothing about six-hour quarters, which no longer exist", () => {
    // ADR-0027. The wording is the contract a reader of a stored sentence sees,
    // so a prompt still naming a window would produce sentences about a span
    // nothing else in the system agrees is a span.
    const prompt = buildDaySummaryPrompt({
      label: "Big Bend Wall Pause",
      dayKey: "2026-08-14",
      members: MEMBERS,
    });
    for (const quarter of ["night", "morning", "afternoon", "evening"]) {
      expect(prompt).not.toContain(quarter);
    }
    expect(prompt).toContain("Summarise what happened that day in one sentence.");
  });

  it("trims a long description rather than sending it whole", () => {
    const prompt = buildDaySummaryPrompt({
      label: null,
      dayKey: "2026-08-14",
      members: [{ ...MEMBERS[0]!, description: "x".repeat(400) }],
    });
    expect(prompt).toContain(`${"x".repeat(200)}…`);
    expect(prompt).not.toContain("x".repeat(201));
  });
});
