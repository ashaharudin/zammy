/**
 * The nightly chores route (VERCEL-ALL-IN-SCOPE §3.3). Vercel discovers
 * functions in `api/` at the PROJECT root, which is why this file lives outside
 * the workspace it serves — and why it is three lines: everything real is in
 * `apps/api/src/chore-route.ts`, where the workspace typechecks and tests it.
 *
 * Reached directly at `/api/chores?pass=<name>` — no rewrite, like the drain and
 * unlike the Fastify surface. The scheduler is Supabase Cron
 * (`deploy/vercel/supabase-cron.sql`), which is what buys minute precision on a
 * free tier where Vercel's own cron is once a day, ±59 minutes.
 */
import handler from "@zammy/api/chores";

export default handler;
