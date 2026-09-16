/**
 * The Tier 2 SEO storyline page (`docs/SEO.md`). Same three-line shape as
 * `index.ts` and for the same reason: Vercel discovers functions in `api/` at
 * the PROJECT root, outside the workspace that typechecks and tests them.
 * Everything real is in `apps/api/src/vercel-storyline.ts`.
 *
 * Routed here by `vercel.json`'s `/storyline/(.*)` rewrite, which — like the
 * `/api/v1/(.*)` rewrite beside it — preserves the original path, so this
 * function sees exactly what the browser asked for (`/storyline/<uuid>/<slug>`)
 * and not the destination URL it was rewritten to.
 */
import handler from "@zammy/api/vercel-storyline";

export default handler;
