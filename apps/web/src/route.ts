import { STORYLINE_UUID } from "@zammy/shared";
import type { TopicFilters } from "./api.js";

/**
 * The URL as the single source of truth for what the app is showing (§8.2):
 * keywords, and the filters that narrow them.
 *
 * Filters are held apart from the keywords because they outlive them. The hero
 * carries them before there is anything to search, a search adopts whatever is
 * set, and clearing back to the hero keeps them — so a reader who has said
 * "Malay, sports" says it once, not once per topic.
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

const PARAM_KEYS = { language: "lang", country: "country", category: "category" } as const;

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
      category: params.get(PARAM_KEYS.category) ?? undefined,
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
