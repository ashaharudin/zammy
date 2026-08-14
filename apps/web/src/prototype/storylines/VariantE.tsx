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
      {/* The bar is drawn against a faint full-height track. Without it the
          ramp only reads comparatively — two pills side by side say which is
          bigger, a lone pill says nothing, because a low bar and a tall one are
          only distinguishable against a known maximum. */}
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          display: "inline-block",
          width: "0.6rem",
          fontFamily: MONO,
          fontSize: "0.8rem",
          lineHeight: 1,
          color: "var(--fg-muted)",
        }}
      >
        <span style={{ position: "absolute", inset: 0, opacity: 0.18 }}>█</span>
        <span style={{ position: "relative" }}>{bucket.glyph}</span>
      </span>
      <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{storyline.label}</span>
      {qualifier && (
        <span style={{ fontFamily: MONO, fontSize: "0.65rem", color: "var(--fg-faint)" }}>
          · {qualifier}
        </span>
      )}
    </button>
  );
}
