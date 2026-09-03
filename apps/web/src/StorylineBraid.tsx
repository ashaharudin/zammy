import { useEffect, useRef, useState } from "react";
import type { StorylineSummary } from "@zammy/shared";
import type { RowMembership } from "./memberships.js";
import { pillDetail } from "./storylineLabels.js";
import { MONO } from "./theme.js";

/**
 * The SPINE BRAID (S9's verdict, ADR-0025): where else the piece on this row is
 * running, said on the rail itself.
 *
 * A row in one arc keeps the marker the rail has always drawn. A row in three
 * draws three ticks — the arc named in the gutter beside it solid, the
 * crossings hollow — so before anything is pressed the timeline already shows
 * where the crossings are and how many. Pressing names them; pressing a name
 * opens that storyline.
 *
 * Chosen over the four alternatives on cost at rest: most rows cross nothing,
 * and on those this is the rail unchanged, where a gutter stack spends gutter
 * width and an under-card fold spends column height on every crossing row. It
 * was also the only answer that reached inside a slot's disclosure without a
 * second idiom — that section already has a hairline down its left, so the same
 * glyph hangs on it, and five of S9's twelve fixture crossings live only there.
 *
 * NOTHING HERE RANKS. The solid tick says which arc you are standing in, not
 * which arc is the real one — "'primary storyline' is a concept with no
 * principled definition" (`packages/storage/src/storylines.ts`). The list names
 * only the crossings, under a header counting exactly them, because the gutter
 * label two inches to the left already names the remaining arc and already
 * opens it; repeating it inside its own popover would be the list disagreeing
 * with the row it hangs off.
 *
 * What it does NOT do, recorded so it is not rediscovered as a bug: it does not
 * tell a reader that two rows on one screen are one piece. S9 had a version
 * that dimmed every row outside a selected arc, which made the duplication
 * ADR-0011 accepts explain itself; it was cut deliberately.
 */
/**
 * The dense braid's own metrics: one tick's width, and the padding its button
 * puts to the left of that tick.
 *
 * Exported because a caller hanging the braid on a rule cannot centre it
 * without them, and `braidOnRule` below is the only thing that should have to
 * know them. Hand-tuning that offset instead is how the rail's glyphs came to
 * sit 0.9px off the spine (`markerLeft`), and how this one first sat 1.5px off
 * the disclosure's hairline.
 */
const DENSE_TICK_WIDTH = "9px";
const DENSE_PADDING = "0.15rem";
const TICK_WIDTH = "11px";

/**
 * How far LEFT of a row's content box a dense braid must sit for its ticks to
 * land centred on a 1px rule running `inset` to that row's left.
 *
 * The disclosure's hairline is a border, so its centre is half a pixel further
 * out than the padding that clears it — which is the half of this that is easy
 * to drop and impossible to see dropping.
 */
export function braidOnRule(inset: string): string {
  return `calc(-1 * ${inset} - 0.5px - ${DENSE_TICK_WIDTH} / 2 - ${DENSE_PADDING})`;
}

export function StorylineBraid({
  membership,
  subject,
  onOpenStoryline,
  dense,
}: {
  membership: RowMembership;
  /**
   * What the ticks are ABOUT, for the screen reader: "This article", or one
   * row's own title. The glyph is identical on both spines and the subject is
   * the only thing that differs, so it is the only thing passed in.
   */
  subject: string;
  onOpenStoryline: (storylineId: string) => void;
  /** Tighter hit area for the disclosure's hairline, which has 0.9rem to give. */
  dense?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);

  // The same dismissal `FilterChipRow` uses, and deliberately the same: a
  // popover that closes on outside-press also gives one-open-at-a-time for
  // free, because pressing a second braid is an outside press on the first.
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

  if (membership.ticks.length === 0) return null;

  const count = membership.others.length;
  return (
    <span ref={container} style={{ position: "relative", lineHeight: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${subject} is also in ${count} other storyline${
          count === 1 ? "" : "s"
        }. Name them.`}
        style={{
          display: "inline-grid",
          gap: "2px",
          border: "none",
          background: "none",
          padding: dense ? DENSE_PADDING : "0.2rem 0.3rem",
          cursor: "pointer",
          lineHeight: 0,
        }}
      >
        {membership.ticks.map((tick) => (
          <span
            key={tick.id}
            style={{
              display: "block",
              width: dense ? DENSE_TICK_WIDTH : TICK_WIDTH,
              height: "2px",
              borderRadius: "1px",
              background: "var(--fg)",
              // The arc you are reading under is solid; the crossings are
              // hollow. Not a hierarchy — the row simply has to say which tick
              // is the one it is filed under here, or the glyph names three
              // arcs and points at none.
              opacity: tick.current ? 0.9 : 0.32,
            }}
          />
        ))}
      </button>
      {open && (
        <MembershipList
          others={membership.others}
          qualifiers={membership.qualifiers}
          left={dense ? "1.4rem" : "1.7rem"}
          onOpenStoryline={(id) => {
            // Closed on the way out: the next rail may hold a row under the
            // same key, and a popover that survived the navigation would
            // re-open itself on something the reader never pressed.
            setOpen(false);
            onOpenStoryline(id);
          }}
        />
      )}
    </span>
  );
}

/**
 * What the ticks open, wherever they are: a header counting exactly what is
 * under it, and the crossings, each opening its storyline on one press.
 *
 * One component for both spines. The rail's braid and the disclosure's differ
 * in what they are ABOUT — a slot's headline versus one row of coverage — and
 * in nothing else, so a second copy would only be a second place for the
 * wording and the elevation to drift.
 */
function MembershipList({
  others,
  qualifiers,
  left,
  onOpenStoryline,
}: {
  others: readonly StorylineSummary[];
  qualifiers: Map<string, string>;
  left: string;
  onOpenStoryline: (storylineId: string) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top: 0,
        zIndex: 20,
        minWidth: "13rem",
        textAlign: "left",
        // NOT --surface: this floats over cards that are already --surface, so
        // it would land as a shape with a hairline round it and no elevation at
        // all. Mixed toward the FOREGROUND instead, which lifts it in the dark
        // theme and sinks it in the light one without either direction needing
        // its own token.
        background: "color-mix(in srgb, var(--surface) 92%, var(--fg))",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        boxShadow: "var(--shadow)",
        padding: "0.4rem 0.3rem 0.3rem",
        lineHeight: "normal",
      }}
    >
      <h3
        style={{
          margin: "0 0 0.25rem",
          padding: "0 0.35rem",
          fontFamily: MONO,
          fontSize: "0.58rem",
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--fg-faint)",
        }}
      >
        also in {others.length} storyline{others.length === 1 ? "" : "s"}
      </h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.15rem" }}>
        {others.map((arc) => {
          const qualifier = qualifiers.get(arc.id);
          const detail = pillDetail(arc);
          return (
            <li key={arc.id}>
              <button
                type="button"
                // By UUID, never by the label's words: labels are non-unique,
                // so only the id identifies the story (ADR-0011).
                onClick={() => onOpenStoryline(arc.id)}
                aria-label={`Open storyline ${arc.label}${
                  qualifier ? `, ${qualifier}` : ""
                }, ${detail}`}
                style={{
                  display: "block",
                  width: "100%",
                  border: "none",
                  borderRadius: "4px",
                  background: "none",
                  color: "var(--fg)",
                  cursor: "pointer",
                  fontFamily: MONO,
                  fontSize: "0.7rem",
                  lineHeight: 1.3,
                  padding: "0.25rem 0.35rem",
                  textAlign: "left",
                  // A dormant arc is offered at lower contrast: it answers "why
                  // is a five-month-old story here" before the reader has to
                  // ask, without taking a line to say it. The words are in
                  // `detail` below for anyone the contrast does not reach.
                  opacity: arc.dormant ? 0.6 : 1,
                }}
              >
                {arc.label}
                {qualifier && <span style={{ opacity: 0.7 }}> · {qualifier}</span>}
                <span style={{ display: "block", fontSize: "0.6rem", color: "var(--fg-faint)" }}>
                  {detail}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
