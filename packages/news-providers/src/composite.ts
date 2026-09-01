import {
  accumulateStats,
  emptyStats,
  isNewsError,
  type CallOpts,
  type ClientLimits,
  type ClientLogger,
  type NewsClient,
  type ProviderCompleteness,
  type QuotaView,
  type SearchParams,
  type SearchResult,
  type Sighting,
} from "@zammy/news-client";
import type { CurrentsClient, LatestNewsParams } from "@zammy/currents-client";
import type { GnewsClient } from "@zammy/gnews-client";

/**
 * Two providers behind one client (ARCHITECTURE 5.6).
 *
 * Every call fans out to both and the results are merged. Nothing above this
 * class changes: the Query Service still plans in `SearchParams`, still receives
 * `Sighting[]`, and still never learns which upstream answered.
 *
 * ## What this reports, and what it deliberately does not decide
 *
 * `topic_coverage` records the spans we have actually fetched, and it is what
 * separates "nothing was published then" from "we never asked" (ADR-0001). The
 * old failure mode was a combined end-of-results signal: GNews runs out of its
 * 100 daily calls halfway through a window, Currents reports the window
 * finished, and one coverage row claims days GNews never looked at — a
 * permanent, silent gap that no error reports and no retry repairs, because
 * coverage says the work is done.
 *
 * ADR-0012 prevented that by ranking the providers — one coverage-bearing, the
 * rest best-effort breadth that could never end a walk. **ADR-0019 supersedes
 * that**, and its argument dissolves rather than overrules: coverage is
 * `(subject, provider, span)`, so each provider records only the spans it
 * actually walked and a provider that ran out of budget simply still has a gap.
 * The claim that needed forbidding is now inexpressible, so nothing here needs
 * to rank anyone.
 *
 * What this class does instead is **report facts and resolve nothing**:
 * `completeness` carries one entry per provider that actually answered, each
 * saying whether its OWN walk of this window reached the end. A provider that
 * errored, sat out a query it cannot express, or ran out of budget is simply
 * absent from that list — which is exactly "it has no claim over this window",
 * and cannot be mistaken for a claim that it finished. The caller picks the
 * provider it is recording for.
 *
 * The one thing still resolved to a single answer is `isLastPage`, and it is
 * not a coverage claim: the fan-out sends every provider the same `pageNumber`
 * and `pageSize`, so this is a **shared paging plan** and exactly one provider
 * can own its termination — the primary's. ADR-0019's "providers stop sharing a
 * plan" is what retires that, and it is a planner change, not this one.
 *
 * A supplement's failures stay non-fatal: the call succeeds with whatever the
 * others returned, because failing the whole call over a supplement would make
 * adding a provider a reliability regression. That is a choice about control
 * flow and never about visibility — every sit-out lands in `adjustments`, in a
 * warn log, and in `quotaByProvider()` behind `/readyz`.
 */

export interface CompositeOptions {
  logger?: ClientLogger;
}

/** One provider's contribution to a fanned-out call. */
interface Contribution {
  provider: string;
  result: SearchResult | null;
  /** Set when the provider did not contribute. Never fatal for a supplement. */
  error?: unknown;
}

export class CompositeNewsClient implements CurrentsClient {
  readonly provider = "composite";
  readonly limits: ClientLimits;
  private readonly logger: ClientLogger | undefined;

  constructor(
    /**
     * The provider whose paging plan the fan-out follows: its `isLastPage`
     * terminates the shared walk, and its failures are the composite's
     * failures. NOT a coverage rank — every provider's own claim is reported
     * in `completeness` (ADR-0019).
     */
    private readonly primary: CurrentsClient,
    /** Best-effort supplements. Present order is the order they are reported in. */
    private readonly supplements: readonly GnewsClient[],
    options: CompositeOptions = {},
  ) {
    this.limits = narrowestLimits([primary, ...supplements]);
    this.logger = options.logger;
  }

  async search(params: SearchParams, opts: CallOpts = {}): Promise<SearchResult> {
    // Dispatched together rather than in sequence: they are independent calls to
    // different hosts, and a reader waiting on the 1200ms synchronous fill
    // budget (ARCHITECTURE 6.3) should not pay for them one after the other.
    const [primary, ...supplements] = await Promise.all([
      this.callPrimary((client) => client.search(params, opts)),
      ...this.supplements.map((client) =>
        this.callSupplement(client, () => client.search(params, opts)),
      ),
    ]);

    return this.merge(primary!, supplements, "search");
  }

  /**
   * The §10.1 breadth sample, widened.
   *
   * Currents contributes its whole curated v2 category list in one call. GNews
   * contributes one `/top-headlines` call — its taxonomy takes a single category
   * per request, and nine calls for nine categories would be most of a day's
   * budget for one wordcloud refresh, so the default feed is what it adds.
   */
  async latestNews(params: LatestNewsParams = {}, opts: CallOpts = {}): Promise<SearchResult> {
    const [primary, ...supplements] = await Promise.all([
      this.callPrimary((client) => client.latestNews(params, opts)),
      ...this.supplements.map((client) =>
        this.callSupplement(client, () =>
          client.topHeadlines(
            {
              ...(params.language ? { language: params.language } : {}),
              ...(params.pageNumber !== undefined ? { pageNumber: params.pageNumber } : {}),
            },
            opts,
          ),
        ),
      ),
    ]);

    return this.merge(primary!, supplements, "latestNews");
  }

  /**
   * Reference lists come from Currents alone, and deliberately.
   *
   * They populate the search form's pickers, and the form's values are what a
   * topic fingerprint is built from. Merging in GNews's shorter lists would
   * offer filters that only one provider honours, and intersecting them would
   * remove filters that work perfectly well today. Currents' lists describe what
   * a topic can be; GNews either serves such a topic or sits it out.
   */
  async availableLanguages(opts?: CallOpts): Promise<Record<string, string>> {
    return this.primary.availableLanguages(opts);
  }

  async availableRegions(opts?: CallOpts): Promise<Record<string, string>> {
    return this.primary.availableRegions(opts);
  }

  async availableCategories(opts?: CallOpts): Promise<string[]> {
    return this.primary.availableCategories(opts);
  }

  /**
   * The primary's budget, so `/readyz.upstream` and `meta.degraded` keep the
   * meaning they had before GNews existed: when this runs out, the timeline
   * stops refreshing. A supplement running out only
   * narrows the breadth, which is why it is reported separately rather than
   * folded in — a 100-call budget would otherwise dominate the headline number
   * and make a healthy system look exhausted every afternoon.
   */
  async quota(): Promise<QuotaView> {
    return this.primary.quota();
  }

  /** Every provider's budget, for the per-provider breakdown on `/readyz`. */
  async quotaByProvider(): Promise<Record<string, QuotaView>> {
    const clients: NewsClient[] = [this.primary, ...this.supplements];
    const views = await Promise.all(clients.map((client) => client.quota()));

    const byProvider: Record<string, QuotaView> = {};
    clients.forEach((client, index) => {
      byProvider[client.provider] = views[index]!;
    });
    return byProvider;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.primary.close(),
      ...this.supplements.map((client) => client.close()),
    ]);
  }

  private async callPrimary(
    call: (client: CurrentsClient) => Promise<SearchResult>,
  ): Promise<Contribution> {
    // No catch: the fan-out has no plan left when the provider whose plan it
    // is cannot answer, and that failure is the caller's to render
    // (ARCHITECTURE 11), exactly as it was before the fan-out existed.
    return { provider: this.primary.provider, result: await call(this.primary) };
  }

  private async callSupplement(
    client: GnewsClient,
    call: () => Promise<SearchResult>,
  ): Promise<Contribution> {
    try {
      return { provider: client.provider, result: await call() };
    } catch (error) {
      // Swallowed on purpose, and never silently — see the class comment. A
      // supplement that cannot answer costs us breadth, not correctness, and
      // failing the whole call over it would make adding a provider a
      // reliability regression.
      return { provider: client.provider, result: null, error };
    }
  }

  private merge(
    primary: Contribution,
    supplements: readonly Contribution[],
    operation: string,
  ): SearchResult {
    const base = primary.result!;
    const sightings: Sighting[] = [...base.sightings];
    const normalization = accumulateStats(emptyStats(), base.normalization);
    const adjustments = [...base.adjustments];
    let rawCount = base.rawCount;
    // Each contributor's own account of its own walk, concatenated rather than
    // resolved. A single client reports itself, so this is just the union.
    const completeness: ProviderCompleteness[] = [...base.completeness];

    for (const contribution of supplements) {
      if (!contribution.result) {
        const note = describeSitOut(contribution);
        adjustments.push(note);
        this.logger?.warn(
          { provider: contribution.provider, operation, err: contribution.error },
          `${contribution.provider} contributed nothing to this ${operation}; ` +
            "serving the remaining providers' results alone",
        );
        continue;
      }

      // Sightings are concatenated, not deduplicated. Two providers reporting
      // one URL is two genuine observations of one article, which is the same
      // relationship one provider re-emitting a story creates — and the storage
      // fold already collapses both on `dedupKey` (ADR-0002).
      sightings.push(...contribution.result.sightings);
      rawCount += contribution.result.rawCount;
      completeness.push(...contribution.result.completeness);
      accumulateStats(normalization, contribution.result.normalization);
      for (const adjustment of contribution.result.adjustments) {
        const tagged = `[${contribution.provider}] ${adjustment}`;
        if (!adjustments.includes(tagged)) adjustments.push(tagged);
      }
    }

    return {
      sightings,
      requestedAt: base.requestedAt,
      rawCount,
      // The SHARED PAGING PLAN's terminator, which is the primary's alone
      // because the plan is (same `pageNumber`, same `pageSize`, one loop). Not
      // a coverage claim — those are per provider, below.
      isLastPage: base.isLastPage,
      completeness,
      pageSize: base.pageSize,
      normalization,
      // The binding constraint, so a caller reading `quota` to decide whether to
      // keep going sees the budget that will actually stop it first.
      quota: tightestQuota([primary, ...supplements]),
      adjustments,
    };
  }
}

function describeSitOut(contribution: Contribution): string {
  const error = contribution.error;
  const reason = isNewsError(error)
    ? `${error.kind}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return `[${contribution.provider}] sat this call out (${reason})`;
}

/**
 * The most conservative limit each provider can satisfy.
 *
 * Every provider is asked the same `pageNumber` and `pageSize`, so the shared
 * numbers must be ones all of them can honour. The alternative — letting each
 * clamp its own page size — reads fine and silently under-covers: at a requested
 * page size of 20, page 2 is items 21–40 for Currents and items 11–20 for a
 * provider that clamped to 10, so that provider re-reads what it already sent
 * and never reaches its own tail.
 *
 * The price is that enabling a provider with a smaller page can make the others
 * spend more calls for the same window. That is a real cost, and it is the one
 * worth paying: it is visible in the quota numbers, whereas under-coverage is
 * visible nowhere.
 */
export function narrowestLimits(clients: readonly NewsClient[]): ClientLimits {
  const all = clients.map((client) => client.limits);
  return {
    maxPageSize: Math.min(...all.map((limits) => limits.maxPageSize)),
    maxRetrievableResults: Math.min(...all.map((limits) => limits.maxRetrievableResults)),
    maxLookbackDays: Math.min(...all.map((limits) => limits.maxLookbackDays)),
    maxRangeDays: Math.min(...all.map((limits) => limits.maxRangeDays)),
  };
}

/** The snapshot with the least left — the budget that will bind first. */
function tightestQuota(contributions: readonly Contribution[]) {
  let tightest: SearchResult["quota"] = null;
  for (const contribution of contributions) {
    const quota = contribution.result?.quota;
    if (!quota) continue;
    if (!tightest || quota.remaining < tightest.remaining) tightest = quota;
  }
  return tightest;
}
