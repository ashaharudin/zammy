import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchParams } from "@zammy/news-client";
import { ITEMS_PER_QUERY, RawGoogleNewsItem, parsePublished } from "./raw.js";
import { parseRssFeed } from "./rss.js";

/**
 * Serves recorded feeds instead of calling Google News
 * (`GOOGLE_NEWS_MODE=fixture`).
 *
 * Two files, both genuine live captures — unlike its GNews counterpart, which
 * had no key to record with and says so in its own `_provenance`:
 *
 *   `google-news-search-capped.xml`  100 items over two days of Aug 2026.
 *                                    The cap, hit exactly.
 *   `google-news-search-deep.xml`     20 items over two days of Feb 2025,
 *                                    18 months back. A short feed.
 *
 * They are the raw bytes, read through the same `parseRssFeed` the live client
 * uses, so fixture mode exercises the parser for real rather than around it.
 *
 * **Keywords are deliberately not filtered on.** Google matches against full
 * body text this feed does not carry — the same finding PROBE-FINDINGS 3
 * recorded for Currents, where only 7 of 20 articles returned for `climate`
 * contained the word anywhere we can see. A local keyword filter would return a
 * *different* set from the real one and teach development the wrong lesson
 * about what a query returns. The window is filtered, because the window is the
 * one thing the endpoint applies to data we can see.
 */

const FIXTURE_FILES = [
  "google-news-search-capped.xml",
  "google-news-search-deep.xml",
] as const;

export class GoogleNewsFixtureStore {
  private items: RawGoogleNewsItem[] = [];
  private language: string | null = null;
  private loaded = false;

  constructor(private readonly fixturesDir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;

    const collected: RawGoogleNewsItem[] = [];
    for (const filename of FIXTURE_FILES) {
      const xml = await this.readText(filename);
      if (!xml) continue;
      const feed = parseRssFeed(xml);
      this.language ??= feed.language;
      for (const item of feed.items) {
        const parsed = RawGoogleNewsItem.safeParse(item);
        if (parsed.success) collected.push(parsed.data);
      }
    }

    if (collected.length === 0) {
      throw new Error(
        `No Google News fixtures loaded from ${this.fixturesDir}. ` +
          `Fixture mode needs ${FIXTURE_FILES.join(" and ")} committed in ./fixtures.`,
      );
    }

    // Newest first, which is the order the live feed arrives in.
    collected.sort((a, b) => parsePublished(b.pubDate) - parsePublished(a.pubDate));
    this.items = collected;
    this.loaded = true;
  }

  get size(): number {
    return this.items.length;
  }

  /** The channel `<language>` of the first fixture read, e.g. `en-CA`. */
  get feedLanguage(): string | null {
    return this.language;
  }

  /**
   * Approximate the endpoint: window-filter, newest first, truncate at the cap.
   *
   * The truncation is the part worth having. It means a window wide enough to
   * catch the capped capture returns exactly `ITEMS_PER_QUERY` items offline,
   * so the "subdivide, do not treat this as finished" path is exercised in the
   * mode most development runs in rather than first met in production.
   *
   * The window applied is the one the caller ASKED for, not the day-padded,
   * Pacific-resolved one the live client actually sends (`BOUND_PADDING_MS` in
   * `raw.ts`). Reproducing that here would model Google's timezone twice and
   * make the fixture answers depend on a guess; the padding is asserted
   * directly against the query string instead, which is where it is real.
   */
  search(params: SearchParams): RawGoogleNewsItem[] {
    this.assertLoaded("search");

    let results = this.items;
    if (params.startDate) {
      const from = params.startDate.getTime();
      results = results.filter((item) => parsePublished(item.pubDate) >= from);
    }
    if (params.endDate) {
      const to = params.endDate.getTime();
      results = results.filter((item) => parsePublished(item.pubDate) <= to);
    }

    return results.slice(0, ITEMS_PER_QUERY);
  }

  private assertLoaded(method: string): void {
    if (!this.loaded) {
      throw new Error(`GoogleNewsFixtureStore.load() must be awaited before ${method}()`);
    }
  }

  private async readText(filename: string): Promise<string | null> {
    try {
      return await readFile(join(this.fixturesDir, filename), "utf8");
    } catch {
      return null;
    }
  }
}
