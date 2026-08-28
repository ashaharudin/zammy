import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InProcessQuotaGovernor, type FetchLike } from "@zammy/news-client";
import { HttpGoogleNewsClient, type HttpGoogleNewsClientOptions } from "./http.js";
import { ITEMS_PER_QUERY, RawGoogleNewsItem } from "./raw.js";
import { parseRssFeed, type RssFeed } from "./rss.js";

/**
 * Test doubles for the Google News client. Not part of the published surface —
 * excluded from the build in tsconfig.json alongside the tests themselves.
 */

export const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

export interface StubbedCall {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Simulate a transport fault instead of a response. */
  throws?: unknown;
}

export interface FetchStub {
  fetch: FetchLike;
  calls: Array<{ url: string; init: RequestInit }>;
}

export function stubFetch(responses: StubbedCall[]): FetchStub {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const stub = responses[index++];
    if (!stub) {
      throw new Error(
        `fetch called ${calls.length} times but only ${responses.length} responses ` +
          "were stubbed — an unexpected extra upstream call is itself a bug worth failing on",
      );
    }
    if (stub.throws) throw stub.throws;

    return new Response(stub.body ?? feed(), {
      status: stub.status ?? 200,
      headers: stub.headers ?? { "content-type": "text/xml; charset=UTF-8" },
    });
  };

  return { fetch: fetchImpl, calls };
}

/** The day both fixture feeds were captured. */
export const CAPTURED_AT = Date.parse("2026-08-28T00:00:00.000Z");

export function makeClient(
  overrides: Partial<HttpGoogleNewsClientOptions> = {},
): HttpGoogleNewsClient {
  return new HttpGoogleNewsClient({
    baseUrl: "https://news.google.com/rss",
    userAgent: "zammy-test/0.0",
    locale: { language: "en", country: "CA" },
    limits: {
      maxPageSize: ITEMS_PER_QUERY,
      maxRetrievableResults: ITEMS_PER_QUERY,
      maxLookbackDays: 730,
      maxRangeDays: 730,
    },
    quota: new InProcessQuotaGovernor({
      dailyLimit: 50,
      burstLimit: 5,
      interactiveReserve: 10,
    }),
    // Instant, deterministic backoff so retry paths cost no wall-clock time.
    sleep: async () => {},
    random: () => 0.5,
    // Pinned to the capture date. The lookback clamp is computed against `now`,
    // so a wall clock would make the windowing assertions start failing on
    // their own two years from whenever they were written.
    now: () => CAPTURED_AT,
    ...overrides,
  });
}

export interface ItemOverrides {
  title?: string | null;
  link?: string | null;
  guid?: string | null;
  pubDate?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  sourceName?: string | null;
}

/**
 * One `<item>` in the shape Google actually emits — entity-escaped
 * `<description>` blob, ` - Outlet` title suffix, opaque `CBM…` link, and a
 * `<source url>` naming a publisher the link does not.
 *
 * Passing `null` for a field omits the element entirely, which is how a
 * truncated or changed feed would arrive.
 */
export function item(overrides: ItemOverrides = {}): string {
  const {
    title = "A headline - Example News",
    link = "https://news.google.com/rss/articles/CBMiK2V4YW1wbGU?oc=5",
    guid = "CBMiK2V4YW1wbGU",
    pubDate = "Thu, 20 Aug 2026 17:09:53 GMT",
    description = null,
    sourceUrl = "https://www.example.com",
    sourceName = "Example News",
  } = overrides;

  const parts: string[] = [];
  if (title !== null) parts.push(`<title>${escapeXml(title)}</title>`);
  if (link !== null) parts.push(`<link>${escapeXml(link)}</link>`);
  if (guid !== null) parts.push(`<guid isPermaLink="false">${escapeXml(guid)}</guid>`);
  if (pubDate !== null) parts.push(`<pubDate>${escapeXml(pubDate)}</pubDate>`);
  // Google always sends one, and it is always the anchor blob. Synthesised in
  // that shape so a test asserting `description === null` is asserting that we
  // discarded something real rather than that nothing arrived.
  const blob =
    description ??
    `<a href="${link ?? ""}" target="_blank">${title ?? ""}</a>&nbsp;&nbsp;` +
      `<font color="#6f6f6f">${sourceName ?? ""}</font>`;
  parts.push(`<description>${escapeXml(blob)}</description>`);
  if (sourceUrl !== null || sourceName !== null) {
    parts.push(
      `<source url="${escapeXml(sourceUrl ?? "")}">${escapeXml(sourceName ?? "")}</source>`,
    );
  }
  return `<item>${parts.join("")}</item>`;
}

/** A whole channel wrapping the given items. */
export function feed(items: string[] = [item()], language = "en-CA"): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>' +
    "<generator>NFE/5.0</generator>" +
    "<title>&quot;test&quot; - Google News</title>" +
    `<language>${language}</language>` +
    "<copyright>Copyright © 2026 Google. All rights reserved.</copyright>" +
    "<image><title>Google News</title>" +
    "<url>https://lh3.googleusercontent.com/x</url>" +
    "<link>https://news.google.com/</link></image>" +
    "<description>Google News</description>" +
    items.join("") +
    "</channel></rss>"
  );
}

/** A capped feed: exactly `ITEMS_PER_QUERY` distinct items. */
export function cappedFeed(): string {
  return feed(
    Array.from({ length: ITEMS_PER_QUERY }, (_, i) =>
      item({
        title: `Headline ${i} - Example News`,
        link: `https://news.google.com/rss/articles/CBM${i}?oc=5`,
        guid: `CBM${i}`,
      }),
    ),
  );
}

/**
 * Read a feed the way the live client does: `parseRssFeed`, then the schema.
 *
 * The schema step is not ceremony — it is what turns the reader's plain
 * `RssItem` into the loose shape `normalizeSightings` takes, which is the same
 * path `HttpGoogleNewsClient` and the fixture store both run.
 */
export function parseFeed(xml: string): {
  feed: RssFeed;
  items: RawGoogleNewsItem[];
} {
  const feedValue = parseRssFeed(xml);
  const items: RawGoogleNewsItem[] = [];
  for (const raw of feedValue.items) {
    const parsed = RawGoogleNewsItem.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
  }
  return { feed: feedValue, items };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
