import { describe, expect, it } from "vitest";
import type { Reference } from "./api.js";
import { defaultCountry, defaultLanguage, defaultedFilters } from "./browserDefaults.js";
import { parseRoute } from "./route.js";

/**
 * What the command bar's filter chips start on before the user picks anything
 * (§8.1). Both defaults read the browser rather than the URL, so they take the
 * browser's readings as arguments — nothing here touches `navigator`.
 */

/** The upstream list, name→code, as /api/v1/reference serves it (§2). */
const LANGUAGES = { English: "en", French: "fr", German: "de", Malay: "msa" };

/** Codes are upper-case here, unlike languages — upstream serves them that way. */
const REGIONS = { Canada: "CA", "United States": "US", Japan: "JP", India: "IN" };

describe("defaultLanguage", () => {
  it("takes the browser's most-preferred language", () => {
    expect(defaultLanguage(["fr-CA", "en-US"], LANGUAGES)).toBe("fr");
  });

  it("skips preferences upstream does not carry, rather than filtering to nothing", () => {
    // Upstream's list is short (23 languages); a Welsh or Icelandic browser is
    // asking for a filter that would return an empty timeline forever.
    expect(defaultLanguage(["cy-GB", "de-AT"], LANGUAGES)).toBe("de");
  });

  it("falls back to English when nothing the browser wants is on offer", () => {
    expect(defaultLanguage(["cy-GB"], LANGUAGES)).toBe("en");
    expect(defaultLanguage([], LANGUAGES)).toBe("en");
  });
});

describe("defaultCountry", () => {
  it("takes the region the browser's locale names", () => {
    expect(defaultCountry({ locales: ["en-CA"], timeZone: undefined }, REGIONS)).toBe("CA");
  });

  it("falls back to the timezone when the locale names no region", () => {
    // A bare "en" is common — Chrome on a machine whose language was never
    // regionalized — and the timezone still knows where the reader is.
    expect(defaultCountry({ locales: ["en"], timeZone: "America/Edmonton" }, REGIONS)).toBe("CA");
  });

  it("prefers the locale's region over the timezone", () => {
    // A Canadian abroad reads Canadian news; the region subtag is a stated
    // preference, the timezone is only where the laptop happens to be.
    expect(defaultCountry({ locales: ["en-CA"], timeZone: "Asia/Tokyo" }, REGIONS)).toBe("CA");
  });

  it("says any country rather than guess at one upstream does not cover", () => {
    // "any country" is undefined, not a code: it is the ABSENCE of a country
    // filter, which is what a reader upstream has no bureau for should get.
    expect(defaultCountry({ locales: ["is-IS"], timeZone: "Atlantic/Reykjavik" }, REGIONS)).toBe(
      undefined,
    );
    expect(defaultCountry({ locales: [], timeZone: undefined }, REGIONS)).toBe(undefined);
  });

  it("offers nothing while the reference list is still loading", () => {
    // An empty reference is the first paint, not a claim that CA does not exist —
    // guessing CA there would send a country the API would reject.
    expect(defaultCountry({ locales: ["en-CA"], timeZone: "America/Toronto" }, {})).toBe(undefined);
  });
});

/**
 * Which of those readings a set of filters actually adopts. The rules differ per filter
 * because only one of them can say "I chose no filter": language has the code
 * `all`, while an absent country is silent about whether the reader picked
 * "any country" or never picked at all.
 */
const REFERENCE: Reference = {
  languages: LANGUAGES,
  regions: REGIONS,
};

const CANADIAN = { locales: ["en-CA"], timeZone: "America/Edmonton" };

describe("defaultedFilters", () => {
  it("fills both filters when a topic states none", () => {
    expect(defaultedFilters({}, CANADIAN, REFERENCE, "browser")).toEqual({
      language: "en",
      country: "CA",
    });
  });

  it("takes the browser's language on the timeline, and English on the hero", () => {
    // The hero is a cloud built from English coverage, so it speaks English
    // whatever the browser prefers; a topic already open follows the reader.
    const french = { locales: ["fr-CA"], timeZone: "America/Montreal" };

    expect(defaultedFilters({}, french, REFERENCE, "browser").language).toBe("fr");
    expect(defaultedFilters({}, french, REFERENCE, "english").language).toBe("en");
  });

  it("leaves a chosen any-country alone rather than re-detecting it on reload", () => {
    // Picking "any country" drops the param, so the only thing separating
    // it from a never-filtered topic is that the reader's other picks are on
    // the URL beside it. Re-detecting here would quietly localize a topic the
    // reader had deliberately opened up — and a shared link with it.
    expect(defaultedFilters({ language: "en" }, CANADIAN, REFERENCE, "browser")).toEqual({
      language: "en",
    });
  });

  it("keeps an explicit any-language, which the country filter has no way to say", () => {
    expect(defaultedFilters({ language: "all" }, CANADIAN, REFERENCE, "browser")).toEqual({
      language: "all",
    });
  });

  it("defaults a stale ?category= link exactly as it defaults the plain search", () => {
    // Composed with `parseRoute` on purpose: the claim is about a URL, and
    // neither unit can state it alone. `untouched` counted `category` until
    // ADR-0020, so `?q=housing&category=technology` used to state a filter and
    // suppress the country default; the parameter is not parsed now, so the
    // link states nothing and is defaulted like any bare `?q=`.
    //
    // What this actually pins, stated exactly: THE GATE. Forcing `untouched`
    // false fails it. It does NOT pin "nobody re-adds the parameter" — putting
    // `category` back in `PARAM_KEYS` alone leaves this green, because
    // `TopicFilters` has no field for `parseRoute` to surface it through. The
    // type system is the first guard there and this test is the second.
    const stale = defaultedFilters(
      parseRoute("?q=housing&category=technology").filters,
      CANADIAN,
      REFERENCE,
      "browser",
    );

    expect(stale).toEqual(
      defaultedFilters(parseRoute("?q=housing").filters, CANADIAN, REFERENCE, "browser"),
    );
    expect(stale).toEqual({ language: "en", country: "CA" });
    // The change this makes to that reader's saved link, stated rather than
    // implied: it used to keep "any country" and now takes theirs. Defensible —
    // a stale link should behave like the plain search in every respect — but
    // it is a change, and ADR-0020 records it.
    expect(parseRoute("?q=housing&category=technology&country=JP").filters.country).toBe("JP");
  });

  it("answers the language question even when the URL states other filters", () => {
    // A hand-typed or older link can carry a country but no language; the API
    // would apply its own default language to that, so leaving the chip
    // reading "any language" over a filtered timeline would misreport it.
    expect(defaultedFilters({ country: "JP" }, CANADIAN, REFERENCE, "browser")).toEqual({
      language: "en",
      country: "JP",
    });
  });
});
