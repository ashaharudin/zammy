import { useEffect, useState } from "react";
import type { TimelinePage } from "@zammy/shared";
import { pickerCategories, type Reference, type TopicQuery } from "./api.js";
import { dayLabel, timeLabel } from "./format.js";
import { MONO } from "./theme.js";

/**
 * The persistent chrome once a topic is open: prompt + query + filter chips,
 * and underneath a terse meta row that renders the response's freshness
 * honestly (§8.1) — count, coverage, asOf/servedFrom, ingest progress, stale
 * and degraded states. The count line is aria-live so screen readers hear the
 * timeline grow during progressive fill.
 */
export function CommandBar({
  topic,
  page,
  articleCount,
  ingesting,
  reference,
  onSearch,
  onClear,
}: {
  topic: TopicQuery;
  /** The newest response — the authority on meta and coverage. */
  page: TimelinePage | undefined;
  /** Total articles across all loaded pages, not just the newest one. */
  articleCount: number;
  ingesting: boolean;
  reference: Reference | undefined;
  onSearch: (topic: TopicQuery) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(topic.q);
  const [language, setLanguage] = useState(topic.language ?? "");
  const [country, setCountry] = useState(topic.country ?? "");
  const [category, setCategory] = useState(topic.category ?? "");

  // Back/forward (or a shared link) changes the topic from outside; the bar
  // must follow the URL, not fight it.
  useEffect(() => {
    setQ(topic.q);
    setLanguage(topic.language ?? "");
    setCountry(topic.country ?? "");
    setCategory(topic.category ?? "");
  }, [topic]);

  const chip: React.CSSProperties = {
    fontFamily: MONO,
    fontSize: "0.7rem",
    border: "1px solid var(--border)",
    borderRadius: "3px",
    background: "var(--chip-bg)",
    padding: "0.15rem 0.3rem",
    color: "var(--fg-muted)",
    maxWidth: "9rem",
  };

  const submit = () => {
    if (!q.trim()) return;
    onSearch({
      q: q.trim(),
      language: language || undefined,
      country: country || undefined,
      category: category || undefined,
    });
  };

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        background: "var(--surface-translucent)",
        backdropFilter: "blur(6px)",
        borderBottom: "1px solid var(--border)",
        zIndex: 10,
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        style={{
          maxWidth: "760px",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.75rem 1rem 0.35rem",
        }}
      >
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search and return home"
          style={{
            fontFamily: MONO,
            fontWeight: 700,
            border: "none",
            background: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          zammy&gt;
        </button>
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="keywords (all terms must match)"
          aria-label="Search topics"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            fontFamily: MONO,
            fontSize: "0.95rem",
            padding: "0.25rem 0",
            minWidth: 0,
            background: "transparent",
          }}
        />
        <select style={chip} value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language filter">
          <option value="">lang:*</option>
          {Object.entries(reference?.languages ?? {}).map(([name, code]) => (
            <option key={code} value={code}>
              lang:{code} ({name})
            </option>
          ))}
        </select>
        <select style={chip} value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country filter">
          <option value="">geo:*</option>
          {Object.entries(reference?.regions ?? {}).map(([name, code]) => (
            <option key={code} value={code}>
              geo:{code} ({name})
            </option>
          ))}
        </select>
        <select style={chip} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category filter">
          <option value="">cat:*</option>
          {(reference ? pickerCategories(reference) : []).map((c) => (
            <option key={c} value={c}>
              cat:{c}
            </option>
          ))}
        </select>
      </form>
      <div
        style={{
          maxWidth: "760px",
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "1rem",
          padding: "0 1rem 0.5rem",
          fontFamily: MONO,
          fontSize: "0.75rem",
          color: "var(--fg-faint)",
        }}
      >
        <span aria-live="polite">
          {page ? `${articleCount} articles` : "searching…"}
          {page?.topic.coverage && (
            <> · covered since {dayLabel(page.topic.coverage.from).toLowerCase()}</>
          )}
        </span>
        <span>
          {page?.meta.degraded && (
            <span style={{ color: "var(--amber)", marginRight: "0.75rem" }}>
              degraded: {page.meta.degraded}
            </span>
          )}
          {page?.meta.stale && (
            <span style={{ color: "var(--amber)", marginRight: "0.75rem" }}>stale</span>
          )}
          {ingesting ? (
            <span style={{ color: "var(--amber)" }}>▮▯▯ ingesting from upstream…</span>
          ) : (
            page && <>as of {timeLabel(page.meta.asOf)} · {page.meta.servedFrom}</>
          )}
        </span>
      </div>
    </header>
  );
}
