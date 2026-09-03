import { useEffect, useRef, useState } from "react";
import type { StorylineSummary } from "@zammy/shared";
import type { RowMembership } from "./memberships.js";
import { pillDetail, storylineSpan } from "./storylineLabels.js";
import { MONO } from "./theme.js";

/**
 * The dense braid's own metrics: one tick's width, and the padding its button
 * puts to the left of that tick.
 *
 * `braidOnRule` below is the only thing that should have to know them.
 * Hand-tuning that offset instead is how the rail's glyphs came to sit 0.9px
 * off the spine (`markerLeft`), and how this one first sat 1.5px off the
 * disclosure's hairline.
 */
const DENSE_TICK_WIDTH = "9px";
const DENSE_PADDING = "0.15rem";
const TICK_WIDTH = "11px";
const RAIL_PADDING = "0.2rem 0.3rem";

/**
 * Pointer target, grown WITHOUT moving anything.
 *
 * The glyph is eleven pixels of furniture; the thing a finger has to hit is
 * not. `TimelinePage`'s day dot already holds this line — it wears a 1.5rem box
 * "giving the pointer a 24px target instead of the glyph's ~22×16" — and the
 * braid shipped smaller than the glyph that comment calls too small (measured
 * 20.6×12.4 on the rail, 13.8×10.8 on the hairline, unchanged at 375px).
 *
 * Padding grows the button and an equal negative margin takes it back out of
 * layout, so the hit area reaches 24px in both directions while the marker box,
 * the `--bg` mask it punches in the spine, and every offset `braidOnRule`
 * computes stay exactly where they were. Growing the padding alone would widen
 * the hole in the rail and push the ticks off the hairline.
 */
const HIT_GROW = { rail: "6px 2px", dense: "7px 6px" } as const;

/**
 * The button's padding, grown by `HIT_GROW`, and the margin that takes the
 * growth back out of layout.
 *
 * ADDED to the base padding rather than replacing it, which is the whole
 * arithmetic: the parent lays out the MARGIN box, whose width is
 * `-grow + (glyph + 2·(base + grow)) - grow` = `glyph + 2·base`, unchanged; and
 * the ticks sit at `marginLeft + base`, also unchanged, which is what keeps
 * `braidOnRule`'s subtraction of `base` correct. Replacing the base instead
 * moved the ticks and made the target smaller in one dimension while growing it
 * in the other — measured 15×18 on the rail against the 20.6×12.4 it started
 * from, which is how that mistake was caught.
 */
function hitArea(base: string, grow: string): { padding: string; margin: string } {
  const [v, h] = grow.split(" ") as [string, string];
  const [bv, bh] = base.includes(" ") ? (base.split(" ") as [string, string]) : [base, base];
  return {
    padding: `calc(${bv} + ${v}) calc(${bh} + ${h})`,
    margin: `-${v} -${h}`,
  };
}

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
  const trigger = useRef<HTMLButtonElement>(null);

  /**
   * Close, and put the keyboard back where it was.
   *
   * `restoreFocus` is the difference between the two ways out. Escape is a
   * cancel — the reader is still on this row and their place in a rail that can
   * run to seventy cards must survive it, where unmounting the popover under a
   * focused list item strands focus on `<body>` and the next Tab restarts at the
   * top of the document. A press outside, or focus deliberately moving away, is
   * not a cancel: pulling focus back there would take it off whatever the reader
   * just chose.
   */
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    // THREE WAYS OUT, because outside-press alone covered exactly one of them.
    // Enter and Space on a button produce a bare `click` with no `mousedown`,
    // so tabbing down the rail opening braids left every one of them open at
    // once — on a page carrying 166 of these. `click` is what makes "only one
    // is open" true for the keyboard as well; it cannot close the popover its
    // own opening press just opened, because that press's target is the trigger
    // and the trigger is inside this container. `focusin` adds the case where
    // focus leaves without activating anything, i.e. tabbing past.
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("click", onPointerDown);
    window.addEventListener("focusin", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("click", onPointerDown);
      window.removeEventListener("focusin", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (membership.ticks.length === 0) return null;

  const count = membership.others.length;
  return (
    <span ref={container} style={{ position: "relative", lineHeight: 0 }}>
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-expanded={open}
        // `aria-expanded` and nothing else. Not `aria-haspopup`, because what
        // opens is a short list of destinations rather than a menu or a listbox
        // and claiming a role the markup does not carry describes it worse than
        // the plain disclosure it is. And not `aria-controls`, which was here
        // and came out: the list it would point at only exists while the popover
        // is open, so on a page carrying 166 of these it was a dangling IDREF on
        // every closed one. The list carries the same words as its own
        // accessible name, so nothing was lost with it.
        aria-label={`${subject} is also in ${count} other storyline${
          count === 1 ? "" : "s"
        }. Name them.`}
        style={{
          display: "inline-grid",
          gap: "2px",
          border: "none",
          background: "none",
          ...(dense
            ? hitArea(DENSE_PADDING, HIT_GROW.dense)
            : hitArea(RAIL_PADDING, HIT_GROW.rail)),
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
            // re-open itself on something the reader never pressed. No focus
            // restore — the rail this trigger belongs to is being replaced.
            close(false);
            onOpenStoryline(id);
          }}
        />
      )}
    </span>
  );
}

/**
 * What the ticks open, wherever they are: a line counting exactly what is under
 * it, and the crossings, each opening its storyline on one press.
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
  const heading = `also in ${others.length} storyline${others.length === 1 ? "" : "s"}`;
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
      {/*
        A paragraph, NOT a heading, and that is the one thing about it that had
        to be decided rather than styled. `RelatedSection` takes a `level` prop
        because its depth varies; this hangs off a rail marker and has no fixed
        depth at all, so a hardcoded `h3` landed in the outline as a sibling of
        the day's segment — a screen reader navigating by heading heard "also in
        1 storyline" as a peer of "Evening, Aug 24" rather than as something
        inside the row. The list below carries the same words as its accessible
        name, so nothing is lost by leaving the outline alone.
      */}
      <p
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
        {heading}
      </p>
      <ul
        aria-label={heading}
        style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.15rem" }}
      >
        {others.map((arc) => {
          const qualifier = qualifiers.get(arc.id);
          // The span, then the size and dormancy — "when did this run" before
          // "how big is it". This is the one surface where a reader chooses
          // between arcs that have NO slot on the page to look at, so the dates
          // are the part that cannot be read off the timeline instead. The
          // qualifier is a different fact and appears only on a collision.
          const detail = `${storylineSpan(arc.from, arc.to)} · ${pillDetail(arc)}`;
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
