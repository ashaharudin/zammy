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

/**
 * The site-wide `WebSite` node's identity, shared with the static block in
 * `apps/web/index.html` so the two agree they are one entity. A fragment on
 * the origin, which is the ordinary spelling for a node that is not itself a
 * retrievable page.
 */
export const WEBSITE_ID = "https://www.zammy.info/#website";

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

  const view = await readStorylineView(deps, { storylineIds: [resolved], limit: DEFAULT_PAGE_LIMIT });
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
  const html = injectJsonLd(
    injectBody(
      injectHead(template, { title, description, canonicalUrl }),
      renderBody(params.label, params.view),
    ),
    jsonLdScript(storylineJsonLd({ label: params.label, description, canonicalUrl, view: params.view })),
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
interface HeadField {
  readonly name: string;
  readonly tag: RegExp;
  /** The attribute the value lives in, or null for `<title>`, whose value is its text. */
  readonly attr: string | null;
}

/**
 * Every tag this file rewrites, as a table rather than as eight constants —
 * so it can be EXPORTED, and checked against the real `apps/web/index.html`.
 *
 * `render-storyline.test.ts` drives this file through a synthetic template,
 * which is right for testing the rewriting itself and proves nothing at all
 * about the template actually shipped: that template necessarily matches these
 * patterns, because it was written to. The one check that matters is against
 * the real file, and it imports THESE patterns rather than retyping them — the
 * rule `railAnnouncer.test.ts` already follows for `RAIL_STATUS_ID`, and for
 * the same reason. A test carrying its own copy of the thing it checks is a
 * test of that copy.
 */
export const HEAD_FIELDS: readonly HeadField[] = [
  { name: "title", tag: /<title>[\s\S]*?<\/title>/, attr: null },
  { name: "description", tag: /<meta[^>]*name="description"[^>]*>/, attr: "content" },
  { name: "canonical", tag: /<link[^>]*rel="canonical"[^>]*>/, attr: "href" },
  { name: "og:url", tag: /<meta[^>]*property="og:url"[^>]*>/, attr: "content" },
  { name: "og:title", tag: /<meta[^>]*property="og:title"[^>]*>/, attr: "content" },
  { name: "og:description", tag: /<meta[^>]*property="og:description"[^>]*>/, attr: "content" },
  { name: "twitter:title", tag: /<meta[^>]*name="twitter:title"[^>]*>/, attr: "content" },
  {
    name: "twitter:description",
    tag: /<meta[^>]*name="twitter:description"[^>]*>/,
    attr: "content",
  },
];

/** The empty mount point `injectBody` writes into, exported for the same check. */
export const ROOT_DIV = '<div id="root"></div>';

/** Where `injectJsonLd` inserts the structured-data script, exported for the
 * same reason `ROOT_DIV` is: this is an injection point whose target lives in
 * the real template, and `render-storyline-template.test.ts` checks it is
 * there exactly once rather than assuming any HTML document must have one —
 * the same rule the file already applies to every `HEAD_FIELDS` tag. */
export const HEAD_CLOSE_TAG = "</head>";

function injectHead(
  html: string,
  head: { title: string; description: string; canonicalUrl: string },
): string {
  const values: Record<string, string> = {
    title: head.title,
    description: head.description,
    canonical: head.canonicalUrl,
    "og:url": head.canonicalUrl,
    "og:title": head.title,
    "og:description": head.description,
    "twitter:title": head.title,
    "twitter:description": head.description,
  };
  let out = html;
  for (const field of HEAD_FIELDS) {
    const value = values[field.name] ?? "";
    out =
      field.attr === null
        ? // A FUNCTION, not a string — see `injectBody` for what a string costs here.
          out.replace(field.tag, () => `<title>${escapeHtml(value)}</title>`)
        : setAttr(out, field.tag, field.attr, value);
  }
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
    // The leading `\s` is load-bearing: an unanchored `href="[^"]*"` also
    // matches the TAIL of `data-href="…"`, so a template whose attribute had
    // been renamed would be rewritten in place — the wrong attribute updated,
    // the right one still missing, and nothing anywhere reporting it. Every
    // real attribute is preceded by whitespace, so requiring it costs nothing.
    const attrPattern = new RegExp(`(?<=\\s)${attr}="[^"]*"`);
    // The inner replacement is a FUNCTION too, for the reason `injectBody`
    // gives: a description carrying `$'` or `$"` reaches here already escaped
    // into `$&#39;` / `$&quot;`, and a string replacement would read that `$&`
    // as "insert the matched attribute here".
    return attrPattern.test(tag)
      ? tag.replace(attrPattern, () => `${attr}="${escapeHtml(value)}"`)
      : tag;
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
  // A REPLACER FUNCTION, not a string, and this is the one place it is not a
  // style choice. `String.replace` reads `$&`, `` $` ``, `$'` and `$$` in a
  // STRING replacement as substitution patterns, and `escapeHtml` is what
  // creates them: it turns `'` into `&#39;`, so a headline reading
  // `Oil at $' a barrel` arrives here as `Oil at $&#39;` — a `$&`, which
  // expands to the matched `<div id="root"></div>` and leaves a second root
  // div nested inside the page. `` $` `` is worse and needs no escaping to
  // get here: it inserts everything BEFORE the match, which is the entire
  // `<head>`. Article titles and day summaries are upstream text this file
  // does not get to choose, so the only safe form is the one that does no
  // substitution at all.
  return html.replace(ROOT_DIV, () => `<div id="root">${bodyHtml}</div>`);
}

/**
 * Inserts a `<script type="application/ld+json">` block right before
 * `</head>`.
 *
 * Not inside `#root` — `injectBody` writes there, and React empties that node
 * on its first commit (`createRoot`, not `hydrateRoot`), which would delete
 * the structured data the instant the app mounts even though nothing renders
 * that fast for a crawler that never runs JavaScript. The head survives for
 * the lifetime of the response, which is exactly as long as anything reading
 * this markup needs it to.
 */
function injectJsonLd(html: string, scriptTag: string): string {
  // A REPLACER FUNCTION, not a string — `jsonLdScript`'s own escaping deals
  // with `<`, `>` and `&`, which is what keeps `</script>` out of the
  // serialized JSON; it does nothing about `$`. A headline reading
  // `Oil at $' a barrel` survives `JSON.stringify` as a literal `$'`, and a
  // STRING replacement passed to `html.replace` reads that as "insert
  // whatever came after the match" — the same trap `injectBody` and `setAttr`
  // already guard against, on text this file does not get to choose either.
  return html.replace(HEAD_CLOSE_TAG, () => `${scriptTag}${HEAD_CLOSE_TAG}`);
}

// ---------------------------------------------------------------------------
// JSON-LD structured data (`docs/SEO.md`, "What comes next" 1)
// ---------------------------------------------------------------------------

/**
 * Serializes a JSON-LD payload for embedding in a `<script
 * type="application/ld+json">` element.
 *
 * **This is deliberately not `escapeHtml`.** That function escapes for HTML
 * text and attribute content, and the inside of this script element is JSON,
 * not HTML — `escapeHtml` would turn a literal `&` in a headline into
 * `&amp;` and a `"` into `&quot;`, and both of those are now wrong on two
 * counts: they are not what JSON escaping calls for, and a `&quot;` sitting
 * where JSON expects a bare `"` either breaks a string's boundary or survives
 * as four garbage characters inside a value nobody meant to put there.
 *
 * The hazard that actually matters runs the other way. A `</script>`
 * sequence anywhere in upstream text — a storyline label, a day summary —
 * closes this element early and drops the rest of the JSON into the document
 * as markup, and `JSON.stringify` will not save you: JSON has no notion of
 * "this string is about to sit inside a `<script>` tag". The standard fix is
 * escaping every `<` in the ALREADY-SERIALIZED JSON as its six-character
 * Unicode escape — `>` and `&` get the same treatment, by convention and for
 * symmetry, though only `<` is load-bearing here. `JSON.parse` reads the
 * escape back to the literal character, so the parsed value is byte-for-byte
 * what went in, but the raw HTML this function returns cannot contain the
 * three characters that give markup its meaning — `</script>` included.
 */
function jsonLdScript(data: unknown): string {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * `CollectionPage` + `ItemList`, making the same claim `docs/SEO.md` insists
 * on machine-readable: the storyline — the synthesized arc and the day
 * summaries (ADR-0023) — is the original content on this page, and the
 * headlines are a list of links out to the outlets that actually wrote them.
 *
 * **Deliberately not `NewsArticle`.** Zammy did not write these headlines,
 * does not host their text, and a rich-result type built for "this page is a
 * news article" is a claim of authorship this page must not make about
 * somebody else's work — thin aggregator pages that do are exactly the
 * ranking liability `docs/SEO.md` names. Each entry is a plain `ListItem`
 * pointing at the outlet's own URL, with a `publisher` naming the outlet —
 * attribution without authorship.
 */
function storylineJsonLd(params: {
  label: string | null;
  description: string;
  canonicalUrl: string;
  view: TimelineReadResult;
}): unknown {
  const storyline = params.view.storylines[0];
  // ONE ENTRY PER DAY — the slot's own lead article, not every syndicated copy
  // the body lists under it.
  //
  // Measured on a live storyline before this was trimmed: 9 days carrying 237
  // articles between them serialized to 118kB of JSON-LD against a 108kB page,
  // and 48kB of that survived gzip, because a list of distinct URLs is exactly
  // the content compression cannot help with. It roughly doubled every
  // storyline page for markup no search feature consumes — `CollectionPage`
  // and `ItemList` of `WebPage` earn no rich result; they are read, if at all,
  // by something parsing the page for meaning.
  //
  // Which is also the argument for what to keep. A slot is one storyline-day,
  // and its lead is the article chosen to head that day (`@zammy/representative`);
  // the rest are the same story as other outlets ran it. One per day describes
  // the shape of the arc — the thing this page is actually about, and the thing
  // `docs/SEO.md` calls the original content here — where 237 near-duplicate
  // URLs describe how loudly the wire repeated itself. The body still lists
  // every one of them, each an outbound link with its own attribution; nothing
  // is hidden, it is just not restated in JSON.
  const items = params.view.items.map((entry) => ({
    "@type": "WebPage",
    url: entry.article.url,
    name: entry.article.title,
    // Absent rather than a made-up value: `sourceDomain` is null for the
    // rare upstream row that never carried one (`Article`, `@zammy/shared`),
    // and a `publisher` naming nothing would be worse than no publisher.
    ...(entry.article.sourceDomain !== null
      ? { publisher: { "@type": "Organization", name: entry.article.sourceDomain } }
      : {}),
  }));
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: params.label ?? "Storyline",
    description: params.description,
    url: params.canonicalUrl,
    // `@id` matching the static `WebSite` block in `apps/web/index.html`, which
    // this page INHERITS: that block lives in the template `render-storyline.ts`
    // rewrites, so a storyline page carries two ld+json scripts and would
    // otherwise describe the same site as two unrelated nodes. A shared `@id`
    // is what tells a consumer they are one thing.
    isPartOf: { "@id": WEBSITE_ID },
    ...(storyline ? { dateCreated: storyline.from, dateModified: storyline.to } : {}),
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: items.length,
      itemListElement: items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item,
      })),
    },
  };
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
