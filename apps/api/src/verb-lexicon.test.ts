import { readFileSync } from "node:fs";
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

  it("has no lemma in two classification lists, whatever it derives to", () => {
    // Read from the SOURCE, because the observable assertions below cannot see
    // this. `ok` was added to FINITE_ONLY_LEMMAS while it still sat in
    // PAST_ONLY_LEMMAS, and nothing caught it: both routes derive "oked", the
    // Set dedupes, and only the finite list adds "oks", so every behavioural
    // test still passed. A duplicate is a latent contradiction — the moment
    // either list's routes change, the more permissive one silently wins — and
    // the file's own rule ("the three are alternatives, one classification per
    // lemma") is the thing worth pinning, not the symptom it happens to have.
    //
    // The three lists are module-private on purpose, so this parses them rather
    // than exporting them for a test. `place` moving correctly and `ok` being
    // copied in the same change is the argument for making the check mechanical
    // rather than trusting a re-read.
    const source = readFileSync(new URL("./verb-lexicon.ts", import.meta.url), "utf8");
    const lemmas = (name: string): string[] => {
      const block = new RegExp(`const ${name}[^=]*=\\s*\\[(.*?)\\] as const;`, "s").exec(source);
      expect(block, `${name} not found — did it stop being an "as const" array?`).not.toBeNull();
      return [...block![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    };

    const classifications = {
      VERB_LEMMAS: lemmas("VERB_LEMMAS"),
      FINITE_ONLY_LEMMAS: lemmas("FINITE_ONLY_LEMMAS"),
      PAST_ONLY_LEMMAS: lemmas("PAST_ONLY_LEMMAS"),
    };

    for (const [name, list] of Object.entries(classifications)) {
      expect(list.length, `${name} parsed empty`).toBeGreaterThan(10);
      const repeated = [...new Set(list.filter((l, i) => list.indexOf(l) !== i))];
      expect(repeated, `${name} repeats a lemma`).toEqual([]);
    }

    const names = Object.keys(classifications) as Array<keyof typeof classifications>;
    for (let a = 0; a < names.length; a += 1) {
      for (let b = a + 1; b < names.length; b += 1) {
        const shared = classifications[names[a]!].filter((lemma) =>
          classifications[names[b]!].includes(lemma),
        );
        expect(shared, `${names[a]!} and ${names[b]!} share a lemma`).toEqual([]);
      }
    }
  });

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
    // The 2026-08-21 sweep of the live archive. `homers` and `place` are the
    // reported pair; the rest are what the same scan turned up beside them.
    ["Neto Homers", "homers"],
    ["Brewers Place", "place"],
    ["Australia Adds", "adds"],
    ["Estrada Asks", "asks"],
    ["Europe Bakes", "bakes"],
    ["Trump Chastises", "chastises"],
    ["Senate Clears", "clears"],
    ["President Confers", "confers"],
    ["Dpm Conveys", "conveys"],
    ["Japan Deepening", "deepening"],
    ["Bacaro Demolishes", "demolishes"],
    ["Hamas Disarms", "disarms"],
    ["Bounce Fades", "fades"],
    ["Sec Intensifies", "intensifies"],
    ["Lesotho Lauds", "lauds"],
    ["France Likens", "likens"],
    ["Canada Nearing", "nearing"],
    ["Unifil Neutralizes", "neutralizes"],
    ["Senate Oks", "oks"],
    ["Seoul Overhauls", "overhauls"],
    ["Trump Resurrects", "resurrects"],
    ["Trump Reverts", "reverts"],
    ["Mamdani Shrugs", "shrugs"],
    ["Bencic Withdraws", "withdraws"],
    ["Lhc Acquits", "acquits"],
    ["Penguins Activates", "activates"],
  ])("gates the predicate of %s", (_label, form) => {
    expect(VERB_FORMS.has(form)).toBe(true);
  });

  it.each([
    ["Glover Inducted", "inducted"],
    ["Turkey Misrepresented", "misrepresented"],
  ])("gates the participle of %s", (_label, form) => {
    expect(PAST_FORMS.has(form)).toBe(true);
  });
});

describe("the bare form of a plural subject's verb", () => {
  // Headline style puts a plural subject in front of the BARE verb, and in a
  // headline a plural subject is a team: "Brewers place RHP Abner Uribe
  // (forearm) on 15-day IL", "Albies and Riley homer, Braves beat Marlins
  // 4-2". Neither word is inflected, so neither -s nor -ing nor -ed reaches
  // it, and both were live labels (`Brewers Place`, `Riley Homer`).
  //
  // Both bare forms ARE ordinary nouns — "a place", "a homer" — which by the
  // file's usual test would put them in BARE_NOUN_LEMMAS. They are gated
  // anyway, on the same asymmetry `beat` and `die` are: the nominal reading
  // takes a numeral or an adjective in front of it, never a name, so the only
  // pairs that clear the bigram's proper-noun bar are the clauses.

  it("gates bare place and homer", () => {
    expect(VERB_FORMS.has("place")).toBe(true);
    expect(VERB_FORMS.has("homer")).toBe(true);
  });

  it("gates their other inflections too", () => {
    // `place` moved out of PAST_ONLY_LEMMAS to get here, so the -s and -ing
    // routes it used to be denied must have come with it.
    for (const form of ["places", "placing", "homers", "homering"]) {
      expect(VERB_FORMS.has(form), `"${form}" was not gated`).toBe(true);
    }
    expect(PAST_FORMS.has("placed")).toBe(true);
    expect(PAST_FORMS.has("homered")).toBe(true);
  });

  it("does not gate the bare forms that really are only nouns", () => {
    // The counterweight: `near` and `overhaul` are the new lemmas whose bare
    // form is NOT a predicate a headline reaches this way. Bare `near` is a
    // preposition ("Near Bordeaux" heads 17 live labels) and "an overhaul" is
    // a plain noun, so both are in BARE_NOUN_LEMMAS.
    for (const bare of ["near", "overhaul", "shrug"]) {
      expect(VERB_FORMS.has(bare), `bare "${bare}" was gated`).toBe(false);
    }
    // And the FINITE_ONLY entries keep their bare forms by the wholesale
    // exclusion: "clear" is an adjective, "ask" and "bake" are not names of
    // anything but are not worth the -ing either ("an asking price").
    for (const bare of ["clear", "ask", "bake", "ok"]) {
      expect(VERB_FORMS.has(bare), `bare "${bare}" was gated`).toBe(false);
    }
    expect(VERB_FORMS.has("clearing")).toBe(false);
    expect(VERB_FORMS.has("asking")).toBe(false);
    expect(VERB_FORMS.has("baking")).toBe(false);
  });
});

describe("the derivers spell the new stems correctly", () => {
  // Same reasoning as the block at the top of this file: a misspelled form
  // gates nothing and looks present. These are the new lemmas whose stem the
  // spelling rules could plausibly get wrong.

  it("doubles the consonant of acquit and confer", () => {
    expect(PAST_FORMS.has("acquitted")).toBe(true);
    expect(VERB_FORMS.has("acquitting")).toBe(true);
    expect(PAST_FORMS.has("conferred")).toBe(true);
    expect(VERB_FORMS.has("conferring")).toBe(true);
  });

  it("turns the -y of intensify into -ies and -ied", () => {
    expect(VERB_FORMS.has("intensifies")).toBe(true);
    expect(VERB_FORMS.has("intensifys")).toBe(false);
    expect(PAST_FORMS.has("intensified")).toBe(true);
  });

  it("keeps the -ey of convey whole", () => {
    // The -y rule fires only after a consonant, so "conveys" must not have
    // become "convies".
    expect(VERB_FORMS.has("conveys")).toBe(true);
    expect(VERB_FORMS.has("convies")).toBe(false);
    expect(PAST_FORMS.has("conveyed")).toBe(true);
  });

  it("adds -es after the sibilant of demolish and chastise", () => {
    expect(VERB_FORMS.has("demolishes")).toBe(true);
    expect(VERB_FORMS.has("demolishs")).toBe(false);
    expect(VERB_FORMS.has("chastises")).toBe(true);
  });

  it("drops the -e of fade and place before -ing", () => {
    expect(VERB_FORMS.has("fading")).toBe(true);
    expect(VERB_FORMS.has("fadeing")).toBe(false);
    expect(VERB_FORMS.has("placing")).toBe(true);
    expect(VERB_FORMS.has("placeing")).toBe(false);
  });
});
