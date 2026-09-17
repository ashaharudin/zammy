import { describe, expect, it } from "vitest";
import {
  findInView,
  leaveStorylineView,
  openStorylineView,
  parseLocation,
  parseRoute,
  removeStorylineFromView,
  routeSearch,
  routeStorylines,
  routeUrl,
  withViewStorylines,
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

/**
 * The pretty path (Tier 2 SEO): `/storyline/<uuid>/<slug>` reads exactly like
 * the query form, and a URL that does not name one falls through to it
 * untouched.
 */
describe("parseLocation", () => {
  const UUID = "0192f3c4-5d6e-7f80-9123-456789abcdef";

  it("reads a storyline id out of the pretty path, ignoring the slug", () => {
    expect(parseLocation(`/storyline/${UUID}/trump-upended`, "")).toEqual({
      q: null,
      filters: { language: undefined, country: undefined },
      storyline: UUID,
    });
  });

  it("reads filters and the view's origin from the query string beside it", () => {
    expect(parseLocation(`/storyline/${UUID}/trump-upended`, "?lang=en&from=Trump")).toEqual({
      q: null,
      filters: { language: "en", country: undefined },
      storyline: UUID,
      from: "Trump",
    });
  });

  it("accepts the bare id with no slug segment at all", () => {
    expect(parseLocation(`/storyline/${UUID}`, "")).toEqual({
      q: null,
      filters: { language: undefined, country: undefined },
      storyline: UUID,
    });
  });

  it("falls through to the query-string parse for every other path", () => {
    // The hero, a search, and a mistyped or unrecognized path all land here —
    // there is no separate "404" route for the SPA to render, so this is
    // exactly what `/` itself parses to.
    expect(parseLocation("/", "?q=wildfires")).toEqual(parseRoute("?q=wildfires"));
    expect(parseLocation("/nonsense", "?q=wildfires")).toEqual(parseRoute("?q=wildfires"));
  });

  it("does not accept a bigint SEED in the path — only a UUID view has one", () => {
    // Inverting the UUID check here would let `/storyline/23905` (ADR-0010's
    // seed shape) be read as a storyline VIEW, which has no keywords and would
    // silently drop the ones a seed link is supposed to carry.
    expect(parseLocation("/storyline/23905", "?q=mail-in+voting")).toEqual(
      parseRoute("?q=mail-in+voting"),
    );
  });
});

describe("routeUrl", () => {
  const UUID = "0192f3c4-5d6e-7f80-9123-456789abcdef";

  it("builds the pretty path for a storyline view, slugging the label given", () => {
    expect(
      routeUrl({ q: null, filters: {}, storyline: UUID }, "Trump Upended"),
    ).toBe(`/storyline/${UUID}/trump-upended`);
  });

  it("still names a real segment with no label to slug", () => {
    expect(routeUrl({ q: null, filters: {}, storyline: UUID })).toBe(
      `/storyline/${UUID}/storyline`,
    );
  });

  it("carries the filters and the view's origin as a query string", () => {
    expect(
      routeUrl(
        { q: null, filters: { language: "en" }, storyline: UUID, from: "Trump" },
        "Trump Upended",
      ),
    ).toBe(`/storyline/${UUID}/trump-upended?lang=en&from=Trump`);
  });

  it("round-trips through parseLocation", () => {
    const route = { q: null, filters: { language: "en" }, storyline: UUID, from: "Trump" };
    const [pathname, search] = routeUrl(route, "Trump Upended").split("?");
    expect(parseLocation(pathname!, search ? `?${search}` : "")).toEqual(route);
  });

  it("falls back to routeSearch on `/` for every route without a view", () => {
    expect(routeUrl({ q: "wildfires", filters: { language: "en" } })).toBe(
      `/${routeSearch({ q: "wildfires", filters: { language: "en" } })}`,
    );
  });

  it("does not build a pretty path for a bigint SEED", () => {
    // Same distinction `routeSearch` already draws: a seed shares `q`'s
    // lifetime and has no route of its own to be pretty about.
    const route = { q: "mail-in voting", filters: {}, storyline: "23905" };
    expect(routeUrl(route)).toBe(`/${routeSearch(route)}`);
  });
});

/**
 * A view of SEVERAL storylines (ADR-0028): the path names the first, `?also=`
 * carries the rest, and a click inside the view adds rather than swaps.
 */
describe("a view of several storylines", () => {
  const A = "0192f3c4-5d6e-7f80-9123-456789abcdef";
  const B = "11111111-1111-4111-8111-111111111111";
  const C = "22222222-2222-4222-8222-222222222222";
  const view = { q: null, filters: { language: "en", country: undefined }, storyline: A, from: "Trump" };

  it("reads the further storylines from the pretty path's query string", () => {
    expect(parseLocation(`/storyline/${A}/trump-upended`, `?from=Trump&also=${B},${C}`)).toEqual({
      q: null,
      filters: { language: undefined, country: undefined },
      storyline: A,
      from: "Trump",
      also: [B, C],
    });
  });

  it("reads them from the query form too, so an old-shaped link widens the same way", () => {
    expect(parseRoute(`?storyline=${A}&also=${B}`)).toEqual({
      q: null,
      filters: { language: undefined, country: undefined },
      storyline: A,
      also: [B],
    });
  });

  it("keeps only UUIDs in the list, never the path's own storyline, and no repeats", () => {
    expect(parseLocation(`/storyline/${A}/x`, `?also=${A},${B},23905,${B},,junk`).also).toEqual([B]);
  });

  it("drops the list where there is no view for it to widen", () => {
    // A bigint seed is not a view; a plain search is not a view. Neither may
    // carry a second storyline into a page that holds none.
    expect(parseRoute(`?q=voting&storyline=23905&also=${B}`)).toEqual({
      q: "voting",
      filters: { language: undefined, country: undefined },
      storyline: "23905",
    });
    expect(parseRoute(`?q=voting&also=${B}`)).toEqual({
      q: "voting",
      filters: { language: undefined, country: undefined },
    });
  });

  it("writes the first to the path and the rest to the query string", () => {
    expect(routeUrl({ ...view, also: [B, C] }, "Trump Upended")).toBe(
      `/storyline/${A}/trump-upended?lang=en&from=Trump&also=${B}%2C${C}`,
    );
  });

  it("round-trips through parseLocation", () => {
    const route = { ...view, also: [B, C] };
    const [pathname, search] = routeUrl(route, "Trump Upended").split("?");
    expect(parseLocation(pathname!, search ? `?${search}` : "")).toEqual(route);
  });

  it("lists what the view holds, the path's first", () => {
    expect(routeStorylines({ ...view, also: [B] })).toEqual([A, B]);
    expect(routeStorylines(view)).toEqual([A]);
    expect(routeStorylines({ q: "voting", filters: {}, storyline: "23905" })).toEqual([]);
    expect(routeStorylines({ q: "voting", filters: {} })).toEqual([]);
  });

  it("adds a storyline clicked from inside the view, keeping the path and the origin", () => {
    expect(openStorylineView(view, B)).toEqual({ ...view, also: [B] });
    expect(openStorylineView({ ...view, also: [B] }, C)).toEqual({ ...view, also: [B, C] });
  });

  it("leaves a view alone when the storyline clicked is already in it", () => {
    expect(openStorylineView({ ...view, also: [B] }, A)).toEqual({ ...view, also: [B] });
    expect(openStorylineView({ ...view, also: [B] }, B)).toEqual({ ...view, also: [B] });
  });

  it("still opens a fresh view from a search, as it always did", () => {
    expect(openStorylineView({ q: "Trump", filters: { language: "en" } }, A)).toEqual({
      q: null,
      filters: { language: "en" },
      storyline: A,
      from: "Trump",
    });
  });

  it("takes one storyline out, promoting the next to the path when it was the first", () => {
    expect(removeStorylineFromView({ ...view, also: [B, C] }, B)).toEqual({ ...view, also: [C] });
    expect(removeStorylineFromView({ ...view, also: [B, C] }, A)).toEqual({
      ...view,
      storyline: B,
      also: [C],
    });
    expect(removeStorylineFromView({ ...view, also: [B] }, B)).toEqual(view);
  });

  it("answers null for the last one out, so the caller leaves the view", () => {
    expect(removeStorylineFromView(view, A)).toBeNull();
  });

  it("can be told exactly which storylines it holds, keeping everything else", () => {
    // What the URL becomes when the server's answer differs from what was
    // asked — an alias followed, a stale id dropped.
    expect(withViewStorylines({ ...view, also: [B] }, [C, A])).toEqual({ ...view, storyline: C, also: [A] });
    expect(withViewStorylines({ ...view, also: [B] }, [])).toBeNull();
  });
});

/**
 * Typing inside the view is a search FOR storylines (ADR-0028, amended): the
 * words ride in the URL as `?find=`, the view stays where it is, and the pills
 * row answers.
 */
describe("finding storylines from inside the view", () => {
  const A = "0192f3c4-5d6e-7f80-9123-456789abcdef";
  const B = "11111111-1111-4111-8111-111111111111";
  const view = { q: null, filters: { language: "en", country: undefined }, storyline: A, from: "Trump" };

  it("reads the words from the pretty path's query string", () => {
    expect(parseLocation(`/storyline/${A}/x`, `?from=Trump&find=visa+ban`).find).toBe("visa ban");
    expect(parseRoute(`?storyline=${A}&find=visa`).find).toBe("visa");
  });

  it("writes them beside the view, and round-trips", () => {
    const route = { ...view, also: [B], find: "visa ban" };
    expect(routeUrl(route, "Trump Upended")).toBe(
      `/storyline/${A}/trump-upended?lang=en&from=Trump&also=${B}&find=visa+ban`,
    );
    const [pathname, search] = routeUrl(route, "Trump Upended").split("?");
    expect(parseLocation(pathname!, `?${search}`)).toEqual(route);
  });

  it("drops the words where there is no view to search from", () => {
    // On a plain search the words typed ARE the search; `find` means nothing.
    expect(parseRoute("?q=wildfires&find=visa")).toEqual({
      q: "wildfires",
      filters: { language: undefined, country: undefined },
    });
  });

  it("sets and clears the words without moving the view", () => {
    expect(findInView(view, " visa ban ")).toEqual({ ...view, find: "visa ban" });
    expect(findInView({ ...view, find: "visa" }, null)).toEqual(view);
    expect(findInView({ ...view, find: "visa" }, "   ")).toEqual(view);
  });

  it("does not carry the words out of the view", () => {
    // Leaving is a step back to the search that opened the view; the words
    // typed inside it were a question about storylines, not that search.
    expect(leaveStorylineView({ ...view, find: "visa" }, null)).toEqual({
      route: { q: "Trump", filters: { language: "en", country: undefined } },
      replace: false,
    });
  });

  it("survives adding and removing storylines", () => {
    expect(openStorylineView({ ...view, find: "visa" }, B)).toEqual({ ...view, find: "visa", also: [B] });
    expect(removeStorylineFromView({ ...view, find: "visa", also: [B] }, B)).toEqual({ ...view, find: "visa" });
  });
});
