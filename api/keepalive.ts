/**
 * The Supabase free-tier pause guard (VERCEL-ALL-IN-SCOPE §3.3). Three lines
 * for the same reason every other file in `api/` is: Vercel discovers functions
 * at the PROJECT root, outside the workspace that typechecks and tests them.
 *
 * A route of its own rather than a chore side effect, deliberately — "the
 * database stays awake" must not share a failure mode with the most complex
 * nightly job in the system. `apps/api/src/keepalive.ts` has the argument.
 */
import handler from "@zammy/api/keepalive";

export default handler;
