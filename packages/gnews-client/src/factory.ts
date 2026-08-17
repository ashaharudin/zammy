import {
  InProcessQuotaGovernor,
  type ClientLimits,
  type ClientLogger,
  type FetchLike,
  type QuotaGovernor,
} from "@zammy/news-client";
import { FixtureGnewsClient } from "./fixture-client.js";
import { GnewsFixtureStore } from "./fixture-store.js";
import { HttpGnewsClient } from "./http.js";
import type { GnewsClient } from "./client.js";

/**
 * Only the settings the client needs, structurally — not an import of
 * `@zammy/config`, for the same reason the Currents factory does not import it.
 */
export interface GnewsClientConfig {
  GNEWS_MODE: "live" | "fixture";
  GNEWS_API_KEY?: string | undefined;
  GNEWS_BASE_URL: string;
  GNEWS_USER_AGENT: string;
  GNEWS_MAX_PAGE_SIZE: number;
  GNEWS_MAX_RETRIEVABLE_RESULTS: number;
  GNEWS_MAX_LOOKBACK_DAYS: number;
  GNEWS_MAX_RANGE_DAYS: number;
  GNEWS_DAILY_CALL_LIMIT: number;
  GNEWS_BURST_CALL_LIMIT: number;
  GNEWS_BURST_WINDOW_MS: number;
  GNEWS_INTERACTIVE_RESERVE: number;
  FIXTURES_DIR: string;
}

export interface CreateGnewsClientDeps {
  logger?: ClientLogger;
  fetch?: FetchLike;
  quota?: QuotaGovernor;
}

export function gnewsClientLimits(config: GnewsClientConfig): ClientLimits {
  return {
    maxPageSize: config.GNEWS_MAX_PAGE_SIZE,
    maxRetrievableResults: config.GNEWS_MAX_RETRIEVABLE_RESULTS,
    maxLookbackDays: config.GNEWS_MAX_LOOKBACK_DAYS,
    maxRangeDays: config.GNEWS_MAX_RANGE_DAYS,
  };
}

export async function createGnewsClient(
  config: GnewsClientConfig,
  deps: CreateGnewsClientDeps = {},
): Promise<GnewsClient> {
  const limits = gnewsClientLimits(config);

  const bounds = {
    dailyLimit: config.GNEWS_DAILY_CALL_LIMIT,
    burstLimit: config.GNEWS_BURST_CALL_LIMIT,
  };

  if (config.GNEWS_MODE === "fixture") {
    const store = new GnewsFixtureStore(config.FIXTURES_DIR);
    await store.load();
    return new FixtureGnewsClient(store, limits, bounds);
  }

  return new HttpGnewsClient({
    baseUrl: config.GNEWS_BASE_URL,
    // Config validation already refuses live mode without a key, so this is a
    // belt-and-braces default rather than a real branch.
    apiKey: config.GNEWS_API_KEY ?? "",
    userAgent: config.GNEWS_USER_AGENT,
    limits,
    quota:
      deps.quota ??
      new InProcessQuotaGovernor({
        ...bounds,
        interactiveReserve: config.GNEWS_INTERACTIVE_RESERVE,
        // A second, not a minute: the Free tier's documented limit is 1 request
        // per second, which is a different shape of window from the Currents
        // 60/60s the default was written for.
        burstWindowMs: config.GNEWS_BURST_WINDOW_MS,
      }),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
