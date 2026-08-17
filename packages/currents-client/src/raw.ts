import { z } from "zod";
import type { SearchParams } from "@zammy/news-client";

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
