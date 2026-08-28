import {
  InProcessQuotaGovernor,
  type ClientLimits,
  type ClientLogger,
  type FetchLike,
  type QuotaGovernor,
} from "@zammy/news-client";
import { FixtureGoogleNewsClient } from "./fixture-client.js";
import { GoogleNewsFixtureStore } from "./fixture-store.js";
import { HttpGoogleNewsClient } from "./http.js";
import { ITEMS_PER_QUERY } from "./raw.js";
import type { GoogleNewsClient } from "./client.js";

/**
 * Only the settings the client needs, structurally — not an import of
 * `@zammy/config`, for the same reason neither other adapter's factory imports
 * it.
 */
export interface GoogleNewsClientConfig {
  /**
   * Off by default, and enforced here rather than only at the wiring site.
   *
   * The principle is `GNEWS_ENABLED`'s, stated in the news-providers factory:
   * adding a provider changes what gets ingested and how budget is spent, so it
   * is an explicit decision rather than something that happens the moment a
   * package is installed.
   *
   * Two hazards specific to this provider used to be the reason, and **both are
   * now guarded** — worth recording, because the guards are what any later
   * reader should check still hold rather than assume:
   *
   *   - **Its articles could not be identified.** The `<link>` is an opaque
   *     redirect, so `dedup_key` cannot collapse a Google News item onto the
   *     same story from Currents. G1 landed `alt_key` (migration 0020,
   *     ADR-0018) and this adapter derives one from `<source url>` and the
   *     title — see `normalize.ts`, which also drops any item that cannot carry
   *     one rather than minting a row keyed on the redirect.
   *   - **The cloud would have measured its own fetching.** G2 landed the
   *     ranker restriction. ADR-0019 then reshaped it: the honest predicate is
   *     on a fetch's reason (`plane <> 'deepening'`), not on which provider
   *     answered, because this provider is expected to serve search and breadth
   *     too and no provider-level test can be right about both at once. The
   *     shipped form is still `DISCOVERY_PROVIDERS`, correct today and carrying
   *     its own shelf life; G5 replaces it.
   *
   * What is still missing is not a hazard but a destination: `storyline_coverage`
   * (G3) does not exist yet, and nothing calls this factory at all — G5 writes
   * the attachment rules and does the wiring. So the flag stays false, and it
   * stays enforced HERE rather than only at a future call site, because "off"
   * has to mean unreachable: an unwired guard is satisfied by doing nothing and
   * stops being satisfied the moment someone adds the import.
   */
  GOOGLE_NEWS_ENABLED: boolean;
  GOOGLE_NEWS_MODE: "live" | "fixture";
  GOOGLE_NEWS_BASE_URL: string;
  GOOGLE_NEWS_USER_AGENT: string;
  GOOGLE_NEWS_LANGUAGE: string;
  GOOGLE_NEWS_COUNTRY: string;
  GOOGLE_NEWS_MAX_LOOKBACK_DAYS: number;
  GOOGLE_NEWS_DAILY_CALL_LIMIT: number;
  GOOGLE_NEWS_BURST_CALL_LIMIT: number;
  GOOGLE_NEWS_BURST_WINDOW_MS: number;
  GOOGLE_NEWS_INTERACTIVE_RESERVE: number;
  FIXTURES_DIR: string;
}

export interface CreateGoogleNewsClientDeps {
  logger?: ClientLogger;
  fetch?: FetchLike;
  quota?: QuotaGovernor;
}

/**
 * Limits — except that there is no tier, which is the whole problem.
 *
 * `maxPageSize` and `maxRetrievableResults` are both `ITEMS_PER_QUERY` and both
 * come from the constant rather than from config, because neither is a plan we
 * could buy up: the endpoint returns at most 100 items and offers no offset.
 * Setting them equal makes `clampSearchParams` compute exactly one retrievable
 * page, so a caller that asks for a second one is refused by the shared clamp
 * as well as by `unservableReason` — two independent guards over the failure
 * that would otherwise re-ingest page one forever.
 */
export function googleNewsClientLimits(config: GoogleNewsClientConfig): ClientLimits {
  return {
    maxPageSize: ITEMS_PER_QUERY,
    maxRetrievableResults: ITEMS_PER_QUERY,
    maxLookbackDays: config.GOOGLE_NEWS_MAX_LOOKBACK_DAYS,
    // No per-call range ceiling was found, and none is documented — so the
    // range limit is the lookback, i.e. no artificial slicing. The real
    // constraint on a wide window is the 100-item cap, and that surfaces as
    // `isLastPage: false` rather than as a refusal, which is the honest signal:
    // the window was answerable, it just was not answered completely.
    maxRangeDays: config.GOOGLE_NEWS_MAX_LOOKBACK_DAYS,
  };
}

export async function createGoogleNewsClient(
  config: GoogleNewsClientConfig,
  deps: CreateGoogleNewsClientDeps = {},
): Promise<GoogleNewsClient> {
  if (!config.GOOGLE_NEWS_ENABLED) {
    throw new Error(
      "GOOGLE_NEWS_ENABLED is false; refusing to build a Google News client. " +
        "G1 (alt_key) and G2 (ranker isolation) have landed; this provider stays " +
        "off until G3 (storyline_coverage) exists and G5 wires it to a caller — " +
        "see DISCOVERY-DEEPENING-PLAN.md.",
    );
  }

  const limits = googleNewsClientLimits(config);

  /**
   * A budget we invented.
   *
   * Every other provider's numbers here are transcribed from something the
   * provider published — Currents' 1000/day came off an `x-ratelimit-limit`
   * header, GNews' 100/day off its pricing page. **These are neither.** There
   * is no key, no documented ceiling and no rate-limit header, so `quota()`
   * returns null forever and the governor will never once be corrected by
   * upstream. Nobody should later read these as measured limits.
   *
   * They are therefore set low on purpose. What an unhappy keyless endpoint
   * looks like is on record: GDELT answered 1 of 6 probe calls and the five
   * failures arrived as silent connection timeouts at 30–75s, not as a 429
   * (RESEARCH-FREE-NEWS-SOURCES §1) — i.e. the first warning we would get is no
   * warning at all, just a provider that stops answering. The breaker handles
   * that after the fact; a conservative budget is what keeps us from getting
   * there.
   */
  const bounds = {
    dailyLimit: config.GOOGLE_NEWS_DAILY_CALL_LIMIT,
    burstLimit: config.GOOGLE_NEWS_BURST_CALL_LIMIT,
  };

  if (config.GOOGLE_NEWS_MODE === "fixture") {
    const store = new GoogleNewsFixtureStore(config.FIXTURES_DIR);
    await store.load();
    return new FixtureGoogleNewsClient(store, limits, bounds);
  }

  return new HttpGoogleNewsClient({
    baseUrl: config.GOOGLE_NEWS_BASE_URL,
    userAgent: config.GOOGLE_NEWS_USER_AGENT,
    locale: {
      language: config.GOOGLE_NEWS_LANGUAGE,
      country: config.GOOGLE_NEWS_COUNTRY,
    },
    limits,
    quota:
      deps.quota ??
      new InProcessQuotaGovernor({
        ...bounds,
        interactiveReserve: config.GOOGLE_NEWS_INTERACTIVE_RESERVE,
        burstWindowMs: config.GOOGLE_NEWS_BURST_WINDOW_MS,
      }),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
