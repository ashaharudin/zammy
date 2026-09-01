import { useEffect, useRef, useState } from "react";
import type { TimelinePage } from "@zammy/shared";
import type { Reference, TopicQuery } from "./api.js";
import { FilterChipRow, useFilterDefaults } from "./FilterChipRow.js";
import { StorylinePills } from "./StorylinePills.js";
import { MONO } from "./theme.js";
import { upstreamHealthRecord } from "./upstreamHealth.js";

/**
 * The persistent chrome once a topic is open: prompt + query, and underneath a
 * meta row carrying the topic's filter chip — location.
 *
 * The chips replaced a flag icon, a servedFrom/degraded/stale readout, and the
 * response's asOf freshness stamp. The icon said less than a word does, the
 * freshness readout was operational detail standing where the reader's own
 * filters belong, and the asOf stamp was clock chrome nobody asked for;
 * degraded state is logged now (see upstreamHealth) rather than shown.
 *
 * Ingest progress is deliberately not here: the timeline owns that state and
 * says it in motion (see IngestBeacon/IngestGhosts).
 *
 * Country and category filters, dropped from the UI on 2026-08-10, came back as
 * chips; shared links carrying them have kept working throughout. Category has
 * since gone for good (ADR-0020) — half the ingest cannot express one — and a
 * link still carrying `?category=` keeps working the same way, as the search
 * without it.
 */
export function CommandBar({
  topic,
  page,
  reference,
  onSearch,
  onClear,
  onOpenStorylineView,
  onLeaveStorylineView,
  qualifiers,
}: {
  topic: TopicQuery;
  /** The newest response — the authority on meta. */
  page: TimelinePage | undefined;
  reference: Reference | undefined;
  onSearch: (topic: TopicQuery, options?: { replace?: boolean }) => void;
  onClear: () => void;
  onOpenStorylineView: (storylineId: string) => void;
  /** The keywords typed to leave the view, or null for a dismissed chip. */
  onLeaveStorylineView: (typed: string | null) => void;
  /** storyline id → the date that separates it from its namesakes on screen. */
  qualifiers: Map<string, string>;
}) {
  const [q, setQ] = useState(topic.q);
  // The storyline view: opened by clicking a label, so there are no keywords
  // and the box is empty by definition (ADR-0011).
  const view = topic.q === "" && topic.storyline !== undefined ? topic.storyline : null;
  const viewLabel = view ? (page?.storylines[0]?.label ?? null) : null;

  // Back/forward (or a shared link) changes the topic from outside; the bar
  // must follow the URL, not fight it.
  useEffect(() => {
    setQ(topic.q);
  }, [topic]);

  useUpstreamHealthLog(page);
  // The reader's own browser for country, English for language (§8.1), on a
  // topic whose URL states no filters.
  //
  // NOT in the storyline view, which has no filters to default: it is one
  // storyline's own coverage, and narrowing it by language would hide part of
  // the story. Found by typing into the view and watching the search not
  // happen — the hook was navigating (replace) to add `lang`/`country`, which
  // changed `topic`, which reset the input from under the reader mid-keystroke.
  useFilterDefaults(view ? null : topic, reference, "english", (filters) =>
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
          // Filters carry over; the storyline seed does not. It is provenance
          // for one phrase click (ADR-0010), and spreading it into whatever
          // the reader types next would keep enrolling that slot in unrelated
          // topics. The filter chips below DO keep it: they narrow this same
          // topic rather than starting another.
          // Typing exits the storyline view, and drops the ADR-0010 seed for
          // the same reason: both are provenance for what the reader was
          // looking at, and neither belongs to what they type next.
          if (!q.trim()) return;
          // Leaving the VIEW is its own transition (leaveStorylineView): the
          // view stood between this search and the one that opened it, and it
          // is that earlier search the reader's Back belongs to.
          if (view) return onLeaveStorylineView(q.trim());
          const { storyline: _held, ...carried } = topic;
          onSearch({ ...carried, q: q.trim() });
        }}
        style={{
          maxWidth: "var(--page-max)",
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
        {view && (
          <StorylineChip
            label={viewLabel}
            onDismiss={() => onLeaveStorylineView(null)}
          />
        )}
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={view ? "search to leave this storyline" : "search..."}
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
          maxWidth: "var(--page-max)",
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
        {/* The storyline view is not a search, so the location chip here only
            sets what the reader leaves with — it narrows the search they
            return to, not this storyline's own coverage. The theme toggle
            rides along regardless, since it isn't a filter at all. */}
        <FilterChipRow
          filters={topic}
          reference={reference}
          onChange={(filters) => onSearch({ ...topic, ...filters })}
        />
      </div>
      {/* S8's verdict: surfaced storylines live in the chrome, in the meta row
          — never in the results, which they are not part of. Suppressed
          in the view itself, which is already about one storyline. */}
      {!view && (
        <StorylinePills
          storylines={page?.storylines ?? []}
          qualifiers={qualifiers}
          onOpen={onOpenStorylineView}
        />
      )}
    </header>
  );
}

/**
 * The storyline view's subject, as a dismissible chip in the prompt row
 * (ADR-0011). Dismissing steps back out to the search the view was opened
 * from, and to the hero only where there was none — a shared link.
 *
 * Renders "storyline" when the label is null — a promoted storyline whose
 * label generation failed is still a storyline, and the chip is what tells the
 * reader why the box is empty.
 */
function StorylineChip({ label, onDismiss }: { label: string | null; onDismiss: () => void }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: "var(--chip-bg)",
        fontFamily: MONO,
        fontSize: "0.75rem",
        padding: "0.1rem 0.2rem 0.1rem 0.55rem",
        whiteSpace: "nowrap",
        maxWidth: "50%",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {label ?? "storyline"}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Leave the storyline ${label ?? ""}`.trim()}
        style={{
          border: "none",
          background: "none",
          color: "var(--fg-faint)",
          cursor: "pointer",
          fontSize: "0.8rem",
          lineHeight: 1,
          padding: "0 0.25rem",
        }}
      >
        ×
      </button>
    </span>
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
