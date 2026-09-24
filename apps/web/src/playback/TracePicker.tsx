import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { TraceSummary } from "@zammy/shared/request-trace";
import { MONO } from "../theme.js";
import { NOTICE_TEXT } from "./pageNotices.js";
import { describeSummary } from "./stepText.js";

/**
 * Choosing what to play (ADR-0031): a dropdown of the recorded traces the API still holds,
 * newest first, each named by when it ran, what it asked for and how it answered —
 * "12:04:31 · search “quokka zebra” → 200 in 812 ms".
 *
 * A native `<select>`, so the keyboard, a screen reader and a phone's picker all work without
 * help. The trace on screen is always an option: one opened from a `#t=` link that has since
 * fallen out of the newest ten (or was never in them) is listed at the top as the current
 * trace, rather than the select showing an option that is not the one playing.
 *
 * **A pick waits for the reader to settle** (`PICK_SETTLE_MS`). On a closed select, an arrow key
 * fires `change` at once in Chrome and Firefox on Windows and Linux, so a pick per `change`
 * would read, restart and announce every trace the reader arrows past. The select shows the
 * draft straight away, and the page is told only once it has stopped moving; choosing with a
 * mouse or a phone's picker lands the same way, a moment later.
 *
 * "Refresh" re-reads the list at once, and says when it is done (`onRefresh` resolves); the page
 * also re-reads it on its own every `RECENT_POLL_MS`, which the button does not show. When the
 * list cannot be read, the reason is written under it — as text, not a live region: the page has
 * one (`PlaybackAnnouncer`), and a Refresh that fails is spoken there.
 */
export function TracePicker({
  current,
  traces,
  loading,
  failure,
  onPick,
  onRefresh,
}: {
  /** The id on screen, or null when nothing is. */
  current: string | null;
  traces: readonly TraceSummary[] | undefined;
  loading: boolean;
  /** Why the list could not be read, or null. */
  failure: string | null;
  onPick: (id: string) => void;
  /** Re-read the list; resolves once the read has settled, however it went. */
  onRefresh: () => Promise<void>;
}) {
  const id = useId();
  const listed = traces ?? [];
  const [draft, setDraft] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const settle = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(settle.current ?? undefined), []);
  // A draft the page has caught up with, or overtaken, is spent.
  useEffect(() => setDraft(null), [current]);

  const shownId = draft ?? current;
  // The trace on screen is always an option. "Not among the newest" is said only once the list
  // has been read and does not hold it; until then it is simply "this trace".
  const unlisted = shownId !== null && !listed.some((t) => t.id === shownId);
  const unlistedLabel = traces === undefined ? "This trace" : "This trace (not among the newest)";

  const choose = (value: string) => {
    setDraft(value);
    window.clearTimeout(settle.current ?? undefined);
    settle.current = window.setTimeout(() => {
      settle.current = null;
      if (value !== current) onPick(value);
      else setDraft(null);
    }, PICK_SETTLE_MS);
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: "0.5rem",
        fontFamily: MONO,
        fontSize: "0.8rem",
      }}
    >
      <label htmlFor={id} style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: "1 1 18rem", minWidth: 0 }}>
        <span style={{ color: "var(--fg-muted)" }}>Recorded trace</span>
        <select
          id={id}
          value={shownId ?? ""}
          disabled={listed.length === 0 && !unlisted}
          onChange={(event) => {
            if (event.target.value !== "") choose(event.target.value);
          }}
          style={FIELD}
        >
          {shownId === null && (
            <option value="" disabled>
              {loading
                ? "Reading the list…"
                : listed.length === 0
                  ? "No recorded traces"
                  : "Choose a trace"}
            </option>
          )}
          {unlisted && <option value={shownId}>{unlistedLabel}</option>}
          {listed.map((trace) => (
            <option key={trace.id} value={trace.id}>
              {describeSummary(trace, clockTime)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          if (refreshing) return;
          setRefreshing(true);
          void onRefresh().finally(() => setRefreshing(false));
        }}
        // Not `disabled` while a read is in flight: that would throw focus to `<body>`.
        aria-disabled={refreshing}
        style={{
          minHeight: "44px",
          padding: "0 0.9rem",
          border: "1px solid var(--border)",
          borderRadius: "999px",
          background: "var(--chip-bg)",
          color: "var(--fg)",
          cursor: refreshing ? "progress" : "pointer",
          fontFamily: MONO,
          fontSize: "0.8rem",
        }}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      {failure !== null && (
        <p style={{ ...NOTICE_TEXT, flexBasis: "100%" }}>
          {failure}
        </p>
      )}
      {failure === null && !loading && listed.length === 0 && (
        <p style={{ margin: 0, flexBasis: "100%", color: "var(--fg-muted)", lineHeight: 1.5 }}>
          No trace is stored. With tracing on, every search, storyline view, storyline open,
          trending and reference request is recorded and kept for{" "}
          <code>REQUEST_TRACE_TTL_SECONDS</code> (an hour by default): use the site, then
          Refresh.
        </p>
      )}
    </div>
  );
}

/** How long the select must be still before its value is played. */
export const PICK_SETTLE_MS = 400;

/** A trace's start as the reader's own clock shows it, to the second. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const FIELD: CSSProperties = {
  width: "100%",
  minHeight: "44px",
  minWidth: 0,
  padding: "0 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--surface)",
  color: "var(--fg)",
  fontFamily: MONO,
  fontSize: "0.8rem",
};
