import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
// Named import: ioredis is CJS, so the default import resolves to a namespace
// rather than the class under NodeNext resolution.
import type { Redis } from "ioredis";

interface HealthDeps {
  pool: Pool;
  redis: Redis;
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
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      check(() => deps.pool.query("SELECT 1")),
      check(() => deps.redis.ping()),
    ]);

    // Redis down is survivable; Postgres down is not.
    const ready = postgres.ok;

    return reply.code(ready ? 200 : 503).send({
      status: ready ? (redis.ok ? "ready" : "degraded") : "unready",
      checks: { postgres, redis },
    });
  });
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
