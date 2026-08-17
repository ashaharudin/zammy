import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InProcessQuotaGovernor, type FetchLike } from "@zammy/news-client";
import { HttpGnewsClient, type HttpGnewsClientOptions } from "./http.js";

/**
 * Test doubles for the GNews client. Not part of the published surface —
 * excluded from the build in tsconfig.json alongside the tests themselves.
 */

export const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

export interface StubbedCall {
  status?: number;
  body?: string | object;
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

    const body =
      typeof stub.body === "string" ? stub.body : JSON.stringify(stub.body ?? {});
    return new Response(body, {
      status: stub.status ?? 200,
      headers: stub.headers ?? { "content-type": "application/json" },
    });
  };

  return { fetch: fetchImpl, calls };
}

/** The Free tier's shape: 100 calls a day, one a second, ten per page. */
export function makeClient(
  overrides: Partial<HttpGnewsClientOptions> = {},
): HttpGnewsClient {
  return new HttpGnewsClient({
    baseUrl: "https://gnews.io/api/v4",
    apiKey: "test-key",
    userAgent: "zammy-test/0.0",
    limits: {
      maxPageSize: 10,
      maxRetrievableResults: 100,
      maxLookbackDays: 30,
      maxRangeDays: 30,
    },
    quota: new InProcessQuotaGovernor({
      dailyLimit: 100,
      burstLimit: 60,
      interactiveReserve: 25,
    }),
    // Instant, deterministic backoff so retry paths cost no wall-clock time.
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
}

/** One well-formed GNews article, for tests that care about a single field. */
export function rawArticle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f6",
    title: "A headline",
    description: "A description",
    content: "Some content [1234 chars]",
    url: "https://example.com/story",
    image: "https://example.com/image.jpg",
    publishedAt: "2026-08-04T20:45:56.000Z",
    lang: "en",
    source: {
      id: "example",
      name: "Example News",
      url: "https://example.com",
      country: "us",
    },
    ...overrides,
  };
}

export function okBody(
  articles: Array<Record<string, unknown>> = [rawArticle()],
  totalArticles = articles.length,
): Record<string, unknown> {
  return { totalArticles, articles };
}
