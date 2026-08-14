import { useState } from "react";
import { MONO } from "../../theme.js";
import { ActivitySparkline, CommandBar, Page } from "./Chrome.js";
import { Rail, storylineMeta } from "./Rail.js";
import { spanLabel, spanQualifier, suggestStorylines } from "./mock-data.js";
import type { VariantProps } from "./variant-props.js";

/**
 * PROTOTYPE (S8) — VARIANT C: command-bar typeahead.
 *
 * The results page is left exactly as the baseline draws it. Storylines are
 * offered while the reader is still TYPING, in a dropdown under the command
 * bar: named stories first, then "search for <words>" as the fallback row.
 *
 * The claim: a reader who types "iran" wants the story, not a token match, and
 * the cheapest place to give it to them is before the search runs — nothing is
 * displaced, nothing is injected, and the results page keeps one job.
 *
 * The cost it has to be judged on: it is invisible to anyone arriving by shared
 * link or by clicking a term on the landing page (they never type), and it
 * disappears the moment the search executes — surfacing that only exists during
 * keystrokes cannot be revisited.
 */
export function VariantC({
  query,
  slots,
  viewing,
  onQueryChange,
  onOpenStoryline,
  onDismissView,
}: VariantProps) {
  // Typing state, held apart from the executed query — the dropdown belongs to
  // the keystrokes, not to the results below.
  const [typing, setTyping] = useState<string | null>(null);
  const partial = typing ?? "";
  const suggestions = typing === null ? [] : suggestStorylines(partial);
  const collides = new Set(
    suggestions
      .map((s) => s.label)
      .filter((label, i, all) => label !== null && all.indexOf(label) !== i),
  );

  const dropdown =
    typing === null || partial.trim() === "" ? undefined : (
      <div
        style={{
          position: "absolute",
          top: "100%",
          left: "1rem",
          right: "1rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          boxShadow: "var(--shadow)",
          overflow: "hidden",
          zIndex: 20,
        }}
      >
        {suggestions.length > 0 && (
          <div
            style={{
              padding: "0.4rem 0.75rem 0.2rem",
              fontFamily: MONO,
              fontSize: "0.65rem",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--fg-faint)",
            }}
          >
            storylines
          </div>
        )}
        {suggestions.map((storyline) => (
          <button
            key={storyline.id}
            onMouseDown={(event) => {
              // mousedown, not click: blur would close the dropdown first.
              event.preventDefault();
              setTyping(null);
              onOpenStoryline(storyline.id);
            }}
            style={{
              display: "flex",
              width: "100%",
              alignItems: "center",
              gap: "0.6rem",
              border: "none",
              background: "none",
              textAlign: "left",
              padding: "0.45rem 0.75rem",
              cursor: "pointer",
            }}
          >
            <ActivitySparkline storyline={storyline} />
            <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
              {storyline.label}
              {collides.has(storyline.label) && (
                <span style={{ color: "var(--fg-faint)", fontWeight: 400 }}>
                  {" "}
                  · {spanQualifier(storyline.span)}
                </span>
              )}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontFamily: MONO,
                fontSize: "0.68rem",
                color: "var(--fg-faint)",
                whiteSpace: "nowrap",
              }}
            >
              {spanLabel(storyline.span)} · {storylineMeta(storyline)}
            </span>
          </button>
        ))}
        <button
          onMouseDown={(event) => {
            event.preventDefault();
            onQueryChange(partial);
            setTyping(null);
          }}
          style={{
            display: "block",
            width: "100%",
            border: "none",
            borderTop: suggestions.length > 0 ? "1px solid var(--border)" : "none",
            background: "none",
            textAlign: "left",
            padding: "0.5rem 0.75rem",
            cursor: "pointer",
            fontFamily: MONO,
            fontSize: "0.8rem",
            color: "var(--fg-muted)",
          }}
        >
          search for “{partial}”
        </button>
      </div>
    );

  return (
    <>
      <CommandBar
        query={typing ?? query}
        viewing={viewing}
        onQueryChange={(next) => {
          setTyping(next);
          onQueryChange(next);
        }}
        onDismissView={onDismissView}
        dropdown={dropdown}
      />
      <Page>
        <Rail
          items={slots.map((slot) => ({ kind: "slot" as const, slot }))}
          onOpenStoryline={onOpenStoryline}
        />
      </Page>
    </>
  );
}
