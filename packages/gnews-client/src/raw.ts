import { z } from "zod";
import { NewsInvalidQueryError, type SearchParams } from "@zammy/news-client";

/**
 * The GNews v4 wire shape (https://docs.gnews.io).
 *
 * Documented rather than probed, unlike the Currents shapes next door — no key
 * was available to record real payloads — so everything optional is typed
 * optional and unknown fields pass through. Where the docs and a live response
 * disagree, the live response wins and this file is what changes.
 *
 * Notable differences from Currents, each of which the adapter absorbs:
 *
 *   - `publishedAt` is real ISO-8601 ("2025-07-18T21:32:58.500Z").
 *   - the envelope is `{totalArticles, articles[]}`, and `totalArticles` is a
 *     genuine total, so the last page can be recognised rather than inferred.
 *   - `source` names the outlet directly; we still derive the domain from the
 *     URL so one story from two providers presents as one source.
 *   - there is no category on an article, and no category filter on /search.
 *   - `id` post-dates the v4 launch, so it is treated as optional.
 */
export const RawGnewsArticle = z
  .object({
    id: z.string().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    content: z.string().nullish(),
    url: z.string().nullish(),
    image: z.string().nullish(),
    publishedAt: z.string().nullish(),
    lang: z.string().nullish(),
    source: z
      .object({
        id: z.string().nullish(),
        name: z.string().nullish(),
        url: z.string().nullish(),
        country: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();
export type RawGnewsArticle = z.infer<typeof RawGnewsArticle>;

export const RawGnewsResponse = z
  .object({
    totalArticles: z.number().nullish(),
    articles: z.array(RawGnewsArticle).nullish(),
  })
  .loose();
export type RawGnewsResponse = z.infer<typeof RawGnewsResponse>;

/** GNews caps `q` at 200 characters and 400s past it. */
export const MAX_QUERY_CHARS = 200;

/**
 * What `/search` cannot express, and must therefore never be asked.
 *
 * Each of these would otherwise be answered — with the filter silently dropped.
 * That is the dangerous failure: a category-filtered topic would ingest
 * unfiltered articles and its timeline would fill with stories that do not
 * belong to it. Refusing locally costs nothing and keeps the topic honest.
 */
export function unservableReason(params: SearchParams): string | null {
  if (!params.keywords?.length) {
    return "GNews /search requires a q parameter; a keyword-less sweep has no equivalent";
  }
  if (params.category) {
    return `GNews /search has no category filter (got "${params.category}"), and answering ` +
      "without it would ingest off-topic articles into a category-filtered topic";
  }
  if (params.domain) {
    return `GNews /search has no domain filter (got "${params.domain}"), and answering ` +
      "without it would ingest articles from every other outlet into a domain-filtered topic";
  }
  return null;
}

/**
 * Build the upstream query string.
 *
 * Keywords are space-joined, which GNews reads as an implicit AND — the same
 * meaning Currents gives a space-joined `keywords`, so one canonical topic
 * asks both providers the same question.
 */
export function toQueryParams(
  params: SearchParams,
  limits: { maxPageSize: number },
): URLSearchParams {
  const unservable = unservableReason(params);
  if (unservable) {
    throw new NewsInvalidQueryError(unservable, { q: unservable });
  }

  const query = new URLSearchParams();

  const q = (params.keywords ?? []).join(" ").trim();
  if (q.length > MAX_QUERY_CHARS) {
    throw new NewsInvalidQueryError(
      `q is ${q.length} characters; GNews rejects anything over ${MAX_QUERY_CHARS}`,
      { q: `Max length is ${MAX_QUERY_CHARS} characters` },
    );
  }
  query.set("q", q);

  if (params.language) query.set("lang", params.language);
  if (params.country) query.set("country", params.country);
  if (params.startDate) query.set("from", toGnewsDate(params.startDate));
  if (params.endDate) query.set("to", toGnewsDate(params.endDate));
  if (params.pageNumber !== undefined) {
    query.set("page", String(Math.max(1, Math.trunc(params.pageNumber))));
  }
  if (params.pageSize !== undefined) {
    const size = Math.min(Math.trunc(params.pageSize), limits.maxPageSize);
    query.set("max", String(Math.max(1, size)));
  }

  applySharedDefaults(query);
  return query;
}

/**
 * Defaults every call sends, for two reasons that are easy to get wrong:
 *
 *   `sortby=publishedAt` — the pager's coverage frontier assumes newest-first
 *   ordering, and `relevance` would make "the oldest article this page reached"
 *   meaningless, quietly corrupting the span we then record as covered.
 *
 *   `nullable=description,content,image` — GNews *omits* articles missing any of
 *   these by default. We render a missing image as no image and a missing
 *   description as null anyway, so the default would drop usable articles for a
 *   field we do not need. Opting in is strictly more coverage.
 */
function applySharedDefaults(query: URLSearchParams): void {
  query.set("sortby", "publishedAt");
  query.set("nullable", "description,content,image");
}

/** GNews wants ISO-8601 with milliseconds and a `Z`, which is `toISOString()`. */
export function toGnewsDate(date: Date): string {
  return date.toISOString();
}

/**
 * The `/top-headlines` taxonomy, verbatim from the docs. Its own list, sharing
 * no values with the Currents v2 taxonomy — which is precisely why neither is
 * promoted into the shared contract.
 */
export const TOP_HEADLINE_CATEGORIES = [
  "general",
  "world",
  "nation",
  "business",
  "technology",
  "entertainment",
  "sports",
  "science",
  "health",
] as const;

export type TopHeadlineCategory = (typeof TOP_HEADLINE_CATEGORIES)[number];

export interface TopHeadlinesParams {
  language?: string;
  country?: string;
  /** One value per call — unlike Currents, GNews takes a single category. */
  category?: string;
  pageNumber?: number;
  pageSize?: number;
}

const TOP_HEADLINE_CATEGORY_SET: ReadonlySet<string> = new Set(TOP_HEADLINE_CATEGORIES);

export function toTopHeadlinesQuery(
  params: TopHeadlinesParams,
  limits: { maxPageSize: number },
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.category) {
    // Pre-flight rather than spend a call learning it: the likeliest mistake is
    // passing a Currents v2 name like "science_technology", which is a 400 here.
    if (!TOP_HEADLINE_CATEGORY_SET.has(params.category)) {
      throw new NewsInvalidQueryError(
        `invalid /top-headlines category "${params.category}" ` +
          `(GNews accepts: ${TOP_HEADLINE_CATEGORIES.join(", ")})`,
        { category: `invalid category value: ${params.category}` },
      );
    }
    query.set("category", params.category);
  }
  if (params.language) query.set("lang", params.language);
  if (params.country) query.set("country", params.country);
  if (params.pageNumber !== undefined) {
    query.set("page", String(Math.max(1, Math.trunc(params.pageNumber))));
  }
  const size = Math.min(
    Math.trunc(params.pageSize ?? limits.maxPageSize),
    limits.maxPageSize,
  );
  query.set("max", String(Math.max(1, size)));

  applySharedDefaults(query);
  return query;
}
