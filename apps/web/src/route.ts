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
}

const PARAM_KEYS = { language: "lang", country: "country", category: "category" } as const;

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  return {
    q: params.get("q")?.trim() || null,
    filters: {
      language: params.get(PARAM_KEYS.language) ?? undefined,
      country: params.get(PARAM_KEYS.country) ?? undefined,
      category: params.get(PARAM_KEYS.category) ?? undefined,
    },
  };
}

export function routeSearch(route: Route): string {
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  for (const [filter, key] of Object.entries(PARAM_KEYS)) {
    const value = route.filters[filter as keyof TopicFilters];
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
