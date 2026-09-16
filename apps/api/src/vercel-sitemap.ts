import { bootOnce, configOrExplain } from "./cron-route.js";
import { buildSitemap, type SitemapDeps } from "./render-sitemap.js";
import { createConfiguredDb } from "./wiring.js";
import type { VercelHandler } from "./vercel.js";

/**
 * The Vercel entrypoint for `/sitemap.xml` (Tier 2 SEO, `docs/SEO.md`),
 * replacing the static `apps/web/public/sitemap.xml`. `api/sitemap.ts` is the
 * three-line file Vercel discovers; everything real is here, the same split
 * every other entrypoint in `api/` uses. See `vercel-storyline.ts`'s own
 * comment for why this is a raw handler with its own small boot rather than a
 * route added to the Fastify app `vercel.ts` builds.
 */

async function bootFromEnvironment(): Promise<SitemapDeps> {
  const config = configOrExplain();
  return {
    db: createConfiguredDb(config, { max: 2 }),
    now: () => new Date(),
    defaultLanguage: config.DEFAULT_LANGUAGE,
    trending: {
      windowHours: config.TREND_WINDOW_HOURS,
      halfLifeHours: config.TREND_HALF_LIFE_HOURS,
    },
  };
}

export function createSitemapHandler(boot: () => Promise<SitemapDeps>): VercelHandler {
  const ready = bootOnce(boot);

  return async (_request, response) => {
    let deps: SitemapDeps;
    try {
      deps = await ready();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("sitemap: boot failed:", message);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "unavailable" }));
      return;
    }

    try {
      const xml = await buildSitemap(deps);
      response.writeHead(200, {
        "content-type": "application/xml; charset=utf-8",
        // A crawler re-fetches a sitemap on its own schedule, rarely more than
        // hourly, so 15 minutes at the edge costs nothing real and spares the
        // database a query per crawl.
        "cache-control": "public, max-age=0, s-maxage=900, stale-while-revalidate=3600",
      });
      response.end(xml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("sitemap: render failed:", message);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "internal error" } }));
    }
  };
}

export default createSitemapHandler(bootFromEnvironment);
