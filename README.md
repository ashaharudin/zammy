# Zammy

A news aggregator: keywords in, a time-ordered timeline of headlines out, with a landing-page
wordcloud of the storylines the last 24 hours updated. Backed by
[Currents API](https://currentsapi.services), and optionally [GNews](https://gnews.io) alongside it.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design, and why it is shaped this way.
- **[docs/PROBE-FINDINGS.md](docs/PROBE-FINDINGS.md)** — what 45 live API calls revealed. Read this
  before assuming anything about the upstream; several findings contradict the OpenAPI spec.

**Status: Phases 0–5f and 7a complete** — the full keyword→timeline product is built: schema with
write-time dedup, the query service with caching and progressive fill, the timeline front end,
article grouping, persistent storylines with model-generated labels, the landing-page wordcloud
(now naming recently updated storylines), and GNews as a second provider behind the client
interface. Deployment moved to Vercel + Supabase + Upstash
([ADR-0015](docs/adr/0015-all-in-on-vercel-hobby-shaped.md)) and is in progress. Not
started: topic summaries (Phase 7b). The full phase table is in
[ARCHITECTURE §13](docs/ARCHITECTURE.md#13-delivery-phases).

## Quick start

```bash
pnpm install
cp .env.example .env          # defaults to offline fixture mode; no API key needed
pnpm infra:up                 # postgres + redis
pnpm dev                      # api on :3000
pnpm dev:web                  # web on :5173, proxying /api to :3000
```

Check it works:

```bash
curl -s localhost:3000/readyz
```

## Working offline

`CURRENTS_MODE=fixture` (the default) serves the recorded payloads in [`fixtures/`](fixtures) instead
of calling the API. The free tier allows **1000 calls per day**, which a dev server with hot reload
would exhaust before lunch; the whole app and the entire test suite run with no network and no quota
spend. The fixtures are real captured responses, so offline mode reproduces the upstream's actual
misbehaviour — the duplication, the `"None"` images, the non-ISO timestamps. Synthetic fixtures
would hide exactly the bugs worth catching.

To go online, set `CURRENTS_MODE=live` and `CURRENTS_API_KEY` in `.env`.

## Watching a request

Open [localhost:5173/?trace](http://localhost:5173/?trace). It plays one API request back as a
16-bit warehouse — a robot carrying the request past the rate limiter, the Redis rack, the
Postgres vault and the Currents mast, and worker robots carrying its jobs through the back room —
with the same steps listed in words underneath. Seven built-in examples (a cache hit, a cold
search, a storyline open, a 429, …) work with nothing configured; their timings are illustrative
and their paths are pinned to the code by a test
([ADR-0029](docs/adr/0029-a-traced-request-records-what-it-touched-never-what-it-asked.md)).

To record your own, make a token, set `REQUEST_TRACE_ENABLED=true` and
`REQUEST_TRACE_TOKEN=<the token>` in `.env` (both lines are already there from `.env.example`),
and restart the api — the api refuses to boot with tracing on and no token, or with a token
shorter than 24 characters or holding whitespace:

```bash
export TOKEN=$(openssl rand -hex 16) && echo "$TOKEN"
```

Then paste the token into **Record a real request** on the page, pick a route and run it: the
page switches to the recorded trace and keeps polling it while its jobs run, for up to thirty
minutes (after that, **Check again** reads it once more). Or from a shell — the response's
`x-zammy-trace-id` header names the trace:

```bash
curl -s -o /dev/null -D - -H "x-zammy-trace: Bearer $TOKEN" \
  'http://localhost:3000/api/v1/timeline?q=climate'
# x-zammy-trace-id: 3f0c…   → open http://localhost:5173/?trace#t=3f0c…
```

A wrong token is not an error: the request is simply not traced, and the response carries no
`x-zammy-trace-id` at all.

A trace records which stations a request touched and how each answered — never keys, URLs, SQL
values or search text — and a request without the header is served exactly as before. A
recorded trace is a real request: a search nobody ran recently spends upstream quota in live
mode. Traces expire after `REQUEST_TRACE_TTL_SECONDS` (an hour by default). In production
tracing is turned on for a session and then off again
([deploy/vercel/README.md](deploy/vercel/README.md)).

The single-letter shortcuts (K, J, L, `[`, `]`, …) can be switched off with **Letter shortcuts**
beside the key legend; the page remembers that per browser, and Space, the arrows, Home and End
keep working.

## Layout

```
packages/shared            wire contract ONLY — what ships to the browser (ADR-0004)
packages/config            server-only env validation — MUST NOT be imported by web
packages/news-client       provider-agnostic core: Sighting, error taxonomy, quota, transport, pager
packages/currents-client   Currents adapter: its wire shapes, its quirks, its fixture store
packages/gnews-client      GNews adapter: same, for the second provider
packages/google-news-client  Google News RSS adapter. Built, off, and wired to
                           nothing yet (G4 of the discovery/deepening plan)
packages/news-providers    the composite + the factory apps/api calls — the only layer
                           that knows how many providers exist
apps/api                   Fastify: HTTP surface, query planning, in-process job consumer
apps/web                   React + Vite
fixtures/                  real captured upstream payloads — the regression basis
```

The `shared` / `config` split is load-bearing: `shared` reaches the browser, `config` holds the API
key. Keeping them apart is what makes it structurally hard to leak the key into a bundle.

## Talking to the upstream

`createNewsClient(config)` returns one interface backed by the live APIs or the recorded fixtures,
chosen by `CURRENTS_MODE` / `GNEWS_MODE` and by which providers are enabled. Nothing above the
package branches on the mode or on which upstream answered — that rule is what makes offline
development predict production.

With `GNEWS_ENABLED=false` (the default) you get the Currents client bare. Switched on, calls fan out
to both and merge — and inside that one shared page plan the primary's `isLastPage` is what ends the
walk, so a GNews outage narrows results without ever failing a call or ending a walk
([ADR-0012](docs/adr/0012-a-second-provider-adds-breadth-but-never-coverage.md)).

**That is a property of the plan, not a ranking of the providers**, and the difference has been
load-bearing since
[ADR-0019](docs/adr/0019-a-fetch-carries-its-own-reason-and-its-own-coverage.md) replaced ADR-0012.
Coverage is `(subject, provider, span)`: each provider records only the spans it actually walked, and
nothing is *the* coverage-bearer. The composite's asymmetry survives because its two providers still
share one page plan; the deepening plane does not share it, and records its own spans against
`storyline_coverage`.

```ts
const client = await createNewsClient(config);
const page = await client.search({ keywords: ["climate", "policy"], pageSize: 20 });

// Page a whole window, with an honest reason for stopping.
const all = await collectPages(client, { keywords: ["climate"] }, { maxCalls: 2 });
if (all.stoppedBy === "cap") {
  // Upstream had more to give; the 100-result ceiling cut us off. Subdivide the window.
}
```

`stoppedBy` matters: `end_of_results` means upstream is out of articles; `cap` means it is not, and
only a narrower time window will reach the rest.

A third adapter, `@zammy/google-news-client`, is **not part of that fan-out** — it has no offset
parameter at all, so it cannot share a page plan with anything. It serves the **deepening plane**,
reaching ~18 months back over arcs Currents already found against Currents' 30 days
([the design](docs/DESIGN-DISCOVERY-AND-DEEPENING.md)), and it is meant to serve search and breadth
too. That is what retired ADR-0012's provider ranking: what a fetch may feed the ranker is decided by
*why the call was made* (`sightings.plane`), not by who answered.

Set `GOOGLE_NEWS_ENABLED=true` and opening a storyline deepens it: the arc's whole label goes to
Google News, the span is planned against `storyline_coverage`, and what comes back joins that arc by
provenance and forms no new one. Left false — the default and what production runs — the client is
never built and the path answers `unavailable` having spent nothing.

It is off by default and unreachable while it is: `createGoogleNewsClient` refuses to build anything
with `GOOGLE_NEWS_ENABLED=false`, and nothing calls it. The two guards it waited on — `alt_key`
article identity and the ranker isolation, G1 and G2 of
[the plan](docs/DISCOVERY-DEEPENING-PLAN.md) — have both landed; G3's `storyline_coverage` has not,
and G5 is what wires it.

## Commands

```bash
pnpm build          # build every package and app
pnpm test           # run all tests
pnpm typecheck      # type-check without emitting
pnpm infra:up       # start postgres + redis
pnpm infra:down     # stop them
pnpm infra:reset    # stop and delete the postgres volume
pnpm db:migrate     # apply migrations (a deploy step, never on boot)

# The nightly chores (ARCHITECTURE 9.1). One-shot processes, not a background
# thread in the api: the platform's scheduler runs them — 03:00 and 04:00 UTC —
# so the api does not have to be awake for them. Nothing in the api reports a
# chore that never ran, so the schedule needs its own monitoring.
pnpm chores retention     # the retention report, and the trailing-corpus prune
pnpm chores storylines    # dormancy → bridge sweep → late candidates → labels → merge
pnpm chores storylines --max-labels=1   # bound the model spend (500 calls/day, free tier)

# Grouping maintenance (ARCHITECTURE 14.3, ADR-0005). Run after a change to
# the headline tokenizer, which leaves already-stored tokens behind:
pnpm regroup --tokens-only    # re-derive stored tokens; changes no groupings
pnpm regroup --days=7         # …and re-run the grouping decision for groups of one

docker compose --profile app up --build   # everything in containers, api included
```

Note `--build`: `docker compose up` alone reuses a stale image and silently runs old code.

## Deployment

Deployment moved to Vercel + Supabase + Upstash
([ADR-0015](docs/adr/0015-all-in-on-vercel-hobby-shaped.md); see
[ARCHITECTURE 4.1](docs/ARCHITECTURE.md#41-deployment-target--vercel--supabase-adr-0015-local-development-on-docker-compose)
for the shape and [deploy/vercel/](deploy/vercel/) for the operator scripts). Rollout is in
progress — see [ARCHITECTURE §13](docs/ARCHITECTURE.md#13-delivery-phases) for current status.

Docker Compose here is the local development environment and was never a deploy target; the same
source and config run everywhere, differing only by environment variables. The api's container
image itself does not ship to production — Vercel builds straight from source and never touches
`apps/api/Dockerfile`, which exists for Compose only.

## Conventions worth knowing

- **Config is validated at boot**; the process refuses to start on bad config, reporting every
  problem at once. Adding a setting means adding it to `packages/config`.
- **`CURRENTS_USER_AGENT` must be non-empty.** Cloudflare returns `403` (error 1010) to default
  library User-Agents; the probe lost its first 11 calls to this.
- **A sighting is not an article.** Upstream re-emits the same story under fresh UUIDs — one post
  appeared 50 times in 100 results. The timeline pages over articles, and `count(articles)` is the
  number you want. See [CONTEXT.md](CONTEXT.md).
- **Never `new Date()` an upstream timestamp.** Use the adapter's parser — Currents' format is not
  ISO-8601, and a wrong timestamp silently corrupts the timeline.
- **Never branch on an HTTP status code above an adapter.** The same code means different things per
  provider — a 403 is a Cloudflare ban on Currents and a spent daily budget on GNews. Branch on the
  typed error's `kind`.
- **End-of-page is decided by the raw count, never by how many articles survived normalization.**
  One malformed article would otherwise truncate a topic's history with no error to report it.
- **The 100-result cap is a wall, not a cursor.** A page past it is refused locally, not clamped —
  clamping hands back articles you already have and a pager counts them as new. Get past the cap by
  narrowing the time window.
- **`/readyz` must never call the upstream.** At a 30-second probe interval that alone would cost
  ~2900 calls a day against a 1000-call budget. It reports what the last real call observed.
