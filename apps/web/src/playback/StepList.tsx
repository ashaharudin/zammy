import { memo } from "react";
import { MONO } from "../theme.js";

/**
 * The playback as text (ADR-0029, "The canvas is decoration; the words are the page"): one
 * button per step, in order, each saying what the step is in the page's own words
 * (`describeStep`) — the equivalent of the canvas, which is `aria-hidden`, and the index the
 * static overview's numbered badges point into.
 *
 * An `<ol>` of real buttons, so a reader can walk the trace with Tab or a screen reader's list
 * navigation and jump the stage to any step by activating it (`onSeek`). The current step
 * carries `aria-current="step"` and a marked face; the list does not scroll itself to follow
 * the playback, because a page that moves under a reader who is reading it is worse than a
 * current step off-screen.
 *
 * Shown by default. "Hide steps" makes it `.sr-only` rather than removing it, so assistive
 * technology keeps it and a keyboard user tabbing into it brings it back into view
 * (`.sr-only:focus-within`, index.css).
 *
 * Memoized on its props: while playing, the page re-renders when the current step changes,
 * and the descriptions (one string per step) are built once per timeline by the caller.
 */
export const StepList = memo(function StepList({
  descriptions,
  current,
  hidden,
  onSeek,
}: {
  descriptions: readonly string[];
  current: number;
  hidden: boolean;
  onSeek: (stepIndex: number) => void;
}) {
  return (
    <ol
      aria-label="Steps"
      className={hidden ? "sr-only" : undefined}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: "1px",
        fontFamily: MONO,
        fontSize: "0.78rem",
      }}
    >
      {descriptions.map((text, i) => {
        const isCurrent = i === current;
        return (
          <li key={i}>
            <button
              type="button"
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => onSeek(i)}
              style={{
                display: "block",
                width: "100%",
                minHeight: "44px",
                padding: "0.45rem 0.6rem",
                textAlign: "left",
                border: "none",
                borderLeft: `3px solid ${isCurrent ? "var(--fg)" : "transparent"}`,
                background: isCurrent ? "var(--chip-bg)" : "transparent",
                color: isCurrent ? "var(--fg)" : "var(--fg-muted)",
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: "inherit",
                lineHeight: 1.4,
                overflowWrap: "anywhere",
              }}
            >
              {text}
            </button>
          </li>
        );
      })}
    </ol>
  );
});
