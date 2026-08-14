import { useCallback, useEffect, useState } from "react";
import type { TopicQuery } from "./api.js";
import { Hero } from "./Hero.js";
import { TimelinePage } from "./TimelinePage.js";

/**
 * Phase 4 root: keywords in, timeline out (ARCHITECTURE 8).
 *
 * Query state lives in the URL (§8.2) — `/?q=climate+policy&lang=en` — so
 * searches are shareable and back/forward works. React state is only ever a
 * mirror of location.search; every transition goes through the history API.
 */
const PARAM_KEYS = {
  language: "lang",
  country: "country",
  category: "category",
  /** ADR-0010's seed, in the URL so a shared phrase link seeds for its
   * recipient too — it is provenance, and provenance travels with the link. */
  storyline: "storyline",
} as const;

function topicFromLocation(): TopicQuery | null {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q")?.trim();
  if (!q) return null;
  return {
    q,
    language: params.get(PARAM_KEYS.language) ?? undefined,
    country: params.get(PARAM_KEYS.country) ?? undefined,
    category: params.get(PARAM_KEYS.category) ?? undefined,
    storyline: params.get(PARAM_KEYS.storyline) ?? undefined,
  };
}

function searchFor(topic: TopicQuery | null): string {
  if (!topic) return "";
  const params = new URLSearchParams({ q: topic.q });
  if (topic.language) params.set(PARAM_KEYS.language, topic.language);
  if (topic.country) params.set(PARAM_KEYS.country, topic.country);
  if (topic.category) params.set(PARAM_KEYS.category, topic.category);
  if (topic.storyline) params.set(PARAM_KEYS.storyline, topic.storyline);
  return `?${params}`;
}

export function App() {
  const [topic, setTopic] = useState<TopicQuery | null>(topicFromLocation);

  useEffect(() => {
    const onPopState = () => setTopic(topicFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: TopicQuery | null) => {
    window.history.pushState(null, "", `${window.location.pathname}${searchFor(next)}`);
    setTopic(next);
  }, []);

  if (topic === null) {
    return <Hero onSearch={(q) => navigate({ q })} />;
  }
  return <TimelinePage topic={topic} onSearch={navigate} onClear={() => navigate(null)} />;
}
