import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import cloud from "d3-cloud";
import type { TrendingResponse, TrendingStoryline } from "@zammy/shared";
import type { StorylineOpenSource } from "./analytics.js";
import { fetchTrending } from "./api.js";
import { usePrefersReducedMotion } from "./browser.js";
import { cloudDetail, windowPhrase } from "./cloudLabels.js";
import { HOVER_CRAWL_RATE, boardWidth, laneDriftSeconds } from "./cloudBoard.js";
import { dealIntoLanes, edgeFades, laneCount, laneWidths } from "./cloudLanes.js";
import { FONT_MIN, fontSizes } from "./cloudFont.js";
import { layoutSeed } from "./layoutSeed.js";
import { LoadingGlyph } from "./LoadingGlyph.js";
import { MONO } from "./theme.js";

/**
 * The landing-page wordcloud (ARCHITECTURE 10.5): the STORYLINES the last 24
 * hours updated, drawn as their labels — sized by how many articles each gained
 * inside the window, coloured by how recently it moved, each word a real
 * <button> that opens the storyline it names.
 *
 * Two channels, one question each (ADR-0013). Size answers "how much is
 * happening", colour answers "how recently" — and keeping them independent is
 * why `rankColors` sorts by `lastUpdated` instead of reading array position.
 * The response arrives ranked by volume AND recency together (ADR-0014), so
 * position is no longer a recency signal; taking colour off the index is what
 * stops both channels from answering the same question.
 *
 * The click opens the storyline by UUID (ADR-0016, retracting ADR-0013's
 * search-not-UUID exception) — the same thing a label does everywhere else in
 * the app (ADR-0010, ADR-0011, and `StorylinePills`), because a label names
 * one specific arc and the UUID is exact, and a keyword search over its own
 * words routinely landed on an empty timeline instead of the arc it named.
 *
 * The words DRIFT, right to left, and that is what makes them a strip rather
 * than a picture: d3-cloud lays out a board wider than the window looking at
 * it (`cloudBoard`), and the board is drawn twice, side by side. Everything a
 * reader can see at once used to be everything there was; now the cloud
 * carries more storylines than the hero has room for, and gives them a turn
 * instead of shrinking all of them to fit.
 *
 * Each LANE travels at its own speed — a horizontal band of the board, packed
 * by its own d3-cloud run and moved as one piece (`cloudLanes`). The band is
 * the unit because it is the largest thing that can move without breaking the
 * layout: inside it nothing moves relative to anything else, so d3-cloud's
 * no-collision guarantee still holds, and two bands are disjoint slices of the
 * height, so they cannot reach each other however far apart they slide. Words
 * at their own speeds would leave the arrangement immediately, pass through
 * each other, and thin the board out as they sheared apart.
 *
 * The animation is still per WORD in the DOM — a lane is not an element, it is
 * a duration that a band's words happen to share. Both copies of a word cross
 * exactly one strip width per cycle, so at every instant one stands one strip
 * to the right of the other; when the pair restarts they swap places, and the
 * word is still where it was. Every lane's distance is identical and only the
 * duration differs (`cloudBoard`), which is what lets a few independent cycles
 * share one repeating board.
 *
 * Accessibility is not optional here (§10.5): a wordcloud is close to unusable
 * for screen readers, so the same data renders as an ordered list — always
 * present for assistive tech, toggleable visible for everyone. Size and colour
 * are decorative; the counts and the update time are the accessible signal.
 *
 * Motion that starts by itself and never stops needs a way out (WCAG 2.2.2),
 * and it has three: `prefers-reduced-motion` replaces the drift with a strip
 * the reader pans by hand, hovering the cloud pauses it under the pointer, and
 * the list toggle above hides it outright. The first is the one that matters —
 * the other two are for a reader who has not said anything.
 */

const POLL_INTERVAL_MS = 1500;
const POLL_MAX = 40; // the sample takes ~10–20s; stop asking after ~60s

/**
 * How much of the strip is on screen at once, and the width the viewport's
 * scale is taken against. The board itself is now as wide as its words need
 * (`boardWidth`); this is the window that travels along it, and it stays at
 * the 700px the whole cloud used to be so that a word is drawn at the size it
 * has always been drawn at.
 */
const VIEW_WIDTH = 700;
const LAYOUT_HEIGHT = 340;

/**
 * Blank strip between the end of one copy of the board and the start of the
 * next. The words inside a copy are kept 3px apart by d3-cloud's own padding;
 * across the seam nothing is, and the board's leftmost and rightmost words are
 * one frame apart there. Wide enough that the loop reads as the cloud coming
 * back around rather than as two words colliding.
 */
const SEAM_PX = 48;


/**
 * Warm→cool ramp keyed to RECENCY: what moved minutes ago burns red, what has
 * been quiet since yesterday morning cools to blue. Under the term cloud this
 * ramp keyed to score rank, which conflated volume with freshness; here it is
 * the channel that answers "how recently", and font size answers "how much".
 *
 * Decorative only (the cloud is aria-hidden); the list view keeps plain --fg
 * because mid-ramp hues (the yellow especially) don't clear body-text contrast.
 */
const PALETTE = [
  "#F94144",
  "#F3722C",
  "#F8961E",
  "#F9844A",
  "#F9C74F",
  "#90BE6D",
  "#43AA8B",
  "#4D908E",
  "#577590",
  "#277DA1",
] as const;

/**
 * Recency rank → palette bucket, ranked HERE rather than read off the array.
 *
 * Under ADR-0013 the response's own order was the recency rank and this
 * function was an index lookup. ADR-0014 ranks the response by volume and
 * recency together — so that `limit` still slices the storylines that matter
 * most — which leaves array position answering the same question size already
 * answers. Sorting by `lastUpdated` is what keeps the two channels apart.
 *
 * The cloud and the list still cannot disagree about which word is freshest:
 * both read this one map, keyed by UUID rather than by position.
 */
function rankColors(storylines: readonly TrendingStoryline[]): Map<string, string> {
  const byRecency = [...storylines].sort(
    (a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated),
  );
  return new Map(
    byRecency.map((storyline, index) => [
      storyline.id,
      PALETTE[
        Math.min(PALETTE.length - 1, Math.floor((index / byRecency.length) * PALETTE.length))
      ]!,
    ]),
  );
}

/**
 * One cloud per language (§10.1): a storyline enters a language's cloud through
 * the articles that covered it in that language, so the language is part of the
 * query key, not a filter applied after.
 */
export function useTrending(language: string) {
  const pollsUsed = useRef(0);
  // Per language, as useTimeline counts per topic: a budget carried over from
  // the cloud the reader was just looking at would strand the next language on
  // its first in_progress response — no polls left, so the cloud it is warming
  // never arrives and "gathering the latest news…" never resolves.
  useEffect(() => {
    pollsUsed.current = 0;
  }, [language]);

  return useQuery({
    queryKey: ["trending", language],
    queryFn: ({ signal }) => fetchTrending(language, signal),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchInterval: (query) => {
      const latest = query.state.data;
      if (!latest || latest.meta.ingest.state !== "in_progress") return false;
      if (pollsUsed.current >= POLL_MAX) return false;
      pollsUsed.current += 1;
      return POLL_INTERVAL_MS;
    },
  });
}

interface PlacedWord {
  storyline: TrendingStoryline;
  /** Which band it was laid out in, and so which speed it drifts at. */
  lane: number;
  /** From the strip's horizontal centre, as d3-cloud reports it. */
  x: number;
  /** From the middle of its LANE, as d3-cloud reports it within that band. */
  y: number;
  size: number;
}

/** Deterministic per language (see layoutSeed): no reshuffle per poll. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

export function TrendingCloud({
  language,
  onOpenStoryline,
}: {
  /** The cloud's language, already made concrete (see cloudLanguage). */
  language: string;
  onOpenStoryline: (storylineId: string, label: string | null, source: StorylineOpenSource) => void;
}) {
  const trending = useTrending(language);
  const [asList, setAsList] = useState(false);
  const [placed, setPlaced] = useState<PlacedWord[]>([]);
  // The stylesheet honours the same query for the drift itself; the hook is here
  // because the fallback is a different LAYOUT, not a paused one — a strip the
  // reader pans by hand, which CSS alone cannot swap in.
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const laneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [sectionWidth, setSectionWidth] = useState(VIEW_WIDTH);
  /** Each lane's own measured content width — see the layout effect below. */
  const [laneExtents, setLaneExtents] = useState<number[]>([]);

  // The layout always runs at the board's own width and the result is scaled
  // down to the viewport — re-running d3-cloud at the measured width would
  // break the deterministic per-language placement (§10.5).
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setSectionWidth(entries[0]?.contentRect.width ?? VIEW_WIDTH);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  /**
   * EACH LANE IS MEASURED SEPARATELY, and that is what keeps the board full.
   *
   * A lane wraps at its own content width. Wrapping every lane at the width of
   * the widest — or at the board the layout ran in — pads the short ones with
   * however much they fell short, and since the lanes are at different phases,
   * those gaps drift through the window independently: measured on the live
   * board, each lane's cluster filled about 60% of the strip, and the cloud
   * spent much of its time two-thirds empty. A lane that repeats at its own
   * length has no gap to show.
   *
   * d3-cloud does not confine word boxes to its size() — outer words routinely
   * overhang the box — so this is the RENDERED extent rather than the width the
   * lane was laid out in. offsetLeft/offsetWidth ignore transforms: with
   * left: calc(50% + x) and translate(-50%, -50%), offsetLeft IS the word's
   * centre in its copy's space. The centre is read off the copy rather than
   * assumed, which is what lets the measurement settle: the copy is drawn at
   * the width this measured last time, and measuring it again returns the same
   * number.
   */
  useLayoutEffect(() => {
    if (placed.length === 0) return;
    const measured = laneRefs.current.map((lane) => {
      const copy = lane?.children[0] as HTMLElement | undefined;
      if (!copy) return 0;
      const centre = copy.offsetWidth / 2;
      let half = 0;
      for (const child of copy.children) {
        const word = child as HTMLElement;
        half = Math.max(half, Math.abs(word.offsetLeft - centre) + word.offsetWidth / 2);
      }
      return half * 2;
    });
    setLaneExtents((current) =>
      current.length === measured.length && current.every((width, i) => width === measured[i])
        ? current
        : measured,
    );
  }, [placed, asList]);

  // The window travels along the strip, so it is the window — not the strip —
  // that has to fit. Scaling to the whole extent, which is what the fixed board
  // needed, would shrink a 60-word cloud to half the size of a 20-word one.
  const scale = Math.min(1, sectionWidth / VIEW_WIDTH);

  const data: TrendingResponse | undefined = trending.data;
  const storylines = data?.storylines ?? [];
  const board = boardWidth(storylines.length);
  const warming = data !== undefined && data.meta.ingest.state === "in_progress";
  const colors = rankColors(storylines);
  // Empty bounds only when there is no data, in which case there are no words
  // to label; `windowHours` falls back to 24 rather than rendering NaN.
  const bounds = data ?? { windowStart: "", windowEnd: "" };

  const lanes = laneCount(storylines.length);
  const laneHeight = LAYOUT_HEIGHT / lanes;
  /**
   * The width each band is laid out in — spread around the board's own width
   * rather than all alike, so the bands come back around at lengths that agree
   * only rarely (`cloudLanes`). Derived rather than stored: a function of the
   * language and the lane, so it is the same board on every poll.
   */
  const laneLayoutWidths = laneWidths(
    board,
    Array.from({ length: lanes }, (_, lane) =>
      seededRandom(`${data?.language ?? ""}:width:${lane}`)(),
    ),
  );

  /**
   * One copy of a lane: that lane's own extent, a seam, and — the floor that is
   * not cosmetic — never narrower than the window looking at it. A copy shorter
   * than the window leaves a band of nothing at the right edge for the last
   * stretch of every pass, because the second copy runs out before the first
   * has finished leaving. A compact cloud on a wide desktop is exactly that
   * case, and it is the one a phone never reproduces.
   *
   * Before the first measurement every lane claims the board it was laid out
   * in, which is never too SHORT — the wrong direction to be wrong in for one
   * frame.
   */
  const laneSpan = (lane: number) =>
    Math.max((laneExtents[lane] || laneLayoutWidths[lane] || board) + SEAM_PX, sectionWidth / scale);
  const widestLane = Math.max(...Array.from({ length: lanes }, (_, i) => laneSpan(i)));

  /**
   * THE WINDOW'S EDGES, ONE FADE PER LANE PER SIDE.
   *
   * Words used to be guillotined at the window's two edges: four rows ending in
   * half a word at exactly the same x, which reads as a rendering fault rather
   * than as a cloud passing by, and is what made the bands legible as bands. A
   * single fade for the whole board only softened that line — every row still
   * began and ended dissolving in the same two places. A fade per lane per side
   * (`cloudLanes.edgeFadePercent`) leaves nothing to line up: one lane is going
   * before another has begun.
   *
   * It is one mask on the WINDOW with a layer per lane, rather than a mask on
   * each lane, and that is not a tidying choice: a lane is the element that
   * moves, so a mask on it would travel with it and sweep its own fade across
   * the board. The layers are sized and placed to tile the window's height —
   * they meet exactly, so their union is the whole of it — and each carries its
   * own horizontal gradient. Held still for a reduced-motion reader the mask
   * stays put too: a mask on a scroll container is anchored to the box, not to
   * what has been scrolled past.
   */
  const edgeFadeMask = (() => {
    const bandHeight = (LAYOUT_HEIGHT * scale) / lanes;
    // Each side shuffled on its own, or a lane that is slow to let a word in
    // would be just as slow to let it out, and the two edges would rhyme.
    const picks = (side: string) =>
      Array.from({ length: lanes }, (_, lane) =>
        seededRandom(`${data?.language ?? ""}:fade:${side}:${lane}`)(),
      );
    const starts = edgeFades(lanes, picks("left"));
    const ends = edgeFades(lanes, picks("right"));
    const layers = Array.from({ length: lanes }, (_, lane) => ({
      image: `linear-gradient(to right, transparent, #000 ${starts[lane]}%, #000 ${100 - ends[lane]!}%, transparent)`,
      size: `100% ${bandHeight}px`,
      position: `0 ${lane * bandHeight}px`,
    }));
    const image = layers.map((layer) => layer.image).join(", ");
    const size = layers.map((layer) => layer.size).join(", ");
    const position = layers.map((layer) => layer.position).join(", ");
    // `no-repeat` is load-bearing: a mask layer tiles by default, and one
    // tiling band would cover the whole window and hide every other layer's
    // fade. The layers do not overlap, so the default compositing adds them.
    return {
      maskImage: image,
      maskSize: size,
      maskPosition: position,
      maskRepeat: "no-repeat",
      WebkitMaskImage: image,
      WebkitMaskSize: size,
      WebkitMaskPosition: position,
      WebkitMaskRepeat: "no-repeat",
    } as const;
  })();

  /**
   * Two copies is the loop — the second is the first one arriving again. Held
   * still, a lane instead tiles as far as the widest one, so the reader panning
   * the board by hand does not find the short lanes ending early.
   */
  const laneCopies = (lane: number) =>
    reduced ? Math.max(1, Math.ceil(widestLane / laneSpan(lane))) : 2;

  /**
   * A WORD BEING AIMED AT SLOWS TO A CRAWL — it does not stop.
   *
   * By playback RATE, which is the only way to change a running animation's
   * speed without moving it. `animation-duration` cannot: progress is elapsed ÷
   * duration, so lengthening the duration under a running animation recomputes
   * the fraction and every lane jumps backwards mid-stride, which is a worse
   * thing to do to a reader reaching for a word than anything it fixes.
   * `updatePlaybackRate` is the seamless form of the same change — the lane
   * keeps its position and only its speed moves.
   *
   * Every lane slows, not just the one under the pointer: a neighbouring band
   * still at full speed slides its own words over the one being aimed at.
   *
   * The cloud is aria-hidden and its words are not tabbable (the list below is
   * the keyboard path), so a pointer is the only thing that can be aiming at
   * one; there is no focus equivalent to mirror here.
   */
  const crawling = useRef(false);
  const setLaneRate = (rate: number) => {
    crawling.current = rate !== 1;
    for (const lane of laneRefs.current) {
      for (const animation of lane?.getAnimations() ?? []) {
        if (typeof animation.updatePlaybackRate === "function") animation.updatePlaybackRate(rate);
        else animation.playbackRate = rate;
      }
    }
  };

  // A commit that replaces the lane elements — a language change, a lane
  // opening or closing — hands back animations at full speed, under a pointer
  // that has not moved. Re-applied rather than remembered by the DOM.
  useLayoutEffect(() => {
    if (crawling.current) setLaneRate(HOVER_CRAWL_RATE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, lanes]);

  // Panning starts in the middle rather than at the left edge: d3-cloud fills
  // outward from the centre, so the edge a scroll container would otherwise
  // open on is the sparsest part of each lane.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !reduced) return;
    viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
  }, [reduced, placed, widestLane, scale]);

  // ONE LAYOUT PER LANE (§10.5), each in a band of its own width. The board is
  // cut into bands first and each band is packed on its own, which is what
  // makes a lane safe to move as a unit: d3-cloud's no-collision guarantee
  // holds inside one, and two bands are disjoint slices of the height, so they
  // cannot reach each other however far they slide. See `cloudLanes` for why
  // the bands cannot instead be found in a finished board.
  //
  // The lanes are independent runs, so the words arrive in as many batches as
  // there are lanes. They are gathered and committed ONCE, when the last one
  // ends: a lane at a time would render a board that fills in stripes, and
  // every partial commit would re-measure the strip (see the layout effect
  // above) at a width that is about to change.
  useEffect(() => {
    if (storylines.length === 0) {
      setPlaced([]);
      return;
    }
    // The narrowest band, not the board: the clamp is what keeps a long label
    // placeable, and a word may be dealt into any lane (see `wordFit`).
    const sizes = fontSizes(storylines, Math.min(...laneLayoutWidths));
    // d3-cloud identifies a word by its `text`, so the layout is keyed on the
    // label while everything else here is keyed on the UUID. Labels are
    // deliberately non-unique (ADR-0011) — the API keeps one word per label so
    // this mapping stays one-to-one (see `dedupeByLabel`).
    const byLabel = new Map(storylines.map((s) => [s.label, s]));
    const dealt = dealIntoLanes(storylines, laneLayoutWidths);
    const seed = layoutSeed({ language: data?.language ?? "" });
    const gathered: PlacedWord[][] = dealt.map(() => []);
    let pending = dealt.length;

    const layouts = dealt.map((laneWords, lane) =>
      cloud()
        .size([laneLayoutWidths[lane] ?? board, laneHeight])
        .words(laneWords.map((s) => ({ text: s.label, size: sizes.get(s.id) })))
        .padding(3)
        .rotate(0)
        .font(MONO)
        .fontSize((d) => d.size ?? FONT_MIN)
        // Per lane, or every band spirals into the same pattern and the cloud
        // reads as one picture repeated down the board.
        .random(seededRandom(`${seed}:lane:${lane}`))
        .on("end", (words) => {
          gathered[lane] = words.flatMap((w) => {
            const storyline = w.text === undefined ? undefined : byLabel.get(w.text);
            return storyline && w.x !== undefined && w.y !== undefined && w.size !== undefined
              ? [{ storyline, lane, x: w.x, y: w.y, size: w.size }]
              : [];
          });
          pending -= 1;
          if (pending === 0) setPlaced(gathered.flat());
        }),
    );
    for (const layout of layouts) layout.start();
    return () => {
      for (const layout of layouts) layout.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.language, lanes, JSON.stringify(storylines.map((s) => s.label))]);

  if (trending.isError) return null; // the landing page still works as a search box

  return (
    <section
      ref={sectionRef}
      aria-label={
        data
          ? `Storylines updated in ${windowPhrase(data)}`
          : "Storylines updated in the last 24 hours"
      }
      style={{ width: "100%", maxWidth: "760px" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          fontFamily: MONO,
          fontSize: "0.8rem",
          color: "var(--fg-faint)",
        }}
      >
        {/* A language upstream barely covers can finish its sample with
            nothing to show. Saying so is the honest end state — the reader
            still has the search box, and silence over an empty board reads as
            a cloud that failed to draw. */}
        <span>
          {data !== undefined && !warming && storylines.length === 0
            ? "no storylines yet"
            : ""}
        </span>
        {storylines.length > 0 && (
          <button
            onClick={() => setAsList(!asList)}
            aria-pressed={asList}
            aria-label={asList ? "View as cloud" : "View as list"}
            title={asList ? "View as cloud" : "View as list"}
            style={{
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              padding: "0.25rem",
              display: "flex",
              alignItems: "center",
            }}
          >
            {asList ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <path
                  d="M5.5 13.5a3 3 0 1 1 .43-5.97 4 4 0 0 1 7.77 1.06A2.5 2.5 0 0 1 13 13.5H5.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <circle cx="3" cy="4.5" r="1.25" fill="currentColor" />
                <circle cx="3" cy="9" r="1.25" fill="currentColor" />
                <circle cx="3" cy="13.5" r="1.25" fill="currentColor" />
                <line x1="6.5" y1="4.5" x2="16" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="6.5" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="6.5" y1="13.5" x2="16" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
          </button>
        )}
      </div>

      {!asList && (
        <div
          ref={viewportRef}
          aria-hidden="true"
          onMouseEnter={() => setLaneRate(HOVER_CRAWL_RATE)}
          onMouseLeave={() => setLaneRate(1)}
          style={{
            position: "relative",
            width: "100%",
            height: `${LAYOUT_HEIGHT * scale}px`,
            // The window onto the strip. Hidden while it drifts by itself;
            // pannable when it does not, which is the reduced-motion reader's
            // way of reaching the far end. `contain` so that panning to that
            // end does not hand the overscroll to the browser's back gesture.
            overflowX: reduced ? "auto" : "hidden",
            overflowY: "hidden",
            overscrollBehaviorX: "contain",
            ...edgeFadeMask,
          }}
        >
          {placed.length > 0 && (
            // Three layers, one job each, because two of them want the
            // `transform` property and only one of them can have it: the sizer
            // states the on-screen size (and so what there is to pan over), the
            // scaler holds the viewport fit, and each lane holds its own drift.
            <div
              className="cloud-strip"
              style={{
                position: "relative",
                width: `${widestLane * scale}px`,
                height: `${LAYOUT_HEIGHT * scale}px`,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: `${widestLane}px`,
                  height: `${LAYOUT_HEIGHT}px`,
                  transform: `scale(${scale})`,
                  transformOrigin: "left top",
                  // A lane is two copies wide and hangs out of this box; held
                  // still, that overhang is what the reader would otherwise be
                  // able to pan into — a second helping of the lanes that
                  // happened to be short. Clipped here rather than on each
                  // lane, which would have to clip vertically too and words
                  // legitimately overhang their band.
                  overflow: "hidden",
                }}
              >
                {Array.from({ length: lanes }, (_, lane) => {
                  const span = laneSpan(lane);
                  const copies = laneCopies(lane);
                  return (
                    /* One lane, one marquee. Its width is exactly its copies,
                       so `translateX(-50%)` of a two-copy lane is one copy —
                       the only translation that puts the second copy where the
                       first began and leaves no seam to see. The copies are
                       what make the loop; the animation is what moves it. */
                    <div
                      key={lane}
                      ref={(el) => {
                        laneRefs.current[lane] = el;
                      }}
                      className={reduced ? undefined : "cloud-lane"}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: `${lane * laneHeight}px`,
                        display: "flex",
                        width: `${span * copies}px`,
                        height: `${laneHeight}px`,
                        ["--cloud-lane-duration" as string]: `${laneDriftSeconds(
                          span,
                          seededRandom(`${data?.language ?? ""}:lane:${lane}`)(),
                        )}s`,
                      }}
                    >
                      {Array.from({ length: copies }, (_, copy) => (
                        <div
                          key={copy}
                          style={{
                            position: "relative",
                            flex: "none",
                            width: `${span}px`,
                            height: `${laneHeight}px`,
                          }}
                        >
                          {placed
                            .filter((word) => word.lane === lane)
                            .map((word) => (
                              <button
                                key={word.storyline.id}
                                tabIndex={-1}
                                onClick={() =>
                                  onOpenStoryline(
                                    word.storyline.id,
                                    word.storyline.label,
                                    "hero_cloud",
                                  )
                                }
                                title={cloudDetail(word.storyline, bounds)}
                                style={{
                                  position: "absolute",
                                  left: `calc(50% + ${word.x}px)`,
                                  top: `${laneHeight / 2 + word.y}px`,
                                  transform: "translate(-50%, -50%)",
                                  border: "none",
                                  background: "none",
                                  cursor: "pointer",
                                  fontFamily: MONO,
                                  fontSize: `${word.size}px`,
                                  lineHeight: 1,
                                  whiteSpace: "nowrap",
                                  color: colors.get(word.storyline.id) ?? "var(--fg)",
                                  padding: 0,
                                }}
                              >
                                {word.storyline.label}
                              </button>
                            ))}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(warming || data === undefined) && placed.length === 0 && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                color: "var(--fg-faint)",
              }}
            >
              <LoadingGlyph />
            </div>
          )}
        </div>
      )}

      {/* The accessible equivalent (§10.5): always in the tree for assistive
          tech; the toggle above makes it visible for everyone. The COUNTS and
          the update time are the signal — size and colour never carry meaning
          alone, and the ranking they stand in for is not legible as either. */}
      {storylines.length > 0 && (
        <ol
          className={asList ? undefined : "sr-only"}
          style={
            asList
              ? {
                  columns: 2,
                  columnGap: "3rem",
                  width: "max-content",
                  maxWidth: "100%",
                  margin: "1rem auto 0",
                  paddingLeft: "1.5rem",
                  fontFamily: MONO,
                  fontSize: "0.95rem",
                }
              : undefined
          }
        >
          {storylines.map((storyline) => (
            <li key={storyline.id} style={{ marginBottom: "0.3rem" }}>
              <button
                onClick={() => onOpenStoryline(storyline.id, storyline.label, "hero_cloud")}
                style={{
                  border: "none",
                  background: "none",
                  color: "var(--fg)",
                  cursor: "pointer",
                  fontFamily: MONO,
                  fontSize: "inherit",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                {storyline.label}
              </button>{" "}
              <span style={{ color: "var(--fg-faint)" }}>
                — {storyline.size} article{storyline.size === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
