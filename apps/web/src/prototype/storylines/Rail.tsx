import { useState } from "react";
import { MONO } from "../../theme.js";
import type { MockArticle, MockSlot, MockStoryline } from "./mock-data.js";
import { spanQualifier } from "./mock-data.js";

/**
 * PROTOTYPE (S8) — the BASELINE layer every variant shares: the time rail with
 * storyline-day slots and a universal gutter label on every labeled storyline
 * (ADR-0011 fixes this much; only the surfacing treatment above it is open).
 *
 * A trimmed copy of TimelinePage's rail, not an import: the real one is bound to
 * today's wire types and its own data hooks. Geometry (the CSS custom
 * properties, the derived centre line) is copied verbatim so the variants are
 * judged at the app's real density.
 */

const RAIL_CENTER = "var(--rail-center)";
const RAIL_WIDTH = "3px";
const RAIL_INSET = "var(--rail-inset)";
const RAIL_GUTTER = "var(--rail-gutter)";
const GUTTER_GAP = "0.3rem";

export function markerLeft(width: string) {
  return `calc(${RAIL_CENTER} - ${RAIL_INSET} - ${width} / 2)`;
}

/**
 * A rail row. `slot` is the ordinary storyline-day; `node` is a variant's own
 * injection (variant B's storyline slot), which owns its look but borrows the
 * rail's geometry.
 */
export type RailItem =
  | { kind: "slot"; slot: MockSlot }
  | { kind: "custom"; key: string; day: string; marker: string; node: React.ReactNode };

export function Rail({
  items,
  /** Labels on screen more than once take the quiet date qualifier. */
  onOpenStoryline,
}: {
  items: RailItem[];
  onOpenStoryline: (storylineId: string) => void;
}) {
  const collisions = labelCollisions(items);

  if (items.length === 0) {
    return (
      <p style={{ color: "var(--fg-faint)", textAlign: "center", marginTop: "3rem" }}>
        No articles here.
      </p>
    );
  }

  return (
    <div style={{ position: "relative", paddingLeft: RAIL_INSET }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: `calc(${RAIL_CENTER} - ${RAIL_WIDTH} / 2)`,
          top: 0,
          bottom: 0,
          width: RAIL_WIDTH,
          background: "var(--rail)",
          borderRadius: "2px",
        }}
      />
      {groupByDay(items).map((day) => (
        <section key={day.day} aria-label={day.day}>
          <RailEntry marker="●" big>
            <h2
              style={{
                fontSize: "0.9rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                margin: 0,
              }}
            >
              {day.day}
            </h2>
          </RailEntry>
          {day.items.map((item) =>
            item.kind === "slot" ? (
              <SlotCard
                key={`${item.slot.storylineId}-${item.slot.published}`}
                slot={item.slot}
                qualify={item.slot.label !== null && collisions.has(item.slot.label)}
                onOpenStoryline={onOpenStoryline}
              />
            ) : (
              <RailEntry key={item.key} marker={item.marker} head={item.node}>
                {null}
              </RailEntry>
            ),
          )}
        </section>
      ))}
    </div>
  );
}

/** Labels carried by two different storylines among the rows on screen. */
function labelCollisions(items: RailItem[]): Set<string> {
  const byLabel = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.kind !== "slot" || item.slot.label === null) continue;
    const ids = byLabel.get(item.slot.label) ?? new Set();
    ids.add(item.slot.storylineId);
    byLabel.set(item.slot.label, ids);
  }
  return new Set([...byLabel].filter(([, ids]) => ids.size > 1).map(([label]) => label));
}

function SlotCard({
  slot,
  qualify,
  onOpenStoryline,
}: {
  slot: MockSlot;
  qualify: boolean;
  onOpenStoryline: (storylineId: string) => void;
}) {
  const [showRelated, setShowRelated] = useState(false);
  const total = slot.related.length + slot.moreCoverage.length;

  return (
    <RailEntry
      marker="○"
      head={
        <div style={{ maxWidth: "640px" }}>
          {slot.label && (
            <GutterLabel
              label={slot.label}
              qualifier={qualify && slot.span ? spanQualifier(slot.span) : null}
              onOpen={() => onOpenStoryline(slot.storylineId)}
            />
          )}
          <ArticleCard article={slot.article} published={slot.published} />
        </div>
      }
    >
      {total > 0 && (
        <div style={{ maxWidth: "640px" }}>
          <button
            onClick={() => setShowRelated(!showRelated)}
            aria-expanded={showRelated}
            style={{
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              fontSize: "0.7rem",
              padding: "0.3rem 0.2rem 0",
            }}
          >
            {showRelated ? "▲" : "▼"} {total} related
          </button>
          {showRelated && (
            <div
              style={{
                margin: "0.25rem 0 0",
                padding: "0 0 0 0.9rem",
                borderLeft: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {slot.related.length > 0 && <Section label="same story" articles={slot.related} />}
              {slot.moreCoverage.length > 0 && (
                <Section label="more coverage" articles={slot.moreCoverage} />
              )}
            </div>
          )}
        </div>
      )}
    </RailEntry>
  );
}

/**
 * The label in the gutter, left of the spine (ADR-0010's surviving half). In v2
 * it opens the STORYLINE by UUID rather than executing its own words as a
 * search, so it is universal: every labeled storyline's slots carry it.
 */
function GutterLabel({
  label,
  qualifier,
  onOpen,
}: {
  label: string;
  qualifier: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-label={`Open storyline ${label}${qualifier ? `, ${qualifier}` : ""}`}
      style={{
        position: "absolute",
        left: `calc(-1 * ${RAIL_INSET})`,
        width: `calc(${RAIL_GUTTER} - ${GUTTER_GAP})`,
        top: "50%",
        transform: "translateY(-50%)",
        border: "none",
        background: "none",
        padding: 0,
        textAlign: "right",
        color: "var(--fg-faint)",
        fontFamily: MONO,
        fontSize: "0.7rem",
        lineHeight: 1.25,
        cursor: "pointer",
        overflowWrap: "anywhere",
      }}
    >
      {label}
      {qualifier && (
        <span style={{ display: "block", opacity: 0.75 }}>· {qualifier}</span>
      )}
    </button>
  );
}

function Section({ label, articles }: { label: string; articles: MockArticle[] }) {
  return (
    <section aria-label={label}>
      <h3
        style={{
          margin: "0 0 0.3rem",
          fontSize: "0.65rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--fg-faint)",
        }}
      >
        {label}
      </h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.4rem" }}>
        {articles.map((a) => (
          <li key={a.id}>
            <a href={a.url} style={{ fontSize: "0.85rem", textDecoration: "none" }}>
              {a.title}
            </a>
            <div style={{ fontSize: "0.7rem", color: "var(--fg-faint)" }}>
              {timeLabel(a.published)} · {a.sourceDomain}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ArticleCard({ article, published }: { article: MockArticle; published: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article
      style={{
        background: "var(--surface)",
        borderRadius: "8px",
        border: "1px solid var(--border)",
        padding: "0.6rem 0.9rem",
      }}
    >
      <a
        href={article.url}
        style={{ fontSize: "0.95rem", lineHeight: 1.35, textDecoration: "none", display: "block" }}
      >
        {article.title}
      </a>
      <div
        style={{
          marginTop: "0.25rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.25rem 0.5rem",
          alignItems: "center",
        }}
      >
        <small style={{ fontSize: "0.7rem", color: "var(--fg-faint)" }}>
          {timeLabel(published)}
        </small>
        <span
          style={{
            fontSize: "0.7rem",
            background: "var(--chip-bg)",
            borderRadius: "4px",
            padding: "0.1rem 0.4rem",
          }}
        >
          {article.sourceDomain}
        </span>
        {article.description && (
          <button
            onClick={() => setOpen(!open)}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              fontSize: "0.7rem",
            }}
          >
            {open ? "less ▲" : "more ▼"}
          </button>
        )}
      </div>
      {open && article.description && (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          {article.description}
        </p>
      )}
    </article>
  );
}

export function RailEntry({
  marker,
  big,
  head,
  children,
}: {
  marker: string;
  big?: boolean;
  head?: React.ReactNode;
  children: React.ReactNode;
}) {
  const markerStyle = {
    position: "absolute",
    left: markerLeft("1.4rem"),
    width: "1.4rem",
    textAlign: "center",
    color: "var(--fg)",
    background: "var(--bg)",
    fontSize: big ? "0.9rem" : "0.75rem",
    ...(big ? { top: "1.55rem" } : { top: "50%", transform: "translateY(-50%)", lineHeight: 1 }),
  } as const;

  const glyph = (
    <span aria-hidden="true" style={markerStyle}>
      {marker}
    </span>
  );

  return (
    <div style={{ position: "relative", padding: big ? "1.5rem 0 0.5rem" : "0.35rem 0" }}>
      {head === undefined ? (
        glyph
      ) : (
        <div style={{ position: "relative" }}>
          {glyph}
          {head}
        </div>
      )}
      {children}
    </div>
  );
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function groupByDay(items: RailItem[]): { day: string; items: RailItem[] }[] {
  const days: { day: string; items: RailItem[] }[] = [];
  for (const item of items) {
    const day = item.kind === "slot" ? dayLabel(item.slot.published) : item.day;
    const last = days.at(-1);
    if (last && last.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }
  return days;
}

/** Shared by the strip and the rail-slot: a storyline's arc in one line. */
export function storylineMeta(storyline: MockStoryline): string {
  const days = storyline.activity.length;
  return `${storyline.articleCount} articles · ${days} day${days === 1 ? "" : "s"}${
    storyline.status === "dormant" ? " · dormant" : ""
  }`;
}
