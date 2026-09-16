import { describe, expect, it } from "vitest";
import { slugifyStoryline, storylinePath } from "./storyline-slug.js";

describe("slugifyStoryline", () => {
  it("lowercases and hyphenates a plain label", () => {
    expect(slugifyStoryline("Trump Upended")).toBe("trump-upended");
  });

  it("collapses punctuation and whitespace runs to one hyphen", () => {
    expect(slugifyStoryline("Iran & Israel: What's Next?")).toBe("iran-israel-what-s-next");
  });

  it("trims a leading or trailing hyphen left by punctuation at the edges", () => {
    expect(slugifyStoryline("!Breaking: Storm Warning!")).toBe("breaking-storm-warning");
  });

  it("folds an accented letter to its base rather than dropping it", () => {
    // NFKD peels the combining tilde off; without that step this label folds
    // to nothing and falls into the `null` case below instead.
    expect(slugifyStoryline("Niño Watch")).toBe("nino-watch");
  });

  it("falls back to a real segment when a label is null", () => {
    expect(slugifyStoryline(null)).toBe("storyline");
  });

  it("falls back to the same segment when a label folds to nothing", () => {
    // All punctuation — the ASCII fold leaves no letters or digits at all,
    // which is the case the `|| "storyline"` guard exists for. Inverting that
    // guard (`slug &&` instead of `slug ||`, or dropping it) would return the
    // empty string here, and a route built from it would collapse to
    // `/storyline/<uuid>/` — a path one segment short rather than a real one.
    expect(slugifyStoryline("###")).toBe("storyline");
  });

  it("falls back for a label with no Latin letters to fold to", () => {
    expect(slugifyStoryline("東京地震")).toBe("storyline");
  });
});

describe("storylinePath", () => {
  it("joins the id and the slug under /storyline/", () => {
    expect(storylinePath("9618c568-212f-4e06-86e8-e157e8ed1fae", "Trump Upended")).toBe(
      "/storyline/9618c568-212f-4e06-86e8-e157e8ed1fae/trump-upended",
    );
  });

  it("still names a real path when the label is null", () => {
    expect(storylinePath("9618c568-212f-4e06-86e8-e157e8ed1fae", null)).toBe(
      "/storyline/9618c568-212f-4e06-86e8-e157e8ed1fae/storyline",
    );
  });
});
