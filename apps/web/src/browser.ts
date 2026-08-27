/**
 * The one place that reads the browser's own settings.
 *
 * `browserDefaults` states the discipline — "the browser's readings come in as
 * arguments rather than off `navigator`, so the rules are testable without a
 * DOM and the caller owns the one place that touches globals" — but the
 * readings themselves had no home, so that one place was a helper private to
 * the filter chips. The timeline needs the zone too (§8.1, part-of-day
 * segments), and a second `resolvedOptions()` call elsewhere would have made
 * that comment false.
 */

/** What `browserDefaults` takes: the reader's languages and where they are. */
export function readBrowser(): { locales: readonly string[]; timeZone: string | undefined } {
  return {
    locales: navigator.languages?.length ? navigator.languages : [navigator.language],
    timeZone: readTimeZone(),
  };
}

/**
 * The reader's own IANA zone — what the rail's days and segments are cut by.
 *
 * Deliberately NOT derived from the country chip: that answers "whose news",
 * and a reader on `en-GB` sitting in Vancouver wants Vancouver's evening. And
 * deliberately not `APP_TIMEZONE`, which is the write path's day (§7.4,
 * ADR-0005) and has never been the reader's.
 *
 * `resolvedOptions()` is specified to always name a zone, so the fallback is a
 * formality rather than a case that occurs.
 */
export function readTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
