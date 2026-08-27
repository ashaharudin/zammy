import { useState } from "react";
import type { TopicFilters } from "./api.js";
import { cloudLanguage } from "./cloudLanguage.js";
import { FilterChipRow, useFilterDefaults } from "./FilterChipRow.js";
import { MONO } from "./theme.js";
import { TrendingCloud } from "./TrendingCloud.js";
import { useReference } from "./useTimeline.js";

const SEARCH_PLACEHOLDER = "Search for a timeline of when it happens...";

/**
 * The empty state: the rolling 24-hour wordcloud — the storylines the window
 * updated, named by their labels (ADR-0013) — with the command-bar prompt
 * scaled up and centered beneath it (ARCHITECTURE 10). The landing page is
 * never blank, and the cloud gives users something to click before they know
 * what to type (§9.3 cold start).
 *
 * The same filter chips the open-topic bar carries sit under the prompt, set
 * before there is anything to search and carried into whatever the reader then
 * searches (§8.2, route.ts). They are not decoration here: the cloud is built
 * per language, so the language chip redraws it.
 *
 * That chip starts on English rather than the browser's language, unlike the
 * timeline's: the hero's job is to show the day's news to someone who has not
 * asked for anything yet, and English is the corpus upstream covers deeply
 * enough to fill a cloud.
 */
export function Hero({
  filters,
  onFilters,
  onSearch,
  onOpenStoryline,
}: {
  filters: TopicFilters;
  /** A chip pick, which the URL holds until a search adopts it. */
  onFilters: (filters: TopicFilters) => void;
  onSearch: (q: string) => void;
  /** A cloud word opens its storyline by UUID (ADR-0016), not a search. */
  onOpenStoryline: (storylineId: string) => void;
}) {
  const [q, setQ] = useState("");
  const reference = useReference();
  const language = cloudLanguage(filters.language);

  useFilterDefaults(filters, reference.data, "english", onFilters);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "2.5rem",
        padding: "3rem 1rem",
      }}
    >
      <TrendingCloud language={language} onOpenStoryline={onOpenStoryline} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (q.trim()) onSearch(q.trim());
        }}
        style={{
          width: "100%",
          maxWidth: "640px",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <h1 style={{ fontFamily: MONO, fontSize: "1.6rem", margin: 0, whiteSpace: "nowrap" }}>
          zammy&gt;
        </h1>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            autoFocus
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Search topics"
            style={{
              width: "100%",
              padding: "0.9rem 3.25rem 0.9rem 0.25rem",
              fontSize: "1.1rem",
              border: "none",
              borderBottom: "1px solid var(--fg)",
              borderRadius: 0,
              background: "transparent",
              outline: "none",
            }}
          />
          <button
            type="submit"
            aria-label="Search"
            style={{
              position: "absolute",
              right: "0.5rem",
              top: "50%",
              transform: "translateY(-50%)",
              width: "2.4rem",
              height: "2.4rem",
              borderRadius: "50%",
              border: "none",
              background: "var(--fg)",
              color: "var(--bg)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="2" />
              <line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </form>
      <div
        style={{
          width: "100%",
          maxWidth: "640px",
          // Aligned under the input rather than the prompt: the chips narrow
          // what the box above them will search.
          marginTop: "-1.75rem",
          paddingLeft: "6.5rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.4rem",
          fontFamily: MONO,
          fontSize: "0.75rem",
          color: "var(--fg-faint)",
        }}
      >
        <FilterChipRow filters={filters} reference={reference.data} onChange={onFilters} />
      </div>
    </main>
  );
}
