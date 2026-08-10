import { useEffect, useRef, useState } from "react";
import type { TimelinePage } from "@zammy/shared";
import type { Reference, TopicQuery } from "./api.js";
import { MONO } from "./theme.js";

/**
 * The persistent chrome once a topic is open: prompt + query + the language
 * picker, and underneath a terse meta row that renders the response's
 * freshness honestly (§8.1) — count, coverage, asOf/servedFrom, ingest
 * progress, stale and degraded states. The count line is aria-live so screen
 * readers hear the timeline grow during progressive fill.
 *
 * Country and category filters were dropped from the UI (2026-08-10) — the
 * API still accepts them, and shared links carrying them keep working.
 */
export function CommandBar({
  topic,
  page,
  ingesting,
  reference,
  onSearch,
  onClear,
}: {
  topic: TopicQuery;
  /** The newest response — the authority on meta. */
  page: TimelinePage | undefined;
  ingesting: boolean;
  reference: Reference | undefined;
  onSearch: (topic: TopicQuery) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(topic.q);

  // Back/forward (or a shared link) changes the topic from outside; the bar
  // must follow the URL, not fight it.
  useEffect(() => {
    setQ(topic.q);
  }, [topic]);

  const submit = (language: string | undefined) => {
    if (!q.trim()) return;
    onSearch({ ...topic, q: q.trim(), language });
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
          submit(topic.language);
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
        <LanguagePicker
          value={topic.language}
          languages={reference?.languages ?? {}}
          onSelect={(code) => submit(code)}
        />
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
        <span>
          {page ? <AsOf iso={page.meta.asOf} /> : "searching…"}
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
            page?.meta.servedFrom
          )}
        </span>
      </div>
    </header>
  );
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
 * Representative flag per upstream language code. A language is not a country,
 * so these are conventional picks, not statements; unknown codes get 🌐.
 */
const LANGUAGE_FLAGS: Record<string, string> = {
  ar: "🇸🇦",
  zh: "🇨🇳",
  nl: "🇳🇱",
  en: "🇬🇧",
  fi: "🇫🇮",
  fr: "🇫🇷",
  de: "🇩🇪",
  hi: "🇮🇳",
  it: "🇮🇹",
  ja: "🇯🇵",
  ko: "🇰🇷",
  msa: "🇲🇾",
  pt: "🇵🇹",
  ru: "🇷🇺",
  es: "🇪🇸",
  vi: "🇻🇳",
  da: "🇩🇰",
  cs: "🇨🇿",
  el: "🇬🇷",
  hu: "🇭🇺",
  sr: "🇷🇸",
  th: "🇹🇭",
  tr: "🇹🇷",
};

const ANY_LANGUAGE = "🌐";

function flagFor(code: string | undefined): string {
  if (!code) return ANY_LANGUAGE;
  return LANGUAGE_FLAGS[code] ?? ANY_LANGUAGE;
}

/**
 * Flag-icon trigger with a flag + name listbox. Picking an entry re-runs the
 * search immediately — a filter icon that waits for a second Enter reads as
 * broken. A custom popover rather than a native <select> because the closed
 * control must render as just the flag.
 */
function LanguagePicker({
  value,
  languages,
  onSelect,
}: {
  value: string | undefined;
  /** Display name → code, from /api/v1/reference. */
  languages: Record<string, string>;
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

  const entries: { code: string | undefined; flag: string; label: string }[] = [
    { code: undefined, flag: ANY_LANGUAGE, label: "any language" },
    ...Object.entries(languages).map(([name, code]) => ({
      code,
      flag: flagFor(code),
      label: name,
    })),
  ];

  return (
    <div ref={container} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language filter: ${value ?? "any"}`}
        title="Language"
        style={{
          border: "1px solid var(--border)",
          borderRadius: "999px",
          background: "var(--chip-bg)",
          cursor: "pointer",
          fontSize: "1rem",
          lineHeight: 1,
          padding: "0.25rem 0.45rem",
        }}
      >
        {flagFor(value)}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Language"
          style={{
            position: "absolute",
            right: 0,
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
          {entries.map((entry) => (
            <li key={entry.code ?? "*"}>
              <button
                type="button"
                role="option"
                aria-selected={entry.code === value}
                onClick={() => {
                  setOpen(false);
                  onSelect(entry.code);
                }}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  width: "100%",
                  border: "none",
                  background: entry.code === value ? "var(--chip-bg)" : "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  padding: "0.3rem 0.5rem",
                  fontSize: "0.85rem",
                  textAlign: "left",
                }}
              >
                <span aria-hidden="true">{entry.flag}</span>
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
