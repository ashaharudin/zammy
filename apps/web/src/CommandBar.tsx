import { useEffect, useRef, useState } from "react";
import type { TimelinePage } from "@zammy/shared";
import type { Reference, TopicQuery } from "./api.js";
import { FilterChipRow, useFilterDefaults } from "./FilterChipRow.js";
import { MONO } from "./theme.js";
import { upstreamHealthRecord } from "./upstreamHealth.js";

/**
 * The persistent chrome once a topic is open: prompt + query, and underneath a
 * meta row carrying the response's asOf stamp (§8.1) followed by the topic's
 * filter chips — location, language, category.
 *
 * The chips replaced a flag icon and a servedFrom/degraded/stale readout. The
 * icon said less than a word does, and the freshness readout was operational
 * detail standing where the reader's own filters belong; degraded state is
 * logged now (see upstreamHealth) rather than shown.
 *
 * Ingest progress is deliberately not here: the timeline owns that state and
 * says it in motion (see IngestBeacon/IngestGhosts).
 *
 * Country and category filters, dropped from the UI on 2026-08-10, are back as
 * chips; shared links carrying them have kept working throughout.
 */
export function CommandBar({
  topic,
  page,
  reference,
  onSearch,
  onClear,
}: {
  topic: TopicQuery;
  /** The newest response — the authority on meta. */
  page: TimelinePage | undefined;
  reference: Reference | undefined;
  onSearch: (topic: TopicQuery, options?: { replace?: boolean }) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(topic.q);

  // Back/forward (or a shared link) changes the topic from outside; the bar
  // must follow the URL, not fight it.
  useEffect(() => {
    setQ(topic.q);
  }, [topic]);

  useUpstreamHealthLog(page);
  // The reader's own browser, on a topic whose URL states no filters (§8.1).
  useFilterDefaults(topic, reference, "browser", (filters) =>
    onSearch({ ...topic, ...filters }, { replace: true }),
  );

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
          if (q.trim()) onSearch({ ...topic, q: q.trim() });
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
      </form>
      <div
        style={{
          maxWidth: "760px",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.4rem",
          padding: "0 1rem 0.5rem",
          fontFamily: MONO,
          fontSize: "0.75rem",
          color: "var(--fg-faint)",
        }}
      >
        <span>{page ? <AsOf iso={page.meta.asOf} /> : "searching…"}</span>
        <FilterChipRow
          filters={topic}
          reference={reference}
          onChange={(filters) => onSearch({ ...topic, ...filters })}
        />
      </div>
    </header>
  );
}

/**
 * §11's degraded and stale states, logged instead of shown. console is the
 * transport until the app has a real one; the record is already the shape a
 * transport would ship, so adopting one is a change of sink, not of caller.
 */
function useUpstreamHealthLog(page: TimelinePage | undefined) {
  const lastLogged = useRef<string | null>(null);

  useEffect(() => {
    if (!page) return;
    const record = upstreamHealthRecord(page.meta);
    if (!record) {
      lastLogged.current = null;
      return;
    }
    // Progressive fill re-renders this bar on every page; one line per distinct
    // state, not one per response.
    const key = `${record.degraded}:${record.stale}:${record.servedFrom}`;
    if (lastLogged.current === key) return;
    lastLogged.current = key;
    console.warn("[zammy]", record);
  }, [page]);
}

/** The response's asOf freshness stamp: day, date, time, timezone (§8.1). */
function AsOf({ iso }: { iso: string }) {
  return (
    <time dateTime={iso}>
      {new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(iso))}
    </time>
  );
}
