import type { ClientLogger, FetchLike, QuotaGovernor } from "@zammy/news-client";
import {
  createCurrentsClient,
  type CurrentsClient,
  type CurrentsClientConfig,
} from "@zammy/currents-client";
import { createGnewsClient, type GnewsClientConfig } from "@zammy/gnews-client";
import { CompositeNewsClient } from "./composite.js";

/**
 * Build the news client this configuration calls for.
 *
 * One entry point, one returned interface, and no caller learns how many
 * providers are behind it — the same rule that keeps `CURRENTS_MODE` invisible
 * above the client (ARCHITECTURE 4.1) applied to provider count.
 */

export interface NewsProvidersConfig
  extends CurrentsClientConfig,
    Omit<GnewsClientConfig, "GNEWS_USER_AGENT"> {
  /**
   * Off by default. Adding a provider changes what gets ingested and how the
   * budget is spent, so it is an explicit decision rather than something that
   * happens the moment a package is installed.
   */
  GNEWS_ENABLED: boolean;
  /** Optional: falls back to the Currents one, which is already mandatory. */
  GNEWS_USER_AGENT?: string | undefined;
}

export interface CreateNewsClientDeps {
  logger?: ClientLogger;
  fetch?: FetchLike;
  /**
   * Governors keyed by provider name — `"currents"`, `"gnews"`. Each provider
   * has its own budget, its own tier and its own reset, so they are never
   * shared between providers.
   *
   * Left unset, each adapter builds an in-process counter. That is correct for
   * a single replica that stays up, and wrong in the two ways
   * `InProcessQuotaGovernor` documents — notably worse for GNews, which sends
   * no headers to correct a restart's optimism. ARCHITECTURE 5.4's Redis-backed
   * snapshot belongs here; it is designed and not yet built.
   */
  quota?: Record<string, QuotaGovernor>;
}

export async function createNewsClient(
  config: NewsProvidersConfig,
  deps: CreateNewsClientDeps = {},
): Promise<CurrentsClient> {
  const currents = await createCurrentsClient(config, {
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.quota?.["currents"] ? { quota: deps.quota["currents"] } : {}),
  });

  // Returned bare rather than wrapped in a composite of one: with no supplement
  // there is nothing to merge, nothing to narrow, and no reason for a caller to
  // pay a layer of indirection for a fan-out that is not happening.
  if (!config.GNEWS_ENABLED) return currents;

  const gnews = await createGnewsClient({
    ...config,
    // One User-Agent for the whole service unless someone deliberately splits
    // them. The Currents one is already required and non-empty, so this cannot
    // fall back to the default library UA that cost the probe its first 11 calls.
    GNEWS_USER_AGENT: config.GNEWS_USER_AGENT?.trim() || config.CURRENTS_USER_AGENT,
  }, {
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.quota?.["gnews"] ? { quota: deps.quota["gnews"] } : {}),
  });

  return new CompositeNewsClient(currents, [gnews], {
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
