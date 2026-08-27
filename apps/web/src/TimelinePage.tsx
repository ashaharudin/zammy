import { useEffect, useRef, useState } from "react";
import type { Article, TimelineEntry } from "@zammy/shared";
import { isTerminalPage } from "@zammy/shared";
import { ApiError, type TopicQuery } from "./api.js";
import { readTimeZone } from "./browser.js";
import { isCollapsed, nothingCollapsed, segmentKey, toggle } from "./dayCollapse.js";
import {
  groupByDay,
  hasLaterCoverage,
  relativeTime,
  timeLabel,
  type Segment,
} from "./format.js";
import { storylineQualifiers, visibleStorylines } from "./storylineLabels.js";
import { LoadingGlyph } from "./LoadingGlyph.js";
import { collapseCopies, outletLinks } from "./relatedRows.js";
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
  onOpenStoryline,
  onLeaveStoryline,
}: {
  topic: TopicQuery;
  onSearch: (topic: TopicQuery, options?: { replace?: boolean }) => void;
  onClear: () => void;
  onOpenStoryline: (storylineId: string) => void;
  /** The keywords typed to leave the view, or null for a dismissed chip. */
  onLeaveStoryline: (typed: string | null) => void;
}) {
  const timeline = useTimeline(topic);
  const reference = useReference();

  const pages = timeline.data?.pages ?? [];
  const latest = pages.at(-1);
  const items = pages.flatMap((page) => page.items);
  const { visible, newCount, reveal } = useHeldNewItems(items, JSON.stringify(topic));
  const surfaced = latest?.storylines ?? [];
  // The date qualifier each storyline needs, computed over everything ON SCREEN
  // together — slots and pills alike — because "is this label ambiguous" is the
  // condition ADR-0011 attaches the disambiguator to, and it is a question
  // about the set rather than about any one storyline.
  const qualifiers = storylineQualifiers(visibleStorylines(visible, surfaced));
  const storylineView = topic.q === "" && topic.storyline !== undefined;
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
        onOpenStorylineView={onOpenStoryline}
        onLeaveStorylineView={onLeaveStoryline}
        qualifiers={qualifiers}
      />
      <main style={{ maxWidth: "var(--page-max)", margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>
        {timeline.isPending && <SkeletonRail />}

        {timeline.isError && (
          <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
        )}

        {latest && (
          <Rail
            // ADR-0011: the label's words are never executed as a search —
            // labels are non-unique, so only the UUID identifies the story.
            // The reader's filters do NOT narrow the view, which is one
            // storyline's own coverage; they ride in the route because the
            // search waiting behind it is still theirs (openStorylineView).
            onOpenStorylineView={onOpenStoryline}
            qualifiers={qualifiers}
            items={visible}
            newCount={newCount}
            onReveal={reveal}
            ingesting={ingesting ?? false}
            pendingJobs={latest.meta.ingest.pendingJobs}
            terminal={terminal}
            emptyLabel={
              storylineView
                ? "This storyline has no coverage to show."
                : `No articles yet for “${topic.q}”.`
            }
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
 *
 * The two positions are CSS custom properties (index.css) rather than literals
 * because the gutter they are derived from responds to viewport width, which
 * only a media query can do. Everything here still reads as arithmetic on
 * them, so the derivation is unchanged — it just happens in `calc`.
 */
const RAIL_CENTER = "var(--rail-center)";
const RAIL_WIDTH = "3px";
const RAIL_INSET = "var(--rail-inset)";
/** Room to the LEFT of the spine, and the gap that keeps a chip off it. */
const RAIL_GUTTER = "var(--rail-gutter)";
const GUTTER_GAP = "0.3rem";

/** Left offset that centres a marker of the given width on RAIL_CENTER. */
function markerLeft(width: string) {
  return `calc(${RAIL_CENTER} - ${RAIL_INSET} - ${width} / 2)`;
}

function Rail({
  items,
  newCount,
  onReveal,
  onOpenStorylineView,
  qualifiers,
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
  onOpenStorylineView: (storylineId: string) => void;
  /** storyline id → the date that separates it from its namesakes on screen. */
  qualifiers: Map<string, string>;
  ingesting: boolean;
  pendingJobs: number;
  terminal: boolean;
  emptyLabel: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadOlder: () => void;
}) {
  const [collapsed, setCollapsed] = useState(nothingCollapsed);
  // The reader's own zone and clock, read once here rather than off a global
  // deeper down: everything below takes them as arguments so the day and
  // segment rules stay testable without a DOM.
  const timeZone = readTimeZone();
  const now = new Date();

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
      {groupByDay(items, now, timeZone).map((day) => {
        const dayCollapsed = isCollapsed(collapsed, day.key);
        // A day whose coverage all landed in one part of the day gets no
        // segment treatment: a divider that chunks nothing is noise. Read off
        // the shape groupByDay already produced.
        const segmented = day.segments.length >= 2;
        return (
          <section key={day.key} aria-label={day.day}>
            <RailEntry
              // ▶ not the smaller ▸: at the rail's font size ▶ carries roughly
              // the dot's ink, and its optical centre matches ●'s to the pixel,
              // so both states sit on the same line without a nudge.
              marker={dayCollapsed ? "▶" : "●"}
              big
              toggle={() => setCollapsed((sections) => toggle(sections, day.key))}
            >
              <h2
                style={{
                  fontSize: "0.9rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  margin: 0,
                }}
              >
                {/*
                  The heading text is the day's control, the same way a
                  segment's is (SegmentDivider); the dot on the spine is a
                  pointer shortcut for it. One rule for the whole rail: a
                  heading collapses what it heads.
                */}
                <button
                  onClick={() => setCollapsed((sections) => toggle(sections, day.key))}
                  aria-expanded={!dayCollapsed}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    cursor: "pointer",
                    // `font: inherit` first: the shorthand would otherwise
                    // reset the heading's size back to the button default.
                    // The other three are NOT redundant — the UA stylesheet
                    // sets `text-transform: none` on form controls, so the
                    // heading's uppercase stops at the button without this.
                    font: "inherit",
                    color: "inherit",
                    letterSpacing: "inherit",
                    textTransform: "inherit",
                  }}
                >
                  {day.day}
                </button>
              </h2>
            </RailEntry>
            {!dayCollapsed &&
              day.segments.map((part) => {
                const key = segmentKey(day.key, part.segment);
                const partCollapsed = segmented && isCollapsed(collapsed, key);
                return (
                  // A landmark only where there is a segment to name: an
                  // unsegmented day is one undivided run of cards, and a
                  // section around it would announce a division that the rail
                  // deliberately does not draw.
                  <Wrapper key={key} {...(segmented ? { "aria-label": part.segment } : {})}>
                    {segmented && (
                      <SegmentDivider
                        segment={part.segment}
                        count={part.items.length}
                        collapsed={partCollapsed}
                        onToggle={() => setCollapsed((sections) => toggle(sections, key))}
                      />
                    )}
                    {!partCollapsed &&
                      part.items.map((entry) => (
                        <GroupCard
                          // NOT `storylineId` alone: under ADR-0011 a storyline
                          // takes one slot per day it has coverage, so the id
                          // repeats down the rail and React would reuse one
                          // card for several days.
                          key={`${entry.storylineId}:${entry.published}`}
                          entry={entry}
                          onOpenStorylineView={onOpenStorylineView}
                          qualifiers={qualifiers}
                          timeZone={timeZone}
                          // A card's own disclosures sit one level below
                          // whatever heads them, so they are h4 under a
                          // segment's h3 and h3 under a bare day's h2. Without
                          // this they would either collide with the segment
                          // heading or skip a level on an unsegmented day.
                          relatedLevel={segmented ? "h4" : "h3"}
                        />
                      ))}
                  </Wrapper>
                );
              })}
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
 *
 * A slot with wider coverage also carries its storyline phrase, hanging in the
 * gutter on the far side of the spine (ADR-0010): the day's story has a name,
 * and the name is a search.
 */
function GroupCard({
  entry,
  onOpenStorylineView,
  qualifiers,
  timeZone,
  relatedLevel,
}: {
  entry: TimelineEntry;
  onOpenStorylineView: (storylineId: string) => void;
  /** storyline id → the date that separates it from its namesakes on screen. */
  qualifiers: Map<string, string>;
  /** The reader's zone, so a card's clock agrees with the day it sits under. */
  timeZone: string;
  /** The heading level for this card's own disclosures — one below its head. */
  relatedLevel: "h3" | "h4";
}) {
  const [showRelated, setShowRelated] = useState(false);
  const updated = hasLaterCoverage(entry);
  const total = entry.related.length + entry.moreCoverage.length;

  return (
    <RailEntry
      marker="○"
      // The headline card alone is the marker's anchor: the disclosure and the
      // rows it opens are content BELOW the article, and a glyph that slid down
      // to the middle of an expanded slot would no longer point at anything.
      head={
        <div style={{ maxWidth: "640px" }}>
          {/*
            The gutter holds the storyline's label, on every slot of a labelled
            storyline — universal, where ADR-0010's phrase appeared only on
            slots with wider coverage, because a label is an identity rather
            than a lucky bigram. An unlabelled storyline leaves the gutter
            empty, which is what "invisible as a storyline" looks like.
          */}
          {entry.storyline?.label && (
            <StorylineLabel
              label={entry.storyline.label}
              qualifier={qualifiers.get(entry.storylineId) ?? null}
              onOpen={() => onOpenStorylineView(entry.storylineId)}
            />
          )}
          <ArticleCard
            article={entry.article}
            published={entry.published}
            updatedAt={updated ? entry.updatedAt : null}
            timeZone={timeZone}
          />
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
              {entry.related.length > 0 && (
                <RelatedSection
                  label="same story"
                  articles={entry.related}
                  timeZone={timeZone}
                  level={relatedLevel}
                  softCap
                />
              )}
              {entry.moreCoverage.length > 0 && (
                <RelatedSection
                  label="more coverage"
                  articles={entry.moreCoverage}
                  timeZone={timeZone}
                  level={relatedLevel}
                />
              )}
            </div>
          )}
        </div>
      )}
    </RailEntry>
  );
}

/**
 * A part of the reader's local day, dividing one day's slots (§8.1).
 *
 * Deliberately NOT a `RailEntry`: a marker box masks the spine with the page
 * background and draws inside the hole it punches, so an entry with no glyph
 * would be a gap in the rail with nothing in it. The spine runs unbroken past
 * a segment instead, which gives the rail a grammar — the spine marks slots
 * and days; segments are typography — and keeps the day/segment hierarchy
 * legible without a second glyph vocabulary.
 *
 * The heading text is the control, since there is no dot to make one of. That
 * puts the state on the text: `aria-expanded` alone would tell screen readers
 * and nobody else, and a collapsed segment is otherwise a heading with nothing
 * beneath it and no visible reason why.
 *
 * It needs no offset of its own — it sits inside the container that already
 * carries the rail's `RAIL_INSET` padding, so it lines up with card content.
 */
/** A heading whose LEVEL its caller decides, because its depth in the rail varies. */
function Heading({
  level,
  style,
  children,
}: {
  level: "h3" | "h4";
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const Tag = level;
  return <Tag style={style}>{children}</Tag>;
}

/**
 * A segment's run of cards: a `<section>` when it is a named part of the day,
 * a bare `<div>` when the day was never divided. Same children either way —
 * only whether the run is a landmark changes.
 */
function Wrapper({ children, ...rest }: { children: React.ReactNode; "aria-label"?: string }) {
  return rest["aria-label"] === undefined ? <div>{children}</div> : <section {...rest}>{children}</section>;
}

function SegmentDivider({
  segment,
  count,
  collapsed,
  onToggle,
}: {
  segment: Segment;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <h3 style={{ margin: "1.1rem 0 0.4rem" }}>
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          cursor: "pointer",
          // `font: inherit` first, or the shorthand resets what follows.
          font: "inherit",
          fontFamily: MONO,
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: collapsed ? "var(--fg-faint)" : "var(--fg)",
        }}
      >
        {segment}
        {/* The count only where the cards it counts are hidden. */}
        {collapsed && <span style={{ opacity: 0.7 }}> · {count}</span>}
      </button>
    </h3>
  );
}

/**
 * The storyline's LABEL, in the gutter on the far side of the spine — the same
 * home ADR-0010's layout gave the phrase, and the half of ADR-0010 that
 * survives (ADR-0011 keeps the gutter, drops the phrase-as-query).
 *
 * Clicking opens the STORYLINE, by UUID. The label's words are never executed
 * as a search: labels are deliberately non-unique, so the words no longer
 * identify the story and navigation has to ride the id. That is also why the
 * qualifier can be presentational — it separates two labels on screen without
 * having to be part of anything's identity.
 *
 * The qualifier renders only when this label actually collides with another on
 * screen. Every slot of a labelled storyline carries the label, so a permanent
 * date beside every one of them would be a lot of chrome answering a question
 * almost no reader has.
 */
function StorylineLabel({
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
      aria-label={`Open the storyline ${label}${qualifier ? `, ${qualifier}` : ""}`}
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
        // Dimmer than the label and on its own line: it is a tiebreak, not part
        // of the name, and a reader who has no collision should be able to
        // ignore it without effort.
        <span style={{ display: "block", opacity: 0.65 }}>{qualifier}</span>
      )}
    </button>
  );
}

/** Same-story copies shown before the "+N more" expander unfolds the rest. */
const SAME_STORY_CAP = 3;

/**
 * One disclosure section, its heading a disclosure of its own: clicking it
 * folds the section's rows, and the folded heading carries its article count
 * so the "N related" promise stays reconcilable while part of it is hidden.
 *
 * "Same story" rows are syndication copies, so word-identical titles collapse
 * to one row — four "The Latest:" wire updates are one fact, not four lines —
 * listing each outlet that printed it, linked to that outlet's own copy. The
 * section soft-caps behind an expander: the copies prove breadth, the
 * coverage section is the part worth the vertical space.
 */
function RelatedSection({
  label,
  articles,
  timeZone,
  level,
  softCap,
}: {
  label: string;
  articles: Article[];
  timeZone: string;
  /** h4 beneath a segment's h3, h3 beneath a bare day's h2. */
  level: "h3" | "h4";
  softCap?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(true);
  const rows = collapseCopies(articles);
  const capped = softCap && !showAll ? rows.slice(0, SAME_STORY_CAP) : rows;
  // Hidden ARTICLES, not hidden rows: the disclosure button promises "N
  // related" in articles, and a row absorbing word-identical copies carries
  // several. Counting rows here left the two numbers irreconcilable — a
  // reader could see "17 related" yet only ever count 14 (live report:
  // 11 same-story articles collapsing to 8 rows swallowed 3 from the tally).
  const hidden = articles.length - capped.reduce((total, row) => total + row.copies.length, 0);

  return (
    <section aria-label={label}>
      <Heading
        level={level}
        style={{
          margin: "0 0 0.3rem",
          fontSize: "0.65rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--fg-faint)",
        }}
      >
        {/* Typography lives on the h3, keeping the heading a heading to a
            screen reader with the toggle inside it. The global `button`
            rule inherits font and color, but the UA stylesheet resets
            text-transform and letter-spacing on buttons — inherit those
            explicitly or the label drops out of uppercase. No glyph: the
            count appearing is the collapsed signal. */}
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            padding: 0,
            textTransform: "inherit",
            letterSpacing: "inherit",
          }}
        >
          {label}
          {!open && ` (${articles.length})`}
        </button>
      </Heading>
      {open && (
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
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "0.3rem 0.5rem",
                }}
              >
                <time dateTime={article.published}>{timeLabel(article.published, timeZone)}</time>
                {outletLinks(copies).map((outlet) => (
                  <a
                    key={outlet.article.id}
                    href={outlet.article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    // The headline card's source-chip treatment: the chip is the
                    // signal these are tappable sources, not more metadata text.
                    style={{
                      background: "var(--chip-bg)",
                      borderRadius: "4px",
                      padding: "0.1rem 0.4rem",
                      textDecoration: "none",
                    }}
                  >
                    {outlet.label}
                  </a>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && hidden > 0 && (
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

function ArticleCard({
  article,
  published,
  updatedAt,
  timeZone,
}: {
  article: Article;
  /** The slot's time — the group's, which may predate this article's own. */
  published: string;
  /** Newest coverage in the group, when later than the slot's time. */
  updatedAt: string | null;
  timeZone: string;
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
      {/* Wraps: the rail's gutter narrows the card on a phone, and a meta row
          that cannot wrap clips its own "more" control off the right edge. */}
      <div
        style={{
          marginTop: "0.25rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.25rem 0.5rem",
          alignItems: "center",
        }}
      >
        <small style={{ fontSize: "0.7rem", color: "var(--fg-faint)", fontVariantNumeric: "tabular-nums" }}>
          <time dateTime={published}>{timeLabel(published, timeZone)}</time>
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
  toggle,
  head,
  children,
}: {
  marker: string;
  big?: boolean;
  /**
   * A pointer shortcut on the rail marker for a control the entry's content
   * already carries — the day dot collapses its articles, the same thing
   * clicking the day's heading does.
   *
   * Deliberately NOT an accessible control of its own: two buttons for one
   * disclosure is two things to hear and one thing to do, and of the pair the
   * heading is the one that says what it collapses. So the dot leaves the a11y
   * tree and the tab order, and the heading speaks for both. That is also why
   * this needs no label or expanded state — ARIA on a hidden node says
   * nothing.
   */
  toggle?: () => void;
  /**
   * The part of the entry the marker centres on, for entries that grow
   * downward: `children` then renders below it without moving the glyph.
   * Omit it and the marker centres on the entry as a whole.
   */
  head?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Decorative for every other entry; a real button only where it does something,
  // so screen readers are not offered a dot per article.
  const markerStyle = {
    position: "absolute",
    left: markerLeft("1.4rem"),
    width: "1.4rem",
    textAlign: "center",
    color: "var(--fg)",
    background: "var(--bg)",
    fontSize: big ? "0.9rem" : "0.75rem",
    // Day markers anchor to their heading's line. Everything else centres on
    // its anchor box — `head` when the entry has one, otherwise the entry
    // itself, whose vertical padding is symmetric. Tall cards therefore carry
    // their dot lower down the rail than short ones.
    ...(big
      ? { top: "1.55rem" }
      : { top: "50%", transform: "translateY(-50%)", lineHeight: 1 }),
  } as const;

  const glyph = toggle ? (
    // A span, not a button: it is already out of the a11y tree, and a
    // FOCUSABLE node inside a hidden subtree is the worst of both — a mouse
    // click would move focus onto something that announces nothing. The
    // heading carries the keyboard path, so this needs only to be clickable.
    <span
      onClick={toggle}
      aria-hidden="true"
      style={{
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
    </span>
  ) : (
    <span aria-hidden="true" style={markerStyle}>
      {marker}
    </span>
  );

  return (
    <div style={{ position: "relative", padding: big ? "1.5rem 0 0.5rem" : "0.35rem 0" }}>
      {head === undefined ? (
        glyph
      ) : (
        // The marker's containing block, so its 50% resolves against the head
        // alone. Full-width and flush with the entry's content box, which keeps
        // markerLeft's offsets — measured from the entry — exact.
        <div style={{ position: "relative" }}>
          {glyph}
          {head}
        </div>
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

/** Same mark as the trending cloud's own "still gathering" state (§8.2). */
function SkeletonRail() {
  return (
    <div
      aria-label="Loading timeline"
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "3rem 0",
        color: "var(--fg-faint)",
      }}
    >
      <LoadingGlyph />
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
