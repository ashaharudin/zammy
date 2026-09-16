import type { Kysely } from "kysely";
import { storylinePath, TRENDING_LIMIT_MAX } from "@zammy/shared";
import { readTrendingStorylines, type Database } from "@zammy/storage";
import { windowBounds } from "./trending-service.js";
import { SITE_ORIGIN } from "./render-storyline.js";

/**
 * Tier 2 SEO's third piece (`docs/SEO.md`, "What comes next" 3): a generated
 * sitemap, replacing the static one-URL `apps/web/public/sitemap.xml` that
 * existed only because one URL existed.
 *
 * Off the SAME query `/api/v1/trending` answers with — `readTrendingStorylines`
 * itself, not the route — so this reads what the landing page already reads
 * rather than inventing a second opinion about which storylines are worth
 * listing. That also means this sitemap has the same shape as the cloud:
 * storylines the rolling window found several newsrooms covering, busiest and
 * freshest first (ADR-0013, ADR-0014), not every storyline this database has
 * ever held. A storyline that ages out of the window ages out of here too, and
 * the day it becomes prominent again it is back — which is the right list for
 * a sitemap to carry: what to crawl NOW, not an ever-growing archive a crawler
 * has no reason to keep re-checking.
 *
 * `readTrendingStorylines` is a plain read (db + a window), unlike
 * `readTrending` itself — no Redis cache, no breadth-sample election, no
 * queue. This function's whole dependency list is therefore a database and a
 * clock, the same as `render-storyline.ts`'s, and for the same reason: a
 * sitemap crawl should not be spending Redis round trips or touching the
 * ingest queue any more than a storyline page-load should be spending an
 * `/api/v1/*` request against its own rate limiter.
 */

export interface SitemapDeps {
  db: Kysely<Database>;
  now: () => Date;
  /** The language the landing-page cloud names by default (`DEFAULT_LANGUAGE`). */
  defaultLanguage: string;
  trending: { windowHours: number; halfLifeHours: number };
}

export async function buildSitemap(deps: SitemapDeps): Promise<string> {
  const now = deps.now();
  const { from, to } = windowBounds(now, deps.trending.windowHours);
  const storylines = await readTrendingStorylines(deps.db, {
    language: deps.defaultLanguage,
    from,
    to,
    halfLifeHours: deps.trending.halfLifeHours,
    limit: TRENDING_LIMIT_MAX,
  });

  const urls: { loc: string; lastmod?: string }[] = [
    // No <lastmod>, same as the file this replaces: the home page has no
    // single moment it was last "updated" and a hand-written one would be
    // wrong the day after it was written (the static file's own comment).
    { loc: `${SITE_ORIGIN}/` },
    ...storylines.map((storyline) => ({
      loc: `${SITE_ORIGIN}${storylinePath(storyline.id, storyline.label)}`,
      lastmod: storyline.lastUpdated.toISOString(),
    })),
  ];

  const body = urls
    .map((url) =>
      url.lastmod
        ? `  <url>\n    <loc>${escapeXml(url.loc)}</loc>\n    <lastmod>${url.lastmod}</lastmod>\n  </url>`
        : `  <url>\n    <loc>${escapeXml(url.loc)}</loc>\n  </url>`,
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  );
}

/** A storyline slug is already `[a-z0-9-]+` and the origin is a literal, so
 * this only ever has real work to do on a value nothing here can produce —
 * kept anyway because "an XML document with a literal `&` in it" is a worse
 * failure than one extra pass over a string this short.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
