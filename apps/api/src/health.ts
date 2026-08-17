import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
// Named import: ioredis is CJS, so the default import resolves to a namespace
// rather than the class under NodeNext resolution.
import type { Redis } from "ioredis";
import type { CurrentsClient } from "@zammy/currents-client";
import type { QuotaView } from "@zammy/news-client";

interface HealthDeps {
  pool: Pool;
  redis: Redis;
  currents: CurrentsClient;
}

/**
 * Liveness and readiness (ARCHITECTURE 6.1). The ALB uses these in AWS, and
 * `docker compose` uses them locally, so the split matters:
 *
 *   /healthz — is the process alive? No dependency checks. A failing dependency
 *              must not get the container killed and restarted, which fixes nothing.
 *   /readyz  — can it actually serve? Checks Postgres and Redis.
 *
 * Postgres is the one hard dependency: without it we cannot honour the ordering
 * guarantee the timeline is built on. Redis being down is degraded, not down —
 * it is pure cache (ARCHITECTURE 11).
 *
 * Upstream is reported but never *probed*. A readiness check that called the
 * Currents API would spend a quota token every time the load balancer asked —
 * at a 30-second interval that is ~2900 calls a day against a 1000-call budget,
 * so the probe alone would exhaust the product's entire capacity. What we report
 * instead is what the last real call already told us (ARCHITECTURE 5.4).
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const [postgres, redis, quota, providers] = await Promise.all([
      check(() => deps.pool.query("SELECT 1")),
      check(() => deps.redis.ping()),
      deps.currents.quota(),
      quotaByProvider(deps.currents),
    ]);

    // Redis down is survivable; Postgres down is not.
    const ready = postgres.ok;

    return reply.code(ready ? 200 : 503).send({
      status: ready ? (redis.ok ? "ready" : "degraded") : "unready",
      checks: { postgres, redis },
      // Quota exhaustion is a designed-for state on the Free tier, not an
      // incident, so it never makes us unready — but it is the first thing worth
      // knowing when the timeline stops refreshing.
      upstream: {
        dailyRemaining: quota.dailyRemaining,
        burstRemaining: quota.burstRemaining,
        resetAt: quota.resetAt?.toISOString() ?? null,
        observed: quota.observed !== null,
        // The top-level numbers stay the coverage-bearing provider's, so this
        // field keeps meaning what it always did. `providers` is additive: a
        // supplement running out narrows breadth rather than stopping the
        // timeline, and folding its much smaller budget into the headline would
        // make a healthy system look exhausted every afternoon.
        providers,
      },
    });
  });
}

/**
 * Per-provider budgets, when there is more than one provider to report.
 *
 * Feature-detected rather than typed into the client interface: a single-provider
 * deployment returns its own client bare, and `NewsClient` should not carry a
 * method that only the composite can answer.
 */
async function quotaByProvider(
  client: CurrentsClient,
): Promise<Record<string, unknown> | null> {
  const composite = client as CurrentsClient & {
    quotaByProvider?: () => Promise<Record<string, QuotaView>>;
  };
  if (typeof composite.quotaByProvider !== "function") return null;

  const byProvider = await composite.quotaByProvider();
  return Object.fromEntries(
    Object.entries(byProvider).map(([provider, view]) => [
      provider,
      {
        dailyRemaining: view.dailyRemaining,
        burstRemaining: view.burstRemaining,
        resetAt: view.resetAt?.toISOString() ?? null,
        observed: view.observed !== null,
      },
    ]),
  );
}

async function check(
  probe: () => Promise<unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await probe();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * A readiness probe that reports `error: ""` is worse than useless. Node's
 * connection failures often carry an empty `message` with the real cause in
 * `code` or in an AggregateError's children, so dig for something actionable.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [];
  if (error.message) parts.push(error.message);

  const code = (error as NodeJS.ErrnoException).code;
  if (code) parts.push(code);

  if (error instanceof AggregateError) {
    const causes = error.errors
      .map((inner) =>
        inner instanceof Error
          ? inner.message || (inner as NodeJS.ErrnoException).code || inner.name
          : String(inner),
      )
      .filter(Boolean);
    if (causes.length) parts.push(`[${[...new Set(causes)].join(", ")}]`);
  }

  return parts.length ? parts.join(" ") : error.name;
}
