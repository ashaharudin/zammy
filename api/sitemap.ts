/**
 * The generated sitemap (`docs/SEO.md`), replacing the static
 * `apps/web/public/sitemap.xml`. Same three-line shape as `index.ts` and for
 * the same reason. Everything real is in `apps/api/src/vercel-sitemap.ts`.
 *
 * Routed here by `vercel.json`'s `/sitemap.xml` rewrite. The static file this
 * replaces is deleted rather than left in `apps/web/public/`: a static file at
 * the same path would be served directly and the rewrite below it would never
 * fire at all.
 */
import handler from "@zammy/api/vercel-sitemap";

export default handler;
