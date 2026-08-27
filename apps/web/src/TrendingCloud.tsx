import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import cloud from "d3-cloud";
import type { TrendingResponse, TrendingStoryline } from "@zammy/shared";
import { fetchTrending } from "./api.js";
import { cloudDetail, windowPhrase } from "./cloudLabels.js";
import { FONT_MIN, fontSizes } from "./cloudFont.js";
import { layoutSeed } from "./layoutSeed.js";
import { LoadingGlyph } from "./LoadingGlyph.js";
import { MONO } from "./theme.js";

/**
 * The landing-page wordcloud (ARCHITECTURE 10.5): the STORYLINES the last 24
 * hours updated, drawn as their labels — sized by how many articles each gained
 * inside the window, coloured by how recently it moved, each word a real
 * <button> that runs the search.
 *
 * Two channels, one question each (ADR-0013). Size answers "how much is
 * happening", colour answers "how recently" — and keeping them independent is
 * why `rankColors` sorts by `lastUpdated` instead of reading array position.
 * The response arrives ranked by volume AND recency together (ADR-0014), so
 * position is no longer a recency signal; taking colour off the index is what
 * stops both channels from answering the same question.
 *
 * The click runs a SEARCH rather than opening the storyline, and this is the one
 * place in the app that does. Everywhere else a label opens its storyline by
 * UUID (ADR-0010, ADR-0011, and `StorylinePills`), because a label names one
 * specific arc and the UUID is exact. The cloud is the exception on purpose: it
 * is also the cold-start answer (§9.3), and a click that opens a storyline mints
 * no topic and feeds the demand-driven loop nothing.
 *
 * What it searches is `storyline.query`, not the label the button draws — the
 * label's own words that its coverage actually says, resolved by the API
 * (`cloudQuery`). Drawing one string and searching another is a real cost, and
 * it buys the thing the cloud existed for: a four-word label run verbatim is
 * four conjunctive upstream terms and returns an empty timeline (ADR-0014).
 *
 * Accessibility is not optional here (§10.5): a wordcloud is close to unusable
 * for screen readers, so the same data renders as an ordered list — always
 * present for assistive tech, toggleable visible for everyone. Size and colour
 * are decorative; the counts and the update time are the accessible signal.
 */

const POLL_INTERVAL_MS = 1500;
const POLL_MAX = 40; // the sample takes ~10–20s; stop asking after ~60s

const LAYOUT_WIDTH = 700;
const LAYOUT_HEIGHT = 340;

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
  x: number;
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
  onSearch,
}: {
  /** The cloud's language, already made concrete (see cloudLanguage). */
  language: string;
  onSearch: (q: string) => void;
}) {
  const trending = useTrending(language);
  const [asList, setAsList] = useState(false);
  const [placed, setPlaced] = useState<PlacedWord[]>([]);
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [sectionWidth, setSectionWidth] = useState(LAYOUT_WIDTH);
  const [contentWidth, setContentWidth] = useState(LAYOUT_WIDTH);

  // The layout always runs at LAYOUT_WIDTH and the result is scaled down to
  // the viewport — re-running d3-cloud at the measured width would break the
  // deterministic per-language placement (§10.5).
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setSectionWidth(entries[0]?.contentRect.width ?? LAYOUT_WIDTH);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  // d3-cloud does not confine word boxes to its size() — outer words routinely
  // overhang the 700px box, so the scale must come from the rendered extent.
  // offsetLeft/offsetWidth ignore transforms: with left: calc(50% + x) and
  // translate(-50%, -50%), offsetLeft IS the word's center in stage space.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let half = LAYOUT_WIDTH / 2;
    for (const child of stage.children) {
      const word = child as HTMLElement;
      half = Math.max(
        half,
        Math.abs(word.offsetLeft - LAYOUT_WIDTH / 2) + word.offsetWidth / 2,
      );
    }
    setContentWidth(half * 2);
  }, [placed, asList]);

  const scale = Math.min(1, sectionWidth / contentWidth);

  const data: TrendingResponse | undefined = trending.data;
  const storylines = data?.storylines ?? [];
  const warming = data !== undefined && data.meta.ingest.state === "in_progress";
  const colors = rankColors(storylines);
  // Empty bounds only when there is no data, in which case there are no words
  // to label; `windowHours` falls back to 24 rather than rendering NaN.
  const bounds = data ?? { windowStart: "", windowEnd: "" };

  useEffect(() => {
    if (storylines.length === 0) {
      setPlaced([]);
      return;
    }
    const sizes = fontSizes(storylines, LAYOUT_WIDTH);
    // d3-cloud identifies a word by its `text`, so the layout is keyed on the
    // label while everything else here is keyed on the UUID. Labels are
    // deliberately non-unique (ADR-0011) — the API keeps one word per label so
    // this mapping stays one-to-one (see `dedupeByLabel`).
    const byLabel = new Map(storylines.map((s) => [s.label, s]));
    const layout = cloud()
      .size([LAYOUT_WIDTH, LAYOUT_HEIGHT])
      .words(storylines.map((s) => ({ text: s.label, size: sizes.get(s.id) })))
      .padding(3)
      .rotate(0)
      .font(MONO)
      .fontSize((d) => d.size ?? FONT_MIN)
      .random(seededRandom(layoutSeed({ language: data?.language ?? "" })))
      .on("end", (words) => {
        setPlaced(
          words.flatMap((w) => {
            const storyline = w.text === undefined ? undefined : byLabel.get(w.text);
            return storyline && w.x !== undefined && w.y !== undefined && w.size !== undefined
              ? [{ storyline, x: w.x, y: w.y, size: w.size }]
              : [];
          }),
        );
      });
    layout.start();
    return () => {
      layout.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.language, JSON.stringify(storylines.map((s) => s.label))]);

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
            ? "no storylines have moved in this language yet"
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
          aria-hidden="true"
          style={{
            position: "relative",
            width: "100%",
            height: `${LAYOUT_HEIGHT * scale}px`,
            overflow: "hidden",
          }}
        >
          {/* Fixed-size stage: words keep their layout coordinates; the stage
              shrinks as one unit. Center-top origin + translateX(-50%) keeps
              it horizontally centered at every scale. */}
          <div
            ref={stageRef}
            style={{
              position: "absolute",
              left: "50%",
              top: 0,
              width: `${LAYOUT_WIDTH}px`,
              height: `${LAYOUT_HEIGHT}px`,
              transform: `translateX(-50%) scale(${scale})`,
              transformOrigin: "center top",
            }}
          >
            {placed.map((word) => (
              <button
                key={word.storyline.id}
                tabIndex={-1}
                onClick={() => onSearch(word.storyline.query)}
                title={cloudDetail(word.storyline, bounds)}
                style={{
                  position: "absolute",
                  left: `calc(50% + ${word.x}px)`,
                  top: `${LAYOUT_HEIGHT / 2 + word.y}px`,
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
                onClick={() => onSearch(storyline.query)}
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
                — {cloudDetail(storyline, bounds)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
