import { useId, type CSSProperties } from "react";
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
 * "Refresh" re-reads the list at once; the page also re-reads it on its own every
 * `RECENT_POLL_MS`. When the list cannot be read, the reason takes the dropdown's place.
 */
export function TracePicker({
  current,
  traces,
  loading,
  failure,
  refreshing,
  onPick,
  onRefresh,
}: {
  /** The id on screen, or null when nothing is. */
  current: string | null;
  traces: readonly TraceSummary[] | undefined;
  loading: boolean;
  /** Why the list could not be read, or null. */
  failure: string | null;
  refreshing: boolean;
  onPick: (id: string) => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const listed = traces ?? [];
  const unlisted = current !== null && !listed.some((t) => t.id === current);

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
          value={current ?? ""}
          disabled={listed.length === 0 && !unlisted}
          onChange={(event) => {
            if (event.target.value !== "") onPick(event.target.value);
          }}
          style={FIELD}
        >
          {current === null && (
            <option value="" disabled>
              {loading
                ? "Reading the list…"
                : listed.length === 0
                  ? "No recorded traces"
                  : "Choose a trace"}
            </option>
          )}
          {unlisted && <option value={current}>This trace (not among the newest)</option>}
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
          if (!refreshing) onRefresh();
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
        <p role="status" style={{ ...NOTICE_TEXT, flexBasis: "100%" }}>
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
