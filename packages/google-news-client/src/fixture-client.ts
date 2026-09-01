import {
  NewsInvalidQueryError,
  UnmeteredQuotaGovernor,
  clampSearchParams,
  soleContributor,
  tagProvider,
  type CallOpts,
  type ClientLimits,
  type QuotaView,
  type SearchParams,
  type SearchResult,
} from "@zammy/news-client";
import type { GoogleNewsFixtureStore } from "./fixture-store.js";
import { PROVIDER, normalizeSightings } from "./normalize.js";
import { isLastPage, pageSizeAdjustment } from "./http.js";
import { ITEMS_PER_QUERY, unservableReason } from "./raw.js";
import type { GoogleNewsClient } from "./client.js";

/**
 * Fixture-backed Google News client (`GOOGLE_NEWS_MODE=fixture`).
 *
 * Satisfies the same interface as the live client, so no code above this
 * package branches on environment (ARCHITECTURE 4.1). It reproduces the
 * refusals that matter as well as the happy path — a query this endpoint cannot
 * express is refused here exactly as it would be live, tag included — and it
 * reproduces the 100-item wall, which is the behaviour a caller is most likely
 * to get wrong.
 *
 * Fixture mode matters more here than for either other adapter, and for a
 * reason worth stating: this provider has no key, no published ceiling and no
 * rate-limit header, so there is no number that tells us when we have asked too
 * often. Every call a developer does not make against it is a call whose cost
 * we would otherwise be unable to measure.
 */
export class FixtureGoogleNewsClient implements GoogleNewsClient {
  readonly provider = PROVIDER;
  private readonly governor: UnmeteredQuotaGovernor;

  constructor(
    private readonly store: GoogleNewsFixtureStore,
    readonly limits: ClientLimits,
    bounds: { dailyLimit: number; burstLimit: number },
  ) {
    this.governor = new UnmeteredQuotaGovernor(bounds);
  }

  async search(params: SearchParams, _opts: CallOpts = {}): Promise<SearchResult> {
    let clamped: SearchParams;
    let adjustments: string[];
    try {
      ({ params: clamped, adjustments } = clampSearchParams(params, this.limits));
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    const unservable = unservableReason(clamped);
    if (unservable) {
      throw tagProvider(new NewsInvalidQueryError(unservable, { q: unservable }), PROVIDER);
    }

    const raw = this.store.search(clamped);
    const { sightings, stats } = normalizeSightings(raw, {
      language: this.store.feedLanguage,
    });

    return {
      sightings,
      requestedAt: new Date(),
      rawCount: raw.length,
      isLastPage: isLastPage(raw.length),
      completeness: soleContributor(PROVIDER, isLastPage(raw.length)),
      pageSize: ITEMS_PER_QUERY,
      normalization: stats,
      // No call was made, so there is no observation to report — and unlike
      // every other adapter, a live call would report nothing either.
      quota: null,
      adjustments: pageSizeAdjustment(clamped.pageSize, adjustments),
    };
  }

  async quota(): Promise<QuotaView> {
    return this.governor.peek();
  }

  async close(): Promise<void> {}
}
