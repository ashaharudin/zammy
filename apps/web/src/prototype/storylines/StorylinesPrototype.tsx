import { useEffect, useState } from "react";
import { MONO } from "../../theme.js";
import {
  PROTOTYPE_QUERIES,
  searchSlots,
  storylineById,
  storylineSlots,
  surfacedStorylines,
} from "./mock-data.js";
import { VariantA } from "./VariantA.js";
import { VariantB } from "./VariantB.js";
import { VariantC } from "./VariantC.js";
import { VariantD } from "./VariantD.js";
import { VariantE } from "./VariantE.js";
import type { VariantProps } from "./variant-props.js";

/**
 * PROTOTYPE (S8) — five variants of how a search SURFACES storylines, on one
 * dev-only route, switchable via `?variant=`. Mock data only; no production
 * wiring, and nothing here is meant to be merged (ADR-0011 "Left open: the
 * surfacing UX awaits the prototype round").
 *
 *   A — top strip of matched-storyline cards above the results
 *   B — storyline as a first-class rail slot at its latest activity
 *   C — command-bar typeahead while the reader is still typing
 *   D — floating bottom strip, persistent as the reader scrolls
 *   E — pills under the date in the command bar, size as a glyph
 *
 * Universal gutter labels are the BASELINE in all of them (they are settled), so
 * what is under evaluation is only the extra surfacing layer.
 *
 * Run: `pnpm prototype:storylines`, or open
 * http://localhost:5173/prototype/storylines while `pnpm dev:web` runs.
 */

const VARIANTS = [
  { key: "A", name: "Top strip", render: (p: VariantProps) => <VariantA {...p} /> },
  { key: "B", name: "Storyline as rail slot", render: (p: VariantProps) => <VariantB {...p} /> },
  { key: "C", name: "Command-bar typeahead", render: (p: VariantProps) => <VariantC {...p} /> },
  { key: "D", name: "Floating bottom strip", render: (p: VariantProps) => <VariantD {...p} /> },
  { key: "E", name: "Pills in the command bar", render: (p: VariantProps) => <VariantE {...p} /> },
];

export function StorylinesPrototype() {
  const [variant, setVariant] = useState(
    () => new URLSearchParams(window.location.search).get("variant") ?? "A",
  );
  const [query, setQuery] = useState("iran");
  const [viewingId, setViewingId] = useState<string | null>(null);

  const setVariantParam = (key: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("variant", key);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    setVariant(key);
  };

  const viewing = viewingId ? (storylineById(viewingId) ?? null) : null;
  const props: VariantProps = {
    query,
    // The storyline view: the timeline filtered to one UUID, search box empty.
    slots: viewing ? storylineSlots(viewing.id) : searchSlots(query),
    surfaced: viewing ? [] : surfacedStorylines(query),
    viewing,
    onQueryChange: (next) => {
      // "Typing exits the view" (ADR-0011).
      setViewingId(null);
      setQuery(next);
    },
    onOpenStoryline: (id) => {
      setViewingId(id);
      setQuery("");
    },
    onDismissView: () => setViewingId(null),
  };

  const active = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]!;

  return (
    <>
      {active.render(props)}
      <Switcher
        current={active.key}
        onChange={setVariantParam}
        query={query}
        onQuery={(q) => {
          setViewingId(null);
          setQuery(q);
        }}
      />
    </>
  );
}

/**
 * The floating switcher, deliberately alien to the design under evaluation. It
 * carries the canned queries too — the variants differ most in what they do
 * with three matches versus none, and switching query has to be one click.
 */
function Switcher({
  current,
  onChange,
  query,
  onQuery,
}: {
  current: string;
  onChange: (key: string) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  const index = Math.max(
    0,
    VARIANTS.findIndex((v) => v.key === current),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.isContentEditable)) return;
      if (event.key === "ArrowLeft") onChange(VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length]!.key);
      if (event.key === "ArrowRight") onChange(VARIANTS[(index + 1) % VARIANTS.length]!.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  const active = VARIANTS[index]!;
  const arrow: React.CSSProperties = {
    background: "none",
    border: "none",
    color: "#fff",
    fontSize: "1rem",
    cursor: "pointer",
    padding: "0.4rem 0.6rem",
    lineHeight: 1,
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        background: "#111",
        color: "#fff",
        borderRadius: "999px",
        padding: "0.15rem 0.5rem",
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        fontFamily: "system-ui, sans-serif",
        fontSize: "0.85rem",
        zIndex: 9999,
        userSelect: "none",
      }}
    >
      <button style={arrow} onClick={() => onChange(VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length]!.key)}>
        ←
      </button>
      <span style={{ minWidth: "13rem", textAlign: "center" }}>
        <strong>{active.key}</strong> — {active.name}
      </span>
      <button style={arrow} onClick={() => onChange(VARIANTS[(index + 1) % VARIANTS.length]!.key)}>
        →
      </button>
      <span style={{ display: "flex", gap: "0.2rem", fontFamily: MONO, fontSize: "0.75rem" }}>
        {["", ...PROTOTYPE_QUERIES].map((q) => (
          <button
            key={q || "none"}
            onClick={() => onQuery(q)}
            style={{
              background: q === query ? "#fff" : "transparent",
              color: q === query ? "#111" : "#bbb",
              border: "1px solid #444",
              borderRadius: "999px",
              padding: "0.1rem 0.5rem",
              cursor: "pointer",
            }}
          >
            {q || "∅"}
          </button>
        ))}
      </span>
    </div>
  );
}
