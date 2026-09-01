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
  private readonly governor: UnmeteredQuotaGovernor;

  /**
   * The clock this client dates its work by, `Date.now` unless a caller says
   * otherwise — the same option `HttpTransport` takes, spelled the same way, so
   * "which clock does the client read" has one answer across both modes.
   *
   * It exists because `clampSearchParams` below applies the 30-day LOOKBACK
   * clamp before the store is ever asked, and reading the WALL clock there made
   * the whole fixture corpus decay: an offline caller asking for a recorded
   * window silently got a narrower one the moment that window aged past the
   * horizon, with a different `startDate` on every page (the clamp is recomputed
   * per call). That is not a test-only wrinkle — it is fixture mode answering a
   * question nobody asked — but it is a test that pays for it first, because
   * fixtures are dated once and the horizon moves every day. It took out
   * `apps/api`'s truncation cases on 2026-09-01: 180 recorded sightings became
   * 98, the fifth page came back short, and a walk that must report `truncated`
   * reported `completed` and recorded coverage over two days it never fetched.
   *
   * The live client has always injected this (`new Date(this.transport.now())`
   * in `http.ts`), which is why the same tests against live mode were fine and
   * why three prior fixes (#181, #187, a8ba6d9) could only work around it from
   * the outside. This is the injection point they said was missing.
   */
  private readonly now: () => number;

  constructor(
    private readonly store: FixtureStore,
    readonly limits: ClientLimits,
    bounds: { dailyLimit: number; burstLimit: number },
    options: { now?: () => number } = {},
  ) {
    this.governor = new UnmeteredQuotaGovernor(bounds);
    this.now = options.now ?? Date.now;
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
      ({ params: clamped, adjustments } = clampSearchParams(
        params,
        this.limits,
        new Date(this.now()),
      ));
    } catch (error) {
      throw tagProvider(error, PROVIDER);
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

  async latestNews(params: LatestNewsParams = {}, _opts: CallOpts = {}): Promise<SearchResult> {
    const pageSize = this.limits.maxPageSize;
    const raw = this.store.latestNews(params, { maxPageSize: pageSize });
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
