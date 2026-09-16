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
server-rendering them, which has not been done.

## What is in place

Static assets in `apps/web/public/`, which Vite copies to the dist root verbatim:

| File | Why |
| --- | --- |
| `robots.txt` | Carries the sitemap line. Restricts nothing — see the open question below. |
| `sitemap.xml` | One URL, because one URL exists. |
| `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | The hero's `zammy>` mark reduced to two stroked paths. |
| `og.png` | 1200×630 share card. |
| `site.webmanifest` | Name, icons, colors. |

And in `apps/web/index.html`: title, description, canonical, OpenGraph, Twitter card, two
`theme-color` entries, the icon links, and the GA4 tag.

## Decisions worth knowing about

**The canonical points at `/` from every route.** Deliberate, and only correct while the parameter
forms render nothing: it consolidates an unbounded number of identical blank URLs onto the one page
that has content. It becomes wrong the day a storyline is server-rendered, and a per-route canonical
is part of that change rather than something to retrofit after it.

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

**The title changed** from a bare `Zammy` to `Zammy — trace any story back to where it started`. A
one-word title is the single largest thing a search result can be missing.

## Open questions

**AI training crawlers are allowed, by inheritance rather than by decision.** No `robots.txt` meant
everything was allowed; this one keeps that. Declining GPTBot / ClaudeBot / CCBot / Google-Extended
is one block per agent, and it is a *separate* question from the retrieval agents (ChatGPT-User,
Claude-User, PerplexityBot) that fetch because a reader asked — those are traffic, and for an
aggregator whose value is freshness they are probably the traffic we want.

**The rate limiter has not been sized for crawlers.** `RATE_LIMIT_PER_MINUTE` per IP applies to
`/api/` only (`apps/api/src/server.ts`), so static crawling is unaffected — but an agent fanning out
across storyline JSON will meet it, and it fails open silently per instance
(`MEASUREMENT-RATE-LIMIT-FAIL-OPEN.md`), so neither we nor the agent gets a clean signal.

**Storyline URLs would never 404.** Merges keep the loser's UUID as an alias and reads resolve
through `merged_into` (`packages/storage/src/storylines.ts`), so a storyline route could serve a
`301` to the survivor's canonical instead of a dead end. That is unusually good link-equity
behaviour to be leaving unused.

## What comes next

In order of how much it would actually move:

1. Pretty routes — `/storyline/<uuid>/<slug>` — alongside the existing parameter, so there is
   something to link to.
2. A Vercel function that server-renders the head and a content skeleton for those routes, with the
   SPA hydrating over it. Not full SSR: per-storyline title, description, canonical, OG tags and a
   readable body of day summaries and headlines is most of the value.
3. A generated sitemap (`api/sitemap.ts`) off the same query that feeds `/api/v1/trending`, with
   `<lastmod>` from `lastUpdated`.
4. `CollectionPage` + `ItemList` JSON-LD per storyline; `WebSite` + `SearchAction` on the landing
   page. The honest framing matters here: Zammy links out rather than hosting article text, and thin
   aggregator pages are a real ranking liability. The original content is the storyline — the
   synthesized arc and the day summaries (ADR-0023) — not the headlines, and the markup should say
   so.
5. `/llms.txt`: what Zammy is, the sighting / article / group / storyline vocabulary from
   `CONTEXT.md`, and a pointer to the JSON API.
