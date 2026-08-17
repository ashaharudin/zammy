import {
  InProcessQuotaGovernor,
  type ClientLimits,
  type ClientLogger,
  type FetchLike,
  type QuotaGovernor,
} from "@zammy/news-client";
import { FixtureCurrentsClient } from "./fixture-client.js";
import { FixtureStore } from "./fixture-store.js";
import { HttpCurrentsClient } from "./http.js";
import type { CurrentsClient } from "./client.js";

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
   * A shared governor, when one exists. Defaults to the in-process counter,
   * which is correct for a single replica that stays up and wrong in the two
   * ways `InProcessQuotaGovernor` documents. ARCHITECTURE 5.4's Redis-backed
   * snapshot is the intended occupant of this slot; it is designed and not yet
   * built, and this parameter is the whole of what wiring it in requires.
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
 * Build the Currents client the configured mode calls for. Callers get one
 * interface and never learn which they got — the whole point of
 * ARCHITECTURE 4.1's rule that no code path may branch on environment.
 */
export async function createCurrentsClient(
  config: CurrentsClientConfig,
  deps: CreateClientDeps = {},
): Promise<CurrentsClient> {
  const limits = clientLimits(config);

  const bounds = {
    dailyLimit: config.CURRENTS_DAILY_CALL_LIMIT,
    burstLimit: config.CURRENTS_BURST_CALL_LIMIT,
  };

  if (config.CURRENTS_MODE === "fixture") {
    const store = new FixtureStore(config.FIXTURES_DIR);
    await store.load();
    return new FixtureCurrentsClient(store, limits, bounds);
  }

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
