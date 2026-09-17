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
  /**
   * The OTHER storylines a view holds beside `storyline` (ADR-0028): a reader
   * with one arc open clicked another, and the view now pages both. In the URL
   * as `?also=<uuid>,<uuid>` so a shared link opens the same set, and held
   * apart from `storyline` rather than folded into one list because the pretty
   * path (`/storyline/<uuid>/<slug>`) can name exactly one — the first the
   * reader chose — and that one is also what the server-rendered page and its
   * canonical link are about. Only ever present with a UUID `storyline`, never
   * repeating it, and only ever UUIDs.
   */
  also?: string[];
  /**
   * The keywords typed into the STORYLINE VIEW's search box (ADR-0028,
   * amended): a search FOR storylines, whose matches take the pills row, not a
   * search of articles. In the URL because the pills are part of what the
   * page is showing (§8.2), and only ever with a view — typing on a plain
   * search is that search.
   */
  find?: string;
}

/** The `?also=` list as the URL spells it: UUIDs, comma-joined, no repeats. */
function parseAlso(params: URLSearchParams, primary: string): string[] {
  const raw = params.get("also");
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => STORYLINE_UUID.test(id) && id !== primary);
  return [...new Set(ids)];
}

/** Is this the STORYLINE VIEW — a UUID standing in `storyline` (ADR-0011)? */
function isView(route: Pick<Route, "storyline">): boolean {
  return route.storyline !== undefined && STORYLINE_UUID.test(route.storyline);
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
  const view = storyline !== undefined && STORYLINE_UUID.test(storyline);
  const also = view ? parseAlso(params, storyline) : [];
  const find = params.get("find")?.trim() || undefined;
  return {
    q,
    filters: {
      language: params.get(PARAM_KEYS.language) ?? undefined,
      country: params.get(PARAM_KEYS.country) ?? undefined,
    },
    // A SEED without keywords seeds nothing, and dropping it keeps the hero's
    // URL to the filters it is actually showing. A storyline VIEW is the
    // opposite: keyword-less is its normal state, so it survives on its own.
    ...(storyline && (q || view) ? { storyline } : {}),
    // An origin only means something where there is a VIEW to leave.
    ...(from && view ? { from } : {}),
    // And so do further storylines: they widen a view, and nothing else.
    ...(also.length > 0 ? { also } : {}),
    ...(find && view ? { find } : {}),
  };
}

export function routeSearch(route: Route): string {
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  for (const [filter, key] of Object.entries(PARAM_KEYS)) {
    const value = route.filters[filter as keyof TopicFilters];
    if (value) params.set(key, value);
  }
  const view = isView(route);
  if (route.storyline && (route.q || view)) params.set("storyline", route.storyline);
  if (route.from && view) params.set("from", route.from);
  if (route.also && route.also.length > 0 && view) params.set("also", route.also.join(","));
  if (route.find && view) params.set("find", route.find);
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
  const also = parseAlso(params, pathStoryline);
  const find = params.get("find")?.trim() || undefined;
  return {
    q: null,
    filters: {
      language: params.get(PARAM_KEYS.language) ?? undefined,
      country: params.get(PARAM_KEYS.country) ?? undefined,
    },
    storyline: pathStoryline,
    ...(from ? { from } : {}),
    ...(also.length > 0 ? { also } : {}),
    ...(find ? { find } : {}),
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
  if (!isView(route)) return `/${routeSearch(route)}`;

  const params = new URLSearchParams();
  for (const [filter, key] of Object.entries(PARAM_KEYS)) {
    const value = route.filters[filter as keyof TopicFilters];
    if (value) params.set(key, value);
  }
  if (route.from) params.set("from", route.from);
  // The path names the FIRST storyline; the rest ride in the query string. A
  // crawler following the path finds the one server-rendered page, which is
  // about that storyline alone; a reader following the whole URL finds the
  // view they were sent.
  if (route.also && route.also.length > 0) params.set("also", route.also.join(","));
  if (route.find) params.set("find", route.find);
  const search = params.toString();
  return `/storyline/${route.storyline}/${slugifyStoryline(label)}${search ? `?${search}` : ""}`;
}

/**
 * The view with its search box set to `keywords` — the pills row becomes the
 * storylines those words surface (ADR-0028, amended) — or, for null, back to
 * whatever the view offered before anything was typed. The view itself does
 * not move: same arcs, same origin.
 */
export function findInView(route: Route, keywords: string | null): Route {
  const { find: _was, ...kept } = route;
  const trimmed = keywords?.trim();
  return trimmed ? { ...kept, find: trimmed } : kept;
}

/**
 * Every storyline the STORYLINE VIEW holds, the path's first: what the view is
 * a view OF. Empty for anything that is not a view — a search, the hero, or a
 * bigint seed standing in `storyline`.
 */
export function routeStorylines(route: Route): string[] {
  if (!isView(route)) return [];
  return [route.storyline!, ...(route.also ?? [])];
}

/**
 * The view with exactly these storylines in it, first to the path and the
 * rest to `also`, or null for an empty list — a view of nothing is not a view,
 * and what to show instead (`leaveStorylineView`) is the caller's decision.
 *
 * Everything else about the route — filters, and the origin the view was
 * opened from — is kept: the set changing is not the reader going anywhere.
 */
export function withViewStorylines(route: Route, ids: readonly string[]): Route | null {
  const [first, ...rest] = ids;
  if (first === undefined) return null;
  const { storyline: _was, also: _were, ...kept } = route;
  return { ...kept, storyline: first, ...(rest.length > 0 ? { also: rest } : {}) };
}

/**
 * The view without one of its storylines — a chip dismissed, or a pressed
 * pill pressed again. Null when that was the last one, which is the caller's
 * cue to leave the view altogether rather than show a view of nothing.
 */
export function removeStorylineFromView(route: Route, storylineId: string): Route | null {
  return withViewStorylines(
    route,
    routeStorylines(route).filter((id) => id !== storylineId),
  );
}

/**
 * The STORYLINE VIEW, opened from wherever the reader is now.
 *
 * From a search: the keywords they leave are kept as the view's origin rather
 * than dropped — the view is a step into one storyline, and the search that
 * surfaced it is where "out" leads. The filters carry as they always do; the
 * view itself ignores them (it is the storylines' own coverage, §api), but the
 * search they came from — and will return to — is still theirs.
 *
 * From INSIDE a view: the storyline is ADDED rather than swapped in (ADR-0028).
 * The reader had one arc open and asked for another, and the pills that
 * offered it are still in the bar, so the natural reading of the click is
 * "this too" rather than "this instead". The origin and the path's storyline
 * both stay where they were; one already in the view is left alone.
 */
export function openStorylineView(current: Route, storylineId: string): Route {
  if (isView(current)) {
    const held = routeStorylines(current);
    if (held.includes(storylineId)) return current;
    return { ...current, also: [...(current.also ?? []), storylineId] };
  }
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
 * opened it. Neither the storylines nor the origin travel onward — all of them
 * are provenance for what the reader was looking at, and belong to that view
 * alone. The filters do travel: they outlive the topic (see Route).
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
