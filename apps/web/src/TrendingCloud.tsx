import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import cloud from "d3-cloud";
import type { TrendingResponse, TrendingTerm } from "@zammy/shared";
import { fetchTrending } from "./api.js";
import { MONO } from "./theme.js";

/**
 * The landing-page wordcloud (ARCHITECTURE 10.5): the day's most-referenced
 * topics, sized by unique articles, each word a real <button> that runs the
 * search — the cloud feeds the demand-driven loop.
 *
 * Accessibility is not optional here (§10.5): a wordcloud is close to
 * unusable for screen readers, so the same data renders as an ordered list —
 * always present for assistive tech, toggleable visible for everyone. Font
 * size is decorative; the article count is the accessible signal.
 */

const POLL_INTERVAL_MS = 1500;
const POLL_MAX = 40; // the 12–24 call sample takes ~10–20s; stop asking after ~60s

const LAYOUT_WIDTH = 700;
const LAYOUT_HEIGHT = 340;
const FONT_MIN = 12;
const FONT_MAX = 56;

export function useTrending() {
  const pollsUsed = useRef(0);
  return useQuery({
    queryKey: ["trending"],
    queryFn: ({ signal }) => fetchTrending(signal),
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
  term: TrendingTerm;
  x: number;
  y: number;
  size: number;
}

/** Font ∝ sqrt(score), clamped — linear makes the top term absurd (§10.5). */
function fontSizes(terms: readonly TrendingTerm[]): Map<string, number> {
  const roots = terms.map((t) => Math.sqrt(Math.max(t.score, 0)));
  const min = Math.min(...roots);
  const max = Math.max(...roots);
  const span = max - min || 1;
  return new Map(
    terms.map((t, i) => [
      t.term,
      FONT_MIN + ((roots[i]! - min) / span) * (FONT_MAX - FONT_MIN),
    ]),
  );
}

/** Deterministic per (day, language): the cloud must not reshuffle per poll. */
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

export function TrendingCloud({ onSearch }: { onSearch: (q: string) => void }) {
  const trending = useTrending();
  const [asList, setAsList] = useState(false);
  const [placed, setPlaced] = useState<PlacedWord[]>([]);
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [sectionWidth, setSectionWidth] = useState(LAYOUT_WIDTH);
  const [contentWidth, setContentWidth] = useState(LAYOUT_WIDTH);

  // The layout always runs at LAYOUT_WIDTH and the result is scaled down to
  // the viewport — re-running d3-cloud at the measured width would break the
  // deterministic per-(day, language) placement (§10.5).
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
  const terms = data?.terms ?? [];
  const warming = data !== undefined && data.meta.ingest.state === "in_progress";

  useEffect(() => {
    if (terms.length === 0) {
      setPlaced([]);
      return;
    }
    const sizes = fontSizes(terms);
    const layout = cloud()
      .size([LAYOUT_WIDTH, LAYOUT_HEIGHT])
      .words(terms.map((t) => ({ text: t.term, size: sizes.get(t.term) })))
      .padding(3)
      .rotate(0)
      .font(MONO)
      .fontSize((d) => d.size ?? FONT_MIN)
      .random(seededRandom(`${data?.day}:${data?.language}`))
      .on("end", (words) => {
        const byTerm = new Map(terms.map((t) => [t.term, t]));
        setPlaced(
          words.flatMap((w) => {
            const term = w.text === undefined ? undefined : byTerm.get(w.text);
            return term && w.x !== undefined && w.y !== undefined && w.size !== undefined
              ? [{ term, x: w.x, y: w.y, size: w.size }]
              : [];
          }),
        );
      });
    layout.start();
    return () => {
      layout.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.day, data?.language, JSON.stringify(terms.map((t) => t.term))]);

  if (trending.isError) return null; // the landing page still works as a search box

  return (
    <section
      ref={sectionRef}
      aria-label="Today's topics"
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
        <span>
          {warming
            ? "gathering today's news…"
            : terms.length > 0
              ? `today's topics — ${data?.day}`
              : ""}
        </span>
        {terms.length > 0 && (
          <button
            onClick={() => setAsList(!asList)}
            aria-pressed={asList}
            style={{
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              fontFamily: MONO,
              fontSize: "0.8rem",
              textDecoration: "underline",
              padding: 0,
            }}
          >
            {asList ? "view as cloud" : "view as list"}
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
                key={word.term.term}
                tabIndex={-1}
                onClick={() => onSearch(word.term.term)}
                title={`${word.term.uniqueArticles} articles`}
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
                  color: "var(--fg)",
                  padding: 0,
                }}
              >
                {word.term.term}
              </button>
            ))}
          </div>
          {warming && placed.length === 0 && (
            <div className="shimmer" style={{ height: "100%" }} />
          )}
        </div>
      )}

      {/* The accessible equivalent (§10.5): always in the tree for assistive
          tech; the toggle above makes it visible for everyone. The COUNT is
          the signal — font size never carries meaning alone. */}
      {terms.length > 0 && (
        <ol
          className={asList ? undefined : "sr-only"}
          style={
            asList
              ? {
                  columns: 2,
                  margin: "1rem 0 0",
                  paddingLeft: "1.5rem",
                  fontFamily: MONO,
                  fontSize: "0.95rem",
                }
              : undefined
          }
        >
          {terms.map((term) => (
            <li key={term.term} style={{ marginBottom: "0.3rem" }}>
              <button
                onClick={() => onSearch(term.term)}
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
                {term.term}
              </button>{" "}
              <span style={{ color: "var(--fg-faint)" }}>
                — {term.uniqueArticles} article{term.uniqueArticles === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
