import { useState } from "react";
import { MONO } from "../../theme.js";
import { CommandBar, Page } from "./Chrome.js";
import { Rail } from "./Rail.js";
import { coverageBucket, spanQualifier } from "./mock-data.js";
import type { MockStoryline } from "./mock-data.js";
import type { VariantProps } from "./variant-props.js";

/**
 * PROTOTYPE (S8) — VARIANT E: pills in the command bar, under the date.
 *
 * D's pills, moved out of the floating layer and into the chrome that already
 * exists: their own row inside the sticky command bar, below the asOf stamp.
 * They stick with the bar, so they are reachable at any scroll depth like D's
 * strip, but they cover nothing — the bar was already occupying that space.
 *
 * Size is a GLYPH, not a number: ▁ 1–10, ▃ 11–50, ▅ 51–100, █ 101+. A count in
 * a pill is four characters of precision nobody acts on, and it is the first
 * thing to overflow on a phone; the ramp answers "how big is this one" and
 * compares two storylines at a glance without being read.
 *
 * The cost it has to be judged on: the command bar is sticky and every row
 * added to it is permanently subtracted from the timeline, on every screen,
 * including the searches that surface nothing (where the row collapses — but
 * the layout still has to not jump when it appears).
 */
export function VariantE({
  query,
  slots,
  surfaced,
  viewing,
  onQueryChange,
  onOpenStoryline,
  onDismissView,
}: VariantProps) {
  // Sticky chrome the reader can shrink. Held across searches on purpose: a
  // reader who has hidden the pills is saying "not what I am here for", and
  // re-offering them on the next query would be the same nag D's dismissal was.
  const [expanded, setExpanded] = useState(true);

  const collides = new Set(
    surfaced
      .map((s) => s.label)
      .filter((label, i, all) => label !== null && all.indexOf(label) !== i),
  );

  const pills =
    viewing || surfaced.length === 0 ? undefined : (
      <div
        role="group"
        aria-label="Storylines matching this search"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.3rem" }}
      >
        {surfaced.map((storyline) => (
          <StorylinePill
            key={storyline.id}
            storyline={storyline}
            qualifier={collides.has(storyline.label) ? spanQualifier(storyline.span) : null}
            onOpen={() => onOpenStoryline(storyline.id)}
          />
        ))}
      </div>
    );

  return (
    <>
      <CommandBar
        query={query}
        viewing={viewing}
        onQueryChange={onQueryChange}
        onDismissView={onDismissView}
        pills={pills}
        pillsExpanded={expanded}
        onTogglePills={() => setExpanded(!expanded)}
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

/**
 * Coverage size: four 4px squares in a 2×2 block, filled bottom row first, then
 * the top — a container filling up rather than a bar growing sideways.
 *
 * The unfilled squares stay drawn, faintly. That is the whole trick: they are
 * the maximum, so one pill on its own still says "one of four" instead of
 * needing a neighbour to be compared against.
 */
function CoverageGlyph({ filled }: { filled: number }) {
  // Fill order within the 2×2 grid, which lays out top-left, top-right,
  // bottom-left, bottom-right.
  const order = [2, 3, 0, 1];
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
      {[0, 1, 2, 3].map((cell) => (
        <span
          key={cell}
          style={{
            width: "4px",
            height: "4px",
            background: "var(--fg-muted)",
            opacity: order.indexOf(cell) < filled ? 1 : 0.2,
          }}
        />
      ))}
    </span>
  );
}

function StorylinePill({
  storyline,
  qualifier,
  onOpen,
}: {
  storyline: MockStoryline;
  qualifier: string | null;
  onOpen: () => void;
}) {
  const bucket = coverageBucket(storyline.articleCount);
  return (
    <button
      onClick={onOpen}
      // The glyph is a picture of a quantity; the quantity itself goes here,
      // where it costs no width.
      aria-label={`Open storyline ${storyline.label}${qualifier ? `, ${qualifier}` : ""} — ${
        bucket.label
      }${storyline.status === "dormant" ? ", dormant" : ""}`}
      title={bucket.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        background: "var(--chip-bg)",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        padding: "0.12rem 0.6rem",
        cursor: "pointer",
        whiteSpace: "nowrap",
        // Dormant storylines are offered more quietly than live ones.
        opacity: storyline.status === "dormant" ? 0.7 : 1,
      }}
    >
      <CoverageGlyph filled={bucket.filled} />
      <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{storyline.label}</span>
      {qualifier && (
        <span style={{ fontFamily: MONO, fontSize: "0.65rem", color: "var(--fg-faint)" }}>
          · {qualifier}
        </span>
      )}
    </button>
  );
}
