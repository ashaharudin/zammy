import type { SurfacedStoryline, TimelineEntry } from "@zammy/shared";

/**
 * Storyline presentation rules (ADR-0011, S8's verdict). Pure, because both of
 * them are the kind of rule that is easy to get subtly wrong and impossible to
 * see going wrong in a screenshot.
 */

/**
 * The date qualifier that separates two storylines sharing a label —
 * "Fort Hood Crash · Mar 2026".
 *
 * Dated from the storyline's FIRST covered day, not its span ("Mar–Aug 2026"):
 * two storylines called the same thing are usually the same event happening
 * twice, so when each BEGAN is what tells them apart, and a range is longer and
 * says it less directly.
 *
 * Two precisions, because month-and-year is often not enough. ADR-0011's own
 * example ("Fort Hood Crash · Mar 2026") is the easy case — months apart — but
 * live data is unkind: the dev archive holds three storylines labelled "Trump
 * Administration" that all begin in the same August, and qualifying them all as
 * "Aug 2026" produces a disambiguator that disambiguates nothing. So the
 * qualifier escalates to the day when the month is ambiguous, and no further:
 * two storylines beginning on the same DAY are told apart by opening one.
 */
export function storylineQualifier(from: string, precision: "month" | "day" = "month"): string {
  return new Date(from).toLocaleDateString(
    undefined,
    precision === "day"
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", year: "numeric" },
  );
}

/**
 * The qualifier each storyline needs, or nothing when its label is unambiguous
 * on screen.
 *
 * Computed over the whole visible set at once, because "does this need a date"
 * is a question about the SET, not about any one storyline — and because the
 * precision has to be chosen per label group: one collision may separate at
 * month precision while another needs the day.
 */
export function storylineQualifiers(
  storylines: readonly { id: string; label: string | null; from: string }[],
): Map<string, string> {
  const byLabel = new Map<string, Map<string, string>>();
  for (const storyline of storylines) {
    if (!storyline.label) continue;
    const group = byLabel.get(storyline.label) ?? new Map<string, string>();
    group.set(storyline.id, storyline.from);
    byLabel.set(storyline.label, group);
  }

  const qualifiers = new Map<string, string>();
  for (const group of byLabel.values()) {
    if (group.size < 2) continue;
    const months = [...group.values()].map((from) => storylineQualifier(from, "month"));
    // Escalate only if the coarse form leaves two of them reading the same.
    const precision = new Set(months).size === group.size ? "month" : "day";
    for (const [id, from] of group) qualifiers.set(id, storylineQualifier(from, precision));
  }
  return qualifiers;
}

/** Every storyline visible on screen: the slots' own, plus the surfaced row. */
export function visibleStorylines(
  items: readonly TimelineEntry[],
  surfaced: readonly SurfacedStoryline[],
): { id: string; label: string | null; from: string }[] {
  const seen = new Map<string, { label: string | null; from: string }>();
  for (const item of items) {
    if (item.storyline) {
      seen.set(item.storylineId, { label: item.storyline.label, from: item.storyline.from });
    }
  }
  for (const storyline of surfaced) {
    seen.set(storyline.id, { label: storyline.label, from: storyline.from });
  }
  return [...seen].map(([id, rest]) => ({ id, ...rest }));
}

/**
 * What a pill says in words rather than in glyphs: the exact article count, and
 * "dormant" when the storyline has fallen quiet (ADR-0011's Lifecycle).
 *
 * Both facts live in the pill's `title` and `aria-label`, where they cost no
 * width — the glyph answers "how big" at a glance and the muted treatment
 * answers "still running", and this is where a reader who wants the actual
 * numbers finds them. Dormancy is a fact about the STORY, so it is stated
 * plainly and not converted into a date the reader has to subtract from today.
 */
export function pillDetail(storyline: { size: number; dormant: boolean }): string {
  const exact = `${storyline.size} article${storyline.size === 1 ? "" : "s"}`;
  return storyline.dormant ? `${exact} · dormant` : exact;
}

/**
 * The size bucket a surfaced storyline's pill draws (S8's verdict): 1–10,
 * 11–50, 51–100, 101+, as 1–4 of four squares.
 *
 * Buckets rather than the count itself because the question a reader asks of a
 * surfaced storyline is "how big is this", and a bucket survives the number
 * moving while they look at it. The exact count still reaches them, in the
 * pill's title and aria-label, where it costs no width.
 */
export const SIZE_STEPS = 4;

export function sizeBucket(size: number): number {
  if (size <= 10) return 1;
  if (size <= 50) return 2;
  if (size <= 100) return 3;
  return SIZE_STEPS;
}
