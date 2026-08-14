import { MONO } from "../../theme.js";
import { CommandBar, Page } from "./Chrome.js";
import { Rail, dayLabel, storylineMeta, timeLabel, type RailItem } from "./Rail.js";
import { spanLabel, spanQualifier, storylineSlots } from "./mock-data.js";
import type { VariantProps } from "./variant-props.js";

/**
 * PROTOTYPE (S8) — VARIANT B: storyline as a rail slot.
 *
 * No strip and no dropdown: a matched storyline appears IN the timeline, at its
 * latest activity, as a first-class slot that is visually distinct from an
 * article slot (◉ on the spine, an accent edge, the label as a heading, the
 * arc's shape in one line). Its own slot for that day is absorbed into it —
 * two rows for the same storyline-day would be the strip's displacement problem
 * moved into the rail.
 *
 * The claim: chronology is the app's one organising idea, and a storyline is a
 * thing that happened in time; putting it anywhere else costs the reader a
 * second mental model. The cost it has to be judged on: a match older than the
 * first screen is surfaced BELOW the fold, i.e. not surfaced at all, and the
 * distinct treatment has to survive three of them in a row.
 */
export function VariantB({
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

  // The storyline-day each surfaced storyline is injected AT: its latest.
  const absorbed = new Set(
    viewing ? [] : surfaced.map((storyline) => `${storyline.id}@${storyline.span.to.slice(0, 10)}`),
  );

  const items: RailItem[] = slots
    .filter((slot) => !absorbed.has(`${slot.storylineId}@${slot.published.slice(0, 10)}`))
    .map((slot) => ({ kind: "slot" as const, slot }));

  if (!viewing) {
    for (const storyline of surfaced) {
      const latest = storylineSlots(storyline.id).find(
        (slot) => slot.published.slice(0, 10) === storyline.span.to.slice(0, 10),
      );
      if (!latest) continue;
      const headlines = [latest.article, ...latest.related, ...latest.moreCoverage];
      const node = (
        <div
          style={{
            maxWidth: "640px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--activity)",
            borderRadius: "8px",
            padding: "0.7rem 0.9rem",
            display: "grid",
            gap: "0.45rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              onClick={() => onOpenStoryline(storyline.id)}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: "1rem",
                fontWeight: 600,
                textAlign: "left",
              }}
            >
              {storyline.label}
              {collides.has(storyline.label) && (
                <span style={{ color: "var(--fg-faint)", fontWeight: 400 }}>
                  {" "}
                  · {spanQualifier(storyline.span)}
                </span>
              )}
            </button>
            <span
              style={{
                fontFamily: MONO,
                fontSize: "0.68rem",
                color: "var(--activity)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              storyline
            </span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: "0.7rem", color: "var(--fg-faint)" }}>
            {spanLabel(storyline.span)} · {storylineMeta(storyline)}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.35rem" }}>
            {headlines.slice(0, 3).map((a) => (
              <li key={a.id}>
                <a href={a.url} style={{ fontSize: "0.9rem", textDecoration: "none" }}>
                  {a.title}
                </a>
                <div style={{ fontSize: "0.68rem", color: "var(--fg-faint)" }}>
                  {timeLabel(a.published)} · {a.sourceDomain}
                </div>
              </li>
            ))}
          </ul>
          <button
            onClick={() => onOpenStoryline(storyline.id)}
            style={{
              justifySelf: "start",
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              fontSize: "0.75rem",
              color: "var(--activity)",
            }}
          >
            follow the storyline →
          </button>
        </div>
      );
      items.push({
        kind: "custom",
        key: storyline.id,
        day: dayLabel(storyline.span.to),
        marker: "◉",
        node,
      });
    }
  }

  // Re-sort so injections land at their latest activity rather than at the end.
  const positioned = items
    .map((item) => ({
      item,
      at:
        item.kind === "slot"
          ? item.slot.published
          : surfaced.find((s) => s.id === item.key)!.span.to,
    }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ item }) => item);

  return (
    <>
      <CommandBar
        query={query}
        viewing={viewing}
        onQueryChange={onQueryChange}
        onDismissView={onDismissView}
      />
      <Page>
        <Rail items={positioned} onOpenStoryline={onOpenStoryline} />
      </Page>
    </>
  );
}
