import { useEffect, useRef, useState } from "react";
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

/**
 * Warm→cool ramp keyed to score rank: the hottest topics burn red, the tail
 * cools to blue — a second visual channel alongside font size. Decorative
 * only (the cloud is aria-hidden); the list view keeps plain --fg because
 * mid-ramp hues (the yellow especially) don't clear body-text contrast.
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

/** Score rank → palette bucket. */
function rankColors(terms: readonly TrendingTerm[]): Map<string, string> {
  const ranked = [...terms].sort((a, b) => b.score - a.score);
  return new Map(
    ranked.map((t, i) => [
      t.term,
      PALETTE[Math.min(PALETTE.length - 1, Math.floor((i / ranked.length) * PALETTE.length))]!,
    ]),
  );
}

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

  const data: TrendingResponse | undefined = trending.data;
  const terms = data?.terms ?? [];
  const warming = data !== undefined && data.meta.ingest.state === "in_progress";
  const colors = rankColors(terms);

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
    <section aria-label="Today's topics" style={{ width: "100%", maxWidth: "760px" }}>
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
        <span>{warming ? "gathering today's news…" : ""}</span>
        {terms.length > 0 && (
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
            height: `${LAYOUT_HEIGHT}px`,
            overflow: "hidden",
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
                color: colors.get(word.term.term) ?? "var(--fg)",
                padding: 0,
              }}
            >
              {word.term.term}
            </button>
          ))}
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
