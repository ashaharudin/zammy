import { useEffect, useRef, useState } from "react";
import type { Reference, TopicFilters } from "./api.js";
import { defaultedFilters, type LanguagePolicy } from "./browserDefaults.js";
import { filterChips, type Chip, type ChipOption } from "./filterChips.js";

/**
 * The filter chips, shared by the hero and the open-topic command bar so a
 * reader meets one control, not two that drift (§8.1).
 *
 * Location, language and category as words, each opening the list it can be
 * changed to. Picking an entry applies immediately — a filter that waits for a
 * second Enter reads as broken. A custom popover rather than a native <select>
 * so the closed control reads as part of the line it sits on rather than as a
 * form field.
 */
export function FilterChipRow({
  filters,
  reference,
  onChange,
}: {
  filters: TopicFilters;
  reference: Reference | undefined;
  onChange: (filters: TopicFilters) => void;
}) {
  return (
    <>
      {filterChips(filters, reference).map((chip) => (
        <FilterChip
          key={chip.kind}
          chip={chip}
          onSelect={(code) => onChange({ ...filters, [chip.kind]: code })}
        />
      ))}
    </>
  );
}

/**
 * The starting filters where none are stated: the browser's own country and
 * language, falling back to any country and English (§8.1, defaultedFilters).
 *
 * Only once the reference list has arrived — a detected code upstream does not
 * carry would be rejected. Applied for real rather than shown as a
 * display-only default, because a chip reading "Canada" over an unfiltered
 * timeline would be a lie; replaced into history, not pushed, because the
 * reader did not ask to go here.
 */
export function useFilterDefaults(
  /** null disables defaulting — for a view that has no filters to default. */
  filters: TopicFilters | null,
  reference: Reference | undefined,
  language: LanguagePolicy,
  onApply: (filters: TopicFilters) => void,
) {
  useEffect(() => {
    if (!reference || !filters) return;
    const next = defaultedFilters(filters, readBrowser(), reference, language);
    if (next.language !== filters.language || next.country !== filters.country) onApply(next);
  }, [filters, reference, language, onApply]);
}

/** The one place that reads the browser's own settings. */
function readBrowser(): { locales: readonly string[]; timeZone: string | undefined } {
  return {
    locales: navigator.languages?.length ? navigator.languages : [navigator.language],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function FilterChip({
  chip,
  onSelect,
}: {
  chip: Chip;
  onSelect: (code: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${CHIP_LABELS[chip.kind]}: ${chip.label}`}
        style={{
          border: "1px solid var(--border)",
          borderRadius: "999px",
          background: "var(--chip-bg)",
          color: "inherit",
          cursor: "pointer",
          font: "inherit",
          lineHeight: 1.3,
          padding: "0.05rem 0.5rem",
        }}
      >
        {chip.label}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={CHIP_LABELS[chip.kind]}
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 0.35rem)",
            margin: 0,
            padding: "0.25rem",
            listStyle: "none",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            boxShadow: "var(--shadow)",
            maxHeight: "60vh",
            overflowY: "auto",
            minWidth: "12rem",
            zIndex: 20,
          }}
        >
          {chip.options.map((option) => (
            <Option
              key={option.code ?? "*"}
              option={option}
              selected={option.code === chip.code}
              onSelect={() => {
                setOpen(false);
                onSelect(option.code);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const CHIP_LABELS: Record<Chip["kind"], string> = {
  country: "Location",
  language: "Language",
  category: "Category",
};

function Option({
  option,
  selected,
  onSelect,
}: {
  option: ChipOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        style={{
          display: "block",
          width: "100%",
          border: "none",
          background: selected ? "var(--chip-bg)" : "none",
          borderRadius: "6px",
          cursor: "pointer",
          padding: "0.3rem 0.5rem",
          fontSize: "0.85rem",
          textAlign: "left",
        }}
      >
        {option.label}
      </button>
    </li>
  );
}
