/**
 * The APP_TIMEZONE day (ARCHITECTURE 10.1). The cloud's "today" is a local
 * calendar day, not the UTC day — under UTC a Vancouver afternoon is already
 * tomorrow, and the most-visited surface in the product would go near-empty
 * every day after about 5pm local. Intl is the only timezone database the
 * runtime ships; everything here derives from it.
 */

/** YYYY-MM-DD of `instant` in `timeZone`. en-CA formats exactly this shape. */
export function zonedDayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** [local midnight, next local midnight) as UTC instants. */
export function zonedDayBounds(dayKey: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: localMidnightUtc(`${dayKey}T00:00:00Z`, timeZone),
    to: localMidnightUtc(`${dayKey}T24:00:00Z`, timeZone),
  };
}

/**
 * The UTC instant of a local wall-clock time: guess the offset at the naive
 * UTC reading, then correct once — the second pass converges across DST
 * transitions, where the first guess can be an hour out.
 */
function localMidnightUtc(naiveIso: string, timeZone: string): Date {
  const naive = new Date(naiveIso);
  const guess = new Date(naive.getTime() - tzOffsetMs(naive, timeZone));
  return new Date(naive.getTime() - tzOffsetMs(guess, timeZone));
}

/** Offset of `timeZone` from UTC at `instant`, in ms (PDT → -7h). */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24, // Intl reports midnight as "24" under hourCycle h24 quirks
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}
