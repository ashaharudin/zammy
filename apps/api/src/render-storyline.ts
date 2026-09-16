import {
  DEFAULT_PAGE_LIMIT,
  storylinePath,
  STORYLINE_UUID,
  type TimelineEntry,
} from "@zammy/shared";
import { resolveStoryline } from "@zammy/storage";
import { readStorylineView, type StorylineViewDeps, type TimelineReadResult } from "./timeline-read.js";

/**
 * Tier 2 SEO's second piece (`docs/SEO.md`, "What comes next" 2): a
 * server-rendered `<head>` and a readable body for `/storyline/<uuid>/<slug>`,
 * so a crawler that never runs JavaScript sees a real page instead of the
 * empty shell every other route on this site still is.
 *
 * Deliberately not full SSR. `apps/web/src/main.tsx` still mounts with
 * `createRoot`, not `hydrateRoot` — this page's job is to be RIGHT the moment
 * it arrives and then get overwritten the moment React commits, not to be a
 * DOM React can adopt. Everything below is therefore string surgery on the
 * built `apps/web/dist/index.html`, never a JSX render.
 *
 * **Reads through the storage layer, never through `/api/v1/*` itself.** A
 * render function calling its own public API would spend a request against
 * `RATE_LIMIT_PER_MINUTE` — keyed per IP, and every crawler shares this
 * function's own outbound IP — to answer a request that same limiter is
 * about to also see land on `/storyline/*` directly. `readStorylineView` is
 * the exact function `GET /api/v1/timeline?storyline=` calls; this is that
 * call made from one layer closer to the database, with no HTTP hop and
 * nothing metered in between.
 */

/** What this page needs from a database: exactly what `readStorylineView` needs. */
export type StorylinePageDeps = StorylineViewDeps;

/** The origin every absolute URL on this page is built against.
 *
 * Hardcoded, matching the other two places this exact string already lives:
 * `apps/web/index.html`'s canonical and OG tags, and the host-noindex rule in
 * `vercel.json`. The day this needs to be configurable it needs to agree with
 * both of those, so it is not a knob this file invents on its own.
 */
export const SITE_ORIGIN = "https://www.zammy.info";

const SITE_TITLE = "Zammy";

/** `apps/web/index.html`'s own description, repeated here for the pages that fall back to it. */
const DEFAULT_DESCRIPTION =
  "Trace any story back to where it started. Zammy groups headlines from across the news " +
  "into storylines, so you can follow how a story actually unfolded.";

export interface StorylinePageResult {
  status: 200 | 301 | 404;
  headers: Record<string, string>;
  body: string;
}

/**
 * `/storyline/<uuid>/<anything>` → the UUID, or `null` for a path that does
 * not name one.
 *
 * The slug is read by NOTHING: this mirrors `apps/web/src/route.ts`'s
 * `parseLocation`, which also takes the id and ignores what follows it. A
 * request for last month's slug against this month's label still resolves —
 * see `storylinePath`'s own comment for why that is the point rather than a
 * gap.
 */
export function extractStorylineId(requestPath: string): string | null {
  const path = requestPath.split("?")[0] ?? requestPath;
  const match = /^\/storyline\/([^/]+)(?:\/[^/]*)?\/?$/.exec(path);
  const candidate = match?.[1];
  return candidate !== undefined && STORYLINE_UUID.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

export async function renderStorylinePage(
  deps: StorylinePageDeps,
  request: { path: string; template: string },
): Promise<StorylinePageResult> {
  const id = extractStorylineId(request.path);
  if (id === null) return notFoundPage(request.template);

  const resolved = await resolveStoryline(deps.db, id);
  if (resolved === null) return notFoundPage(request.template);

  const view = await readStorylineView(deps, { storylineId: resolved, limit: DEFAULT_PAGE_LIMIT });
  // `resolveStoryline` just proved `resolved` names a live row, so this can
  // only answer null if a merge lands between the two statements above —
  // `mergeStorylines` serializes on its own advisory lock rather than asking
  // every reader to defend against that window. Treated as not-found rather
  // than a 500: a request that lost a race this narrow gets an honest "does
  // not exist" instead of a crash for a storyline that, from where it stands,
  // never did.
  if (view === null) return notFoundPage(request.template);

  const label = view.storylines[0]?.label ?? null;
  const canonicalPath = storylinePath(resolved, label);

  // A merged UUID: `resolveStoryline` followed the alias, so what was fetched
  // above is the SURVIVOR's page. Serving it under the loser's URL would be
  // silently duplicating it under two paths; a 301 is what
  // `docs/SEO.md`'s "Storyline URLs never need to 404" was written to spend —
  // link equity flowing to the one page instead of splitting across two.
  if (resolved !== id) return redirectPage(`${SITE_ORIGIN}${canonicalPath}`);

  return okPage(request.template, { label, canonicalPath, view });
}

function okPage(
  template: string,
  params: { label: string | null; canonicalPath: string; view: TimelineReadResult },
): StorylinePageResult {
  const title = pageTitle(params.label);
  const description = pageDescription(params.label, params.view.items);
  const canonicalUrl = `${SITE_ORIGIN}${params.canonicalPath}`;
  const html = injectBody(
    injectHead(template, { title, description, canonicalUrl }),
    renderBody(params.label, params.view),
  );
  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The same shape `/api/v1/trending` answers with (PR #227): a shared
      // cache may hold this and quietly revalidate it, a browser may not — a
      // stale storyline page is worth five minutes of edge staleness, and only
      // the shared copy needs purging if a rewrite of this file is ever wrong.
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    },
    body: html,
  };
}

function redirectPage(location: string): StorylinePageResult {
  return {
    status: 301,
    headers: {
      location,
      "content-type": "text/html; charset=utf-8",
      // A merge has no inverse (`mergeStorylines`'s own comment), so this
      // redirect is as permanent as the row that causes it — safe for a shared
      // cache to hold for a day rather than re-asking on every crawl.
      "cache-control": "public, max-age=0, s-maxage=86400",
    },
    body:
      `<!doctype html><meta charset="utf-8"><title>Moved</title>` +
      `<p>This storyline moved to <a href="${escapeHtml(location)}">${escapeHtml(location)}</a>.</p>`,
  };
}

function notFoundPage(template: string): StorylinePageResult {
  const html = injectHead(template, {
    title: `Storyline not found — ${SITE_TITLE}`,
    description: "This storyline does not exist, or has not been given a URL of its own.",
    canonicalUrl: `${SITE_ORIGIN}/`,
  });
  return {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=60",
    },
    body: injectBody(
      html,
      `<main><h1>Storyline not found</h1><p><a href="/">Back to Zammy</a></p></main>`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Head rewriting
// ---------------------------------------------------------------------------

/**
 * One tag each, matched by the attribute that names it rather than by
 * position — so this survives Vite reordering or reformatting the tags around
 * them, and only breaks the day one of these specific attributes leaves
 * `apps/web/index.html`, which is a change `render-storyline.test.ts` would
 * catch as every field silently failing to update.
 */
const TITLE_TAG = /<title>[\s\S]*?<\/title>/;
const DESCRIPTION_TAG = /<meta[^>]*name="description"[^>]*>/;
const CANONICAL_TAG = /<link[^>]*rel="canonical"[^>]*>/;
const OG_URL_TAG = /<meta[^>]*property="og:url"[^>]*>/;
const OG_TITLE_TAG = /<meta[^>]*property="og:title"[^>]*>/;
const OG_DESCRIPTION_TAG = /<meta[^>]*property="og:description"[^>]*>/;
const TWITTER_TITLE_TAG = /<meta[^>]*name="twitter:title"[^>]*>/;
const TWITTER_DESCRIPTION_TAG = /<meta[^>]*name="twitter:description"[^>]*>/;
const ROOT_DIV = '<div id="root"></div>';

function injectHead(
  html: string,
  head: { title: string; description: string; canonicalUrl: string },
): string {
  let out = html.replace(TITLE_TAG, `<title>${escapeHtml(head.title)}</title>`);
  out = setAttr(out, DESCRIPTION_TAG, "content", head.description);
  out = setAttr(out, CANONICAL_TAG, "href", head.canonicalUrl);
  out = setAttr(out, OG_URL_TAG, "content", head.canonicalUrl);
  out = setAttr(out, OG_TITLE_TAG, "content", head.title);
  out = setAttr(out, OG_DESCRIPTION_TAG, "content", head.description);
  out = setAttr(out, TWITTER_TITLE_TAG, "content", head.title);
  out = setAttr(out, TWITTER_DESCRIPTION_TAG, "content", head.description);
  return out;
}

/** Rewrite one attribute on the first tag `selector` matches. A template that
 * has drifted (the attribute renamed or removed) leaves the tag untouched
 * rather than throwing mid-request — a page that looks like nothing updated
 * is a bug `render-storyline.test.ts` will catch; a 500 on every storyline is
 * a worse way to notice the same drift.
 */
function setAttr(html: string, selector: RegExp, attr: string, value: string): string {
  return html.replace(selector, (tag) => {
    const attrPattern = new RegExp(`${attr}="[^"]*"`);
    return attrPattern.test(tag) ? tag.replace(attrPattern, `${attr}="${escapeHtml(value)}"`) : tag;
  });
}

/** `#root` in the built `dist/index.html` is empty, same as the source
 * (`railAnnouncer.test.ts` pins that invariant on the SOURCE file). This
 * writes content into the built COPY held in memory for one response, never
 * back to disk — React still empties the real `#root` on its first commit
 * (`createRoot`, not `hydrateRoot`), so this content is read by whatever
 * fetches the page and gone the moment the app mounts over it.
 */
function injectBody(html: string, bodyHtml: string): string {
  return html.replace(ROOT_DIV, `<div id="root">${bodyHtml}</div>`);
}

// ---------------------------------------------------------------------------
// Body content — the readable skeleton a non-JS client actually gets
// ---------------------------------------------------------------------------

function pageTitle(label: string | null): string {
  return `${label ?? "Storyline"} — ${SITE_TITLE}`;
}

/**
 * The day's own sentence first (ADR-0023): it is the storyline's synthesized
 * arc, which `docs/SEO.md` calls the original content here — Zammy links out
 * rather than hosting article text, so a description built from a headline
 * would be describing someone else's writing. Falls back to a source count
 * when no sentence has been written yet, and to the site's own description
 * when the storyline has no coverage to describe at all.
 */
function pageDescription(label: string | null, items: readonly TimelineEntry[]): string {
  for (const item of items) {
    if (item.daySummary?.text) return truncate(item.daySummary.text, 300);
  }
  const sources = new Set(
    items
      .flatMap((item) => [item.article, ...item.related, ...item.moreCoverage])
      .map((article) => article.sourceDomain)
      .filter((domain): domain is string => domain !== null),
  );
  if (label !== null && sources.size > 0) {
    return `${label}: coverage from ${sources.size} source${sources.size === 1 ? "" : "s"}, gathered by Zammy.`;
  }
  return DEFAULT_DESCRIPTION;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function renderBody(label: string | null, view: TimelineReadResult): string {
  const storyline = view.storylines[0];
  const span = storyline ? `${storyline.from.slice(0, 10)} – ${storyline.to.slice(0, 10)}` : null;
  const size = storyline ? `${storyline.size} article${storyline.size === 1 ? "" : "s"}` : null;
  const days = view.items.map(renderDay).join("\n");
  return [
    "<main>",
    `<h1>${escapeHtml(label ?? "Storyline")}</h1>`,
    span ? `<p>${escapeHtml(span)}${size ? ` · ${escapeHtml(size)}` : ""}</p>` : "",
    days || "<p>No coverage yet.</p>",
    `<p><a href="/">More storylines on Zammy</a></p>`,
    "</main>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * One storyline-day: the sentence written for it, then every headline the day
 * held — the lead, its syndicated copies, and the rest of the storyline's
 * coverage that day (`TimelineEntry.related` / `.moreCoverage`) — each an
 * outbound link, exactly as the client renders them (`TimelinePage.tsx`).
 */
function renderDay(entry: TimelineEntry): string {
  const dayKey = entry.daySummary?.dayKey ?? entry.published.slice(0, 10);
  const summary = entry.daySummary?.text;
  const headlines = [entry.article, ...entry.related, ...entry.moreCoverage];
  const items = headlines
    .map((article) => {
      const source = article.sourceDomain ? ` — ${escapeHtml(article.sourceDomain)}` : "";
      return `<li><a href="${escapeHtml(article.url)}" rel="noopener noreferrer">${escapeHtml(article.title)}</a>${source}</li>`;
    })
    .join("\n");
  return [
    "<article>",
    `<h2>${escapeHtml(dayKey)}</h2>`,
    summary ? `<p>${escapeHtml(summary)}</p>` : "",
    `<ul>${items}</ul>`,
    "</article>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
