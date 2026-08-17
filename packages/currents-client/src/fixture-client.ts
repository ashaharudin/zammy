import {
  UnmeteredQuotaGovernor,
  clampSearchParams,
  tagProvider,
  type CallOpts,
  type ClientLimits,
  type QuotaView,
  type SearchParams,
  type SearchResult,
} from "@zammy/news-client";
import type { FixtureStore } from "./fixture-store.js";
import { PROVIDER, normalizeSightings } from "./normalize.js";
import type { CurrentsClient, LatestNewsParams } from "./client.js";

/**
 * Fixture-backed client (`CURRENTS_MODE=fixture`).
 *
 * Satisfies the same interface as the live client, which is the point: no code
 * above this package branches on environment (ARCHITECTURE 4.1), so what works
 * offline works online. The fixtures are real captured payloads, so offline mode
 * reproduces the upstream's actual misbehaviour — the duplication, the "None"
 * images, the non-ISO timestamps — and normalization is exercised for real rather
 * than against synthetic input that would never have needed it.
 *
 * It is NOT a relevance oracle: upstream matches against article body text we
 * never receive (PROBE-FINDINGS 3), so the store's keyword filter is strictly
 * narrower than the real one. Development and tests are what this is for.
 */
export class FixtureCurrentsClient implements CurrentsClient {
  readonly provider = PROVIDER;
  readonly coverageProvider = PROVIDER;
  private readonly governor: UnmeteredQuotaGovernor;

  constructor(
    private readonly store: FixtureStore,
    readonly limits: ClientLimits,
    bounds: { dailyLimit: number; burstLimit: number },
  ) {
    this.governor = new UnmeteredQuotaGovernor(bounds);
  }

  async search(params: SearchParams, _opts: CallOpts = {}): Promise<SearchResult> {
    // The clamp is inside the tagging block: its refusals — a pageNumber past
    // the retrievable cap, a range past the per-call ceiling — are this
    // provider's, and left untagged they reach log lines, metrics and
    // `meta.degraded` as `provider: "unknown"`. Fixture mode must refuse
    // exactly as live does, tag included.
    let clamped: SearchParams;
    let adjustments: string[];
    try {
      ({ params: clamped, adjustments } = clampSearchParams(params, this.limits));
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    const pageSize = clamped.pageSize ?? this.limits.maxPageSize;
    const raw = this.store.search(clamped, { maxPageSize: this.limits.maxPageSize });
    const { sightings, stats } = normalizeSightings(raw);

    return {
      sightings,
      requestedAt: new Date(),
      rawCount: raw.length,
      isLastPage: raw.length < pageSize,
      pageSize,
      normalization: stats,
      // No call was made, so there is no observation to report. Null rather than a
      // fabricated "plenty remaining", which would make a quota bug invisible in
      // exactly the mode most development happens in.
      quota: null,
      adjustments,
    };
  }

  async latestNews(params: LatestNewsParams = {}, _opts: CallOpts = {}): Promise<SearchResult> {
    const pageSize = this.limits.maxPageSize;
    const raw = this.store.latestNews(params, { maxPageSize: pageSize });
    const { sightings, stats } = normalizeSightings(raw);
    return {
      sightings,
      requestedAt: new Date(),
      rawCount: raw.length,
      isLastPage: raw.length < pageSize,
      pageSize,
      normalization: stats,
      quota: null,
      adjustments: [],
    };
  }

  async availableLanguages(): Promise<Record<string, string>> {
    return this.store.referenceLanguages;
  }

  async availableRegions(): Promise<Record<string, string>> {
    return this.store.referenceRegions;
  }

  async availableCategories(): Promise<string[]> {
    return this.store.referenceCategories;
  }

  async quota(): Promise<QuotaView> {
    return this.governor.peek();
  }

  async close(): Promise<void> {}
}
