import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { STORYLINE_UUID } from "@zammy/shared";
import { refreshStoryline, type TopicFilters } from "./api.js";
import { Hero } from "./Hero.js";
import {
  leaveStorylineView,
  openStorylineView,
  parseRoute,
  routeSearch,
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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // `replace` is for a transition the reader did not make — the detected
  // filter defaults land on whatever they are looking at, and a history entry
  // for that would make Back appear to do nothing.
  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const url = `${window.location.pathname}${routeSearch(next)}`;
    if (options?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setRoute(next);
  }, []);

  const setFilters = useCallback(
    (filters: TopicFilters) => navigate({ q: null, filters }, { replace: true }),
    [navigate],
  );

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
  // in the route because it is a hint for the one transition in flight, not
  // part of what a shared link should reproduce. `viewLabelHint` is only read
  // while it matches the route's own storyline id, so a stale one from a
  // dismissed view can never leak onto the next.
  const [labelHint, setLabelHint] = useState<{ id: string; label: string | null } | null>(null);
  const openStoryline = useCallback(
    (storylineId: string, label: string | null) => {
      setLabelHint({ id: storylineId, label });
      refreshStoryline(storylineId);
      navigate(openStorylineView(route, storylineId));
    },
    [navigate, route],
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
      }}
      // `storyline` splits off from the filters here rather than riding with
      // them: the filters survive the transition, the seed belongs to the
      // topic it opened (ADR-0010) and only travels when a caller passes it.
      onSearch={({ q, storyline, ...filters }, options) =>
        navigate({ q: q || null, filters, ...(storyline ? { storyline } : {}) }, options)
      }
      onClear={() => navigate({ q: null, filters: route.filters })}
      // Entering and leaving the storyline view are transitions of the ROUTE,
      // not searches: only here is the search being left still in hand to be
      // recorded, and to be returned to.
      onOpenStoryline={openStoryline}
      viewLabelHint={route.storyline && labelHint?.id === route.storyline ? labelHint.label : null}
      onLeaveStoryline={(typed) => {
        const { route: next, replace } = leaveStorylineView(route, typed);
        navigate(next, { replace });
      }}
    />
  );
}
