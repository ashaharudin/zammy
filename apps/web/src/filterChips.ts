import type { Reference, TopicQuery } from "./api.js";

/**
 * The command bar's filter chips (§8.1): the topic's location, language and
 * category, each a label to show and the list it can be changed to.
 *
 * Codes travel, names are shown (§2) — but only where a name helps. "CA" says
 * nothing to a reader, so the location chip reads "Canada"; the language chip
 * keeps the code, which is short, familiar and what the URL carries.
 */

export type ChipKind = "country" | "language" | "category";

export interface ChipOption {
  /** undefined is the unfiltered choice: Worldwide, any language, any category. */
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

export function filterChips(topic: TopicQuery, reference: Reference | undefined): Chip[] {
  const regions = reference?.regions ?? {};
  const nameByCode = new Map(Object.entries(regions).map(([name, code]) => [code, name]));

  return [
    {
      kind: "country",
      label: topic.country ? (nameByCode.get(topic.country) ?? topic.country) : "Worldwide",
      code: topic.country,
      options: named("Worldwide", regions),
    },
    {
      kind: "language",
      label:
        topic.language === undefined || topic.language === ANY_LANGUAGE
          ? "any language"
          : topic.language,
      code: topic.language,
      options: named("any language", reference?.languages ?? {}, ANY_LANGUAGE),
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
