import { describe, expect, it } from "vitest";
import { parseRoute, routeSearch } from "./route.js";

/**
 * The URL as the single source of truth for what the app is showing (§8.2).
 *
 * The filters are held apart from the keywords because they outlive them: the
 * hero carries them before there is anything to search, a search adopts
 * whatever is set, and clearing back to the hero keeps them.
 */

describe("parseRoute", () => {
  it("reads a topic and its filters", () => {
    expect(parseRoute("?q=wildfires&lang=en&country=CA&category=sports")).toEqual({
      q: "wildfires",
      filters: { language: "en", country: "CA", category: "sports" },
    });
  });

  it("reads filters standing on their own, which is the hero", () => {
    expect(parseRoute("?lang=msa&category=sports")).toEqual({
      q: null,
      filters: { language: "msa", country: undefined, category: "sports" },
    });
  });

  it("reads a storyline seed beside the keywords, not among the filters", () => {
    // ADR-0010: it shares q's lifetime, so a shared phrase link seeds for its
    // recipient — and the reader's next search cannot inherit it.
    expect(parseRoute("?q=mail-in+voting&storyline=23905")).toEqual({
      q: "mail-in voting",
      filters: { language: undefined, country: undefined, category: undefined },
      storyline: "23905",
    });
  });

  it("drops a seed with no keywords, which seeds nothing", () => {
    expect(parseRoute("?storyline=23905&lang=en")).toEqual({
      q: null,
      filters: { language: "en", country: undefined, category: undefined },
    });
  });
});

describe("routeSearch", () => {
  it("writes the topic first, then its filters", () => {
    expect(
      routeSearch({
        q: "wildfires",
        filters: { language: "en", country: "CA", category: "sports" },
      }),
    ).toBe("?q=wildfires&lang=en&country=CA&category=sports");
  });

  it("keeps filters that have no topic yet, so the hero can hold them", () => {
    expect(routeSearch({ q: null, filters: { language: "msa", category: "sports" } })).toBe(
      "?lang=msa&category=sports",
    );
  });

  it("writes a bare path when there is nothing to say", () => {
    expect(routeSearch({ q: null, filters: {} })).toBe("");
  });

  it("writes the seed last, after the topic it belongs to", () => {
    expect(routeSearch({ q: "mail-in voting", filters: { language: "en" }, storyline: "23905" })).toBe(
      "?q=mail-in+voting&lang=en&storyline=23905",
    );
  });

  it("will not write a seed the hero would carry into the next search", () => {
    expect(routeSearch({ q: null, filters: { language: "en" }, storyline: "23905" })).toBe("?lang=en");
  });

  it("round-trips what it wrote", () => {
    const route = { q: "banjir", filters: { language: "msa", country: "MY", category: "sports" } };

    expect(parseRoute(routeSearch(route))).toEqual(route);
  });

  it("round-trips a seeded topic", () => {
    const route = {
      q: "mail-in voting",
      filters: { language: "en", country: undefined, category: undefined },
      storyline: "23905",
    };

    expect(parseRoute(routeSearch(route))).toEqual(route);
  });
});
