import { describe, expect, it } from "vitest";
import type { Reference } from "./api.js";
import { filterChips } from "./filterChips.js";

/**
 * The command bar's filter chips (§8.1): what the reader's current topic is
 * filtered to, stated in the meta row beside the asOf stamp — location,
 * language, category, in that order.
 *
 * Codes are what travels (§2); names are what a chip's LIST shows. The country
 * chip reads as a place ("Canada") because a bare "CA" says nothing, while the
 * language chip stays the code the URL carries.
 */
const REFERENCE: Reference = {
  languages: { English: "en", French: "fr" },
  regions: { Canada: "CA", "United State": "US" },
  categories: ["sports", "world"],
};

describe("filterChips", () => {
  it("states location, language and category in that order", () => {
    const chips = filterChips(
      { q: "wildfires", country: "CA", language: "en", category: "sports" },
      REFERENCE,
    );

    expect(chips.map((chip) => chip.label)).toEqual(["Canada", "en", "sports"]);
  });

  it("names the unfiltered state rather than leaving a chip blank", () => {
    const chips = filterChips({ q: "wildfires", language: "en" }, REFERENCE);

    expect(chips.map((chip) => chip.label)).toEqual(["Worldwide", "en", "any category"]);
  });

  it("reads an explicit any-language as words, not as the code 'all'", () => {
    const [, language] = filterChips({ q: "wildfires", language: "all" }, REFERENCE);

    expect(language?.label).toBe("any language");
  });

  it("shows a code the reference has no name for rather than dropping it", () => {
    // A shared link can carry a country the cached reference list has since
    // stopped naming; the filter is still in force, so the chip must say so.
    const [location] = filterChips({ q: "wildfires", country: "ZW" }, REFERENCE);

    expect(location?.label).toBe("ZW");
  });

  it("opens each chip on the unfiltered choice, then what the reference offers", () => {
    const [location, language, category] = filterChips({ q: "wildfires" }, REFERENCE);

    // Names in the list, codes on the wire — including the language list, whose
    // chip reads "en" but whose options have to be readable to pick from.
    expect(location?.options).toEqual([
      { code: undefined, label: "Worldwide" },
      { code: "CA", label: "Canada" },
      { code: "US", label: "United State" },
    ]);
    expect(language?.options).toEqual([
      // "all" rather than undefined: the API canonicalizes it to no language
      // filter, and unlike an absent param it says the reader CHOSE this, so a
      // detected default never overwrites it.
      { code: "all", label: "any language" },
      { code: "en", label: "English" },
      { code: "fr", label: "French" },
    ]);
    expect(category?.options).toEqual([
      { code: undefined, label: "any category" },
      { code: "sports", label: "sports" },
      { code: "world", label: "world" },
    ]);
  });
});
