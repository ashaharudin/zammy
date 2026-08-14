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

  it("round-trips what it wrote", () => {
    const route = { q: "banjir", filters: { language: "msa", country: "MY", category: "sports" } };

    expect(parseRoute(routeSearch(route))).toEqual(route);
  });
});
