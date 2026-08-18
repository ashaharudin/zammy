import { describe, expect, it } from "vitest";
import {
  INCOHERENT_SENTINEL,
  buildCoherencePrompt,
  mayRefuseFormation,
  readCoherenceReply,
} from "./storyline-coherence.js";
import type { LabelMember } from "./storyline-label.js";

/**
 * The coherence verdict. Pure, so these pin the JUDGEMENT — what may act on a
 * storyline and what may not; docs/STORYLINE-LINKING.md records what the
 * archive said about whether the verdict is worth asking for.
 *
 * The two members below are the archive's `73dbc49f`: an off-duty officer shot
 * outside a Pennsylvania lounge and a Los Angeles father shot by an off-duty
 * ICE officer, linked by `off-duty` (df 3) and `fatally` (df 10) against a
 * ceiling of 31. Two anchors, mass 30.9 against a floor of 20 — every token
 * threshold in the design is satisfied, and it is still not one story.
 */
const members: LabelMember[] = [
  {
    title: "Off-duty police officer fatally shot outside Pa. lounge",
    description: "Surveillance video showed a fight breaking out just before the shooting.",
    published: new Date("2026-08-04T10:00:00Z"),
  },
  {
    title: "Family of L.A. father fatally shot by off-duty ICE officer demanding justice",
    description: "The family of a 43-year-old father fatally shot in Northridge want answers.",
    published: new Date("2026-08-12T10:00:00Z"),
  },
];

describe("buildCoherencePrompt", () => {
  it("does not assert that the coverage is one story", () => {
    // The shipped label prompt opens "These headlines all cover ONE news
    // story", which asserts the thing in question; a model told the answer
    // supplies a name. That sentence must not survive here.
    const prompt = buildCoherencePrompt(members);

    // The shipped label prompt's opening line, verbatim. The hedge "they MAY
    // all cover one news story" is the point; the flat assertion is what must go.
    expect(prompt).not.toContain("These headlines all cover");
    expect(prompt).toContain("may be unrelated items");
  });

  it("offers the decline, and asks for it BEFORE the naming rules", () => {
    const prompt = buildCoherencePrompt(members);

    expect(prompt).toContain(INCOHERENT_SENTINEL);
    expect(prompt.indexOf(INCOHERENT_SENTINEL)).toBeLessThan(prompt.indexOf("Between 2 and 5"));
  });

  it("names the disqualifiers the declined set is actually made of", () => {
    // Entity, beat/market, recurring column, turn of phrase — the four
    // categories the archive's declines fall into.
    const prompt = buildCoherencePrompt(members);

    for (const disqualifier of ["a person", "a market", "recurring column", "turn of phrase"]) {
      expect(prompt).toContain(disqualifier);
    }
  });

  it("protects follow-ups, reactions and analysis as the SAME story", () => {
    // Without this an arc could never accumulate, and the gate would refuse
    // exactly the long-running coverage storylines exist to hold together.
    expect(buildCoherencePrompt(members)).toContain(
      "including follow-ups, reactions, analysis",
    );
  });

  it("carries the coverage, numbered, with descriptions trimmed", () => {
    const long = [
      { ...members[0]!, description: "x".repeat(400) },
    ];

    const prompt = buildCoherencePrompt(long);
    expect(prompt).toContain("1. Off-duty police officer");
    expect(prompt).toContain("…");
    expect(prompt).not.toContain("x".repeat(260));
  });
});

describe("readCoherenceReply", () => {
  it("reads the sentinel as an explicit refusal", () => {
    expect(readCoherenceReply("NOT ONE STORY", members)).toEqual({ kind: "incoherent" });
  });

  it("reads a refusal that explains itself as a refusal", () => {
    // The model has decided. Holding it to punctuation would score its
    // judgement as a formatting failure and keep the pile.
    expect(
      readCoherenceReply("NOT ONE STORY — these are two different shootings", members),
    ).toEqual({ kind: "incoherent" });
  });

  it("reads a QUOTED refusal as a refusal", () => {
    expect(readCoherenceReply('"NOT ONE STORY"', members)).toEqual({ kind: "incoherent" });
  });

  it("is case- and whitespace-insensitive about the sentinel", () => {
    expect(readCoherenceReply("  not one story\n", members)).toEqual({ kind: "incoherent" });
  });

  it("does NOT read a label that merely mentions the phrase as a refusal", () => {
    // Anchored at the start on purpose: admitting the sentence anywhere is how
    // a gate starts dissolving storylines it was never asked about.
    const reply = readCoherenceReply("Pennsylvania Lounge Shooting", members);

    expect(reply.kind).toBe("named");
  });

  it("returns a validated label when the model named the story", () => {
    expect(readCoherenceReply("Northridge ICE Shooting", members)).toEqual({
      kind: "named",
      label: "Northridge ICE Shooting",
    });
  });

  it("treats an ungrounded name as UNUSABLE, never as a refusal", () => {
    // A model inventing a name that appears nowhere in the coverage has failed
    // the contract. That is not a judgement that the coverage is unrelated, and
    // conflating the two would dissolve storylines on a formatting slip.
    const reply = readCoherenceReply("Helsinki Transit Strike", members);

    expect(reply.kind).toBe("unusable");
  });

  it("treats a sentence as UNUSABLE", () => {
    const reply = readCoherenceReply(
      "These headlines appear to describe two separate incidents involving officers.",
      members,
    );

    expect(reply.kind).toBe("unusable");
  });

  it("treats no reply at all as UNUSABLE", () => {
    // The archive's own key has a 500-request DAILY quota and the labelling
    // campaign exhausted it. Silence must never act.
    expect(readCoherenceReply(null, members)).toMatchObject({ kind: "unusable" });
  });

  it("keeps the raw text in the reason, for iterating on the prompt", () => {
    const reply = readCoherenceReply("I cannot determine this", members);

    expect(reply).toMatchObject({ kind: "unusable" });
    if (reply.kind === "unusable") expect(reply.reason).toContain("I cannot determine this");
  });
});

describe("mayRefuseFormation", () => {
  it("allows a refusal only where two singletons are becoming a storyline", () => {
    expect(mayRefuseFormation({ trigger: "promotion", groupCountBefore: 1 })).toBe(true);
  });

  it("refuses to act on a join to an ESTABLISHED arc", () => {
    // Measured: over the archive's 21 named arcs of >=20 groups the verdict
    // rejects nine, seven of them genuine events. A mature arc's breadth reads
    // as incoherence, so the gate must not see one.
    expect(mayRefuseFormation({ trigger: "promotion", groupCountBefore: 12 })).toBe(false);
  });

  it("never acts on a merge — that evidence is K bridges plus label agreement", () => {
    expect(mayRefuseFormation({ trigger: "merge", groupCountBefore: 1 })).toBe(false);
  });

  it("never acts on drift, which is exactly where the 43% was measured", () => {
    // `labelStoryline` fires on drift at every doubling of membership. Wiring
    // the verdict there unscoped is the implementation that dissolves mature
    // arcs, so the guard rejects it even at a group count that looks like a
    // formation.
    expect(mayRefuseFormation({ trigger: "drift", groupCountBefore: 1 })).toBe(false);
  });
});
