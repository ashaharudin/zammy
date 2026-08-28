import type { Reference, TopicFilters } from "./api.js";

/**
 * The command bar's filter chips (§8.1): the topic's location, a label to show
 * and the list it can be changed to.
 *
 * Codes travel, names are shown (§2) — but only where a name helps. "CA" says
 * nothing to a reader, so the location chip reads "Canada".
 *
 * **There is one kind, and it is a row on purpose.** A category chip stood
 * beside this one until ADR-0020 retired it: the deepening plane cannot express
 * a category at all, and asking Google News for one silently discards it, so a
 * category-scoped topic is one half the ingest can never honestly answer. The
 * union survives a single member because the next filter to arrive should join
 * a row, not resurrect one — and because `CHIP_LABELS` and the `onChange` key
 * in FilterChipRow both index off it.
 */

export type ChipKind = "country";

export interface ChipOption {
  /** undefined is the unfiltered choice: any country, any language. */
  code: string | undefined;
  label: string;
}

export interface Chip {
  kind: ChipKind;
  /** What the closed chip reads. */
  label: string;
  code: string | undefined;
  options: ChipOption[];
}

export function filterChips(topic: TopicFilters, reference: Reference | undefined): Chip[] {
  const regions = reference?.regions ?? {};
  const nameByCode = new Map(Object.entries(regions).map(([name, code]) => [code, name]));

  return [
    {
      kind: "country",
      label: topic.country ? (nameByCode.get(topic.country) ?? topic.country) : ANY_COUNTRY,
      code: topic.country,
      options: named(ANY_COUNTRY, regions),
    },
  ];
}

/**
 * The unfiltered location. Worded as a choice not to narrow rather than as a
 * place ("Worldwide") — it was one of a set of controls that all read that way,
 * and it keeps the wording now that it is the only one left, because "any
 * country" still says what it does and "Worldwide" reads as a filter.
 */
const ANY_COUNTRY = "any country";

/**
 * The code that asks for no language filter at all. Unlike an absent param it
 * is a stated choice, so the detected default leaves it alone; the API
 * canonicalizes it back to null (§6.2).
 */
export const ANY_LANGUAGE = "all";

/** The unfiltered choice first, then the reference's name→code map as options. */
function named(
  anyLabel: string,
  byName: Record<string, string>,
  anyCode?: string,
): ChipOption[] {
  return [
    { code: anyCode, label: anyLabel },
    ...Object.entries(byName).map(([label, code]) => ({ code, label })),
  ];
}
