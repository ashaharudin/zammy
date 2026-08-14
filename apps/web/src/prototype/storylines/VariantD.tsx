import { useEffect, useState } from "react";
import { MONO } from "../../theme.js";
import { ActivitySparkline, CommandBar, Page } from "./Chrome.js";
import { Rail, storylineMeta } from "./Rail.js";
import { spanLabel, spanQualifier } from "./mock-data.js";
import type { VariantProps } from "./variant-props.js";

/**
 * PROTOTYPE (S8) — VARIANT D: floating bottom strip.
 *
 * A's cards, taken out of the document flow and floated at the bottom of the
 * viewport in the prototype switcher's own shape — a high-ish contrast pill
 * that sits ABOVE the page rather than in it, persisting as the reader scrolls.
 *
 * The claim: A's one real cost is that it displaces the newest headline and is
 * only visible at the top of the page, and B's is that a match can be scrolled
 * past. A floating strip pays neither — the reader can be forty slots down and
 * the matched storylines are still one click away, which is exactly when
 * "follow the story instead" becomes the thing they want.
 *
 * The cost it has to be judged on: it covers content permanently, it is the
 * shape the whole web uses for cookie banners and app-install nags, and a
 * dismissed strip is gone with no way back.
 */
export function VariantD({
  query,
  slots,
  surfaced,
  viewing,
  onQueryChange,
  onOpenStoryline,
  onDismissView,
}: VariantProps) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A new search is a new offer: the dismissal belongs to the query it was made
  // against, not to the session.
  useEffect(() => setDismissed(null), [query]);

  const collides = new Set(
    surfaced
      .map((s) => s.label)
      .filter((label, i, all) => label !== null && all.indexOf(label) !== i),
  );
  const show = !viewing && surfaced.length > 0 && dismissed !== query;

  return (
    <>
      <CommandBar
        query={query}
        viewing={viewing}
        onQueryChange={onQueryChange}
        onDismissView={onDismissView}
      />
      <Page>
        <Rail
          items={slots.map((slot) => ({ kind: "slot" as const, slot }))}
          onOpenStoryline={onOpenStoryline}
        />
        {/* The rail's own tail clearance, so the last slot is reachable under
            the floating strip rather than permanently half-covered. */}
        {show && <div style={{ height: "5rem" }} aria-hidden="true" />}
      </Page>
      {show && (
        <div
          role="region"
          aria-label="Storylines matching this search"
          style={{
            position: "fixed",
            // Clear of the prototype switcher, which owns the very bottom.
            bottom: "3.75rem",
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: "min(var(--page-max), calc(100vw - 2rem))",
            display: "flex",
            alignItems: "stretch",
            gap: "0.4rem",
            background: "var(--surface-translucent)",
            backdropFilter: "blur(6px)",
            border: "1px solid var(--border)",
            borderRadius: "999px",
            boxShadow: "var(--shadow)",
            padding: "0.3rem 0.35rem 0.3rem 0.75rem",
            zIndex: 50,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              alignSelf: "center",
              fontFamily: MONO,
              fontSize: "0.65rem",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--fg-faint)",
              whiteSpace: "nowrap",
            }}
          >
            {surfaced.length} storyline{surfaced.length === 1 ? "" : "s"}
          </span>
          <span style={{ display: "flex", gap: "0.3rem", overflowX: "auto" }}>
            {surfaced.map((storyline) => (
              <button
                key={storyline.id}
                onClick={() => onOpenStoryline(storyline.id)}
                title={`${spanLabel(storyline.span)} · ${storylineMeta(storyline)}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  background: "var(--chip-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "999px",
                  padding: "0.25rem 0.7rem",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <ActivitySparkline storyline={storyline} />
                <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
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
                    fontFamily: MONO,
                    fontSize: "0.65rem",
                    color: "var(--fg-faint)",
                  }}
                >
                  {storyline.articleCount}
                  {storyline.status === "dormant" ? " · dormant" : ""}
                </span>
              </button>
            ))}
          </span>
          <button
            onClick={() => setDismissed(query)}
            aria-label="Dismiss surfaced storylines"
            style={{
              alignSelf: "center",
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              fontSize: "0.9rem",
              padding: "0 0.4rem",
            }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
