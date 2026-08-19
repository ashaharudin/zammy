# Zammy

A news aggregator: keywords in, a time-ordered timeline of headlines out, with a landing-page
wordcloud of the storylines the last 24 hours updated. Backed by
[Currents API](https://currentsapi.services), and optionally [GNews](https://gnews.io) alongside it.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design, and why it is shaped this way.
- **[docs/PROBE-FINDINGS.md](docs/PROBE-FINDINGS.md)** — what 45 live API calls revealed. Read this
  before assuming anything about the upstream; several findings contradict the OpenAPI spec.

**Status: Phases 0–5f and 7a complete** — the full keyword→timeline product is built: schema with
write-time dedup, the query service with caching and progressive fill, the timeline front end,
article grouping, persistent storylines with Gemini-generated labels, the landing-page wordcloud
(now naming recently updated storylines), and GNews as a second provider behind the client
interface. In progress: the OCI deploy ([docs/DEPLOYMENT-OCI.md](docs/DEPLOYMENT-OCI.md)). Not
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

## Layout

```
packages/shared            wire contract ONLY — what ships to the browser (ADR-0004)
packages/config            server-only env validation — MUST NOT be imported by web
packages/news-client       provider-agnostic core: Sighting, error taxonomy, quota, transport, pager
packages/currents-client   Currents adapter: its wire shapes, its quirks, its fixture store
packages/gnews-client      GNews adapter: same, for the second provider
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

With `GNEWS_ENABLED=false` (the default) you get the Currents client bare. Switched on, calls fan
out to both and merge — but Currents is *coverage-bearing* and GNews is best-effort breadth, so a
GNews outage narrows results without ever failing a call or ending a walk
([ADR-0012](docs/adr/0012-a-second-provider-adds-breadth-but-never-coverage.md)).

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

## Commands

```bash
pnpm build          # build every package and app
pnpm test           # run all tests
pnpm typecheck      # type-check without emitting
pnpm infra:up       # start postgres + redis
pnpm infra:down     # stop them
pnpm infra:reset    # stop and delete the postgres volume
pnpm db:migrate     # apply migrations (a deploy step, never on boot)

# Grouping maintenance (ARCHITECTURE 14.3, ADR-0005). Run after a change to
# the headline tokenizer, which leaves already-stored tokens behind:
pnpm regroup --tokens-only    # re-derive stored tokens; changes no groupings
pnpm regroup --days=7         # …and re-run the grouping decision for groups of one

docker compose --profile app up --build   # everything in containers, api included
```

Note `--build`: `docker compose up` alone reuses a stale image and silently runs old code.

## Deployment

Oracle Cloud (OCI) is the deployment target — see [docs/DEPLOYMENT-OCI.md](docs/DEPLOYMENT-OCI.md).
AWS (ECS Fargate + RDS + ElastiCache, [ARCHITECTURE 4.1](docs/ARCHITECTURE.md)) remains an option
but not an immediate goal. Docker Compose here is the local development environment, not a deploy
target; the same image runs everywhere, differing only by environment variables.
Infrastructure-as-code arrives with Phase 1 of the OCI plan
([DEPLOYMENT-OCI §7](docs/DEPLOYMENT-OCI.md)); note the OCI plan's phases and
[ARCHITECTURE §13](docs/ARCHITECTURE.md)'s delivery phases are different numberings.

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
