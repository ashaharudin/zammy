import { describe, expect, it } from "vitest";
import { CLOUD_QUERY_TERMS, cloudQuery, storylineKeywords } from "./cloud-query.js";

/**
 * The search a cloud word runs (ADR-0014).
 *
 * Every case here is a real storyline from the dev archive, because the failure
 * this replaced was invisible to reasoning and obvious in the data: the labels
 * read perfectly and returned nothing. The archive's profiles are quoted as
 * they were stored, folded, so the assertions are about the fold meeting the
 * corpus rather than about a plausible-looking string.
 */

describe("cloudQuery", () => {
  it("keeps the label words the coverage says and drops the prose", () => {
    // The bug, exactly: "jason arday plagiarism controversy" was four
    // conjunctive upstream terms and returned 0 articles, while the arc it
    // named held three (bbc.co.uk, dailymail.com, mises.org).
    expect(
      cloudQuery({
        label: "Jason Arday plagiarism controversy",
        profileTokens: ["academic", "arday", "cambridge", "jason", "professor", "university"],
      }),
    ).toBe("jason arday");
  });

  it("takes the label's leading words, where the naming ones are", () => {
    // Labels are written subject-first, so the cap cuts the prose off the end
    // rather than the name off the front.
    expect(
      cloudQuery({
        label: "Lindsay Clancy murder trial",
        profileTokens: ["clancy", "lindsay", "murder", "trial"],
      }),
    ).toBe("lindsay clancy");
  });

  it("spends at most CLOUD_QUERY_TERMS terms, because upstream ANDs them", () => {
    const query = cloudQuery({
      label: "Hashemi Family ICE Detention",
      profileTokens: ["detention", "family", "hashemi", "ice"],
    });

    expect(query.split(" ")).toHaveLength(CLOUD_QUERY_TERMS);
    expect(query).toBe("hashemi family");
  });

  it("is happy with a single grounded word", () => {
    // "Jayden Daniels NIL dispute" grounded only `jayden` on live data. One
    // term is a wide search, which is the failure mode worth having.
    expect(
      cloudQuery({
        label: "Jayden Daniels NIL dispute",
        profileTokens: ["commanders", "jayden", "quarterback"],
      }),
    ).toBe("jayden");
  });

  it("folds plurals to the corpus spelling before testing membership", () => {
    // `labelWords` is the fold precisely so both sides meet: the label says
    // "Protections", the coverage says `protection`, and a raw lowercase
    // intersection would have dropped the word that names the story.
    expect(
      cloudQuery({
        label: "Trump Forest Protections Repeal",
        profileTokens: ["forest", "protection", "repeal", "trump"],
      }),
    ).toBe("trump forest");
  });

  it("folds possessives too, which a second regex got wrong once", () => {
    // The `dillard'` lesson (see trimWordPunctuation): `singular` alone leaves
    // the apostrophe stranded and the two sides never meet. The possessive is
    // still stripped from what the query SPELLS — it wraps the word rather than
    // belonging to it, and "dillard's earnings" is not what a reader would type.
    expect(
      cloudQuery({
        label: "Dillard's Earnings Beat",
        profileTokens: ["beat", "dillard", "earning"],
      }),
    ).toBe("dillard earnings");
  });

  it("spells the label's own word, not the fold that matched it", () => {
    // The fold is a comparison key and `singular` is lossy: "crisis" folds to
    // `crisi`, which is what the corpus stores and what this used to put in
    // `?q=`, in the command bar and in the hero's ghost text — and then asked
    // upstream for. Matching still happens on `crisi`; only the spelling
    // changed.
    expect(
      cloudQuery({
        label: "Gaza Crisis Talks",
        profileTokens: ["crisi", "gaza", "talk"],
      }),
    ).toBe("gaza crisis");
  });

  it("spends one term per word of the corpus, not one per spelling of it", () => {
    // De-duplication stays on the fold. Both label words mean `state` to the
    // corpus, so spending both of a two-term budget on them would buy one word.
    expect(
      cloudQuery({
        label: "State States Register Ruling",
        profileTokens: ["register", "ruling", "state"],
      }),
    ).toBe("state register");
  });

  it("keeps label order rather than the profile's, and de-duplicates", () => {
    // profile_tokens are stored alphabetically; reading the query off them
    // would put "climate" before "florida" and name the wrong subject.
    expect(
      cloudQuery({
        label: "Florida Textbook Climate Revision",
        profileTokens: ["climate", "florida", "revision", "textbook"],
      }),
    ).toBe("florida textbook");
  });

  it("falls back to the profile when the label shares nothing with it", () => {
    // A label naming its arc in words none of its coverage uses. Headline words
    // with no claim to name the event still beat prose nothing can match.
    expect(
      cloudQuery({
        label: "An Unfolding Situation",
        profileTokens: ["kelowna", "wildfire"],
      }),
    ).toBe("kelowna wildfire");
  });

  it("reaches a name the coverage accents and the labeler does not", () => {
    // The live arc that exposed the fold (dev archive, 2026-08-27): the profile
    // is quoted verbatim, `niño` and all, and the label is the one the model
    // wrote. Before tokenizer version 8 the naming word could not ground, so
    // the arc searched for its two weakest words and `nino` was dropped.
    const arc = {
      label: "El Niño Hurricane Season",
      profileTokens: ["el", "hurricane", "nino", "season", "storm"],
    };
    expect(cloudQuery(arc)).toBe("el niño");
    // ...and the ASCII label the model wrote for a neighbouring arc grounds
    // against the same profile, which is what the fold bought.
    expect(cloudQuery({ ...arc, label: "El Nino Hurricane Season" })).toBe("el nino");
  });

  it("falls back to the label when there is no profile at all", () => {
    // Unreachable through the read (a labelled, promoted storyline has a
    // profile, and merged-away ones are excluded before this runs), but an
    // empty query is a 400 from canonicalize on a word the reader can see.
    expect(cloudQuery({ label: "Fort Hood Crash", profileTokens: [] })).toBe("Fort Hood Crash");
  });
});

describe("storylineKeywords", () => {
  it("is cloudQuery wherever there is a label to ground", () => {
    // One rule, not two: the fingerprint a click mints has to be the one the
    // cloud's own placeholder proposes for the same arc (§6.2).
    const arc = {
      label: "Jason Arday plagiarism controversy",
      profileTokens: ["academic", "arday", "cambridge", "jason", "professor", "university"],
    };
    expect(storylineKeywords(arc)).toBe(cloudQuery(arc));
  });

  it("searches the profile for an arc whose labelling failed", () => {
    // The case the cloud never sees and the timeline gutter does: a promoted
    // storyline renders label-less rather than not at all (ADR-0011), so it is
    // clickable, and a click that asked for nothing would leave exactly those
    // arcs to go stale.
    expect(
      storylineKeywords({ label: null, profileTokens: ["kelowna", "wildfire", "evacuation"] }),
    ).toBe("kelowna wildfire");
  });

  it("has nothing to ask for when the arc has no profile, label or not", () => {
    // A merged-away arc: `mergeStorylines` clears the loser's profile. Null
    // rather than "", because an empty query is a 400 from canonicalize about a
    // keyword no caller chose.
    expect(storylineKeywords({ label: null, profileTokens: [] })).toBeNull();
    // And with a label, which is where the two functions must diverge:
    // `cloudQuery` returns the label VERBATIM here, which is the right string to
    // SHOW and the wrong one to SEND — four conjunctive terms is the query
    // ADR-0014 measured at zero results.
    const label = "Hurricane Fausto Hawaii Landfall";
    expect(cloudQuery({ label, profileTokens: [] })).toBe(label);
    expect(storylineKeywords({ label, profileTokens: [] })).toBeNull();
  });
});
