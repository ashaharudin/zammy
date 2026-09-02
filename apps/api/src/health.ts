import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
// Named import: ioredis is CJS, so the default import resolves to a namespace
// rather than the class under NodeNext resolution.
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { CurrentsClient } from "@zammy/currents-client";
import type { QuotaView } from "@zammy/news-client";
import type { Database } from "@zammy/storage";
import { choreStatusDigest, readChoreStatus } from "./chore-status.js";

interface HealthDeps {
  pool: Pool;
  redis: Redis;
  currents: CurrentsClient;
  /** The same handle the request path uses, for the `chore_runs` digest below. */
  db: Kysely<Database>;
}

/**
 * Liveness and readiness (ARCHITECTURE 6.1). Deployment moved to
 * Vercel + Supabase + Upstash (ADR-0015), which has no container health-check
 * loop to feed; `/readyz` is used for manual and CI verification instead, and
 * `docker compose` uses both locally, so the split still matters:
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
 *
 * ## `chores`, and why it never moves `status`
 *
 * `/readyz` reported the three dependencies and said nothing about whether last
 * night ran, which under one-hour log retention made "did the chores fire?" a
 * question the deployment could not answer at all (ADR-0015, `chore-status.ts`).
 * The digest is folded in here because this is the one URL a person already
 * curls after a deploy.
 *
 * **It is additive and it is inert.** `status` stays a statement about Postgres
 * and Redis exactly as `deploy/vercel/deploy.sh` and
 * `provision-production.sh` document it — `ready`, `degraded`, `unready` and
 * nothing else — because an overdue chore is not a reason to call the API
 * unable to serve, and a probe that went red overnight would train whoever reads
 * it to ignore the colour. An overdue pass shows up as `chores.ok: false` and in
 * no other field.
 *
 * **And it cannot fail the probe.** A `chore_runs` read that throws — the
 * commonest cause being a deployment whose migrations have not caught up — is
 * reported inside `chores` and changes nothing else.
 *
 * The digest is narrow on purpose: this endpoint is unauthenticated, so it
 * carries pass names, a flag and one timestamp. Run ids, sources, error strings
 * and model-call counts are behind the bearer check on `/api/chores?status`.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const [postgres, redis, quota, providers, chores] = await Promise.all([
      check(() => deps.pool.query("SELECT 1")),
      check(() => deps.redis.ping()),
      deps.currents.quota(),
      quotaByProvider(deps.currents),
      choreDigest(deps.db),
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
        // The top-level numbers stay the primary's, so this field keeps
        // meaning what it always did. `providers` is additive: a
        // supplement running out narrows breadth rather than stopping the
        // timeline, and folding its much smaller budget into the headline would
        // make a healthy system look exhausted every afternoon.
        providers,
      },
      // Additive, and it never reaches `status` above — see the header.
      chores,
    });
  });
}

/**
 * The `chore_runs` digest, or the reason there isn't one.
 *
 * `ok: false` with an `error` is "the table could not be read"; `ok: false`
 * without one is "a pass is late or stuck, and `overdue`/`stalled` name it".
 * Both are worth telling apart at a glance, which is why the error is not
 * flattened into the arrays.
 */
async function choreDigest(db: Kysely<Database>): Promise<object> {
  try {
    return choreStatusDigest(await readChoreStatus(db));
  } catch (error) {
    return { ok: false, overdue: [], stalled: [], lastRunAt: null, error: describeError(error) };
  }
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
