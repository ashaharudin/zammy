import { describe, expect, it } from "vitest";
import type { Reference } from "./api.js";
import { filterChips } from "./filterChips.js";

/**
 * The command bar's filter chips (§8.1): what the reader's current topic is
 * filtered to, stated in the meta row — location, and only location since
 * ADR-0020 retired the category chip. There is no language chip either:
 * language always defaults to English for now (browserDefaults.ts).
 *
 * Codes are what travels (§2); names are what a chip's LIST shows. The country
 * chip reads as a place ("Canada") because a bare "CA" says nothing.
 *
 * The names here are the ones the API serves, which are upstream's spell-checked
 * (`repairedRegions`) rather than upstream's own — this component receives a
 * reference body and has no opinion about it, so quoting the typo would pin a
 * string the API can no longer produce.
 */
const REFERENCE: Reference = {
  languages: { English: "en", French: "fr" },
  regions: { Canada: "CA", "United States": "US" },
};

describe("filterChips", () => {
  it("states location, and offers nothing else to narrow by", () => {
    const chips = filterChips({ country: "CA", language: "en" }, REFERENCE);

    // Pinned as the whole row, not just as "the location chip is right": a
    // reader must not be able to choose a category (ADR-0020), and the way
    // that breaks is a second chip reappearing beside this one.
    expect(chips.map((chip) => chip.kind)).toEqual(["country"]);
    expect(chips.map((chip) => chip.label)).toEqual(["Canada"]);
  });

  it("names the unfiltered state rather than leaving a chip blank", () => {
    const chips = filterChips({ language: "en" }, REFERENCE);

    expect(chips.map((chip) => chip.label)).toEqual(["any country"]);
  });

  it("shows a code the reference has no name for rather than dropping it", () => {
    // A shared link can carry a country the cached reference list has since
    // stopped naming; the filter is still in force, so the chip must say so.
    const [location] = filterChips({ country: "ZW" }, REFERENCE);

    expect(location?.label).toBe("ZW");
  });

  it("opens the chip on the unfiltered choice, then what the reference offers", () => {
    const [location] = filterChips({}, REFERENCE);

    expect(location?.options).toEqual([
      { code: undefined, label: "any country" },
      { code: "CA", label: "Canada" },
      { code: "US", label: "United States" },
    ]);
  });
});
