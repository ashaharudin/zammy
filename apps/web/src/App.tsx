import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { STORYLINE_UUID, type StorylineSummary } from "@zammy/shared";
import { refreshStoryline, type TopicFilters } from "./api.js";
import { trackStorylineOpen, type StorylineOpenSource } from "./analytics.js";
import { Hero } from "./Hero.js";
import {
  findInView,
  leaveStorylineView,
  openStorylineView,
  parseLocation,
  removeStorylineFromView,
  routeStorylines,
  routeUrl,
  viewIsFull,
  withViewStorylines,
  type Route,
} from "./route.js";
import { TimelinePage } from "./TimelinePage.js";

/**
 * Phase 4 root: keywords in, timeline out (ARCHITECTURE 8).
 *
 * Query state lives in the URL (§8.2) — `/?q=climate+policy&lang=en` — so
 * searches are shareable and back/forward works. React state is only ever a
 * mirror of location.search; every transition goes through the history API.
 *
 * The filters are part of that state even with no keywords: the hero sets them
 * before there is a topic, a search adopts whatever is set, and clearing back
 * to the hero keeps them, so a reader states "Malay, sports" once.
 */

// PROTOTYPE (S8) — throwaway exploration of how search surfaces storylines,
// dev-only and mock-fed. Open http://localhost:5173/prototype/storylines while
// `pnpm dev:web` runs, or `pnpm prototype:storylines`. Lands on a throwaway
// branch, never on main.
const StorylinesPrototype = lazy(() =>
  import("./prototype/storylines/StorylinesPrototype.js").then((m) => ({
    default: m.StorylinesPrototype,
  })),
);
const showStorylinesPrototype =
  !import.meta.env.PROD && window.location.pathname.startsWith("/prototype/storylines");

export function App() {
  if (showStorylinesPrototype) {
    return (
      <Suspense fallback={null}>
        <StorylinesPrototype />
      </Suspense>
    );
  }
  return <TopicApp />;
}

function TopicApp() {
  const [route, setRoute] = useState<Route>(() =>
    parseLocation(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const onPopState = () =>
      setRoute(parseLocation(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Entering the storyline view is a transition of the ROUTE, not a search
  // (see the TimelinePage prop below) — one definition, shared by every entry
  // point (the hero's cloud, surfaced pills, the timeline gutter) so they
  // cannot drift on how a click gets there.
  //
  // It also asks, in the background, for a top-up of what this storyline's own
  // coverage says (ADR-0017). Being the one definition is what makes that one
  // line rather than four: every click that opens a storyline anywhere in the
  // app feeds the demand-driven loop, which is the contribution ADR-0016 gave
  // up when the cloud stopped running a search. The transition does not wait on
  // it and the view does not show it — whatever arrives lands in the archive for
  // the next read of the arc.
  //
  // `label` is the click's own hand-off — every entry point already renders
  // the storyline's name, so it costs nothing to carry — held here rather than
  // in the route because it is a hint for the transitions in flight, not part
  // of what a shared link should reproduce. One per storyline id, kept for the
  // session: a view may hold several arcs (ADR-0028) and adding one is a fresh
  // page, so for the beat before that page lands every chip already in the bar
  // reads its name from here rather than blinking to "storyline". Keyed by id,
  // so a hint can never name the wrong arc, only be absent.
  //
  // It is ALSO the slug's source (Tier 2 SEO, `route.ts`'s `routeUrl`): a
  // `Route` names a storyline by id and nothing else, on purpose, so the label
  // for the address bar's cosmetic half has to come from somewhere state-side.
  // Declared above `navigate` so a filter change made from inside an open view
  // — `CommandBar`'s `onSearch({ ...topic, ...filters })`, which carries the
  // same storyline id straight through — still finds the label this hint set
  // when the view was opened, without `navigate` itself needing one passed in.
  const [labelHints, setLabelHints] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  const hint = useCallback((entries: readonly (readonly [string, string | null])[]) => {
    setLabelHints((current) => {
      // The same map back when nothing is new: this is also fed by every page
      // the view loads (`onStorylinesNamed`), and a fresh map per page would
      // re-render the app for a fact it already held.
      if (entries.every(([id, label]) => current.has(id) && current.get(id) === label)) {
        return current;
      }
      const next = new Map(current);
      for (const [id, label] of entries) next.set(id, label);
      return next;
    });
  }, []);

  // Every page the view loads names its arcs (`TimelinePage.storylines`), and
  // those names are remembered here too — so a view opened cold, by a shared
  // link, still writes a real slug on its next replace navigation (a filter
  // chip, a find) instead of falling back to `/storyline`.
  const rememberNames = useCallback(
    (named: readonly StorylineSummary[]) =>
      hint(named.map((storyline) => [storyline.id, storyline.label] as const)),
    [hint],
  );

  // `replace` is for a transition the reader did not make — the detected
  // filter defaults land on whatever they are looking at, and a history entry
  // for that would make Back appear to do nothing. `label` is for the ONE
  // transition that mints a fresh view (`openStoryline` below): `labelHints`
  // state is not yet updated on the same tick that sets it, so a slug built
  // from the hints here would still be building the PREVIOUS view's slug (or
  // none) for the view this very call is opening.
  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean; label?: string | null }) => {
      const label =
        options?.label ?? (next.storyline ? (labelHints.get(next.storyline) ?? null) : null);
      const url = routeUrl(next, label);
      if (options?.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
      setRoute(next);
    },
    [labelHints],
  );

  // A bookmarked or shared `?storyline=<uuid>` predates the pretty path, which
  // is canonical now (`route.ts`, `docs/SEO.md`). The very first thing such a
  // link does here is become one — once, on mount, using whatever the initial
  // parse already found. Nothing else can ever produce this shape again: every
  // navigation from here on goes through `navigate` above, which already
  // writes the pretty form for a UUID view. A bigint SEED (ADR-0010) is left
  // alone — it has no route of its own to redirect to, and `routeUrl` already
  // knows that.
  useEffect(() => {
    // The UUID check is the whole condition, deliberately, rather than a diff
    // against the current URL: a bigint SEED also reaches this effect with
    // `route.storyline` set and has no pretty route to move to, and an ORDINARY
    // search never sets `storyline` at all — so a looser check (any URL this
    // function would build differently) would also fire on a plain search
    // whose query parameters merely arrived in a different order, rewriting
    // its address bar for no reason connected to this redirect at all.
    if (window.location.pathname === "/" && STORYLINE_UUID.test(route.storyline ?? "")) {
      window.history.replaceState(null, "", routeUrl(route, null));
    }
    // Mount-once, deliberately: this reads the ROUTE the app booted with, not
    // whatever `route` state has become by the time a later render runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFilters = useCallback(
    (filters: TopicFilters) => navigate({ q: null, filters }, { replace: true }),
    [navigate],
  );

  // From a search this opens the view; from inside a view it ADDS the arc to
  // it (ADR-0028) — `openStorylineView` decides which, and either way the click
  // is one storyline opened, so it is tracked and refreshed exactly once. An arc
  // the view already holds is left alone: the click was aimed at something on
  // screen, and re-pushing the same view would make Back appear to do nothing.
  // A FULL view is left alone too (`viewIsFull`) — the wire caps a view at
  // `MAX_VIEW_STORYLINES` and the pills row stops offering there, but the rail's
  // gutter labels and the braid's crossings do not, so the check is here rather
  // than only in the row that usually produces the click.
  const openStoryline = useCallback(
    (storylineId: string, label: string | null, source: StorylineOpenSource) => {
      if (routeStorylines(route).includes(storylineId) || viewIsFull(route)) return;
      trackStorylineOpen(source);
      hint([[storylineId, label]]);
      refreshStoryline(storylineId);
      // The slug names the PATH's storyline, which is the one clicked only when
      // this click opens a fresh view; adding to an open one keeps its path.
      const fresh = openStorylineView(route, storylineId);
      navigate(fresh, fresh.storyline === storylineId ? { label } : undefined);
    },
    [navigate, route, hint],
  );

  // A chip dismissed: the one way an arc leaves the view, since a taken arc has
  // no pill in the row to press again (`offeredPills` leaves out what the view
  // holds). The last one out closes the view the way dismissing the single chip
  // always has — back to the search it was opened from, or to the hero.
  const removeStoryline = useCallback(
    (storylineId: string) => {
      const next = removeStorylineFromView(route, storylineId);
      if (next === null) {
        const { route: left, replace } = leaveStorylineView(route, null);
        navigate(left, { replace });
        return;
      }
      navigate(next);
    },
    [navigate, route],
  );

  // Typing inside the view asks which storylines say those words (ADR-0028,
  // amended); the pills answer and the view stays put. `replace`, because the
  // reader went nowhere — Back should leave the view, not retype for them.
  const findStorylines = useCallback(
    (keywords: string | null) => navigate(findInView(route, keywords), { replace: true }),
    [navigate, route],
  );

  // The server answered with the arcs it actually served (`TimelinePage.storylines`):
  // aliases followed to their survivors, UUIDs it never held dropped. The URL
  // is made to say the same, silently — `replace`, since the reader went
  // nowhere — so a shared link carries live ids and a chip is never left
  // standing for an arc that is not on the page. `TimelinePage` calls this only
  // when the two lists actually differ, so the common case costs nothing.
  const resolveStorylines = useCallback(
    (served: readonly StorylineSummary[]) => {
      const next = withViewStorylines(
        route,
        served.map((storyline) => storyline.id),
      );
      if (next === null) return;
      hint(served.map((storyline) => [storyline.id, storyline.label] as const));
      navigate(next, { replace: true, label: served[0]?.label ?? null });
    },
    [navigate, route, hint],
  );

  // The storyline view has no keywords — it is opened by clicking a label, and
  // its search box is empty (ADR-0011). So "no q" no longer means "the hero".
  const storylineView = route.storyline !== undefined && STORYLINE_UUID.test(route.storyline);

  if (route.q === null && !storylineView) {
    return (
      <Hero
        filters={route.filters}
        onFilters={setFilters}
        onSearch={(q) => navigate({ q, filters: route.filters })}
        onOpenStoryline={openStoryline}
      />
    );
  }

  return (
    <TimelinePage
      topic={{
        q: route.q ?? "",
        ...route.filters,
        ...(route.storyline ? { storyline: route.storyline } : {}),
        ...(route.also ? { also: route.also } : {}),
      }}
      // The search the view was opened from, as a topic — what keeps its pills
      // in the bar (`useStorylineSearch`). The filters are the route's,
      // which are the ones that search ran under: they outlive the topic.
      viewOrigin={storylineView && route.from ? { q: route.from, ...route.filters } : null}
      viewFind={storylineView ? (route.find ?? null) : null}
      onFindStorylines={findStorylines}
      // `storyline` (and `also`) split off from the filters here rather than
      // riding with them: the filters survive the transition, the storylines
      // belong to the view they name and only travel when a caller passes them.
      // A filter change made INSIDE the view keeps the view's origin too: the
      // reader narrowed the search they will go back to, they did not leave it.
      onSearch={({ q, storyline, also, ...filters }, options) =>
        navigate(
          {
            q: q || null,
            filters,
            ...(storyline ? { storyline } : {}),
            ...(storyline && also ? { also } : {}),
            ...(storyline && storylineView && route.from ? { from: route.from } : {}),
            ...(storyline && storylineView && route.find ? { find: route.find } : {}),
          },
          options,
        )
      }
      onClear={() => navigate({ q: null, filters: route.filters })}
      // Entering and leaving the storyline view are transitions of the ROUTE,
      // not searches: only here is the search being left still in hand to be
      // recorded, and to be returned to.
      onOpenStoryline={openStoryline}
      onRemoveStoryline={removeStoryline}
      onResolveStorylines={resolveStorylines}
      onStorylinesNamed={rememberNames}
      viewLabelHints={labelHints}
    />
  );
}
