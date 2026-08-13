import { useEffect, useRef, useState } from "react";
import type { TimelinePage } from "@zammy/shared";
import type { Reference, TopicQuery } from "./api.js";
import { defaultedTopic } from "./browserDefaults.js";
import { filterChips, type Chip, type ChipOption } from "./filterChips.js";
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
  useBrowserDefaults(topic, reference, onSearch);

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
        {filterChips(topic, reference).map((chip) => (
          <FilterChip
            key={chip.kind}
            chip={chip}
            onSelect={(code) => onSearch({ ...topic, [chip.kind]: code })}
          />
        ))}
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

/**
 * The starting filters for a topic that names none: the browser's own country
 * and language, falling back to Worldwide and English (§8.1, defaultedTopic).
 *
 * Only once the reference list has arrived — a detected code upstream does not
 * carry would be rejected. Applied as a real search rather than a display-only
 * default, because a chip reading "Canada" over an unfiltered timeline would
 * be a lie; replace, not push, because the reader did not ask to go here.
 */
function useBrowserDefaults(
  topic: TopicQuery,
  reference: Reference | undefined,
  onSearch: (topic: TopicQuery, options?: { replace?: boolean }) => void,
) {
  useEffect(() => {
    if (!reference) return;
    const next = defaultedTopic(topic, readBrowser(), reference);
    if (next.language !== topic.language || next.country !== topic.country) {
      onSearch(next, { replace: true });
    }
  }, [topic, reference, onSearch]);
}

/** The one place that reads the browser's own settings. */
function readBrowser(): { locales: readonly string[]; timeZone: string | undefined } {
  return {
    locales: navigator.languages?.length ? navigator.languages : [navigator.language],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
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

/**
 * One filter as a word plus the list it can be changed to. Picking an entry
 * re-runs the search immediately — a filter that waits for a second Enter
 * reads as broken. A custom popover rather than a native <select> so the
 * closed control reads as part of the meta line rather than as a form field.
 */
function FilterChip({
  chip,
  onSelect,
}: {
  chip: Chip;
  onSelect: (code: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${CHIP_LABELS[chip.kind]}: ${chip.label}`}
        style={{
          border: "1px solid var(--border)",
          borderRadius: "999px",
          background: "var(--chip-bg)",
          color: "inherit",
          cursor: "pointer",
          font: "inherit",
          lineHeight: 1.3,
          padding: "0.05rem 0.5rem",
        }}
      >
        {chip.label}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={CHIP_LABELS[chip.kind]}
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 0.35rem)",
            margin: 0,
            padding: "0.25rem",
            listStyle: "none",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            boxShadow: "var(--shadow)",
            maxHeight: "60vh",
            overflowY: "auto",
            minWidth: "12rem",
            zIndex: 20,
          }}
        >
          {chip.options.map((option) => (
            <Option
              key={option.code ?? "*"}
              option={option}
              selected={option.code === chip.code}
              onSelect={() => {
                setOpen(false);
                onSelect(option.code);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const CHIP_LABELS: Record<Chip["kind"], string> = {
  country: "Location",
  language: "Language",
  category: "Category",
};

function Option({
  option,
  selected,
  onSelect,
}: {
  option: ChipOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        style={{
          display: "block",
          width: "100%",
          border: "none",
          background: selected ? "var(--chip-bg)" : "none",
          borderRadius: "6px",
          cursor: "pointer",
          padding: "0.3rem 0.5rem",
          fontSize: "0.85rem",
          textAlign: "left",
        }}
      >
        {option.label}
      </button>
    </li>
  );
}
