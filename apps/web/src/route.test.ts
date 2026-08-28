import { describe, expect, it } from "vitest";
import {
  leaveStorylineView,
  openStorylineView,
  parseRoute,
  routeSearch,
} from "./route.js";

/**
 * The URL as the single source of truth for what the app is showing (§8.2).
 *
 * The filters are held apart from the keywords because they outlive them: the
 * hero carries them before there is anything to search, a search adopts
 * whatever is set, and clearing back to the hero keeps them.
 */

describe("parseRoute", () => {
  it("reads a topic and its filters", () => {
    expect(parseRoute("?q=wildfires&lang=en&country=CA")).toEqual({
      q: "wildfires",
      filters: { language: "en", country: "CA" },
    });
  });

  it("reads filters standing on their own, which is the hero", () => {
    expect(parseRoute("?lang=msa")).toEqual({
      q: null,
      filters: { language: "msa", country: undefined },
    });
  });

  it("ignores a category a bookmark still carries, keeping the search", () => {
    // ADR-0020 retired the category chip; the links readers saved while it
    // existed did not retire with it. The parameter is not read, so the route
    // is the plain search — which is what the reader wanted minus a filter
    // that half the ingest could never honestly serve. The alternative, and
    // the reason this is pinned, is that such a link errors instead.
    expect(parseRoute("?q=housing&lang=en&category=technology")).toEqual({
      q: "housing",
      filters: { language: "en", country: undefined },
    });
  });

  it("drops the stale parameter from the URL the app writes back", () => {
    // Round trip: whatever the reader arrives with, the next navigation states
    // only what the app is actually showing. A category left in the query
    // string would keep re-sharing a filter that no longer exists.
    expect(routeSearch(parseRoute("?q=housing&lang=en&category=technology"))).toBe(
      "?q=housing&lang=en",
    );
  });

  it("reads a storyline seed beside the keywords, not among the filters", () => {
    // ADR-0010: it shares q's lifetime, so a shared phrase link seeds for its
    // recipient — and the reader's next search cannot inherit it.
    expect(parseRoute("?q=mail-in+voting&storyline=23905")).toEqual({
      q: "mail-in voting",
      filters: { language: undefined, country: undefined },
      storyline: "23905",
    });
  });

  it("drops a seed with no keywords, which seeds nothing", () => {
    expect(parseRoute("?storyline=23905&lang=en")).toEqual({
      q: null,
      filters: { language: "en", country: undefined },
    });
  });
});

describe("routeSearch", () => {
  it("writes the topic first, then its filters", () => {
    expect(
      routeSearch({
        q: "wildfires",
        filters: { language: "en", country: "CA" },
      }),
    ).toBe("?q=wildfires&lang=en&country=CA");
  });

  it("keeps filters that have no topic yet, so the hero can hold them", () => {
    expect(routeSearch({ q: null, filters: { language: "msa", country: "MY" } })).toBe(
      "?lang=msa&country=MY",
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
    const route = { q: "banjir", filters: { language: "msa", country: "MY" } };

    expect(parseRoute(routeSearch(route))).toEqual(route);
  });

  it("round-trips a seeded topic", () => {
    const route = {
      q: "mail-in voting",
      filters: { language: "en", country: undefined },
      storyline: "23905",
    };

    expect(parseRoute(routeSearch(route))).toEqual(route);
  });
});

/**
 * ADR-0011's storyline view is opened FROM somewhere — usually a search. The
 * URL records that origin so leaving the view returns the reader to it rather
 * than dropping them on the hero (§8.2: the URL is what the app is showing,
 * including where it will go back to).
 */
describe("the origin behind a storyline view", () => {
  it("reads the search the view was opened from", () => {
    expect(
      parseRoute("?storyline=0192f3c4-5d6e-7f80-9123-456789abcdef&from=Trump"),
    ).toEqual({
      q: null,
      filters: { language: undefined, country: undefined },
      storyline: "0192f3c4-5d6e-7f80-9123-456789abcdef",
      from: "Trump",
    });
  });

  it("writes the origin beside the view, so a reload still knows the way back", () => {
    expect(
      routeSearch({
        q: null,
        filters: { language: "en" },
        storyline: "0192f3c4-5d6e-7f80-9123-456789abcdef",
        from: "Trump",
      }),
    ).toBe("?lang=en&storyline=0192f3c4-5d6e-7f80-9123-456789abcdef&from=Trump");
  });

  it("drops an origin with no view to leave", () => {
    // Only the storyline VIEW can be left. A plain search is already where the
    // reader would return to, so an origin riding along says nothing.
    expect(parseRoute("?q=wildfires&from=Trump")).toEqual({
      q: "wildfires",
      filters: { language: undefined, country: undefined },
    });
  });
});

describe("leaveStorylineView", () => {
  const view = {
    q: null,
    filters: { language: "en", country: undefined },
    storyline: "0192f3c4-5d6e-7f80-9123-456789abcdef",
    from: "Trump",
  };

  it("dismissing the chip returns to the search the view was opened from", () => {
    expect(leaveStorylineView(view, null)).toEqual({
      route: { q: "Trump", filters: { language: "en", country: undefined } },
      replace: false,
    });
  });

  it("typing a search replaces the view, so Back lands on the origin", () => {
    // The view is a step off the reader's path, not a stop on it. Left behind
    // in history it would sit between the new search and the search that
    // opened it, and Back would walk them into a storyline they had left.
    expect(leaveStorylineView(view, "Iran")).toEqual({
      route: { q: "Iran", filters: { language: "en", country: undefined } },
      replace: true,
    });
  });

  it("falls back to the hero when the view was opened by a shared link", () => {
    // Nothing behind it to return to — but the filters the recipient's browser
    // settled on are still theirs, and the hero holds them.
    const { from: _shared, ...linked } = view;
    expect(leaveStorylineView(linked, null)).toEqual({
      route: { q: null, filters: { language: "en", country: undefined } },
      replace: false,
    });
  });
});

describe("openStorylineView", () => {
  it("records the search being left, so the view knows the way back", () => {
    expect(
      openStorylineView(
        { q: "Trump", filters: { language: "en", country: "US" } },
        "0192f3c4-5d6e-7f80-9123-456789abcdef",
      ),
    ).toEqual({
      q: null,
      filters: { language: "en", country: "US" },
      storyline: "0192f3c4-5d6e-7f80-9123-456789abcdef",
      from: "Trump",
    });
  });
});
