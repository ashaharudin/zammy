import type { Reference, TopicFilters } from "./api.js";

/**
 * The command bar's filter chips (§8.1): the topic's location and category,
 * each a label to show and the list it can be changed to.
 *
 * Codes travel, names are shown (§2) — but only where a name helps. "CA" says
 * nothing to a reader, so the location chip reads "Canada".
 */

export type ChipKind = "country" | "category";

export interface ChipOption {
  /** undefined is the unfiltered choice: any country, any language, any category. */
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
    {
      kind: "category",
      label: topic.category ?? "any category",
      code: topic.category,
      // Categories arrive as a bare list — the code is the name.
      options: named(
        "any category",
        Object.fromEntries((reference?.categories ?? []).map((category) => [category, category])),
      ),
    },
  ];
}

/**
 * The unfiltered location. Worded like its neighbours rather than as a place
 * ("Worldwide"), so the three chips read as one set of controls: the reader is
 * choosing not to narrow, three times over.
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
