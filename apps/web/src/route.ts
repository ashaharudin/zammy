import { slugifyStoryline, STORYLINE_UUID } from "@zammy/shared";
import type { TopicFilters } from "./api.js";

/**
 * The URL as the single source of truth for what the app is showing (§8.2):
 * keywords, and the filters that narrow them.
 *
 * Filters are held apart from the keywords because they outlive them. The hero
 * carries them before there is anything to search, a search adopts whatever is
 * set, and clearing back to the hero keeps them — so a reader who has said
 * "Malaysia" says it once, not once per topic.
 */
export interface Route {
  /** null on the landing page: filters standing without a topic. */
  q: string | null;
  filters: TopicFilters;
  /**
   * A storyline, as a sibling of `q` rather than a filter: it shares q's
   * lifetime exactly, belongs to THIS view, and the reader's next search must
   * not inherit it. In the URL so a shared link opens the same thing for its
   * recipient.
   *
   * Two meanings, told apart by shape, for as long as both models are live:
   * a bigint is ADR-0010's seed (provenance for a phrase click, alongside
   * keywords), and a UUID is ADR-0011's STORYLINE VIEW — which stands without
   * keywords at all, since its search box is empty by definition.
   */
  storyline?: string;
  /**
   * The search the STORYLINE VIEW was opened from, so dismissing the chip or
   * typing returns the reader there rather than to the hero. Held only where
   * there is a view to leave; a plain search has nothing behind it to restore.
   */
  from?: string;
}

/**
 * Filter name → its URL parameter. This map is the whole of what the URL says
 * about filters, in both directions: `parseRoute` reads only these keys and
 * `routeSearch` writes only these keys.
 *
 * `category` is deliberately absent (ADR-0020). A bookmarked
 * `?q=housing&category=technology` therefore parses as the plain search for
 * "housing" — the parameter is not read, not held, and not sent onward — and
 * the first navigation rewrites the URL without it. The API strips it too, so
 * a direct caller that never touches this file degrades the same way; neither
 * side is relying on the other to have cleaned up.
 */
const PARAM_KEYS = { language: "lang", country: "country" } as const;

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const q = params.get("q")?.trim() || null;
  const storyline = params.get("storyline") ?? undefined;
  const from = params.get("from")?.trim() || undefined;
  return {
    q,
    filters: {
      language: params.get(PARAM_KEYS.language) ?? undefined,
      country: params.get(PARAM_KEYS.country) ?? undefined,
    },
    // A SEED without keywords seeds nothing, and dropping it keeps the hero's
    // URL to the filters it is actually showing. A storyline VIEW is the
    // opposite: keyword-less is its normal state, so it survives on its own.
    ...(storyline && (q || STORYLINE_UUID.test(storyline)) ? { storyline } : {}),
    // An origin only means something where there is a VIEW to leave.
    ...(from && storyline && STORYLINE_UUID.test(storyline) ? { from } : {}),
  };
}

export function routeSearch(route: Route): string {
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  for (const [filter, key] of Object.entries(PARAM_KEYS)) {
    const value = route.filters[filter as keyof TopicFilters];
    if (value) params.set(key, value);
  }
  const view = route.storyline && STORYLINE_UUID.test(route.storyline);
  if (route.storyline && (route.q || view)) params.set("storyline", route.storyline);
  if (route.from && view) params.set("from", route.from);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/**
 * `/storyline/<uuid>/<slug>` (Tier 2 SEO), as a sibling path of `/` rather than
 * a query parameter on it — so there is a URL a crawler can follow and a reader
 * can share, and something for `api/storyline.ts` to server-render before this
 * app's JavaScript ever runs.
 *
 * Read ONLY here and in `parseLocation` below: every other function in this
 * file still speaks in terms of `search` alone, because a STORYLINE VIEW is the
 * one route with a pathname of its own — the hero and every search stay on `/`
 * exactly as they were. `STORYLINE_UUID` is reused rather than re-typed so the
 * one pattern that decides what a storyline id looks like stays in one place
 * (`@zammy/shared`).
 */
const STORYLINE_PATH = /^\/storyline\/([^/?]+)(?:\/[^/?]*)?\/?$/;

/**
 * `window.location.pathname` + `.search` → a `Route`, the pretty-path form.
 *
 * `parseRoute` alone cannot do this — it only ever reads `search`, which is
 * right for every route but this one. Kept as a second function rather than
 * folded into `parseRoute` so every existing caller (this file's own
 * `routeSearch`, and every test that built a `Route` from a bare query string)
 * keeps meaning exactly what it always meant; `App.tsx` is the one caller that
 * needs the pathname too, and it is the only one updated to call this instead.
 *
 * A path that does not name a storyline falls straight through to `parseRoute`,
 * which is also what makes an unrecognized pathname (a typo, an old deep link
 * to a page this app never had) resolve as the plain search its query string
 * describes rather than as a 404 the SPA has no view for.
 */
export function parseLocation(pathname: string, search: string): Route {
  const match = STORYLINE_PATH.exec(pathname);
  const pathStoryline = match && STORYLINE_UUID.test(match[1]!) ? match[1]! : undefined;
  if (pathStoryline === undefined) return parseRoute(search);

  const params = new URLSearchParams(search);
  const from = params.get("from")?.trim() || undefined;
  return {
    q: null,
    filters: {
      language: params.get(PARAM_KEYS.language) ?? undefined,
      country: params.get(PARAM_KEYS.country) ?? undefined,
    },
    storyline: pathStoryline,
    ...(from ? { from } : {}),
  };
}

/**
 * A `Route` → the URL to navigate to — `routeSearch`'s counterpart once a
 * STORYLINE VIEW has a path of its own.
 *
 * `label` is the one thing this needs that the route itself does not carry
 * (`Route` intentionally holds no display text, only identity — see its own
 * comment). It is best-effort and cosmetic: `parseLocation` above ignores
 * everything after the UUID, so a slug built from a stale or missing label
 * still opens the right storyline, and `slugifyStoryline(null)` names a real
 * segment rather than leaving one out. Every OTHER route (the hero, a search,
 * ADR-0010's bigint seed) has no pathname of its own and falls back to
 * `routeSearch` unchanged.
 */
export function routeUrl(route: Route, label: string | null = null): string {
  const view = route.storyline !== undefined && STORYLINE_UUID.test(route.storyline);
  if (!view) return `/${routeSearch(route)}`;

  const params = new URLSearchParams();
  for (const [filter, key] of Object.entries(PARAM_KEYS)) {
    const value = route.filters[filter as keyof TopicFilters];
    if (value) params.set(key, value);
  }
  if (route.from) params.set("from", route.from);
  const search = params.toString();
  return `/storyline/${route.storyline}/${slugifyStoryline(label)}${search ? `?${search}` : ""}`;
}

/**
 * The STORYLINE VIEW, opened from wherever the reader is now.
 *
 * The keywords they leave are kept as the view's origin rather than dropped:
 * the view is a step into one storyline, and the search that surfaced it is
 * where "out" leads. The filters carry as they always do; the view itself
 * ignores them (it is one storyline's own coverage, §api), but the search they
 * came from — and will return to — is still theirs.
 */
export function openStorylineView(current: Route, storylineId: string): Route {
  return {
    q: null,
    filters: current.filters,
    storyline: storylineId,
    ...(current.q ? { from: current.q } : {}),
  };
}

/**
 * Where the reader goes when they leave the STORYLINE VIEW — by dismissing the
 * chip (`typed` null) or by typing a search.
 *
 * The view is somewhere the reader stepped INTO, not somewhere they searched
 * for, so leaving it is a step back out: dismissing restores the search that
 * opened it. Neither the storyline nor its origin travels onward — both are
 * provenance for what the reader was looking at, and belong to that view alone.
 * The filters do travel: they outlive the topic (see Route).
 */
export function leaveStorylineView(
  route: Route,
  typed: string | null,
): { route: Route; replace: boolean } {
  return {
    route: { q: typed ?? route.from ?? null, filters: route.filters },
    replace: typed !== null,
  };
}
