import { describe, expect, it } from "vitest";
import { cloudLanguage } from "./cloudLanguage.js";

/**
 * The trending cloud follows the hero's language chip, but unlike a timeline
 * it cannot be unfiltered: terms are ranked within one language's corpus
 * against that language's baseline (§10.1), so there is no "any language"
 * cloud to build — only a choice of which one.
 */

describe("cloudLanguage", () => {
  it("follows the chip", () => {
    expect(cloudLanguage("msa")).toBe("msa");
  });

  it("speaks English where the chip says nothing, or says any language", () => {
    expect(cloudLanguage(undefined)).toBe("en");
    expect(cloudLanguage("all")).toBe("en");
  });
});
