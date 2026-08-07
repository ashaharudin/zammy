# Zammy

A news aggregator: keywords in, a time-ordered timeline of headlines out, with a landing-page
wordcloud of the day's most-referenced topics. Backed by [Currents API](https://currentsapi.services).

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design, and why it is shaped this way.
- **[docs/PROBE-FINDINGS.md](docs/PROBE-FINDINGS.md)** — what 45 live API calls revealed. Read this
  before assuming anything about the upstream; several of its findings contradict the OpenAPI spec.

**Status: Phase 1 complete** — scaffold, shared contract, config validation, container build, and the
upstream client: normalization, mandatory User-Agent, typed error taxonomy, header-driven quota
governance, retries with a circuit breaker, and paging. No timeline yet; that needs the schema
(Phase 2) and the query service (Phase 3).

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
of calling the API. This is not just a convenience: the free tier allows **1000 calls per day**, which
a dev server with hot reload will exhaust before lunch. The whole app, and the entire test suite, run
with no network and no quota spend.

The fixtures are real captured responses, so offline mode reproduces the upstream's actual
misbehaviour — the duplication, the `"None"` images, the non-ISO timestamps. That is deliberate.
Synthetic fixtures would hide exactly the bugs worth catching.

To go online, set `CURRENTS_MODE=live` and `CURRENTS_API_KEY` in `.env`.

## Layout

```
packages/shared            wire contract (Zod schemas + types) — bundled into the browser
packages/config            server-only env validation — MUST NOT be imported by web
packages/currents-client   upstream SDK: error taxonomy, wire shapes, fixture store
apps/api                   Fastify: HTTP surface, query planning, in-process job consumer
apps/web                   React + Vite
fixtures/                  real captured upstream payloads — the regression basis
```

The `shared` / `config` split is load-bearing: `shared` reaches the browser, `config` holds the API
key. Keeping them apart is what makes it structurally hard to leak the key into a bundle.

## Talking to the upstream

`createCurrentsClient(config)` returns one interface backed by either the live API or the recorded
fixtures, chosen by `CURRENTS_MODE`. Nothing above the package branches on the mode — that rule is
what makes offline development predict production instead of merely resembling it.

```ts
const client = await createCurrentsClient(config);
const page = await client.search({ keywords: ["climate", "policy"], pageSize: 20 });

// Page a whole window, with an honest reason for stopping.
const all = await collectPages(client, { keywords: ["climate"] }, { maxCalls: 2 });
if (all.stoppedBy === "cap") {
  // Upstream had more to give; the 100-result ceiling cut us off. Subdivide the window.
}
```

`stoppedBy` is the value to care about. `end_of_results` means upstream is out of articles;
`cap` means it is not, and only a narrower time window will reach the rest.

## Commands

```bash
pnpm build          # build every package and app
pnpm test           # run all tests
pnpm typecheck      # type-check without emitting
pnpm infra:up       # start postgres + redis
pnpm infra:down     # stop them
pnpm infra:reset    # stop and delete the postgres volume

docker compose --profile app up --build   # everything in containers, api included
```

Note `--build`: `docker compose up` alone reuses a stale image and will silently run old code.

## Deployment

AWS (ECS Fargate + RDS + ElastiCache) is the deployment target; Docker Compose here is the local
development environment, not a deploy target. The same image runs in both, differing only by
environment variables — see [ARCHITECTURE 4.1](docs/ARCHITECTURE.md). Infrastructure-as-code arrives
with Phase 6.

## Conventions worth knowing

- **Config is validated at boot** and the process refuses to start on bad config, reporting every
  problem at once rather than the first. Adding a setting means adding it to `packages/config`.
- **`CURRENTS_USER_AGENT` must be non-empty.** Cloudflare returns `403` (error 1010) to default
  library User-Agents; the probe lost its first 11 calls to this before diagnosing it.
- **Timeline reads page over clusters, not articles.** Upstream re-emits the same URL under new UUIDs —
  one post appeared 50 times in 100 results. Anything that counts articles must count clusters.
- **Never `new Date()` an upstream timestamp.** Use the parser in `@zammy/currents-client`; the format
  is not ISO-8601 and a wrong timestamp silently corrupts the timeline.
- **End-of-page is decided by the raw count, never by how many articles survived normalization.**
  One malformed article would otherwise read as "that's all there is" and truncate a topic's history
  with no error to report it.
- **The 100-result cap is a wall, not a cursor.** Asking for a page past it is refused locally rather
  than clamped to the last page — clamping hands back articles you already have and a pager counts
  them as new. Get past the cap by narrowing the time window instead.
- **`/readyz` must never call the upstream.** At a 30-second probe interval that alone would cost
  ~2900 calls a day against a 1000-call budget. It reports what the last real call observed.
