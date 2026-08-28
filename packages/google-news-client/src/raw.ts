import { z } from "zod";
import { NewsInvalidQueryError, type SearchParams } from "@zammy/news-client";

/**
 * The Google News RSS wire shape, and the query encoding that reaches it.
 *
 * ```
 * GET news.google.com/rss/search?q=<query>&hl=en-CA&gl=CA&ceid=CA:en
 * ```
 *
 * Probed live 2026-08-27 and again 2026-08-28; everything asserted here was
 * measured, not read off a specification, because there is no specification —
 * this is a feed endpoint, not a published API (RESEARCH-FREE-NEWS-SOURCES §1).
 * Where a future observation disagrees with a comment below, the observation
 * wins and this file is what changes.
 *
 * What an item carries: `<title>`, `<link>`, `<guid>`, `<pubDate>`,
 * `<description>`, `<source url="…">`. That is all of it — no image, no author,
 * no category, no per-item language, and nothing resembling a total.
 */

/**
 * One `<item>`, after `parseRssFeed` has read it. Everything is nullish because
 * a truncated feed is a real thing and the drop accounting is where a missing
 * field belongs, not the schema.
 */
export const RawGoogleNewsItem = z
  .object({
    title: z.string().nullish(),
    /** The opaque `news.google.com/rss/articles/CBM…` redirect. See below. */
    link: z.string().nullish(),
    guid: z.string().nullish(),
    /** RFC 822, always `GMT`. A real publication time, not a seen-time. */
    pubDate: z.string().nullish(),
    description: z.string().nullish(),
    sourceUrl: z.string().nullish(),
    sourceName: z.string().nullish(),
  })
  .loose();
export type RawGoogleNewsItem = z.infer<typeof RawGoogleNewsItem>;

export const RawGoogleNewsFeed = z
  .object({
    language: z.string().nullish(),
    title: z.string().nullish(),
    copyright: z.string().nullish(),
    items: z.array(RawGoogleNewsItem).nullish(),
  })
  .loose();
export type RawGoogleNewsFeed = z.infer<typeof RawGoogleNewsFeed>;

/**
 * Items per query. A wall, not a page size.
 *
 * Measured: `"bank of canada" after:2026-08-20 before:2026-08-22` returned
 * exactly 100 items, and there is no offset, cursor or page parameter to get
 * past them — the endpoint ignores everything of the sort. The way past the cap
 * is to subdivide the window, which is what `isLastPage` is telling the caller
 * to do when `rawCount` comes back at exactly this number. Five weekly slices
 * of one arc gave 433 items where the unsliced query gave 92
 * (DESIGN-DISCOVERY-AND-DEEPENING §1).
 *
 * Deliberately a constant rather than config: `GNEWS_MAX_PAGE_SIZE` is a knob
 * because a paid GNews plan raises it, and there is no plan to buy here.
 */
export const ITEMS_PER_QUERY = 100;

/**
 * A defensive ceiling on `q`, not a measured one.
 *
 * No length limit was probed and none is documented. This is here so a runaway
 * label cannot become a multi-kilobyte URL, and it is generous enough that no
 * real storyline label will meet it. If one ever does, that is a bug in the
 * label, not in this number.
 */
export const MAX_QUERY_CHARS = 400;

/**
 * What this endpoint cannot express, and must therefore never be asked.
 *
 * Same rule as the GNews adapter's, for the same ADR-0012 reason: answering a
 * filtered query unfiltered fills a scoped topic with articles that do not
 * belong to it, and refusing locally costs nothing.
 */
export function unservableReason(params: SearchParams): string | null {
  if (!params.keywords?.length) {
    return "Google News RSS /search requires a q parameter; a keyword-less sweep has no equivalent";
  }
  if (params.category) {
    return (
      `Google News RSS has no category filter (got "${params.category}"), and answering ` +
      "without it would ingest off-topic articles into a category-filtered topic"
    );
  }
  if (params.domain) {
    // Google's web search understands `site:`, and this endpoint may or may not
    // — it was not probed. An unverified filter is worse than no filter: if it
    // is silently ignored, a domain-scoped topic fills with every other outlet
    // and nothing reports it. Refuse until someone measures it.
    return (
      `Google News RSS has no verified domain filter (got "${params.domain}"); ` +
      "answering without one would ingest articles from every other outlet " +
      "into a domain-filtered topic"
    );
  }
  if (params.pageNumber !== undefined && Math.trunc(params.pageNumber) > 1) {
    // There is no offset parameter, so page 2 would return page 1 again — the
    // precise failure `clampSearchParams` refuses rather than clamps: a pager
    // would re-ingest one page forever and count it as new history. The cap is
    // a wall; subdivide the window instead (ARCHITECTURE 6.3).
    return (
      `Google News RSS has no paging (got pageNumber ${params.pageNumber}); every query ` +
      `returns at most ${ITEMS_PER_QUERY} items and there is no offset parameter. ` +
      "Subdivide the window instead — a second page would return the first one again"
    );
  }
  return null;
}

export interface QueryLocale {
  /** Primary language subtag, e.g. `en`. */
  language: string;
  /** Two-letter country, e.g. `CA`. */
  country: string;
}

/**
 * Build the upstream query string.
 *
 * Keywords are space-joined, which reads as an implicit AND — the same meaning
 * Currents gives a space-joined `keywords`, so one canonical topic asks both
 * providers the same question.
 *
 * The three locale parameters are not independent, despite looking it: `hl` is
 * `<lang>-<COUNTRY>`, `gl` is the country, and `ceid` is `<COUNTRY>:<lang>`.
 * Sending a set that disagrees with itself returns a different, quieter result
 * set, so they are derived from one pair rather than configured separately.
 */
export function toQueryParams(params: SearchParams, locale: QueryLocale): URLSearchParams {
  const unservable = unservableReason(params);
  if (unservable) {
    throw new NewsInvalidQueryError(unservable, { q: unservable });
  }

  const terms = [...(params.keywords ?? [])];
  if (params.startDate) terms.push(`after:${toSearchDay(afterBound(params.startDate))}`);
  if (params.endDate) terms.push(`before:${toSearchDay(beforeBound(params.endDate))}`);

  const q = terms.join(" ").trim();
  if (q.length > MAX_QUERY_CHARS) {
    throw new NewsInvalidQueryError(
      `q is ${q.length} characters, past the ${MAX_QUERY_CHARS}-character ceiling this ` +
        "adapter imposes on itself",
      { q: `Max length is ${MAX_QUERY_CHARS} characters` },
    );
  }

  const language = params.language?.trim() || locale.language;
  const country = (params.country?.trim() || locale.country).toUpperCase();

  const query = new URLSearchParams();
  query.set("q", q);
  query.set("hl", `${language}-${country}`);
  query.set("gl", country);
  query.set("ceid", `${country}:${language}`);
  return query;
}

/**
 * A day's worth of padding at each edge of the requested window, and why it is
 * not paranoia.
 *
 * `after:`/`before:` take a date, not a timestamp, and **Google resolves that
 * date in US Pacific time, not UTC.** Measured 2026-08-28, twice, with the
 * offset tracking daylight saving both times:
 *
 * ```
 * after:2026-08-20 before:2026-08-22  → items 2026-08-20T07:00Z … 2026-08-22T07:00Z
 * after:2025-02-01 before:2025-02-03  → items 2025-02-01T08:00Z … 2025-02-03T08:00Z
 * ```
 *
 * 07:00Z is midnight PDT and 08:00Z is midnight PST, so both bounds sit seven
 * or eight hours after the UTC midnight of the same date, and the upper one is
 * inclusive of that instant. A naive `after:<utc day of startDate>` would
 * therefore skip the first seven hours of the window the caller asked for.
 *
 * That is under-fetching, which this codebase treats as the worst available
 * failure (ARCHITECTURE 11): the caller records coverage for the span it asked
 * about, so the missing hours would be recorded as fetched and never revisited.
 * Padding a day outward makes the window Google actually applies strictly
 * *contain* the requested one under either reading of the boundary, in either
 * half of the year, whatever Google decides its timezone is next. What it costs
 * is some articles outside the asked-for span — real articles with real
 * timestamps, which land at the right point on the timeline — and reaching the
 * 100-item cap a little sooner, which surfaces as `isLastPage: false` and makes
 * the caller subdivide. Both are recoverable; a silent gap is not.
 */
const BOUND_PADDING_MS = 86_400_000;

function afterBound(startDate: Date): Date {
  return new Date(startDate.getTime() - BOUND_PADDING_MS);
}

function beforeBound(endDate: Date): Date {
  return new Date(endDate.getTime() + BOUND_PADDING_MS);
}

/** `after:`/`before:` want a bare `YYYY-MM-DD`; anything finer is ignored. */
export function toSearchDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `pubDate` → epoch ms, or NaN.
 *
 * RFC 822 with a `GMT` zone on every item probed, which `Date.parse` handles —
 * it is the one format the ECMAScript spec requires implementations to accept
 * beyond ISO-8601. Validated rather than trusted all the same: a wrong
 * timestamp silently corrupts the timeline, which is the one thing the product
 * promises, so an unparseable value is dropped and counted rather than
 * defaulted to "now" (ARCHITECTURE 11).
 */
export function parsePublished(value: string | null | undefined): number {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return Number.NaN;
  // A bare date, or a string loose enough that runtimes disagree about it,
  // would parse here and not there. Requiring day, month, year and a clock
  // keeps the drop deterministic.
  if (!/^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2}\b/.test(trimmed)) {
    return Number.NaN;
  }
  return Date.parse(trimmed);
}
