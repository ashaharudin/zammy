import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { HttpCurrentsClient, type FetchLike, type HttpCurrentsClientOptions } from "./http.js";
import { InProcessQuotaGovernor } from "./quota.js";

/**
 * Test doubles for the client. Not part of the published surface — excluded from
 * the build in tsconfig.json alongside the tests themselves.
 *
 * The point of injecting fetch, clock, sleep and jitter is that retry, timeout,
 * backoff and breaker behaviour can be asserted exactly, offline, in
 * milliseconds. Testing those against a live upstream would be slow, flaky, and
 * would spend the quota this whole design exists to conserve.
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

/** Rate-limit headers as upstream actually sends them (PROBE-FINDINGS 1, 7). */
export function quotaHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-ratelimit-limit": "1000",
    "x-ratelimit-remaining": "977",
    "x-ratelimit-burst-limit": "60",
    "x-ratelimit-burst-remaining": "59",
    "x-ratelimit-reset-time": "2026-08-05T00:00:00+00:00",
    ...overrides,
  };
}

export function makeClient(
  overrides: Partial<HttpCurrentsClientOptions> = {},
): HttpCurrentsClient {
  return new HttpCurrentsClient({
    baseUrl: "https://api.currentsapi.services/v1",
    apiKey: "test-key",
    userAgent: "zammy-test/0.0",
    limits: { maxPageSize: 20, maxRetrievableResults: 100, maxLookbackDays: 30 },
    quotaBounds: { dailyLimit: 1000, burstLimit: 60 },
    quota: new InProcessQuotaGovernor({
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 250,
    }),
    // Instant, deterministic backoff so retry paths cost no wall-clock time.
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
}

/** One well-formed raw article, for tests that care about a single field. */
export function rawArticle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "827a8757-4627-5126-9878-1c026ee9f06c",
    title: "A headline",
    description: "A description",
    url: "https://example.com/story",
    author: "A Reporter",
    image: "https://example.com/image.jpg",
    language: "en",
    category: ["news"],
    source_category: ["news"],
    published: "2026-08-04 20:45:56 +0000",
    ...overrides,
  };
}
