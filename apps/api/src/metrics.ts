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
}

/** Scrape endpoint. Not under /api/v1 — it is for Prometheus, not browsers. */
export function registerMetricsRoute(app: FastifyInstance, metrics: Metrics): void {
  app.get("/metrics", async (_request, reply) => {
    return reply
      .header("content-type", metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });
}
