import { useEffect, useRef, useState } from "react";
import type { Article, TimelineEntry } from "@zammy/shared";
import { isTerminalPage } from "@zammy/shared";
import { ApiError, type TopicQuery } from "./api.js";
import { isCollapsed, noDaysCollapsed, toggleDay } from "./dayCollapse.js";
import { groupByDay, hasLaterCoverage, relativeTime, timeLabel } from "./format.js";
import { MONO } from "./theme.js";
import { CommandBar } from "./CommandBar.js";
import { useReference, useTimeline } from "./useTimeline.js";

/**
 * The open-topic screen: the time rail from the prototype verdict
 * (branch prototype/timeline-ui) wired to GET /api/v1/timeline.
 *
 * State model (§6.1, §8.2): page.hasMore and meta.ingest.state answer
 * different questions and both gate the rail's tail —
 *   more rows in store            → sentinel + "Load older" fallback
 *   ingest still running upstream → the rail's ingest animation
 *   neither (isTerminalPage)      → the ■ "start of coverage" terminus
 */
export function TimelinePage({
  topic,
  onSearch,
  onClear,
}: {
  topic: TopicQuery;
  onSearch: (topic: TopicQuery) => void;
  onClear: () => void;
}) {
  const timeline = useTimeline(topic);
  const reference = useReference();

  const pages = timeline.data?.pages ?? [];
  const latest = pages.at(-1);
  const items = pages.flatMap((page) => page.items);
  const { visible, newCount, reveal } = useHeldNewItems(items, JSON.stringify(topic));
  const ingesting = latest?.meta.ingest.state === "in_progress";
  const terminal = latest !== undefined && !timeline.hasNextPage && isTerminalPage(latest);

  return (
    <>
      <CommandBar
        topic={topic}
        page={latest}
        reference={reference.data}
        onSearch={onSearch}
        onClear={onClear}
      />
      <main style={{ maxWidth: "760px", margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>
        {timeline.isPending && <SkeletonRail />}

        {timeline.isError && (
          <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
        )}

        {latest && (
          <Rail
            items={visible}
            newCount={newCount}
            onReveal={reveal}
            ingesting={ingesting ?? false}
            pendingJobs={latest.meta.ingest.pendingJobs}
            terminal={terminal}
            emptyLabel={`No articles yet for “${topic.q}”.`}
            hasNextPage={timeline.hasNextPage}
            isFetchingNextPage={timeline.isFetchingNextPage}
            onLoadOlder={() => void timeline.fetchNextPage()}
          />
        )}
      </main>
    </>
  );
}

/**
 * §6.5: refresh-on-read adds articles NEWER than what the reader is looking
 * at. Splicing them in above a reading user silently shifts everything under
 * their eyes, so arrivals newer than the newest item they have SEEN are held
 * back behind an explicit "N new articles" affordance, applied on click.
 *
 * The anchor is the published timestamp of the newest item first shown for
 * this topic. Progressive fill is unaffected — it appends OLDER items, which
 * pass straight through (§6.5 point 3).
 */
function useHeldNewItems(items: TimelineEntry[], topicKey: string) {
  const [anchor, setAnchor] = useState<string | null>(null);
  const keyRef = useRef(topicKey);
  if (keyRef.current !== topicKey) {
    keyRef.current = topicKey;
    setAnchor(null);
  }
  const newest = items[0]?.published ?? null;
  if (anchor === null && newest !== null) setAnchor(newest);

  const effective = anchor ?? newest;
  const visible =
    effective === null ? items : items.filter((item) => item.published <= effective);
  const held = items.slice(0, items.length - visible.length);
  return {
    visible,
    // Articles, not slots: the pill promises "N new articles" and a held slot
    // can carry several (§14.3) — copies and coverage both count.
    newCount: held.reduce(
      (total, entry) => total + 1 + entry.related.length + entry.moreCoverage.length,
      0,
    ),
    reveal: () => setAnchor(newest),
  };
}

/**
 * One centre line for the whole rail, measured from the container's left edge.
 * The spine straddles it and every marker is centred on it — markers position
 * from a RailEntry's own box, which the container's RAIL_INSET padding has
 * already shifted, so each subtracts that inset plus its own half-width.
 * Derive from these rather than hand-tuning offsets: the glyphs sat 0.9px off
 * the spine when the two were picked independently.
 */
const RAIL_CENTER = "0.7rem";
const RAIL_WIDTH = "3px";
const RAIL_INSET = "2.5rem";

/** Left offset that centres a marker of the given width on RAIL_CENTER. */
function markerLeft(width: string) {
  return `calc(${RAIL_CENTER} - ${RAIL_INSET} - ${width} / 2)`;
}

function Rail({
  items,
  newCount,
  onReveal,
  ingesting,
  pendingJobs,
  terminal,
  emptyLabel,
  hasNextPage,
  isFetchingNextPage,
  onLoadOlder,
}: {
  items: TimelineEntry[];
  newCount: number;
  onReveal: () => void;
  ingesting: boolean;
  pendingJobs: number;
  terminal: boolean;
  emptyLabel: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadOlder: () => void;
}) {
  const [collapsed, setCollapsed] = useState(noDaysCollapsed);

  if (items.length === 0 && !ingesting) {
    return (
      <p style={{ color: "var(--fg-faint)", textAlign: "center", marginTop: "3rem" }}>
        {terminal ? emptyLabel : "Nothing here yet."}
      </p>
    );
  }

  return (
    <div style={{ position: "relative", paddingLeft: RAIL_INSET }}>
      <div
        aria-hidden="true"
        // The spine carries the ingest animation's charge while a fetch is in
        // flight; the class owns the background in that state.
        className={ingesting ? "ingest-charge" : undefined}
        style={{
          position: "absolute",
          left: `calc(${RAIL_CENTER} - ${RAIL_WIDTH} / 2)`,
          top: 0,
          bottom: 0,
          width: RAIL_WIDTH,
          background: ingesting ? undefined : "var(--rail)",
          borderRadius: "2px",
        }}
      />
      {ingesting && <IngestStatus pendingJobs={pendingJobs} />}
      {ingesting && <IngestBeacon />}
      {newCount > 0 && (
        <RailEntry marker="▲">
          <button
            onClick={onReveal}
            style={{
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--activity)",
              borderRadius: "6px",
              padding: "0.3rem 0.9rem",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            {newCount} new article{newCount === 1 ? "" : "s"}
          </button>
        </RailEntry>
      )}
      {groupByDay(items).map((day) => {
        const dayCollapsed = isCollapsed(collapsed, day.day);
        return (
          <section key={day.day} aria-label={day.day}>
            <RailEntry
              // ▶ not the smaller ▸: at the rail's font size ▶ carries roughly
              // the dot's ink, and its optical centre matches ●'s to the pixel,
              // so both states sit on the same line without a nudge.
              marker={dayCollapsed ? "▶" : "●"}
              big
              toggle={{
                expanded: !dayCollapsed,
                label: `${dayCollapsed ? "Expand" : "Collapse"} ${day.day}`,
                onToggle: () => setCollapsed((days) => toggleDay(days, day.day)),
              }}
            >
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
            {!dayCollapsed &&
              day.items.map((entry) => (
                <RailEntry key={entry.storylineId} marker="○">
                  <GroupCard entry={entry} />
                </RailEntry>
              ))}
          </section>
        );
      })}
      {ingesting && <IngestGhosts pendingJobs={pendingJobs} />}
      {!ingesting && hasNextPage && (
        <RailEntry marker="↓">
          <LoadOlder loading={isFetchingNextPage} onLoadOlder={onLoadOlder} />
        </RailEntry>
      )}
      {terminal && items.length > 0 && (
        <RailEntry marker="■">
          <span style={{ color: "var(--fg-faint)", fontSize: "0.9rem" }}>start of coverage</span>
        </RailEntry>
      )}
    </div>
  );
}

/**
 * Infinite scroll via IntersectionObserver, with the explicit fallback button
 * §8.2 requires (it also covers environments where IO callbacks never fire,
 * which the prototype ran into).
 */
function LoadOlder({ loading, onLoadOlder }: { loading: boolean; onLoadOlder: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) onLoadOlder();
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  });

  return (
    <div>
      <div ref={sentinel} style={{ height: "1px" }} aria-hidden="true" />
      <button
        onClick={onLoadOlder}
        disabled={loading}
        style={{
          border: "none",
          background: "none",
          color: "var(--fg)",
          cursor: "pointer",
          fontSize: "0.9rem",
          padding: 0,
        }}
      >
        {loading ? "loading older…" : "load older"}
      </button>
    </div>
  );
}

/**
 * One timeline slot (§14.3, ADR-0009): the storyline's headline article, with
 * the day's remaining coverage behind one disclosure in two sections —
 * "same story" (the lead group's other copies) and "more coverage" (the
 * storyline's other groups: retrospectives, follow-ups, fact-checks).
 *
 * The time shown is the STORYLINE's, not the headline article's — the slot
 * sits at its earliest published, and a card showing "3 hours ago" beneath
 * rows from five hours ago reads as a bug. Later coverage surfaces as an
 * "updated" stamp instead, the same treatment §8.1 gives a re-emitted article.
 */
function GroupCard({ entry }: { entry: TimelineEntry }) {
  const [showRelated, setShowRelated] = useState(false);
  const updated = hasLaterCoverage(entry);
  const total = entry.related.length + entry.moreCoverage.length;

  return (
    <div style={{ maxWidth: "640px" }}>
      <ArticleCard
        article={entry.article}
        published={entry.published}
        updatedAt={updated ? entry.updatedAt : null}
      />
      {total > 0 && (
        <>
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
              {entry.related.length > 0 && (
                <RelatedSection label="same story" articles={entry.related} softCap />
              )}
              {entry.moreCoverage.length > 0 && (
                <RelatedSection label="more coverage" articles={entry.moreCoverage} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Same-story copies shown before the "+N more" expander unfolds the rest. */
const SAME_STORY_CAP = 3;

/**
 * One disclosure section. "Same story" rows are syndication copies, so
 * word-identical titles collapse to one row with a copy count — four "The
 * Latest:" wire updates are one fact, not four lines — and the section
 * soft-caps behind an expander: the copies prove breadth, the coverage
 * section is the part worth the vertical space.
 */
function RelatedSection({
  label,
  articles,
  softCap,
}: {
  label: string;
  articles: Article[];
  softCap?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = collapseCopies(articles);
  const capped = softCap && !showAll ? rows.slice(0, SAME_STORY_CAP) : rows;
  // Hidden ARTICLES, not hidden rows: the disclosure button promises "N
  // related" in articles, and a row absorbing word-identical copies carries
  // several. Counting rows here left the two numbers irreconcilable — a
  // reader could see "17 related" yet only ever count 14 (live report:
  // 11 same-story articles collapsing to 8 rows swallowed 3 from the tally).
  const hidden = articles.length - capped.reduce((total, row) => total + row.copies, 0);

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
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.4rem",
        }}
      >
        {capped.map(({ article, copies }) => (
          <li key={article.id}>
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.85rem", lineHeight: 1.3, textDecoration: "none" }}
            >
              {article.title}
            </a>
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--fg-faint)",
                display: "flex",
                gap: "0.5rem",
              }}
            >
              <time dateTime={article.published}>{timeLabel(article.published)}</time>
              {article.sourceDomain && <span>{article.sourceDomain}</span>}
              {copies > 1 && <span>×{copies} outlets</span>}
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          onClick={() => setShowAll(true)}
          style={{
            border: "none",
            background: "none",
            color: "var(--fg-faint)",
            cursor: "pointer",
            fontSize: "0.7rem",
            padding: "0.3rem 0 0",
          }}
        >
          +{hidden} more
        </button>
      )}
    </section>
  );
}

/**
 * Fold word-identical titles into one row with a count. First occurrence wins
 * the row — articles arrive newest first, so the row shows the latest copy —
 * and the fold is by exact title: near-identical wire variants stay separate
 * rows, which is honest about what the outlets actually printed.
 */
function collapseCopies(articles: Article[]): { article: Article; copies: number }[] {
  const rows: { article: Article; copies: number }[] = [];
  const byTitle = new Map<string, number>();
  for (const article of articles) {
    const index = byTitle.get(article.title);
    if (index === undefined) {
      byTitle.set(article.title, rows.length);
      rows.push({ article, copies: 1 });
    } else {
      rows[index]!.copies += 1;
    }
  }
  return rows;
}

function ArticleCard({
  article,
  published,
  updatedAt,
}: {
  article: Article;
  /** The slot's time — the group's, which may predate this article's own. */
  published: string;
  /** Newest coverage in the group, when later than the slot's time. */
  updatedAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const expandable = article.description !== null;

  return (
    <article
      style={{
        background: "var(--surface)",
        borderRadius: "8px",
        border: "1px solid var(--border)",
        padding: "0.6rem 0.9rem",
        display: "flex",
        gap: "0.75rem",
      }}
    >
      {article.imageUrl && (
        // Fixed aspect box so late-loading images never shift the rail (§8.3).
        <div
          style={{
            width: "72px",
            aspectRatio: "3 / 2",
            flexShrink: 0,
            alignSelf: "center",
            background: "var(--chip-bg)",
            borderRadius: "6px",
            overflow: "hidden",
          }}
        >
          <img
            src={article.imageUrl}
            alt=""
            loading="lazy"
            // Hotlink-blocked or dead upstream images collapse to the neutral
            // box rather than the browser's broken-image glyph.
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: "0.95rem", lineHeight: 1.35, textDecoration: "none", display: "block" }}
      >
        {article.title}
      </a>
      <div style={{ marginTop: "0.25rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <small style={{ fontSize: "0.7rem", color: "var(--fg-faint)", fontVariantNumeric: "tabular-nums" }}>
          <time dateTime={published}>{timeLabel(published)}</time>
        </small>
        {updatedAt && (
          <span style={{ fontSize: "0.7rem", color: "var(--fg-faint)" }}>
            updated {relativeTime(updatedAt)}
          </span>
        )}
        {article.sourceDomain && (
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
        )}
        {article.sightingCount > 1 && (
          <span style={{ fontSize: "0.7rem", color: "var(--fg-faint)" }}>
            seen ×{article.sightingCount}, updated {relativeTime(article.latestSeen)}
          </span>
        )}
        {expandable && (
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              fontSize: "0.7rem",
              padding: "0 0.2rem",
            }}
          >
            {open ? "less ▲" : "more ▼"}
          </button>
        )}
      </div>
      {open && article.description && (
        <p style={{ marginTop: "0.5rem", marginBottom: 0, fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          {article.description}
        </p>
      )}
      </div>
    </article>
  );
}

function RailEntry({
  marker,
  big,
  pulse,
  toggle,
  children,
}: {
  marker: string;
  big?: boolean;
  pulse?: boolean;
  /** Makes the rail marker itself the control — the day dot collapses its articles. */
  toggle?: { expanded: boolean; label: string; onToggle: () => void };
  children: React.ReactNode;
}) {
  // Decorative for every other entry; a real button only where it does something,
  // so screen readers are not offered a dot per article.
  const markerStyle = {
    position: "absolute",
    left: markerLeft("1.4rem"),
    width: "1.4rem",
    textAlign: "center",
    // Pulsing marks work in flight, the same thing the ingest animation marks,
    // so it takes the activity colour rather than amber's "pay attention".
    color: pulse ? "var(--activity)" : "var(--fg)",
    background: "var(--bg)",
    fontSize: big ? "0.9rem" : "0.75rem",
    // Day markers anchor to their heading's line. Everything else centres on
    // its row: the entry's vertical padding is symmetric, so the entry's
    // midpoint is the card's midpoint. Tall cards therefore carry their dot
    // lower down the rail than short ones.
    ...(big
      ? { top: "1.55rem" }
      : { top: "50%", transform: "translateY(-50%)", lineHeight: 1 }),
  } as const;

  return (
    <div style={{ position: "relative", padding: big ? "1.5rem 0 0.5rem" : "0.35rem 0" }}>
      {toggle ? (
        <button
          onClick={toggle.onToggle}
          aria-expanded={toggle.expanded}
          aria-label={toggle.label}
          style={{
            // `font: inherit` first: the shorthand would otherwise reset the
            // rail's marker size back to the button default.
            font: "inherit",
            ...markerStyle,
            // A 1.5rem box keeps the glyph on the rail's centre line while
            // giving the pointer a 24px target instead of the glyph's ~22×16.
            width: "1.5rem",
            height: "1.5rem",
            left: markerLeft("1.5rem"),
            // Same split as markerStyle, offset by the taller box's extra 4px.
            ...(big ? { top: "1.32rem" } : { top: "50%", transform: "translateY(-50%)" }),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            padding: 0,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          {marker}
        </button>
      ) : (
        <span aria-hidden="true" className={pulse ? "shimmer" : undefined} style={markerStyle}>
          {marker}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * The head of the ingest animation: a radar pulse on the spine's centre line,
 * above the newest slot. It sits at the TOP because that is where refresh-on-
 * read puts what it finds (§6.5) — an indicator at the tail would point at
 * where older backfill lands and misdescribe what is happening.
 */
function IngestBeacon() {
  return (
    <div style={{ position: "relative", height: "2.6rem" }}>
      <span
        aria-hidden="true"
        style={{ position: "absolute", left: markerLeft("0px"), top: "50%", width: 0, height: 0 }}
      >
        {INGEST_RING_DELAYS.map((delay) => (
          <span key={delay} className="ingest-ring" style={{ animationDelay: `${delay}s` }} />
        ))}
        <span className="ingest-core" />
      </span>
    </div>
  );
}

/** Evenly spaced across the ring animation's 2.1s, so pulses read as steady. */
const INGEST_RING_DELAYS = [0, 0.7, 1.4];

/** How many ghost slots the tail will ever show, however deep the queue is. */
const MAX_INGEST_GHOSTS = 4;

/**
 * The tail of the ingest animation: ghost slots standing where the arriving
 * articles will land, in the same marker-plus-card shape they will take, so
 * their arrival is a resolve rather than a jump.
 *
 * The count tracks pendingJobs, capped — the rail is showing that work is
 * outstanding, not plotting the queue, and a tail of twenty ghosts would bury
 * the articles the reader already has.
 */
function IngestGhosts({ pendingJobs }: { pendingJobs: number }) {
  const count = Math.min(Math.max(pendingJobs, 1), MAX_INGEST_GHOSTS);
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        // Staggered so the stack settles in sequence rather than as one block.
        const delay = `${i * 0.22}s`;
        return (
          <div key={i} style={{ position: "relative", padding: "0.35rem 0" }}>
            <span
              aria-hidden="true"
              className="ingest-ghost-marker"
              style={{
                position: "absolute",
                left: markerLeft("1.4rem"),
                top: "50%",
                width: "1.4rem",
                textAlign: "center",
                fontSize: "0.75rem",
                lineHeight: 1,
                color: "var(--activity)",
                background: "var(--bg)",
                animationDelay: delay,
              }}
            >
              ○
            </span>
            <div
              className="ingest-ghost"
              style={{
                height: "3.4rem",
                maxWidth: "640px",
                borderRadius: "8px",
                border: "1px solid var(--border)",
                background: "var(--chip-bg)",
                position: "relative",
                overflow: "hidden",
                animationDelay: delay,
              }}
            >
              <span className="ingest-sweep" style={{ animationDelay: delay }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * What the animation cannot say. Motion is invisible to a screen reader, and
 * §8.1 asks the UI to be honest about freshness — so the state the rail now
 * shows in teal is still announced here, including the count the text row used
 * to print.
 */
function IngestStatus({ pendingJobs }: { pendingJobs: number }) {
  return (
    <p className="sr-only" role="status" aria-live="polite">
      Gathering articles from upstream — {pendingJobs} job
      {pendingJobs === 1 ? "" : "s"} pending.
    </p>
  );
}

/** Progressive-fill shimmer: a short first paint reads as "more coming" (§8.2). */
function ShimmerRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <RailEntry key={i} marker="○" pulse>
          <div className="shimmer" style={{ height: "3.4rem", maxWidth: "640px" }} />
        </RailEntry>
      ))}
    </>
  );
}

function SkeletonRail() {
  return (
    <div style={{ position: "relative", paddingLeft: RAIL_INSET }} aria-label="Loading timeline">
      <ShimmerRows count={6} />
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? [error.message, ...Object.entries(error.fields).map(([f, m]) => `${f}: ${m}`)].join(" — ")
      : error instanceof Error
        ? error.message
        : "something went wrong";
  return (
    <div style={{ textAlign: "center", marginTop: "3rem", fontFamily: MONO }}>
      <p style={{ color: "var(--amber)", fontSize: "0.9rem" }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
          borderRadius: "6px",
          padding: "0.4rem 1.2rem",
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        retry
      </button>
    </div>
  );
}
