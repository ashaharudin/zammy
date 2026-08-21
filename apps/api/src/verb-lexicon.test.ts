import { describe, expect, it } from "vitest";
import { PAST_FORMS, VERB_FORMS } from "./verb-lexicon.js";

/**
 * The verb lexicon itself, rather than the gate that reads it.
 *
 * `headline-tokens.test.ts` covers the gate's BEHAVIOUR through whole
 * headlines, which is the right level for "does a name beside a verb survive".
 * It cannot see the two failure modes that live in this module, because both
 * are silent: a lemma classified into the wrong list, and a derived form
 * MISSPELLED. Neither throws, neither fails a type check, and both simply
 * leave a word ungated — the exact shape of the bug issue #100 filed and of
 * the gaps found after it.
 *
 * So these assert on the derived sets directly. The point is not to restate
 * the lists (that would be a copy, not a test) but to pin the small number of
 * spelling rules and list invariants where a mistake is invisible.
 */

describe("the derivers spell irregular stems correctly", () => {
  // A misspelled form is strictly worse than a missing one: it gates nothing
  // and it looks present. Each case below is a stem the bare `-e` rule gets
  // wrong, so each needs its own branch in `participles`.

  it("turns -ie into -ying, not -iing (die, vie)", () => {
    // Found by "Boxer Dies" surviving the gate: `die` was absent from the
    // lexicon, and adding it exposed the deriver producing "diing".
    expect(VERB_FORMS.has("dying")).toBe(true);
    expect(VERB_FORMS.has("diing")).toBe(false);
    expect(VERB_FORMS.has("vying")).toBe(true);
    expect(VERB_FORMS.has("viing")).toBe(false);
  });

  it("keeps the e of -ee before -ing and adds only d for the past", () => {
    // Named by issue #100: "PAST_FORMS holds `agreeed`, not `agreed`". It
    // cost `agree` and `disagree` their past route, and `guarantee` — which
    // is PAST_ONLY — every route it had.
    expect(PAST_FORMS.has("agreed")).toBe(true);
    expect(PAST_FORMS.has("agreeed")).toBe(false);
    expect(PAST_FORMS.has("disagreed")).toBe(true);
    expect(PAST_FORMS.has("guaranteed")).toBe(true);
    expect(VERB_FORMS.has("agreeing")).toBe(true);
  });

  it("carries an irregular past that no -ed rule could reach (beaten)", () => {
    // "Rangers Beat" is gated by the BARE form; "Rangers Beaten" needs the
    // participle, which "beated"/"beatted" does not supply.
    expect(PAST_FORMS.has("beaten")).toBe(true);
    expect(PAST_FORMS.has("brought")).toBe(true);
  });

  it("doubles the consonant of a short stem (rip)", () => {
    expect(VERB_FORMS.has("ripping")).toBe(true);
    expect(PAST_FORMS.has("ripped")).toBe(true);
  });
});

describe("each lemma carries exactly one classification", () => {
  // The three lists are alternatives — "a lemma lands in VERB_LEMMAS when
  // both live inflections stay verbal, in FINITE_ONLY_LEMMAS when only its
  // -ing has nominalized, and in PAST_ONLY_LEMMAS when its -s has too". A
  // lemma in two of them is not a doubled entry, it is two contradictory
  // answers to the file's own question, and the -s/-ing routes of the more
  // permissive list silently win. `jump` was in VERB_LEMMAS and
  // PAST_ONLY_LEMMAS at once.
  //
  // The lists are module-private, so this is asserted where it is
  // observable: a lemma routed as PAST_ONLY must not have leaked an -s or
  // -ing form into VERB_FORMS.

  it("gates the -s of jump without gating its -ing", () => {
    // "AGL Jumps" is a clause; "Ski Jumping" and "Show Jumping" are names.
    expect(VERB_FORMS.has("jumps")).toBe(true);
    expect(PAST_FORMS.has("jumped")).toBe(true);
    expect(VERB_FORMS.has("jumping")).toBe(false);
  });

  it("leaves the bare form of a noun-shaped lemma alone", () => {
    // BARE_NOUN_LEMMAS and the wholesale exclusion of the other two lists
    // both land here: "a jump", "the blame", "a rip" are compounds' words.
    for (const bare of ["jump", "blame", "rip", "rise", "leave", "recall"]) {
      expect(VERB_FORMS.has(bare), `bare "${bare}" was gated`).toBe(false);
    }
  });

  it("still gates the inflections of a lemma whose bare form is a noun", () => {
    // Being in BARE_NOUN_LEMMAS buys back the bare form only. The whole
    // point of the entry is that "blames"/"blaming" stay verbal.
    expect(VERB_FORMS.has("blames")).toBe(true);
    expect(VERB_FORMS.has("blaming")).toBe(true);
    expect(PAST_FORMS.has("blamed")).toBe(true);
    expect(VERB_FORMS.has("rips")).toBe(true);
  });
});

describe("the gaps that let clause-shaped labels through", () => {
  // Each of these was a live bigram label the gate admitted.

  it.each([
    ["Rangers Beat", "beat"],
    ["Gigabyte Brings", "brings"],
    ["Danon Blames", "blames"],
    ["AGL Jumps", "jumps"],
    ["Fire Rips", "rips"],
    ["Boxer Dies", "dies"],
  ])("gates the predicate of %s", (_label, form) => {
    expect(VERB_FORMS.has(form)).toBe(true);
  });
});
