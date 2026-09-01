import {
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
  private readonly governor: UnmeteredQuotaGovernor;

  /**
   * The clock this client dates its work by, `Date.now` unless a caller says
   * otherwise — the same option `HttpTransport` and the live client take.
   *
   * The lookback clamp below runs before the store is asked, so a wall-clock
   * read here quietly narrows any window that has aged past the horizon, and
   * fixtures are dated once while the horizon moves daily. Sibling of the same
   * injection point on `FixtureCurrentsClient`, where the decay was first paid
   * for — see that class for the full account.
   */
  private readonly now: () => number;

  constructor(
    private readonly store: GnewsFixtureStore,
    readonly limits: ClientLimits,
    bounds: { dailyLimit: number; burstLimit: number },
    options: { now?: () => number } = {},
  ) {
    this.governor = new UnmeteredQuotaGovernor(bounds);
    this.now = options.now ?? Date.now;
  }

  async search(params: SearchParams, _opts: CallOpts = {}): Promise<SearchResult> {
    // The clamp is inside the tagging block: its refusals — a pageNumber past
    // the retrievable cap, a range past the per-call ceiling — belong to this
    // provider as much as the unservable-query refusal below. Left outside,
    // they reach log lines, metrics and `meta.degraded` as `provider:
    // "unknown"`. Fixture mode must refuse exactly as live does, tag included.
    let clamped: SearchParams;
    let adjustments: string[];
    try {
      ({ params: clamped, adjustments } = clampSearchParams(
        params,
        this.limits,
        new Date(this.now()),
      ));
    } catch (error) {
      throw tagProvider(error, PROVIDER);
    }

    const unservable = unservableReason(clamped);
    if (unservable) {
      throw tagProvider(new NewsInvalidQueryError(unservable, { q: unservable }), PROVIDER);
    }

    const pageSize = clamped.pageSize ?? this.limits.maxPageSize;
    const raw = this.store.search(clamped, { maxPageSize: this.limits.maxPageSize });
    const { sightings, stats } = normalizeSightings(raw);
    const lastPage = raw.length < pageSize;

    return {
      sightings,
      requestedAt: new Date(this.now()),
      rawCount: raw.length,
      isLastPage: lastPage,
      completeness: soleContributor(PROVIDER, lastPage),
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
    const lastPage = isLastPage(raw.length, pageSize, params.pageNumber ?? 1, null);

    return {
      sightings,
      requestedAt: new Date(this.now()),
      rawCount: raw.length,
      isLastPage: lastPage,
      completeness: soleContributor(PROVIDER, lastPage),
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
