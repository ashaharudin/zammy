import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchParams } from "@zammy/news-client";
import { RawGnewsArticle } from "./raw.js";
import { parsePublished } from "./normalize.js";
import type { TopHeadlinesParams } from "./raw.js";

/**
 * Serves recorded payloads instead of calling GNews (`GNEWS_MODE=fixture`).
 *
 * The free tier allows 100 calls a day — a tenth of what Currents gives us — so
 * a dev server with hot reload would exhaust it in minutes. This makes the whole
 * app developable, and the test suite runnable, with no network and no quota
 * (ARCHITECTURE 4.1).
 *
 * **One honest caveat, unlike its Currents counterpart.** No GNews key was
 * available, so `fixtures/gnews-search-sample.json` is not a live capture: its
 * *shape* is the documented v4 response and its *content* is the real recorded
 * Currents articles reshaped into it. That is enough to exercise the mapping,
 * the paging and the drop accounting for real, and it is deliberately not enough
 * to claim we have reproduced GNews's own misbehaviour the way the Currents
 * fixtures reproduce Currents'. The file says so in its `_provenance` field, and
 * it should be replaced with a genuine capture the moment a key exists.
 */

interface GnewsFixture {
  totalArticles?: number;
  articles?: unknown[];
}

export class GnewsFixtureStore {
  private articles: RawGnewsArticle[] = [];
  private loaded = false;

  constructor(private readonly fixturesDir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;

    const fixture = await this.readJson<GnewsFixture>("gnews-search-sample.json");
    const collected: RawGnewsArticle[] = [];
    for (const item of fixture?.articles ?? []) {
      const parsed = RawGnewsArticle.safeParse(item);
      if (parsed.success) collected.push(parsed.data);
    }

    if (collected.length === 0) {
      throw new Error(
        `No GNews fixtures loaded from ${this.fixturesDir}. ` +
          "Fixture mode needs gnews-search-sample.json committed in ./fixtures.",
      );
    }

    // Newest-first, matching the `sortby=publishedAt` every live call sends.
    collected.sort((a, b) => parsePublished(b.publishedAt) - parsePublished(a.publishedAt));
    this.articles = collected;
    this.loaded = true;
  }

  get size(): number {
    return this.articles.length;
  }

  /**
   * Approximate GNews's filtering. Deliberately approximate: the real `in`
   * default matches title and description, and its operator syntax supports
   * AND/OR/NOT, none of which this reproduces. Development is what this is for,
   * not a relevance oracle.
   */
  search(params: SearchParams, limits: { maxPageSize: number }): RawGnewsArticle[] {
    this.assertLoaded("search");

    let results = this.articles;

    if (params.keywords?.length) {
      const terms = params.keywords.map((term) => term.toLowerCase());
      results = results.filter((article) => {
        const haystack =
          `${article.title ?? ""} ${article.description ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    if (params.language) {
      results = results.filter((article) => article.lang === params.language);
    }
    if (params.startDate) {
      const from = params.startDate.getTime();
      results = results.filter((a) => parsePublished(a.publishedAt) >= from);
    }
    if (params.endDate) {
      const to = params.endDate.getTime();
      results = results.filter((a) => parsePublished(a.publishedAt) < to);
    }

    return this.page(results, params.pageSize, params.pageNumber, limits);
  }

  /** Approximate `/top-headlines`: newest-first, no keyword matching. */
  topHeadlines(
    params: TopHeadlinesParams,
    limits: { maxPageSize: number },
  ): RawGnewsArticle[] {
    this.assertLoaded("topHeadlines");

    let results = this.articles;
    if (params.language) {
      results = results.filter((article) => article.lang === params.language);
    }

    return this.page(results, params.pageSize, params.pageNumber, limits);
  }

  /** Reproduce the tier's paging limits, so truncation paths are exercised offline. */
  private page(
    results: readonly RawGnewsArticle[],
    pageSize: number | undefined,
    pageNumber: number | undefined,
    limits: { maxPageSize: number },
  ): RawGnewsArticle[] {
    const size = Math.min(pageSize ?? limits.maxPageSize, limits.maxPageSize);
    const page = Math.max(1, pageNumber ?? 1);
    const offset = (page - 1) * size;
    return results.slice(offset, offset + size);
  }

  private assertLoaded(method: string): void {
    if (!this.loaded) {
      throw new Error(`GnewsFixtureStore.load() must be awaited before ${method}()`);
    }
  }

  private async readJson<T>(filename: string): Promise<T | null> {
    try {
      const raw = await readFile(join(this.fixturesDir, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
