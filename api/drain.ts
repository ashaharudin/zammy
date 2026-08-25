/**
 * The manual ingest drain route (VERCEL-ALL-IN-SCOPE §3.2). Same three-line
 * shape as `index.ts` and `queues/ingest.ts`, and for the same reason: Vercel
 * discovers functions in `api/` at the PROJECT root, outside the workspace that
 * typechecks and tests them.
 *
 * Reached directly at `/api/drain` — no rewrite, unlike the Fastify surface.
 */
import handler from "@zammy/api/drain";

export default handler;
