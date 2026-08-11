import { FixtureCurrentsClient } from "./fixture-client.js";
import { FixtureStore } from "./fixture-store.js";
import { HttpCurrentsClient, type ClientLogger, type FetchLike } from "./http.js";
import { InProcessQuotaGovernor, type QuotaGovernor } from "./quota.js";
import type { ClientLimits, CurrentsClient } from "./client.js";

/**
 * Only the settings the client needs, structurally — not an import of
 * `@zammy/config`.
 *
 * The client knows HTTP and the Currents contract and nothing else
 * (ARCHITECTURE 5). A `Config` object satisfies this shape, so `apps/api` passes
 * its config straight in, while the client stays usable from a test or a script
 * with a hand-written object and no environment at all.
 */
export interface CurrentsClientConfig {
  CURRENTS_MODE: "live" | "fixture";
  CURRENTS_API_KEY?: string | undefined;
  CURRENTS_BASE_URL: string;
  CURRENTS_USER_AGENT: string;
  CURRENTS_MAX_PAGE_SIZE: number;
  CURRENTS_MAX_RETRIEVABLE_RESULTS: number;
  CURRENTS_MAX_LOOKBACK_DAYS: number;
  CURRENTS_MAX_RANGE_DAYS: number;
  CURRENTS_DAILY_CALL_LIMIT: number;
  CURRENTS_BURST_CALL_LIMIT: number;
  INTERACTIVE_RESERVE: number;
  FIXTURES_DIR: string;
}

export interface CreateClientDeps {
  logger?: ClientLogger;
  fetch?: FetchLike;
  /**
   * Phase 3 passes the Redis-backed governor here so quota is shared across
   * Fargate tasks (ARCHITECTURE 5.4). Until then the in-process one is correct
   * for a single replica.
   */
  quota?: QuotaGovernor;
}

export function clientLimits(config: CurrentsClientConfig): ClientLimits {
  return {
    maxPageSize: config.CURRENTS_MAX_PAGE_SIZE,
    maxRetrievableResults: config.CURRENTS_MAX_RETRIEVABLE_RESULTS,
    maxLookbackDays: config.CURRENTS_MAX_LOOKBACK_DAYS,
    maxRangeDays: config.CURRENTS_MAX_RANGE_DAYS,
  };
}

/**
 * Build the client the configured mode calls for. Callers get one interface and
 * never learn which they got — the whole point of ARCHITECTURE 4.1's rule that no
 * code path may branch on environment.
 */
export async function createCurrentsClient(
  config: CurrentsClientConfig,
  deps: CreateClientDeps = {},
): Promise<CurrentsClient> {
  const limits = clientLimits(config);

  if (config.CURRENTS_MODE === "fixture") {
    const store = new FixtureStore(config.FIXTURES_DIR);
    await store.load();
    return new FixtureCurrentsClient(store, limits, {
      dailyLimit: config.CURRENTS_DAILY_CALL_LIMIT,
      burstLimit: config.CURRENTS_BURST_CALL_LIMIT,
    });
  }

  const bounds = {
    dailyLimit: config.CURRENTS_DAILY_CALL_LIMIT,
    burstLimit: config.CURRENTS_BURST_CALL_LIMIT,
  };

  return new HttpCurrentsClient({
    baseUrl: config.CURRENTS_BASE_URL,
    // Config validation already refuses live mode without a key, so this is a
    // belt-and-braces default rather than a real branch.
    apiKey: config.CURRENTS_API_KEY ?? "",
    userAgent: config.CURRENTS_USER_AGENT,
    limits,
    quotaBounds: bounds,
    quota:
      deps.quota ??
      new InProcessQuotaGovernor({
        ...bounds,
        interactiveReserve: config.INTERACTIVE_RESERVE,
      }),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
