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
import type { GnewsFixtureStore } from "./fixture-store.js";
import { PROVIDER, normalizeSightings } from "./normalize.js";
import { isLastPage } from "./http.js";
import { unservableReason, type TopHeadlinesParams } from "./raw.js";
import { NewsInvalidQueryError } from "@zammy/news-client";
import type { GnewsClient } from "./client.js";

/**
 * Fixture-backed GNews client (`GNEWS_MODE=fixture`).
 *
 * Satisfies the same interface as the live client, so no code above this package
 * branches on environment (ARCHITECTURE 4.1). It reproduces the two refusals
 * that matter as well as the happy path: a query GNews cannot express is refused
 * here exactly as it would be live, so the composite's sit-out behaviour is
 * exercised offline rather than first met in production.
 */
export class FixtureGnewsClient implements GnewsClient {
  readonly provider = PROVIDER;
  readonly coverageProvider = PROVIDER;
  private readonly governor: UnmeteredQuotaGovernor;

  constructor(
    private readonly store: GnewsFixtureStore,
    readonly limits: ClientLimits,
    bounds: { dailyLimit: number; burstLimit: number },
  ) {
    this.governor = new UnmeteredQuotaGovernor(bounds);
  }

  async search(params: SearchParams, _opts: CallOpts = {}): Promise<SearchResult> {
    const { params: clamped, adjustments } = clampSearchParams(params, this.limits);

    const unservable = unservableReason(clamped);
    if (unservable) {
      throw tagProvider(new NewsInvalidQueryError(unservable, { q: unservable }), PROVIDER);
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

  async topHeadlines(
    params: TopHeadlinesParams = {},
    _opts: CallOpts = {},
  ): Promise<SearchResult> {
    const pageSize = Math.min(
      params.pageSize ?? this.limits.maxPageSize,
      this.limits.maxPageSize,
    );
    const raw = this.store.topHeadlines(params, { maxPageSize: this.limits.maxPageSize });
    const { sightings, stats } = normalizeSightings(raw);

    return {
      sightings,
      requestedAt: new Date(),
      rawCount: raw.length,
      isLastPage: isLastPage(raw.length, pageSize, params.pageNumber ?? 1, null),
      pageSize,
      normalization: stats,
      quota: null,
      adjustments: [],
    };
  }

  async quota(): Promise<QuotaView> {
    return this.governor.peek();
  }

  async close(): Promise<void> {}
}
