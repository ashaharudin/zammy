# SEO

What the site tells crawlers, and — more usefully — what it still cannot tell them.

## The shape of the problem

Zammy is a Vite SPA served as static files. The HTML that leaves the server is a shell: an empty
`#root`, a stylesheet, a module script. Every view the app has lives behind a query parameter on
`/` — `?q=`, `?storyline=<uuid>`, `?lang=` (see `apps/web/src/route.ts`) — and none of them renders
anything until JavaScript runs.

Two consequences follow, and everything below is downstream of them:

1. **There is no link graph.** Nothing on the landing page is an `<a href>` a crawler can follow to a
   storyline. Even a crawler that renders JavaScript perfectly has no second URL to go to.
2. **Most AI crawlers see nothing at all.** GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended
   and friends fetch HTML and stop; they have no rendering queue the way Googlebot does. To them this
   site is the word "Zammy" and an empty div.

Neither is fixed by metadata. They are fixed by giving storylines routes of their own and
server-rendering them — Tier 2, below, is that fix.

## What Tier 2 shipped

Three pieces, in the order they depend on each other:

1. **Pretty routes.** `/storyline/<uuid>/<slug>` stands alongside `?storyline=<uuid>` rather than
   replacing it — `apps/web/src/route.ts`'s `parseLocation` reads either shape and ignores the slug
   entirely (it is cosmetic; the UUID is identity, exactly as `merged_into` already treats it). A
   bookmarked `?storyline=<uuid>` on `/` redirects to the pretty path once, client-side, on mount —
   every navigation the app makes from then on already writes the pretty form (`routeUrl`).
   ADR-0010's bigint SEED is untouched: it has no route of its own, because it shares `q`'s lifetime
   rather than naming a story.
2. **A server-rendered head and content skeleton** for those routes — `api/storyline.ts` /
   `apps/api/src/render-storyline.ts`. Per-storyline `<title>`, description, canonical, and OG tags,
   plus a readable body: the day's own sentence (ADR-0023) leading each section, then that day's
   headlines as outbound links. Reads `readStorylineView` directly — the same function
   `GET /api/v1/timeline?storyline=` calls — never `/api/v1/*` over HTTP, so a crawl never spends a
   token against `RATE_LIMIT_PER_MINUTE`. **A merged UUID gets the 301 the "open question" below used
   to describe as unused**: `resolveStoryline` follows the alias, and the response redirects to the
   survivor's own canonical path rather than serving a silent duplicate.
3. **A generated sitemap** — `api/sitemap.ts` / `apps/api/src/render-sitemap.ts` — off
   `readTrendingStorylines`, the same storage call `/api/v1/trending` reads, with `<lastmod>` from
   `lastUpdated`. It replaces the static one-URL `apps/web/public/sitemap.xml`, which is deleted
   outright: a static file at `/sitemap.xml` would be served directly and the rewrite to
   `api/sitemap.ts` behind it would never fire.

Not done: full SSR. `apps/web/src/main.tsx` still mounts with `createRoot`, not `hydrateRoot` — the
skeleton is right the instant it arrives and gone the instant React commits over it, which is what
"hydrating over it" means here rather than literal DOM adoption.

## What is in place

Static assets in `apps/web/public/`, which Vite copies to the dist root verbatim:

| File | Why |
| --- | --- |
| `robots.txt` | Carries the sitemap line. Restricts nothing — see the open question below. |
| `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | The hero's `zammy>` mark reduced to two stroked paths. |
| `og.png` | 1200×630 share card. |
| `site.webmanifest` | Name, icons, colors. |

`sitemap.xml` is no longer among them — it is generated per request now (`api/sitemap.ts`, above).

And in `apps/web/index.html`: title, description, canonical, OpenGraph, Twitter card, two
`theme-color` entries, the icon links, and the GA4 tag.

## Decisions worth knowing about

**The canonical points at `/` from every PARAMETER route**, still — `?q=`, `?storyline=<uuid>` before
its client-side redirect fires, `?lang=`. Deliberate, and only correct while those forms render
nothing: it consolidates an unbounded number of identical blank URLs onto the one page that has
content. `/storyline/<uuid>/<slug>` is the one route that now has a canonical of its own
(`render-storyline.ts`), because it is the one route with something server-rendered to be canonical
ABOUT.

**Non-canonical hosts are `noindex`, via `vercel.json` headers.** `zammy-alpha.vercel.app` answers
200 with the same content, and every deployment URL is another copy. The rule is written with
`missing` on the host rather than a list of the hosts we happen to know about, so a host nobody has
thought of yet is noindex by default rather than by being remembered. (`vercel.json` has
`additionalProperties: false` in Vercel's schema and cannot hold a comment saying so — hence this
paragraph.)

**`/api/` is `noindex` but NOT disallowed in `robots.txt`.** These pull in opposite directions on
purpose. The JSON under `/api/v1/` is the only surface a non-rendering agent can read today, so
blocking it in `robots.txt` would close the one door that works; but a timeline response is not a
page and has no business in a search index. `noindex` on the response says exactly that and nothing
more.

**AI agents are split by what they do with the page, not by whose name is on them.** Three groups,
and the middle one is where the decision actually was:

| | Examples | |
| --- | --- | --- |
| Fetches because a reader asked | `ChatGPT-User`, `Claude-User`, `Perplexity-User` | allowed |
| Indexes so Zammy can be found inside an AI product | `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `Applebot` | allowed |
| Trains on the corpus | `GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, `Bytespider`, … | blocked |

The middle row is not training and not a live fetch: it builds the index that decides whether Zammy
can be surfaced at all. For an aggregator whose whole value is freshness, that is the discovery
channel worth having, so it is allowed with the first row rather than blocked with the third.

Two things about that file are easy to get wrong later. A crawler obeys the **most specific group
naming it** and ignores `*` once it has one — so a `Disallow:` added to `*` will not reach any of
the explicitly allowed agents, and has to be repeated into each group. And `Google-Extended` /
`Applebot-Extended` are **not crawlers**: they are opt-out tokens for Gemini and Apple Intelligence
training, Googlebot and Applebot are untouched, and Google's AI Overviews ride on ordinary Search
indexing rather than on that token. Blocking them costs no search visibility, which is the opposite
of what people usually assume.

None of it is enforcement. robots.txt is obeyed voluntarily and `Bytespider` in particular has been
documented ignoring it; blocking that actually blocks is a firewall rule, not a text file.

**The title changed** from a bare `Zammy` to `Zammy — trace any story back to where it started`. A
one-word title is the single largest thing a search result can be missing.

## Open questions

**The agent list is a snapshot, not a standard.** Agents appear, get renamed, and split into
training and retrieval halves; an agent nobody has added yet falls through to `*` and is allowed.
The file needs a pass now and then.

**The limiter is sized for readers, and nothing is sized for agents.** `RATE_LIMIT_PER_MINUTE`
applies to `/api/` only (`apps/api/src/server.ts`), so crawling the static files is unlimited and
irrelevant here. Production answers `x-ratelimit-limit: 120`, which is
`MEASUREMENT-RATE-LIMIT-FAIL-OPEN.md` §4's measured verdict already applied — one reader peaks at
26/min, so 120 is about four readers behind one IP. That is a reader number. It was never chosen
against agent traffic, and one bucket per IP covers both.

Raising it is the wrong lever anyway. `/api/v1/trending` now answers `s-maxage=60,
stale-while-revalidate=300` on a settled cloud (PR #227) — an edge hit never reaches the function,
the database, or the limiter — but that is a property of RESPONSES the CDN may cache, and this
render function's own reads (`render-storyline.ts`, `render-sitemap.ts`) go through the storage
layer directly rather than earning it that way. `/api/v1/reference` still answers with no
`cache-control` of its own; it is read-only and slow-changing in exactly the same way `/trending`
was before #227, and is the next candidate if agent traffic against it ever shows up in the logs.
`/api/v1/timeline` is the opposite case — per-query, high cardinality, expensive — and is the one
that should stay limited.

**Storyline URLs never 404, now for real.** Merges keep the loser's UUID as an alias and reads
resolve through `merged_into` (`packages/storage/src/storylines.ts`); `render-storyline.ts` follows
it and serves a `301` to the survivor's canonical path instead of a dead end or a silent duplicate.
This used to be the "unusually good link-equity behaviour being left unused" paragraph — Tier 2 is
what used it.

## What comes next

Tier 2 (pretty routes, server-rendered head and skeleton, a generated sitemap) shipped above. What is
left, in order of how much it would actually move:

1. `CollectionPage` + `ItemList` JSON-LD per storyline; `WebSite` + `SearchAction` on the landing
   page. The honest framing matters here: Zammy links out rather than hosting article text, and thin
   aggregator pages are a real ranking liability. The original content is the storyline — the
   synthesized arc and the day summaries (ADR-0023) — not the headlines, and the markup should say
   so. `render-storyline.ts`'s body already leads with the day's own sentence for exactly this
   reason; the structured data should make the same claim machine-readable.
2. `/llms.txt`: what Zammy is, the sighting / article / group / storyline vocabulary from
   `CONTEXT.md`, and a pointer to the JSON API.
