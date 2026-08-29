import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDayFromArticlesPrompt,
  buildDayFromSegmentsPrompt,
  buildSegmentSummaryPrompt,
  sentenceCount,
  validateSummary,
  SUMMARY_MAX_CHARS,
} from "./storyline-summary.js";

/**
 * The summariser's contract (ADR-0022), against the recorded response shapes.
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

  it("collapses the newlines a model formats with", () => {
    expect(validateSummary("The pause\nheld through\nthe evening.")).toBe(
      "The pause held through the evening.",
    );
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

  it("still counts a boundary after a quote", () => {
    expect(sentenceCount('He called it "a pause." Work stopped anyway.')).toBe(2);
  });
});

describe("the prompts", () => {
  it("names the quarter's own hours, so the model knows what window it is in", () => {
    const prompt = buildSegmentSummaryPrompt({
      label: "Big Bend Wall Pause",
      dayKey: "2026-08-14",
      segment: "morning",
      members: MEMBERS,
    });
    expect(prompt).toContain("morning (06:00-12:00 UTC) of 2026-08-14");
    expect(prompt).toContain('The running story is called "Big Bend Wall Pause".');
    // Oldest first, numbered, with the description trimmed onto its own line —
    // the labeler's rendering, so one reading of "what the model sees" serves
    // both prompts.
    expect(prompt).toContain("1. Wall work halted at Big Bend");
    expect(prompt).toContain("2. Contractor confirms Big Bend pause");
    expect(prompt).toContain(`at most ${SUMMARY_MAX_CHARS} characters`);
  });

  it("omits the label line entirely when the arc has no label", () => {
    const prompt = buildSegmentSummaryPrompt({
      label: null,
      dayKey: "2026-08-14",
      segment: "night",
      members: MEMBERS,
    });
    expect(prompt).not.toContain("running story is called");
  });

  it("builds the day from the quarters' sentences, not from the articles", () => {
    const prompt = buildDayFromSegmentsPrompt({
      label: "Big Bend Wall Pause",
      dayKey: "2026-08-14",
      segments: [
        { segment: "morning", summary: "Crews stood down at first light." },
        { segment: "evening", summary: "The contractor confirmed the pause." },
      ],
    });
    expect(prompt).toContain("morning (06:00-12:00 UTC): Crews stood down at first light.");
    expect(prompt).toContain("evening (18:00-24:00 UTC): The contractor confirmed the pause.");
    // The headlines must not be in here — that is the whole cost argument.
    expect(prompt).not.toContain("Wall work halted at Big Bend");
  });

  it("falls back to the articles for a day with no quarters", () => {
    const prompt = buildDayFromArticlesPrompt({
      label: "Big Bend Wall Pause",
      dayKey: "2026-08-14",
      members: MEMBERS,
    });
    expect(prompt).toContain("coverage from 2026-08-14 (UTC)");
    expect(prompt).toContain("1. Wall work halted at Big Bend");
  });

  it("trims a long description rather than sending it whole", () => {
    const prompt = buildSegmentSummaryPrompt({
      label: null,
      dayKey: "2026-08-14",
      segment: "afternoon",
      members: [{ ...MEMBERS[0]!, description: "x".repeat(400) }],
    });
    expect(prompt).toContain(`${"x".repeat(200)}…`);
    expect(prompt).not.toContain("x".repeat(201));
  });
});
