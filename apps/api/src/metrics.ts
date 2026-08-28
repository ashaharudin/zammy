import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { QuotaView } from "@zammy/currents-client";

/**
 * The §12 metric set. Each exists to answer one operational question, and two
 * exist specifically because of probe findings:
 *
 *   unique-articles-per-upstream-call (created / calls, baseline ~8 of 20) —
 *   a fall means upstream duplication is worsening;
 *
 *   truncated-segment rate (§11) — a rise means timelines are silently
 *   thinning behind the 100-result cap.
 *
 * Ratios are left to the scrape side (PromQL divides counters); the process
 * only ever counts.
 */

export type CacheTier = "hot" | "recent" | "historical";

export class Metrics {
  readonly registry = new Registry();

  private readonly cacheReads = new Counter({
    name: "zammy_page_cache_reads_total",
    help: "Page cache lookups by staleness tier (§6.4) and outcome",
    labelNames: ["tier", "result"] as const,
    registers: [this.registry],
  });

  private readonly timelineReads = new Histogram({
    name: "zammy_timeline_read_seconds",
    help: "Timeline read latency by where the answer came from",
    labelNames: ["served_from"] as const,
    registers: [this.registry],
  });

  private readonly upstreamCalls = new Counter({
    name: "zammy_upstream_calls_total",
    help: "Currents API calls actually dispatched",
    registers: [this.registry],
  });

  private readonly sightingsReceived = new Counter({
    name: "zammy_sightings_received_total",
    help: "Raw sightings received from upstream, before normalization",
    registers: [this.registry],
  });

  private readonly sightingsDropped = new Counter({
    name: "zammy_sightings_dropped_total",
    help: "Sightings dropped by normalization (§11: drop, count, keep the rest)",
    registers: [this.registry],
  });

  private readonly articlesCreated = new Counter({
    name: "zammy_articles_created_total",
    help: "Articles that did not exist before ingest — divide by upstream calls",
    registers: [this.registry],
  });

  private readonly groupedArticles = new Counter({
    name: "zammy_articles_grouped_total",
    help: "New articles that joined an existing group (§14.3) — divide by articles created",
    registers: [this.registry],
  });

  private readonly truncatedSegments = new Counter({
    name: "zammy_truncated_segments_total",
    help: "Segments that returned the full retrievable cap and had to subdivide",
    registers: [this.registry],
  });

  private readonly storylineRefreshes = new Counter({
    name: "zammy_storyline_refreshes_total",
    help: "Storyline opens by what the background refresh queued (ADR-0017)",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  private readonly storylineDeepens = new Counter({
    name: "zammy_storyline_deepening_total",
    help: "Storyline opens by what the DEEPENING plane queued (ADR-0019, plan G5)",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  constructor(options: { quota?: () => Promise<QuotaView> } = {}) {
    const quota = options.quota;
    if (quota) {
      // Headroom is read at scrape time from the shared snapshot — a stored
      // number would only ever be as fresh as the last upstream call.
      new Gauge({
        name: "zammy_quota_daily_remaining",
        help: "Daily Currents calls remaining per the last observed headers",
        registers: [this.registry],
        async collect() {
          this.set((await quota()).dailyRemaining);
        },
      });
    }
  }

  pageCacheRead(tier: CacheTier, result: "hit" | "miss"): void {
    this.cacheReads.inc({ tier, result });
  }

  timelineRead(servedFrom: string, seconds: number): void {
    this.timelineReads.observe({ served_from: servedFrom }, seconds);
  }

  upstreamCall(stats: { received: number; dropped: number }): void {
    this.upstreamCalls.inc();
    this.sightingsReceived.inc(stats.received);
    this.sightingsDropped.inc(stats.dropped);
  }

  articlesIngested(created: number): void {
    this.articlesCreated.inc(created);
  }

  /**
   * The rate to watch while the threshold is unmeasured (ADR-0005): near zero
   * means grouping is doing nothing, and a sharp rise means it is merging
   * stories that are merely similar.
   */
  articlesGrouped(count: number): void {
    this.groupedArticles.inc(count);
  }

  truncatedSegment(): void {
    this.truncatedSegments.inc();
  }

  /**
   * What a storyline click contributed to the demand-driven loop (ADR-0017).
   *
   * The ratio to watch is `queued / (queued + fresh)`: this exists because
   * ADR-0016 took the loop's cold-start contribution away and this gave it back,
   * so "how often does an open actually spend a call" is the question. All
   * `fresh` means the freshness gate is doing its job on a warm archive; all
   * `queued` on a live window would mean the gate is not holding and every
   * click is buying an upstream call. `no_keywords` is a labelling failure
   * surfacing here — an arc with neither a label nor a profile.
   */
  storylineRefresh(result: "queued" | "fresh" | "no_keywords" | "invalid"): void {
    this.storylineRefreshes.inc({ result });
  }

  /**
   * The deepening plane's half of the same question, and it is a SEPARATE
   * counter rather than a label on the one above because the two are planned
   * against different coverage and can disagree — an arc can be fresh to
   * Currents and cold to the deepening provider on the same click, which is
   * exactly what per-provider coverage is for (ADR-0019).
   *
   * `unavailable` dominating is the shipped state, not a fault:
   * `GOOGLE_NEWS_ENABLED` is false by default and no deepening provider is
   * configured. Watch it after the flag goes on — it should fall to zero.
   *
   * `ungrounded` is the number G6 will want and nothing else reports it: it
   * counts arcs whose model label shares NO word with their own coverage, which
   * is a labelling failure the cloud currently hides rather than a fetch
   * problem. It is also the only refusal here that is a judgement rather than a
   * state, so a sudden rise means the labeler moved, not that traffic did.
   */
  storylineDeepen(
    result: "queued" | "fresh" | "ungrounded" | "unavailable",
  ): void {
    this.storylineDeepens.inc({ result });
  }
}

/** Scrape endpoint. Not under /api/v1 — it is for Prometheus, not browsers. */
export function registerMetricsRoute(app: FastifyInstance, metrics: Metrics): void {
  app.get("/metrics", async (_request, reply) => {
    return reply
      .header("content-type", metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });
}
