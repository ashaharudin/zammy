import { useEffect, useMemo, useRef, useState } from "react";
import type { Article, TimelineEntry } from "@zammy/shared";
import { isTerminalPage } from "@zammy/shared";
import { ApiError, type TopicQuery } from "./api.js";
import { readTimeZone } from "./browser.js";
import { isCollapsed, nothingCollapsed, segmentKey, toggle } from "./dayCollapse.js";
import {
  groupByDay,
  hasLaterCoverage,
  readerDayKey,
  relativeTime,
  timeLabel,
  type RailSlot,
  type Segment,
} from "./format.js";
import { mergeMemberships, rowMembership, type PageMemberships } from "./memberships.js";
import { braidOnRule, StorylineBraid } from "./StorylineBraid.js";
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
  // Stable while the query's data is: everything downstream of this list is
  // memoised on its identity, down to the rail's own grouping, and a fresh array
  // per render would defeat all of it.
  const items = useMemo(() => pages.flatMap((page) => page.items), [timeline.data]);
  const { visible, newCount, reveal } = useHeldNewItems(items, JSON.stringify(topic));
  const surfaced = latest?.storylines ?? [];
  // Merged over every LOADED page, not just the newest: `items` above is every
  // page's slots flattened, so a slot from page one must still find its group's
  // arcs after page four has arrived.
  const memberships = useMemo(() => mergeMemberships(pages), [timeline.data]);
  // The date qualifier each storyline needs, computed over everything ON SCREEN
  // together — slots and pills alike — because "is this label ambiguous" is the
  // condition ADR-0011 attaches the disambiguator to, and it is a question
  // about the set rather than about any one storyline.
  const qualifiers = storylineQualifiers(visibleStorylines(visible, surfaced));
  const storylineView = topic.q === "" && topic.storyline !== undefined;
  const ingesting = latest?.meta.ingest.state === "in_progress";
  const terminal = latest !== undefined && !timeline.hasNextPage && isTerminalPage(latest);

  // Plain refetch(), same as ErrorState's retry: v5 dropped per-page refetch
  // filtering for infinite queries, so this re-runs every loaded page rather
  // than just the newest. Deliberate here and only here — a pull is one
  // gesture, and re-chaining every cursor is exactly what repairs a window the
  // ingest poll held still (`splicePolledPage`). The poll itself no longer
  // does this: forty of these a minute is the fan-out issue #211 named.
  usePullToRefresh(
    () => void timeline.refetch(),
    timeline.isPending || timeline.isFetching,
  );

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
            memberships={memberships}
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
 *
 * The gate is on SLOTS, and one thing now slips past it: a poll that adds an
 * article to a slot already on screen leaves that slot's own `published` where
 * it was, so the slot passes through — and the rail may then draw the article
 * as a card of its own above the one the reader is looking at, or, if it is the
 * earliest thing in a part of the day already drawn, take that card's headline
 * (`RailSlot`). The headline case remounts rather than mutating, since the
 * card's key carries it. Accepted for now, and only inside the ingest window:
 * `refetchOnWindowFocus` is off and the poll runs only while ingest is in
 * progress, so the rail is visibly growing whenever this can happen. Closing it
 * needs a different notion of "seen" than this anchor can carry: an article
 * inside a slot has no position on the slot axis, and the first paint's own
 * coverage is routinely newer than its newest slot — so gating coverage by
 * this timestamp would hold back content that arrived WITH the first response.
 * What it would take is the set of article ids already rendered, narrowed to
 * slots already seen so that an appended older page still paints straight
 * through.
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
  return useMemo(() => {
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
  }, [items, effective, newest]);
}

/** Ignore further pull gestures for this long after one fires a refetch. */
const PULL_REFRESH_COOLDOWN_MS = 4000;
/** How far a touch has to drag down, at the top, before it counts as a pull. */
const PULL_DOWN_THRESHOLD_PX = 60;
/** Matches PULL_DOWN_THRESHOLD_PX's deliberateness on the wheel side. */
const WHEEL_UP_THRESHOLD = 20;

/**
 * True if `target` sits inside an element with scroll of its own (e.g. the
 * command bar's `role="listbox"` filter dropdown, FilterChipRow.tsx) — the
 * page being at scrollY 0 doesn't mean the gesture is meant for the PAGE.
 * A pull-to-refresh listening on `window` can't otherwise tell "scrolling
 * the dropdown" from "scrolling the rail" apart.
 */
function withinNestedScroll(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const scrollsY = style.overflowY === "auto" || style.overflowY === "scroll";
    if (scrollsY && node.scrollHeight > node.clientHeight) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Pull-to-refresh: scrolling up (mouse wheel) or dragging down (touch) while
 * already at the top of the page re-queries page 0 for new articles — the
 * same check the ingest poll runs on a timer, fired instead by the reader's
 * own gesture. Results land behind the existing "N new articles" pill
 * (useHeldNewItems) rather than splicing in, same as any other arrival.
 *
 * `onRefresh` and `disabled` are read through refs rather than as effect
 * deps: both change on every render (a fresh closure, timeline.isFetching
 * ticking through a poll), and re-subscribing window listeners on every
 * render is pure churn for a callback the trigger only needs at the moment
 * a gesture fires.
 */
function usePullToRefresh(onRefresh: () => void, disabled: boolean) {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const lastTriggered = { current: 0 };
    const touchStartY = { current: null as number | null };
    const atTop = () => window.scrollY <= 0;
    const trigger = () => {
      if (disabledRef.current) return;
      const now = Date.now();
      if (now - lastTriggered.current < PULL_REFRESH_COOLDOWN_MS) return;
      lastTriggered.current = now;
      onRefreshRef.current();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < -WHEEL_UP_THRESHOLD && atTop() && !withinNestedScroll(event.target)) {
        trigger();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      // Two+ fingers is a pinch, not a pull — never arm the gesture for one.
      touchStartY.current =
        event.touches.length === 1 && atTop() && !withinNestedScroll(event.target)
          ? (event.touches[0]?.clientY ?? null)
          : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchStartY.current === null || event.touches.length !== 1) return;
      const y = event.touches[0]?.clientY;
      if (y !== undefined && y - touchStartY.current > PULL_DOWN_THRESHOLD_PX && atTop()) {
        trigger();
      }
    };
    const onTouchEnd = () => {
      touchStartY.current = null;
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);
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
  memberships,
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
  /** Which storylines each group on the page is filed in (ADR-0025). */
  memberships: PageMemberships;
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
  // Memoised because it is no longer cheap: cutting slots into cards reads the
  // zone's hour and day for every ARTICLE, not every slot, and `Rail` re-renders
  // on every collapse click and every 1.5s ingest poll. Measured at 200 slots
  // carrying 26 rows each, one pass is 16.5ms; nothing about a collapse click
  // changes its answer. `now` is deliberately not a dependency — the only thing
  // it decides is which day is called "Today", and `todayKey` is that question
  // asked directly, so the labels still move at local midnight.
  const todayKey = readerDayKey(now, timeZone);
  const days = useMemo(() => groupByDay(items, now, timeZone), [items, timeZone, todayKey]);

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
      {days.map((day) => {
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
                  <Wrapper
                    key={key}
                    {...(segmented
                      ? { "aria-label": `${part.segment}${day.dateSuffix ? `, ${day.dateSuffix}` : ""}` }
                      : {})}
                  >
                    {segmented && (
                      <SegmentDivider
                        segment={part.segment}
                        dateSuffix={day.dateSuffix}
                        count={part.items.length}
                        collapsed={partCollapsed}
                        onToggle={() => setCollapsed((sections) => toggle(sections, key))}
                      />
                    )}
                    {!partCollapsed &&
                      part.items.map((slot) => (
                        <GroupCard
                          // NOT `storylineId` alone, and no longer the slot's
                          // time either: `key` is unique per slot AND per part
                          // of the day, since one slot can now draw a card in
                          // more than one of them.
                          key={slot.key}
                          entry={slot}
                          onOpenStorylineView={onOpenStorylineView}
                          qualifiers={qualifiers}
                          memberships={memberships}
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
      {/*
        `hasNextPage` ALONE — the state model at the top of this file, not a
        second copy of its argument. ANDing it with `!ingesting` hid the whole
        tail for the minutes `in_progress` can last, leaving a reader at the
        first page with the rest a cursor away (§8.2).
      */}
      {hasNextPage && (
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
 * One card on the rail (§14.3, ADR-0009): a slot's coverage of one part of the
 * reader's day (`RailSlot`) — its headline article, with the rest of that
 * part's coverage behind one disclosure in two sections, "same story" (the
 * lead group's other copies) and "more coverage" (the storyline's other
 * groups: retrospectives, follow-ups, fact-checks).
 *
 * The time shown is the CARD's earliest article, not necessarily the headline's
 * own — a card showing "3 hours ago" beneath rows from five hours ago reads as
 * a bug. Later coverage in the same part of the day surfaces as an "updated"
 * stamp instead, the same treatment §8.1 gives a re-emitted article; coverage
 * that reached a LATER part is not counted here at all, since the card heading
 * that part carries it.
 *
 * A slot with wider coverage also carries its storyline phrase, hanging in the
 * gutter on the far side of the spine (ADR-0010): the day's story has a name,
 * and the name is a search.
 */
function GroupCard({
  entry,
  onOpenStorylineView,
  qualifiers,
  memberships,
  timeZone,
  relatedLevel,
}: {
  entry: RailSlot;
  onOpenStorylineView: (storylineId: string) => void;
  /** storyline id → the date that separates it from its namesakes on screen. */
  qualifiers: Map<string, string>;
  /** Which storylines each group on the page is filed in (ADR-0025). */
  memberships: PageMemberships;
  /** The reader's zone, so a card's clock agrees with the day it sits under. */
  timeZone: string;
  /** The heading level for this card's own disclosures — one below its head. */
  relatedLevel: "h3" | "h4";
}) {
  const [showRelated, setShowRelated] = useState(false);
  // Asked of THIS CARD's headline group, not the slot's lead: the rail cuts a
  // slot into parts of the reader's day, and a card cut out of a later part is
  // headed by a different group with memberships of its own (`format.ts`).
  const braid = rowMembership(memberships, entry.article.groupId, entry.storylineId);
  const updated = hasLaterCoverage(entry);
  // What this card holds — coverage that landed in a later part of the day is
  // counted by the card that heads that part, so the disclosure never promises
  // rows the reader has to leave the card to find.
  const total = entry.related.length + entry.moreCoverage.length;

  return (
    <RailEntry
      // A slot that crosses nothing keeps the ○ the rail has always drawn and
      // costs the reader nothing, which is the whole of why this treatment went
      // on the spine rather than into the gutter (S9's verdict).
      marker={
        braid.ticks.length > 0 ? (
          <StorylineBraid
            membership={braid}
            subject="This article"
            onOpenStoryline={onOpenStorylineView}
          />
        ) : (
          "○"
        )
      }
      markerControl={braid.ticks.length > 0}
      // The headline card alone is the marker's anchor: the disclosure and the
      // rows it opens are content BELOW the article, and a glyph that slid down
      // to the middle of an expanded slot would no longer point at anything.
      head={
        <div style={{ maxWidth: "640px" }}>
          {/*
            The gutter holds the storyline's label, on every CARD of a labelled
            storyline — universal, where ADR-0010's phrase appeared only on
            slots with wider coverage, because a label is an identity rather
            than a lucky bigram. A slot cut across parts of the day repeats it
            per card, which is the point rather than a cost: a card headed by a
            promoted follow-up has nothing else on it to say which story it
            continues. An unlabelled storyline leaves the gutter empty, which is
            what "invisible as a storyline" looks like.
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
                padding: `0 0 0 ${DISCLOSURE_INSET}`,
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
                  // Only THIS section gets marks. "Same story" is the lead
                  // group's own members, so those rows are in exactly the
                  // headline's storylines and have nothing of their own to
                  // report (ADR-0025); "more coverage" is every other group in
                  // the slot, each with its own memberships, and this is where
                  // most of the crossings actually are.
                  mark={(article) => {
                    const membership = rowMembership(
                      memberships,
                      article.groupId,
                      entry.storylineId,
                    );
                    // Most rows cross nothing. Answering null rather than a
                    // braid that renders null is what lets such a row keep the
                    // DOM it has always had.
                    if (membership.ticks.length === 0) return null;
                    return (
                      <StorylineBraid
                        membership={membership}
                        subject={`“${article.title}”`}
                        onOpenStoryline={onOpenStorylineView}
                        dense
                      />
                    );
                  }}
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
  dateSuffix,
  count,
  collapsed,
  onToggle,
}: {
  segment: Segment;
  dateSuffix: string | null;
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
        {/*
          Beyond Today/Yesterday, a segment is one of many identically-named
          ones down the rail — the day heading above it is the only thing
          disambiguating "Morning" from any other day's — so it carries its
          own date, uppercased like the rest of the heading.
        */}
        {dateSuffix && <span style={{ opacity: 0.7 }}>, {dateSuffix}</span>}
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
 * The disclosure's own geometry: how far its content clears the hairline down
 * its left, and the type the rows are set in.
 *
 * Named because two other things now measure from them — the mark hung on the
 * rule, and the height it centres in — and a literal repeated in three places
 * is two chances to move one of them alone.
 */
const DISCLOSURE_INSET = "0.9rem";
const ROW_FONT_SIZE = "0.85rem";
const ROW_LINE_HEIGHT = 1.3;

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
  mark,
}: {
  label: string;
  articles: Article[];
  timeZone: string;
  /** h4 beneath a segment's h3, h3 beneath a bare day's h2. */
  level: "h3" | "h4";
  softCap?: boolean;
  /**
   * A mark hung on the disclosure's hairline beside one row — the spine braid,
   * one level down. Takes the ROW's leading article, because a row's group is
   * what the mark is about and `collapseCopies` folds within a group.
   *
   * Rendering nothing is the normal answer and must stay cheap: a mark on every
   * row would be a new glyph reporting no news.
   */
  mark?: (article: Article) => React.ReactNode;
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
          {capped.map(({ article, copies }) => {
            // Asked once and used twice: a row with nothing to report must not
            // get the box either. The box carries `--bg` to mask the hairline,
            // and a hole punched in the rule for every coverage row is exactly
            // the "reports no news" glyph this section refuses to draw. It is
            // zero-width today, so that is a latent hole rather than a visible
            // one — and it is the width that is the accident.
            const badge = mark?.(article) ?? null;
            return (
            <li key={article.id} style={badge ? { position: "relative" } : undefined}>
              {badge && (
                // Hung ON the hairline, the way the rail's glyphs are hung on
                // the spine: this section already has a vertical rule down its
                // left (the container in `GroupCard`), so the idiom carries over
                // rather than being invented again. The background masks the
                // rule where the ticks cross it.
                //
                // `braidOnRule` owns the horizontal, because only the braid
                // knows its own tick width, and it lands on the rule exactly.
                //
                // The vertical is CLOSE and not exact, which is worth saying in
                // a file whose rule is "derive, don't tune". It pins the box's
                // middle to half the row's own type height and lets the box size
                // itself — the sizing is the part that matters, because a braid
                // grows with the arc count and a box fixed at one line's height
                // stopped covering the ticks at four arcs, letting the hairline
                // show through the gaps. But the `<li>`'s first LINE BOX is set
                // by its own inherited strut, not by the `line-height` on the
                // `<a>` this measures, so the glyph sits ~0.9px high. Deriving
                // it properly needs a value CSS will not hand us here; a
                // measured constant would buy that pixel by breaking the rule
                // the rest of this file keeps.
                <span
                  style={{
                    position: "absolute",
                    left: braidOnRule(DISCLOSURE_INSET),
                    top: `calc(${ROW_FONT_SIZE} * ${ROW_LINE_HEIGHT} / 2)`,
                    transform: "translateY(-50%)",
                    background: "var(--bg)",
                    lineHeight: 0,
                    // THE SAME TRAP THE RAIL MARKER HAS. Before this box had a
                    // transform or a z-index, nothing between it and the
                    // document created a stacking context, so the popover's 20
                    // competed in the ROOT — above the sticky command bar's 10,
                    // which it painted over as the reader scrolled (measured:
                    // 208×63px of the bar covered).
                    //
                    // Still load-bearing now that the centring transform above
                    // makes a context anyway: the transform decides that the
                    // popover is CAPPED here, and this decides what level "here"
                    // is. Drop it and the box falls to level 0 in tree order and
                    // the next row's card paints over the popover instead. Two
                    // is where the rail's own marker sits, and under the command
                    // bar's 10.
                    zIndex: 2,
                  }}
                >
                  {badge}
                </span>
              )}
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: ROW_FONT_SIZE,
                  lineHeight: ROW_LINE_HEIGHT,
                  textDecoration: "none",
                }}
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
            );
          })}
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
  /**
   * The card's time: for a lead card the slot's own, which may predate this
   * article's; for one cut out of a later part of the day, this article's own
   * (it heads that part because it is the earliest thing in it).
   */
  published: string;
  /** Newest article in the CARD, when later than the card's time. */
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
  markerControl,
  big,
  toggle,
  head,
  children,
}: {
  marker: React.ReactNode;
  /**
   * The marker is a CONTROL of its own — the spine braid — so the box around it
   * stays in the accessibility tree and keeps its own label and expanded state.
   *
   * The opposite of `toggle` below, deliberately: that one is a pointer
   * shortcut for a control the entry already carries, and is hidden. This one
   * IS the only way to what it opens, so hiding it would put the crossings out
   * of reach of the keyboard entirely.
   */
  markerControl?: boolean;
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
    // The centring transform below makes this box a STACKING CONTEXT, which
    // traps anything hung off the marker: the braid's popover sets `z-index:
    // 20` and is still painted over by the next row's card, because 20 only
    // orders it against its siblings INSIDE this box while the box itself sits
    // at level 0 in tree order. This is what lifts the box — and everything in
    // it — over the cards below, and it stays under the command bar's 10.
    zIndex: 2,
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
    <span {...(markerControl ? {} : { "aria-hidden": true })} style={markerStyle}>
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
