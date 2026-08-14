import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { TopicFilters } from "./api.js";
import { Hero } from "./Hero.js";
import { parseRoute, routeSearch, type Route } from "./route.js";
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

  if (route.q === null) {
    return (
      <Hero
        filters={route.filters}
        onFilters={setFilters}
        onSearch={(q) => navigate({ q, filters: route.filters })}
      />
    );
  }

  return (
    <TimelinePage
      topic={{ q: route.q, ...route.filters, ...(route.storyline ? { storyline: route.storyline } : {}) }}
      // `storyline` splits off from the filters here rather than riding with
      // them: the filters survive the transition, the seed belongs to the
      // topic it opened (ADR-0010) and only travels when a caller passes it.
      onSearch={({ q, storyline, ...filters }, options) =>
        navigate({ q, filters, ...(storyline ? { storyline } : {}) }, options)
      }
      onClear={() => navigate({ q: null, filters: route.filters })}
    />
  );
}
