import { z } from "zod";
import { CurrentsInvalidQueryError } from "./errors.js";

/**
 * The raw Currents wire shape, exactly as observed — not as the OpenAPI spec
 * describes it. Differences confirmed live (PROBE-FINDINGS 1):
 *
 *   - `id` is a UUID string; the spec declares integer.
 *   - the link field is `url`; the spec's News definition calls it `urls`.
 *   - `source_category` exists and is absent from the spec entirely.
 *   - `image` is frequently the literal string "None".
 *   - `published` is "2026-08-04 20:45:56 +0000" — not ISO-8601.
 *
 * Unknown fields pass through rather than failing: upstream already shipped one
 * undocumented field, so it will ship another.
 */
export const RawSighting = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    url: z.string().nullish(),
    urls: z.string().nullish(),
    author: z.string().nullish(),
    image: z.string().nullish(),
    language: z.string().nullish(),
    category: z.array(z.string()).nullish(),
    source_category: z.array(z.string()).nullish(),
    published: z.string(),
  })
  .loose();
export type RawSighting = z.infer<typeof RawSighting>;

export const RawSearchResponse = z
  .object({
    status: z.string(),
    news: z.array(RawSighting).nullish(),
  })
  .loose();
export type RawSearchResponse = z.infer<typeof RawSearchResponse>;

/** `{"status":"ok","news":[]}` past the last page — an end signal, not an error. */
export function isEmptyPage(response: RawSearchResponse): boolean {
  return response.status === "ok" && (response.news?.length ?? 0) === 0;
}

/**
 * Reference endpoints return name→code *maps*, not arrays as the spec implies,
 * and the names contain typos ("Vietnamise", "United State", "German"). Always
 * use the values; never derive a code from a name (PROBE-FINDINGS 6).
 */
export const RawLanguages = z
  .object({ languages: z.record(z.string(), z.string()) })
  .loose();
export const RawRegions = z.object({ regions: z.record(z.string(), z.string()) }).loose();
export const RawCategories = z.object({ categories: z.array(z.string()) }).loose();

/** Search parameters, in our naming. Translated to wire names by the client. */
export interface SearchParams {
  keywords?: string[];
  language?: string;
  country?: string;
  category?: string;
  domain?: string;
  startDate?: Date;
  endDate?: Date;
  /** 1-indexed. Upstream rejects 0 with "Min value: 1". */
  pageNumber?: number;
  /** Clamped to the tier maximum (20 on Free). */
  pageSize?: number;
}

/**
 * Build the upstream query string.
 *
 * Keywords are ALWAYS space-joined. Comma-joining returns zero results — the
 * kind of upstream trap that must live in exactly one place.
 */
export function toQueryParams(
  params: SearchParams,
  limits: { maxPageSize: number },
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.keywords?.length) {
    query.set("keywords", params.keywords.join(" "));
  }
  if (params.language) query.set("language", params.language);
  if (params.country) query.set("country", params.country);
  if (params.category) query.set("category", params.category);
  if (params.domain) query.set("domain", params.domain);
  if (params.startDate) query.set("start_date", toCurrentsDate(params.startDate));
  if (params.endDate) query.set("end_date", toCurrentsDate(params.endDate));
  if (params.pageNumber !== undefined) {
    query.set("page_number", String(Math.max(1, Math.trunc(params.pageNumber))));
  }
  if (params.pageSize !== undefined) {
    const size = Math.min(Math.trunc(params.pageSize), limits.maxPageSize);
    query.set("page_size", String(Math.max(1, size)));
  }

  return query;
}

/** Upstream wants `YYYY-MM-DDTHH:MM:SS+00:00`, not `...Z`. */
export function toCurrentsDate(date: Date): string {
  return `${date.toISOString().replace(/\.\d{3}Z$/, "")}+00:00`;
}

export interface ClampLimits {
  maxPageSize: number;
  maxRetrievableResults: number;
  maxLookbackDays: number;
  /** Per-call date-range ceiling. 7 days, observed live 2026-08-11. */
  maxRangeDays: number;
}

/**
 * Pre-flight clamp, so the tier's limits are enforced locally instead of learned
 * from a 400 (ARCHITECTURE 11: pre-flight validation should make upstream 400s
 * unreachable). Every clamp here corresponds to an error upstream actually
 * returned during the probe:
 *
 *   page_size > 20            → "Max page_size for Free tier is 20"
 *   page_number > cap/size    → "Max retrievable results for Free tier is 100"
 *   start_date > 30 days ago  → "Max lookback is 30 days"
 *
 * Adjustments are returned rather than logged-and-forgotten: a window silently
 * pulled forward looks exactly like missing news, so the caller gets to say so.
 */
export function clampSearchParams(
  params: SearchParams,
  limits: ClampLimits,
  now: Date = new Date(),
): { params: SearchParams; adjustments: string[] } {
  const adjustments: string[] = [];
  const clamped: SearchParams = { ...params };

  const requestedPageSize = params.pageSize ?? limits.maxPageSize;
  const pageSize = Math.max(1, Math.min(Math.trunc(requestedPageSize), limits.maxPageSize));
  if (params.pageSize !== undefined && pageSize !== params.pageSize) {
    adjustments.push(`pageSize ${params.pageSize} → ${pageSize} (tier maximum)`);
  }
  clamped.pageSize = pageSize;

  const maxPageNumber = Math.max(1, Math.floor(limits.maxRetrievableResults / pageSize));
  if (params.pageNumber !== undefined) {
    // Asking past the cap must FAIL, not quietly resolve to the last page.
    // Upstream answers such a request with 400 "Max retrievable results for Free
    // tier is 100", and clamping down would be actively worse than that error:
    // page 6 would return page 5's sightings, so a pager would ingest the same
    // twenty sightings forever and count them as new history.
    if (Math.trunc(params.pageNumber) > maxPageNumber) {
      throw new CurrentsInvalidQueryError(
        `pageNumber ${params.pageNumber} exceeds the retrievable cap: ` +
          `${limits.maxRetrievableResults} results at pageSize ${pageSize} is ` +
          `${maxPageNumber} pages. Subdivide the time window instead — the cap is ` +
          "a wall, not a cursor (ARCHITECTURE 6.3).",
        { page_number: `Max retrievable results is ${limits.maxRetrievableResults}` },
      );
    }
    clamped.pageNumber = Math.max(1, Math.trunc(params.pageNumber));
  }

  if (params.startDate) {
    const earliest = new Date(now.getTime() - limits.maxLookbackDays * 86_400_000);
    if (params.startDate < earliest) {
      adjustments.push(
        `startDate ${params.startDate.toISOString()} → ${earliest.toISOString()} ` +
          `(${limits.maxLookbackDays}-day lookback limit)`,
      );
      clamped.startDate = earliest;
    }
  }

  // A range past the ceiling must FAIL, not quietly narrow (observed live
  // 2026-08-11: 400 "date_range: Max range is 7 days"). The planner records
  // coverage for the span it ASKED for, so a silently narrowed fetch would
  // become coverage over days nobody fetched — data loss with no error
  // anywhere. Slicing wide windows is the planner's job (ARCHITECTURE 6.3).
  if (clamped.startDate && clamped.endDate) {
    const rangeMs = clamped.endDate.getTime() - clamped.startDate.getTime();
    if (rangeMs > limits.maxRangeDays * 86_400_000) {
      throw new CurrentsInvalidQueryError(
        `date range ${clamped.startDate.toISOString()} → ` +
          `${clamped.endDate.toISOString()} exceeds the ${limits.maxRangeDays}-day ` +
          "per-call ceiling. Slice the window instead — the planner's gap " +
          "segments must each be individually fetchable (ARCHITECTURE 6.3).",
        { date_range: `Max range is ${limits.maxRangeDays} days` },
      );
    }
  }

  return { params: clamped, adjustments };
}
