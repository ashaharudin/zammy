import { MONO } from "../../theme.js";
import type { MockStoryline } from "./mock-data.js";
import { spanLabel } from "./mock-data.js";

/**
 * PROTOTYPE (S8) — chrome shared by all three variants: the command bar, the
 * storyline-view chip, and the page frame. What differs between variants sits
 * BELOW or INSIDE these, never in place of them.
 */

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: "var(--page-max)", margin: "0 auto", padding: "1.5rem 1rem 5rem" }}>
      {children}
    </main>
  );
}

export function CommandBar({
  query,
  viewing,
  onQueryChange,
  onDismissView,
  dropdown,
}: {
  query: string;
  /** The storyline being viewed: label as a dismissible chip, box empty. */
  viewing: MockStoryline | null;
  onQueryChange: (q: string) => void;
  onDismissView: () => void;
  /** Variant C's typeahead. Rendered under the input, inside the sticky bar. */
  dropdown?: React.ReactNode;
}) {
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
      <div
        style={{
          maxWidth: "var(--page-max)",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.75rem 1rem 0.35rem",
          position: "relative",
        }}
      >
        <span style={{ fontFamily: MONO, fontWeight: 700 }}>zammy&gt;</span>
        {viewing && (
          <button
            onClick={onDismissView}
            aria-label={`Leave storyline ${viewing.label}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              background: "var(--chip-bg)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              padding: "0.15rem 0.6rem",
              fontFamily: MONO,
              fontSize: "0.8rem",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {viewing.label} ×
          </button>
        )}
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={viewing ? "search to leave this storyline" : "keywords (all terms must match)"}
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
        {dropdown}
      </div>
      <div
        style={{
          maxWidth: "var(--page-max)",
          margin: "0 auto",
          padding: "0 1rem 0.5rem",
          fontFamily: MONO,
          fontSize: "0.75rem",
          color: "var(--fg-faint)",
        }}
      >
        {viewing
          ? `storyline · ${spanLabel(viewing.span)} · ${viewing.articleCount} articles`
          : "Thursday, Aug 13 06:00 UTC"}
      </div>
    </header>
  );
}

/** The strip's and the typeahead's shared idea of what a storyline looks like. */
export function ActivitySparkline({ storyline }: { storyline: MockStoryline }) {
  const bars = [...storyline.activity].reverse();
  const peak = Math.max(...bars.map((b) => b.articles), 1);
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-flex", alignItems: "flex-end", gap: "2px", height: "0.9rem" }}
    >
      {bars.map((bar) => (
        <span
          key={bar.day}
          style={{
            width: "4px",
            height: `${Math.max(0.2, bar.articles / peak) * 0.9}rem`,
            background: "var(--rail)",
            borderRadius: "1px",
          }}
        />
      ))}
    </span>
  );
}
