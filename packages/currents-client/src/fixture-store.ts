import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchParams } from "@zammy/news-client";
import { RawSighting } from "./raw.js";
import { parsePublished } from "./normalize.js";

/**
 * Serves recorded upstream payloads instead of calling the API (CURRENTS_MODE=fixture).
 *
 * The free tier allows 1000 calls/day; a dev server with hot reload exhausts that
 * before lunch. This makes the whole app developable — and the entire test suite
 * runnable — with no network and no quota (ARCHITECTURE 4.1).
 *
 * These are real captured payloads, so fixture mode reproduces the upstream's
 * actual misbehaviour: the duplication, the "None" images, the non-ISO dates.
 * That is the point. Synthetic fixtures would hide exactly the bugs worth catching.
 */

interface DuplicatesFixture {
  pages: Array<{ page_number: number; news: unknown[] }>;
}
interface SampleFixture {
  calls: Array<{ label: string; params: Record<string, string>; news: unknown[] }>;
}
interface ReferenceFixture {
  reference_languages?: { languages?: Record<string, string> };
  reference_regions?: { regions?: Record<string, string> };
  reference_categories?: { categories?: string[] };
}

export class FixtureStore {
  private sightings: RawSighting[] = [];
  private loaded = false;
  private languages: Record<string, string> = {};
  private regions: Record<string, string> = {};
  private categories: string[] = [];

  constructor(private readonly fixturesDir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;

    const collected: RawSighting[] = [];

    const duplicates = await this.readJson<DuplicatesFixture>(
      "search-climate-duplicates.json",
    );
    for (const page of duplicates?.pages ?? []) {
      collected.push(...this.parseAll(page.news));
    }

    const sample = await this.readJson<SampleFixture>(
      "search-keywordless-category-sample.json",
    );
    for (const call of sample?.calls ?? []) {
      collected.push(...this.parseAll(call.news));
    }

    // The recorded /v2/latest-news probe (PROBE-FINDINGS 6c). Its items carry
    // the v2 category taxonomy, which is what makes the fixture-mode breadth
    // sample (§10.1) return anything for a curated v2 category list.
    const latest = await this.readJson<SampleFixture>("latest-news-v2-sample.json");
    for (const call of latest?.calls ?? []) {
      // The v1 control call duplicates v2_plain's articles under v1 labels;
      // including both would double-ingest the same stories with conflicting
      // taxonomies. Replay only the v2 recordings.
      if (call.label.startsWith("v2_")) collected.push(...this.parseAll(call.news));
    }

    if (collected.length === 0) {
      throw new Error(
        `No fixtures loaded from ${this.fixturesDir}. ` +
          "Fixture mode needs the recorded payloads committed in ./fixtures.",
      );
    }

    // Reference lists come from the same recorded capture, so offline mode can
    // validate a `language` or `category` filter locally exactly as live mode
    // does (ARCHITECTURE 6.2 step 3) instead of accepting anything.
    const reference = await this.readJson<ReferenceFixture>(
      "error-and-reference-bodies.json",
    );
    this.languages = reference?.reference_languages?.languages ?? {};
    this.regions = reference?.reference_regions?.regions ?? {};
    this.categories = reference?.reference_categories?.categories ?? [];

    if (!Object.keys(this.languages).length || !this.categories.length) {
      throw new Error(
        `Reference data missing from ${this.fixturesDir}/error-and-reference-bodies.json. ` +
          "Fixture mode cannot validate filter values without it.",
      );
    }

    // Newest-first, matching upstream's own default ordering.
    collected.sort((a, b) => parsePublished(b.published) - parsePublished(a.published));
    this.sightings = collected;
    this.loaded = true;
  }

  get size(): number {
    return this.sightings.length;
  }

  /** Name → code, verbatim from the capture — including the "Vietnamise" typo. */
  get referenceLanguages(): Record<string, string> {
    return { ...this.languages };
  }

  get referenceRegions(): Record<string, string> {
    return { ...this.regions };
  }

  get referenceCategories(): string[] {
    return [...this.categories];
  }

  /**
   * Approximate the upstream's filtering. Deliberately approximate: real matching
   * runs against full article body text we never receive, so only 7 of 20 live
   * results for "climate" contained that word in title or description
   * (PROBE-FINDINGS 3). Fixture mode matches on the text we DO have, which is a
   * strictly narrower filter — fine for development, not a relevance oracle.
   */
  search(params: SearchParams, limits: { maxPageSize: number }): RawSighting[] {
    if (!this.loaded) {
      throw new Error("FixtureStore.load() must be awaited before search()");
    }

    let results = this.sightings;

    if (params.keywords?.length) {
      const terms = params.keywords.map((term) => term.toLowerCase());
      results = results.filter((sighting) => {
        const haystack =
          `${sighting.title ?? ""} ${sighting.description ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    if (params.language) {
      results = results.filter((sighting) => sighting.language === params.language);
    }
    if (params.category) {
      const wanted = params.category.toLowerCase();
      results = results.filter((sighting) =>
        (sighting.category ?? []).some((c) => c.toLowerCase() === wanted),
      );
    }
    if (params.startDate) {
      const from = params.startDate.getTime();
      results = results.filter((a) => parsePublished(a.published) >= from);
    }
    if (params.endDate) {
      const to = params.endDate.getTime();
      results = results.filter((a) => parsePublished(a.published) < to);
    }

    // Reproduce the tier's paging limits so code paths that handle truncation
    // are exercised offline rather than first meeting them in production.
    const pageSize = Math.min(params.pageSize ?? limits.maxPageSize, limits.maxPageSize);
    const pageNumber = Math.max(1, params.pageNumber ?? 1);
    const offset = (pageNumber - 1) * pageSize;

    return results.slice(offset, offset + pageSize);
  }

  /**
   * Approximate `/v2/latest-news` (PROBE-FINDINGS 6c): newest-first, filtered
   * by language and — like the real thing — by intersection with the given v2
   * categories, page shared across them, no date parameters at all.
   */
  latestNews(
    params: { language?: string; categories?: readonly string[]; pageNumber?: number },
    limits: { maxPageSize: number },
  ): RawSighting[] {
    if (!this.loaded) {
      throw new Error("FixtureStore.load() must be awaited before latestNews()");
    }

    let results = this.sightings;
    if (params.language) {
      results = results.filter((sighting) => sighting.language === params.language);
    }
    if (params.categories?.length) {
      const wanted = new Set(params.categories.map((c) => c.toLowerCase()));
      results = results.filter((sighting) =>
        (sighting.category ?? []).some((c) => wanted.has(c.toLowerCase())),
      );
    }

    const pageNumber = Math.max(1, params.pageNumber ?? 1);
    const offset = (pageNumber - 1) * limits.maxPageSize;
    return results.slice(offset, offset + limits.maxPageSize);
  }

  private async readJson<T>(filename: string): Promise<T | null> {
    try {
      const raw = await readFile(join(this.fixturesDir, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private parseAll(items: unknown[]): RawSighting[] {
    const parsed: RawSighting[] = [];
    for (const item of items) {
      const result = RawSighting.safeParse(item);
      if (result.success) parsed.push(result.data);
    }
    return parsed;
  }
}
