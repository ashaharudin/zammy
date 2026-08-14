import { MONO } from "../../theme.js";
import { ActivitySparkline, CommandBar, Page } from "./Chrome.js";
import { Rail, storylineMeta } from "./Rail.js";
import { spanLabel, spanQualifier } from "./mock-data.js";
import type { VariantProps } from "./variant-props.js";

/**
 * PROTOTYPE (S8) — VARIANT A: top strip.
 *
 * Matched storylines sit ABOVE the results as a row of cards, before the first
 * day divider. The claim: surfacing is an answer to the search ("these are the
 * stories your words are about"), so it belongs where an answer goes — above
 * the evidence, out of the chronology, all matches visible at once and
 * comparable side by side.
 *
 * The cost it has to be judged on: it displaces the newest headline below the
 * fold, and it says nothing when a search surfaces nothing (the common case).
 */
export function VariantA({
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

  return (
    <>
      <CommandBar
        query={query}
        viewing={viewing}
        onQueryChange={onQueryChange}
        onDismissView={onDismissView}
      />
      <Page>
        {!viewing && surfaced.length > 0 && (
          <section
            aria-label="Storylines matching this search"
            style={{ margin: "0 0 1.5rem", paddingLeft: "var(--rail-inset)" }}
          >
            <h2
              style={{
                margin: "0 0 0.5rem",
                fontFamily: MONO,
                fontSize: "0.7rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--fg-faint)",
                fontWeight: 600,
              }}
            >
              {surfaced.length} storyline{surfaced.length === 1 ? "" : "s"} about “{query}”
            </h2>
            <div
              style={{
                display: "flex",
                gap: "0.6rem",
                overflowX: "auto",
                paddingBottom: "0.3rem",
              }}
            >
              {surfaced.map((storyline) => (
                <button
                  key={storyline.id}
                  onClick={() => onOpenStoryline(storyline.id)}
                  style={{
                    flex: "0 0 15rem",
                    textAlign: "left",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    padding: "0.6rem 0.75rem",
                    cursor: "pointer",
                    display: "grid",
                    gap: "0.35rem",
                  }}
                >
                  <span style={{ fontSize: "0.95rem", fontWeight: 600, lineHeight: 1.25 }}>
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
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      fontFamily: MONO,
                      fontSize: "0.7rem",
                      color: "var(--fg-faint)",
                    }}
                  >
                    <ActivitySparkline storyline={storyline} />
                    {spanLabel(storyline.span)}
                  </span>
                  <span style={{ fontSize: "0.7rem", color: "var(--fg-faint)" }}>
                    {storylineMeta(storyline)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <Rail
          items={slots.map((slot) => ({ kind: "slot" as const, slot }))}
          onOpenStoryline={onOpenStoryline}
        />
      </Page>
    </>
  );
}
