import { useEffect, useRef, useState } from "react";
import type { StorylineSummary, TimelinePage } from "@zammy/shared";
import type { StorylineOpenSource } from "./analytics.js";
import { topicStorylines, type Reference, type TopicQuery } from "./api.js";
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
  surfaced,
  viewFind,
  findEmpty,
  onFindStorylines,
  reference,
  onSearch,
  onClear,
  onOpenStorylineView,
  onRemoveStoryline,
  viewLabelHints,
  qualifiers,
  daySummaries,
  onToggleDaySummaries,
  dayParts,
  onToggleDayParts,
}: {
  topic: TopicQuery;
  /** The newest response — the authority on meta. */
  page: TimelinePage | undefined;
  /**
   * The pills row: what this search surfaced, or — in the view — the matches
   * for its question that it does not already hold, a row's worth
   * (ADR-0028, `storylineOffers`). `TimelinePage` decides which; this only
   * draws it.
   */
  surfaced: readonly StorylineSummary[];
  /**
   * In the view, the keywords its search box last asked about (ADR-0028,
   * amended) — what the box shows, and what `surfaced` is the answer to. Null
   * when nothing has been typed, and always null outside the view.
   */
  viewFind: string | null;
  /** Those keywords found nothing, and the answer is in — say so under the box. */
  findEmpty: boolean;
  /** The view's search box submitted: keywords, or null when emptied. */
  onFindStorylines: (keywords: string | null) => void;
  reference: Reference | undefined;
  onSearch: (topic: TopicQuery, options?: { replace?: boolean }) => void;
  onClear: () => void;
  onOpenStorylineView: (storylineId: string, label: string | null, source: StorylineOpenSource) => void;
  /** One arc out of the view: its chip dismissed. */
  onRemoveStoryline: (storylineId: string) => void;
  /**
   * The labels the clicks that built this view had in hand, by storyline id,
   * for the chips to show before `page` — the view's own topic, not yet
   * fetched — names them itself. Absent for a reload or a shared link, which
   * has no click to have carried one.
   */
  viewLabelHints: ReadonlyMap<string, string | null>;
  /** storyline id → the date that separates it from its namesakes on screen. */
  qualifiers: Map<string, string>;
  /** Whether the rail draws its day sentences (`daySummaryPreference`). */
  daySummaries: boolean;
  onToggleDaySummaries: () => void;
  /** Whether the rail divides each day into parts of the day (`dayPartsPreference`). */
  dayParts: boolean;
  onToggleDayParts: () => void;
}) {
  const [q, setQ] = useState(topic.q);
  // The storyline view: opened by clicking a label, so there are no keywords
  // and the box is empty by definition (ADR-0011). One chip per arc it holds
  // (ADR-0028), in the URL's order — the path's first.
  const held = topic.q === "" ? topicStorylines(topic) : [];
  const view = held.length > 0;
  // `page` is this view's own topic once loaded, and outranks the hint: a
  // storyline whose label generation genuinely failed reports that as `null`
  // there, and the hint — good only until the real answer is in — must not
  // paper over it. Before `page` names an arc there is nothing to outrank yet,
  // so the hint carries its chip instead of the "storyline" fallback. Looked up
  // BY ID rather than by position, because a page mid-add names the arcs it
  // was asked for and a page that followed an alias names the survivor.
  const chipLabel = (storylineId: string): string | null => {
    const named = page?.storylines.find((storyline) => storyline.id === storylineId);
    if (named) return named.label;
    return viewLabelHints.get(storylineId) ?? null;
  };

  // Back/forward (or a shared link) changes the topic from outside; the bar
  // must follow the URL, not fight it. In the view the box holds the words the
  // reader asked the pills with, which live beside the topic rather than in it.
  useEffect(() => {
    setQ(view ? (viewFind ?? "") : topic.q);
  }, [topic, view, viewFind]);

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
          // In the VIEW, typing is a search FOR storylines (ADR-0028, amended):
          // the words go to the pills row, the view stays, and an emptied box
          // hands the row back to whatever it offered before. The view is left
          // by dismissing its chips or by the prompt, not by typing — a reader
          // inside one arc who types "visa" is asking which arcs say visa.
          if (view) return onFindStorylines(q.trim() || null);
          if (!q.trim()) return;
          const { storyline: _held, also: _also, ...carried } = topic;
          onSearch({ ...carried, q: q.trim() });
        }}
        style={{
          maxWidth: "var(--page-max)",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          // Several chips may not fit beside the prompt on a phone; the input
          // then drops to its own line rather than shrinking to nothing. A
          // single chip never wraps, since it is capped at half the row.
          flexWrap: "wrap",
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
        {/* One chip per arc, each dismissible on its own: taking the last one
            out is what leaves the view (`App.tsx`'s `removeStoryline`), so a
            reader with one chip sees exactly the dismiss they always had. A
            dismissed arc goes back to the pills row below (`storylineOffers`). */}
        {held.map((storylineId) => (
          <StorylineChip
            key={storylineId}
            label={chipLabel(storylineId)}
            qualifier={qualifiers.get(storylineId) ?? null}
            crowded={held.length > 1}
            onDismiss={() => onRemoveStoryline(storylineId)}
          />
        ))}
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={view ? "find storylines..." : "search..."}
          aria-label="Search topics"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            fontFamily: MONO,
            fontSize: "0.95rem",
            padding: "0.25rem 0",
            // Beside several chips, wide enough to still be a search box —
            // which is what sends it to its own line on a phone. Beside one
            // chip it may shrink instead, as it always has, and never wraps.
            minWidth: held.length > 1 ? "8rem" : 0,
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
        {/* Unconditional, unlike the sentences below: every rail has days and
            every day has parts, so this control has something behind it on a
            search and in the view alike. First in the pair for the same reason
            — the one that is always here must not move when the other appears. */}
        <DayPartsToggle on={dayParts} onToggle={onToggleDayParts} />
        {/* Only in the VIEW, because only the view has sentences to draw
            (`TimelineEntry.daySummary`): a search's slots carry none, so the
            same control on a search would be a switch with nothing behind it. */}
        {view && (
          <DaySummaryToggle on={daySummaries} onToggle={onToggleDaySummaries} />
        )}
      </div>
      {/* S8's verdict: surfaced storylines live in the chrome, in the meta row
          — never in the results, which they are not part of. Once suppressed
          in the view itself; kept there now (ADR-0028) as a row of OFFERS: the
          matches the view does not hold, so the reader can take a second one.
          A taken pill's arc is named by its chip above, not by the row.
          `TimelinePage` hands an empty list for a view with nothing to offer,
          and the row then draws nothing at all. */}
      <StorylinePills
        storylines={surfaced}
        qualifiers={qualifiers}
        onOpen={onOpenStorylineView}
      />
      {/* The row's one wordless state that needs words: a question the box
          asked and nothing answered. The row itself draws nothing when empty,
          which on a search means "nothing surfaced" and needs no saying, but
          a reader who just typed and pressed Enter needs to know they were
          heard. */}
      {findEmpty && (
        <p
          role="status"
          style={{
            maxWidth: "var(--page-max)",
            margin: "0 auto",
            padding: "0 1rem 0.45rem",
            fontFamily: MONO,
            fontSize: "0.7rem",
            color: "var(--fg-faint)",
          }}
        >
          no storylines say “{viewFind}”
        </p>
      )}
    </header>
  );
}

/**
 * The switch for the day sentences (ADR-0023), beside the filter chips it is
 * not one of — it narrows nothing, it decides whether the rail speaks.
 *
 * A pressed-state toggle rather than two labels that swap, because the two
 * states are one setting rather than two actions: `aria-pressed` is what tells
 * a screen reader that "summaries" is currently on, where a button reading
 * "hide summaries" would have to be read as a prediction of what pressing it
 * does. The tick carries the same fact to everyone else.
 *
 * Icon-only: a filled sheet with lines while on, an outline while off, so the
 * on/off contrast survives losing the word. `aria-pressed` plus `title` still
 * carry the state and the action in words for anyone who needs them.
 */
function DaySummaryToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? "Hide the daily summary" : "Show the daily summary"}
      title={on ? "Hide the daily summary" : "Show the daily summary"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: on ? "var(--chip-bg)" : "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        lineHeight: 1.3,
        opacity: on ? 1 : 0.7,
        padding: "0.05rem 0.4rem",
      }}
    >
      {on ? "▤" : "▢"}
    </button>
  );
}

/**
 * The switch for the rail's parts of the day (§8.1's segment dividers): on, a
 * day is chunked into Night/Morning/Afternoon/Evening; off, it is one run of
 * cards under the day heading alone.
 *
 * A pressed-state toggle, the same shape and chip as `DaySummaryToggle` above,
 * and for the same reason: two states of one setting rather than two actions.
 *
 * Icon only, though, where the summary toggle carries its word. "Summary" is a
 * noun a reader already has — the sentence is right there beside the day
 * heading — but the parts of the day have no name in the interface, and the
 * three-line glyph shows the chunking it stands for more directly than any
 * label short enough to sit in this row would say it. The name is still
 * written: `aria-label` carries it for a screen reader, which never sees the
 * glyph, and `title` says what pressing does for everyone hovering. So the
 * glyph is `aria-hidden` — it is the picture of the label, not a second one.
 */
function DayPartsToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label="Split each day into parts of the day"
      title={on ? "Combine the day's articles" : "Split each day into parts of the day"}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: on ? "var(--chip-bg)" : "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        lineHeight: 1.3,
        opacity: on ? 1 : 0.7,
        // Wider than it is tall by less than the summary chip beside it: a lone
        // glyph needs the pill to read as square-ish rather than as a word that
        // went missing.
        padding: "0.05rem 0.45rem",
      }}
    >
      <span aria-hidden="true">{"\u2261"}</span>
    </button>
  );
}

/**
 * One of the storyline view's subjects, as a dismissible chip in the prompt
 * row (ADR-0011; several of them since ADR-0028). Dismissing takes this arc
 * out of the view; dismissing the last one steps back out to the search the
 * view was opened from, and to the hero only where there was none — a shared
 * link.
 *
 * Renders "storyline" when the label is null — a promoted storyline whose
 * label generation failed is still a storyline, and the chip is what tells the
 * reader why the box is empty. The qualifier is the same date that separates
 * two same-named arcs everywhere else on screen: two chips reading "Trump
 * Administration" would otherwise be two chips the reader cannot tell apart.
 */
function StorylineChip({
  label,
  qualifier,
  crowded,
  onDismiss,
}: {
  label: string | null;
  qualifier: string | null;
  /** More than one chip in the row: each takes less of it, so the input keeps some. */
  crowded: boolean;
  onDismiss: () => void;
}) {
  const name = label ?? "storyline";
  return (
    <span
      // Fades and slides in on mount (`index.css`): a chip is the pill the
      // reader just took, arriving where it now lives. Keyed by storyline id
      // upstream, so a chip that merely re-renders does not replay it.
      className="storyline-chip-enter"
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
        maxWidth: crowded ? "34%" : "50%",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {name}
        {qualifier && <span style={{ opacity: 0.6 }}> · {qualifier}</span>}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Remove the storyline ${name}${qualifier ? `, ${qualifier}` : ""} from the view`}
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
