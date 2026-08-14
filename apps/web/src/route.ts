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
}

const PARAM_KEYS = { language: "lang", country: "country", category: "category" } as const;

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const q = params.get("q")?.trim() || null;
  const storyline = params.get("storyline") ?? undefined;
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
  };
}

export function routeSearch(route: Route): string {
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  for (const [filter, key] of Object.entries(PARAM_KEYS)) {
    const value = route.filters[filter as keyof TopicFilters];
    if (value) params.set(key, value);
  }
  if (route.storyline && (route.q || STORYLINE_UUID.test(route.storyline))) {
    params.set("storyline", route.storyline);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
