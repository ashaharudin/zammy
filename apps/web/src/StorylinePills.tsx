import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StorylineSummary } from "@zammy/shared";
import { MONO } from "./theme.js";
import { pillDetail, sizeBucket, SIZE_STEPS } from "./storylineLabels.js";
import {
  EMPTY_PILL_ROW,
  exitedPills,
  PILL_EXIT_MS,
  PILL_MOVE_MS,
  pillMoveKeyframes,
  receivePills,
  type PillRow,
} from "./storylinePillMotion.js";

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
 *
 * Biggest storyline first, and the row changes by moving rather than by being
 * replaced: `storylinePillMotion` owns both — which pill is drawn where, and
 * which of them is arriving, resting or leaving. What is here is the one thing
 * that cannot be pure: measuring where the pills actually landed, so a pill
 * that changed place slides there from where it was.
 */

/** The reader's answer to "not what I am here for", kept across searches. */
const COLLAPSED_KEY = "zammy:storyline-pills-collapsed";

export function StorylinePills({
  storylines,
  qualifiers,
  onOpen,
}: {
  storylines: readonly StorylineSummary[];
  qualifiers: Map<string, string>;
  onOpen: (storylineId: string, label: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1",
  );

  useEffect(() => {
    // Persisted, because re-opening the row on the reader's next query would be
    // exactly the nag the dismissible variants were refused for.
    globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const row = usePillRow(storylines);
  const rowRef = usePillFlip();

  // Nothing matched and nothing is still fading out of the last search that
  // did: no row, and no handle to open an empty one with.
  if (storylines.length === 0 && (collapsed || row.slots.length === 0)) return null;

  return (
    <>
      {!collapsed && row.slots.length > 0 && (
        <div
          ref={rowRef}
          style={{
            maxWidth: "var(--page-max)",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.35rem",
            padding: "0 1rem 0.45rem",
            // One source of truth for how long a leaving pill fades: the timer
            // that unmounts it is the same constant (see `usePillRow`).
            ["--pill-exit-ms" as string]: `${PILL_EXIT_MS}ms`,
          }}
        >
          {row.slots.map((slot) => (
            <StorylinePill
              key={slot.storyline.id}
              storyline={slot.storyline}
              qualifier={qualifiers.get(slot.storyline.id) ?? null}
              leaving={slot.leaving}
              entering={slot.entering}
              onOpen={() => onOpen(slot.storyline.id, slot.storyline.label)}
            />
          ))}
        </div>
      )}
      <Handle collapsed={collapsed} count={storylines.length} onToggle={() => setCollapsed(!collapsed)} />
    </>
  );
}

/**
 * The row the response asks for, with the pills the last one left behind still
 * fading out of it.
 *
 * Derived during render rather than in an effect, and deliberately: the bar
 * re-renders on every progressive-fill page, and an effect keyed on the
 * storylines array — a fresh `[]` on any page that has none — would feed
 * itself. `receivePills` returns the SAME row when nothing changed, which is
 * what makes the render-phase update terminate.
 */
function usePillRow(storylines: readonly StorylineSummary[]): PillRow {
  const [row, setRow] = useState<PillRow>(EMPTY_PILL_ROW);
  const received = useRef<readonly StorylineSummary[] | null>(null);

  if (received.current !== storylines) {
    received.current = storylines;
    const next = receivePills(row, storylines);
    if (next !== row) setRow(next);
  }

  const exiting = row.pending !== null;
  useEffect(() => {
    if (!exiting) return;
    // The leavers hold their slots for exactly as long as they fade; then the
    // row takes the shape the response asked for, and the survivors slide.
    const timer = setTimeout(() => setRow((current) => exitedPills(current)), PILL_EXIT_MS);
    return () => clearTimeout(timer);
  }, [exiting]);

  return row;
}

/**
 * FLIP: a pill that changed place starts the frame where it used to be and
 * travels to where it now is.
 *
 * Positions are read relative to the ROW, not the viewport — the bar is sticky
 * and the reader may have scrolled between two commits, and a viewport
 * measurement would read that scroll as movement and animate every pill.
 *
 * The move is a Web Animations call rather than a CSS class, because the path
 * is only known at the moment it is measured — `pillMoveKeyframes` bows it in
 * the direction the pill is travelling; `index.css` keeps the fades, which have
 * nothing to measure. Reduced motion is checked here for the same reason — an
 * animation built in script is not covered by the media query the stylesheet
 * honours.
 */
function usePillFlip() {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const places = useRef(new Map<string, { x: number; y: number }>());

  // No dependency array, deliberately: what makes a remembered position wrong
  // is any commit that relaid the row out — a new set of pills, but also a
  // qualifier appearing on one of them and pushing its neighbours along. Nine
  // rects inside one container, after the layout the browser has already done,
  // is not a cost worth a stale-position bug.
  useLayoutEffect(() => {
    measurePills(rowRef.current, places.current, { animate: true });
  });

  useEffect(() => {
    // A resize relays the row out — it wraps at a different pill — without
    // rendering anything, so nothing above runs and every remembered position
    // is now wrong. Re-measured without animating: the pills did not move, the
    // window did, and the next real move must start from where they actually
    // are rather than sliding in from the old width.
    const onResize = () => measurePills(rowRef.current, places.current, { animate: false });
    globalThis.addEventListener?.("resize", onResize);
    return () => globalThis.removeEventListener?.("resize", onResize);
  }, []);

  return rowRef;
}

function measurePills(
  container: HTMLDivElement | null,
  places: Map<string, { x: number; y: number }>,
  options: { animate: boolean },
): void {
  if (!container) {
    // Collapsed, or nothing matched: the places remembered here are about to be
    // wrong, and a row that opens again should not slide in from them.
    places.clear();
    return;
  }
  const origin = container.getBoundingClientRect();
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const drawn = new Set<string>();

  for (const pill of container.querySelectorAll<HTMLElement>("[data-storyline-id]")) {
    const id = pill.dataset.storylineId;
    if (!id) continue;
    drawn.add(id);
    const box = pill.getBoundingClientRect();
    const next = { x: box.left - origin.left, y: box.top - origin.top };
    const previous = places.get(id);
    places.set(id, next);
    if (!previous || !options.animate || reduced || typeof pill.animate !== "function") continue;
    const dx = previous.x - next.x;
    const dy = previous.y - next.y;
    // Sub-pixel drift is layout noise, not a move.
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    // Bubbles rather than slides: `pillMoveKeyframes` bows the path out of the
    // row in the direction the pill is going, so two pills trading places pass
    // around each other instead of through each other.
    pill.animate(pillMoveKeyframes(dx, dy), { duration: PILL_MOVE_MS, easing: "ease-in-out" });
  }

  for (const id of [...places.keys()]) {
    if (!drawn.has(id)) places.delete(id);
  }
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
  leaving,
  entering,
  onOpen,
}: {
  storyline: StorylineSummary;
  qualifier: string | null;
  /** On its way out: fading, still holding its slot, no longer a thing to press. */
  leaving: boolean;
  /** On its way in: this search surfaced it and the last one did not. */
  entering: boolean;
  onOpen: () => void;
}) {
  const label = storyline.label ?? "unlabelled storyline";
  const detail = pillDetail(storyline);
  return (
    <button
      onClick={onOpen}
      // The row's FLIP finds its pills by this, rather than through a ref per
      // pill: a ref callback is re-attached on every render, and the positions
      // remembered across renders are the one thing that must survive them.
      data-storyline-id={storyline.id}
      className={leaving ? "storyline-pill-exit" : entering ? "storyline-pill-enter" : undefined}
      // A pill fading out is a pill the reader can still see and must not be
      // able to reach: `inert` takes it out of the tab order, out of the
      // accessibility tree, and out of range of a click aimed at whatever is
      // about to take its place.
      inert={leaving}
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
