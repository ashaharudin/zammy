import { useEffect, useState } from "react";
import type { SurfacedStoryline } from "@zammy/shared";
import { MONO } from "./theme.js";
import { pillDetail, sizeBucket, SIZE_STEPS } from "./storylineLabels.js";

/**
 * Storylines a search surfaced, as pills in the command bar — S8's variant E,
 * the round's winner.
 *
 * ADR-0011 makes search and storylines separate axes: a search is never limited
 * to a storyline, it SURFACES matching ones. A treatment in the chrome is that
 * separation drawn in layout — a strip inside the results reads as part of the
 * result set, which is the thing this is not. The bar is already sticky, so the
 * pills are reachable at any scroll depth without occluding a single row of
 * timeline.
 */

/** The reader's answer to "not what I am here for", kept across searches. */
const COLLAPSED_KEY = "zammy:storyline-pills-collapsed";

export function StorylinePills({
  storylines,
  qualifiers,
  onOpen,
}: {
  storylines: readonly SurfacedStoryline[];
  qualifiers: Map<string, string>;
  onOpen: (storylineId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1",
  );

  useEffect(() => {
    // Persisted, because re-opening the row on the reader's next query would be
    // exactly the nag the dismissible variants were refused for.
    globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  if (storylines.length === 0) return null;

  return (
    <>
      {!collapsed && (
        <div
          style={{
            maxWidth: "var(--page-max)",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.35rem",
            padding: "0 1rem 0.45rem",
          }}
        >
          {storylines.map((storyline) => (
            <StorylinePill
              key={storyline.id}
              storyline={storyline}
              qualifier={qualifiers.get(storyline.id) ?? null}
              onOpen={() => onOpen(storyline.id)}
            />
          ))}
        </div>
      )}
      <Handle collapsed={collapsed} count={storylines.length} onToggle={() => setCollapsed(!collapsed)} />
    </>
  );
}

/**
 * The bar's own bottom edge, doing double duty as the row's control.
 *
 * It costs no row of its own and it stays put in both states, which is what
 * makes a closed row findable again. The caret is bare and the tint is what
 * says "press me" — mixed toward black rather than reaching for `--chip-bg`,
 * which is LIGHTER than the surface in the dark theme and would make the handle
 * brighter than the chrome it belongs to.
 */
function Handle({
  collapsed,
  count,
  onToggle,
}: {
  collapsed: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={
        collapsed
          ? `Show ${count} storyline${count === 1 ? "" : "s"} matching this search`
          : "Hide matching storylines"
      }
      style={{
        display: "block",
        width: "100%",
        border: "none",
        background: "color-mix(in srgb, var(--surface) 92%, black)",
        color: "var(--fg-faint)",
        cursor: "pointer",
        fontSize: "0.55rem",
        lineHeight: 1,
        padding: "0.15rem 0",
        textAlign: "center",
      }}
    >
      {collapsed ? "▾" : "▴"}
    </button>
  );
}

function StorylinePill({
  storyline,
  qualifier,
  onOpen,
}: {
  storyline: SurfacedStoryline;
  qualifier: string | null;
  onOpen: () => void;
}) {
  const label = storyline.label ?? "unlabelled storyline";
  const detail = pillDetail(storyline);
  return (
    <button
      onClick={onOpen}
      // The exact count and the dormancy live here, where they cost no width:
      // the glyph answers "how big", the muting answers "still running", and
      // anyone who needs the words can still reach them.
      title={`${label}${qualifier ? ` · ${qualifier}` : ""} — ${detail}`}
      aria-label={`Open the storyline ${label}${qualifier ? `, ${qualifier}` : ""}, ${detail}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        // A dormant match is offered at lower contrast: it answers "why is a
        // five-month-old story here" before the reader has to ask, without
        // taking a row of its own to say it (S8's verdict).
        background: storyline.dormant ? "transparent" : "var(--chip-bg)",
        color: storyline.dormant ? "var(--fg-faint)" : "var(--fg)",
        cursor: "pointer",
        fontFamily: MONO,
        fontSize: "0.7rem",
        padding: "0.15rem 0.55rem 0.15rem 0.4rem",
        maxWidth: "100%",
      }}
    >
      <SizeGlyph size={storyline.size} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
        {qualifier && <span style={{ opacity: 0.6 }}> · {qualifier}</span>}
      </span>
    </button>
  );
}

/**
 * Size as a 2×2 block of squares filling bottom-row-first: a container filling
 * rather than a bar growing.
 *
 * The UNFILLED squares stay drawn at low opacity, and that is the load-bearing
 * part — they are the visible maximum, so one pill on its own reads as "one of
 * four" instead of needing a neighbour to be compared against.
 *
 * Divs rather than the block-element ramp (▂▄▆█) S8 started from: ▁ renders as
 * an underscore at this size and reads as a typo, the ramp needs a faint █
 * painted behind it to have a maximum at all, the glyphs sit on the text
 * baseline rather than the pill's optical centre, and the shape is at the mercy
 * of whichever mono font the reader has.
 */
function SizeGlyph({ size }: { size: number }) {
  const filled = sizeBucket(size);
  return (
    <span
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: "4px 4px",
        gridTemplateRows: "4px 4px",
        gap: "1px",
        flexShrink: 0,
      }}
    >
      {FILL_ORDER.map((cell, index) => (
        <span
          key={`${cell.row}-${cell.column}`}
          style={{
            gridRow: cell.row,
            gridColumn: cell.column,
            background: "currentColor",
            opacity: index < filled ? 0.85 : 0.18,
            borderRadius: "1px",
          }}
        />
      ))}
    </span>
  );
}

/** Bottom row first, left to right — a container filling, not a bar growing. */
const FILL_ORDER = [
  { row: 2, column: 1 },
  { row: 2, column: 2 },
  { row: 1, column: 1 },
  { row: 1, column: 2 },
] as const;

// Referenced so the shared step count and the grid above cannot drift apart.
if (FILL_ORDER.length !== SIZE_STEPS) {
  throw new Error(`size glyph draws ${FILL_ORDER.length} cells for ${SIZE_STEPS} steps`);
}
