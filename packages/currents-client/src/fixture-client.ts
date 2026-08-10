import type { FixtureStore } from "./fixture-store.js";
import { normalizeSightings } from "./normalize.js";
import { clampSearchParams, type SearchParams } from "./raw.js";
import { UnmeteredQuotaGovernor, type QuotaView } from "./quota.js";
import type { CallOpts, ClientLimits, CurrentsClient, SearchResult } from "./client.js";

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
  private readonly governor: UnmeteredQuotaGovernor;

  constructor(
    private readonly store: FixtureStore,
    readonly limits: ClientLimits,
    bounds: { dailyLimit: number; burstLimit: number },
  ) {
    this.governor = new UnmeteredQuotaGovernor(bounds);
  }

  async search(params: SearchParams, _opts: CallOpts = {}): Promise<SearchResult> {
    const { params: clamped, adjustments } = clampSearchParams(params, this.limits);
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

  async latestNews(language?: string, opts: CallOpts = {}): Promise<SearchResult> {
    return this.search(language ? { language } : {}, opts);
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
