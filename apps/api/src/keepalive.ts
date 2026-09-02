import { sql } from "kysely";
import type { Database } from "@zammy/storage";
import type { Kysely } from "kysely";
import {
  configOrExplain,
  createCronRoute,
  secretFromEnvironment,
  type CronRequest,
  type CronRouteHandler,
} from "./cron-route.js";
import { createConfiguredDb } from "./wiring.js";

/**
 * The Supabase free-tier pause guard (VERCEL-ALL-IN-SCOPE §3.3).
 *
 * ## Why this is a route of its own
 *
 * Supabase pauses a free project after 7 days of inactivity, and its
 * documentation does **not** promise that pg_cron's internal activity counts:
 * inactivity is defined as insufficient *user* database activity, and the
 * prescribed guard is an external request. The chore route's own pooler queries
 * do qualify — but only on nights the chore runs AND reaches the database, which
 * makes "the database stays awake" a downstream consequence of the most complex
 * nightly job in the system.
 *
 * That is the failure mode this file exists to break. A label pass that has been
 * failing for a week is a bad week; a label pass that has been failing for a week
 * and has therefore let the database be paused is a bad week that ends with the
 * whole deployment down. So the guard is one statement, one connection, no
 * shared pass logic with the chores, and its own cron entry. It shares
 * `cron-route.ts` with them — the bearer check and the boot — and nothing else;
 * that module is the door, not the night.
 *
 * ## Why `DATABASE_URL` and not the session pooler
 *
 * The chores deliberately use `DATABASE_SESSION_URL` because they hold a
 * session-scoped advisory lock. This holds nothing, and the connection worth
 * proving alive is the one the request path uses — the transaction pooler on
 * 6543. It is also the cheaper of the two to open.
 *
 * ## Why it is authenticated
 *
 * It opens a database connection, which is the only thing on this deployment an
 * anonymous caller could make happen repeatedly for free. Same secret and the
 * same fail-closed rule as the chores and the drain: unset `CRON_SECRET`
 * disables the route rather than opening it (`cron-route.ts`'s `isAuthorized`).
 * The cost of that is worth being explicit about — **an unset secret disables
 * the pause guard too**, so a project with no `CRON_SECRET` is a project that
 * will eventually pause.
 */

/** The narrow surface the ping needs, so the tests need no platform. */
export interface Pingable {
  ping: () => Promise<void>;
}

export function createPingable(db: Kysely<Database>): Pingable {
  return {
    // `select 1`, and nothing derived from a table: the guard must not be able
    // to fail because of the schema, a migration mid-flight, or a permission on
    // some object. What it proves is that a connection was opened and a query
    // was served, which is exactly the "user database activity" Supabase counts.
    ping: async () => {
      await sql`select 1`.execute(db);
    },
  };
}

async function bootFromEnvironment(): Promise<Pingable> {
  const config = configOrExplain();
  // max: 1. One statement, one connection, and every instance of every function
  // holds its own pool against a pooler sized for a handful per instance.
  return createPingable(createConfiguredDb(config, { max: 1 }));
}

/**
 * The route body. **Synchronous, unlike the chores** — no 202, no `waitUntil`,
 * and it declares no `defer` so it cannot grow one by accident.
 *
 * A ping whose result is not in the response is not a ping: the whole value here
 * is that the scheduler's own record (`net._http_response`) says whether the
 * database answered. Deferring the work would make a paused project and a
 * healthy one produce identical 202s, which is the one outcome this route may
 * not have. It costs one round trip, so it fits any timeout the chores' 202 fits.
 *
 * The boot is inside the `try` on purpose: "no `DATABASE_URL`" and "the database
 * did not answer" are the same answer to the scheduler, and both are 503.
 */
export async function handleKeepalive({
  ready,
  json,
  logger,
}: CronRequest<Pingable>): Promise<void> {
  const startedAt = Date.now();
  try {
    const pingable = await ready();
    await pingable.ping();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message }, "keep-alive ping failed");
    // 503 and not 500: the database did not answer, which is a statement about
    // a dependency rather than about this route. It is also the status a
    // scheduler's own log makes legible without anyone reading ours.
    json(503, { status: "unavailable" });
    return;
  }

  const ms = Date.now() - startedAt;
  logger.info({ ms }, "keep-alive ping");
  json(200, { status: "awake", ms });
}

/**
 * The route, given something that boots. Parameterized for the tests, in the
 * shape `drain.ts` established.
 *
 * **Every method**, which is what this route has always answered. Supabase Cron
 * posts and a `curl` check is a GET, and unlike the drain there is no state to
 * change by following a link: the worst a crawler can do here is prove the
 * database is awake, having first presented `CRON_SECRET`.
 */
export function createHandler(
  boot: () => Promise<Pingable>,
  readSecret: () => string | undefined = secretFromEnvironment,
): CronRouteHandler {
  return createCronRoute<Pingable>({
    name: "/api/keepalive",
    methods: null,
    boot,
    readSecret,
    handle: handleKeepalive,
  });
}

export default createHandler(bootFromEnvironment);
