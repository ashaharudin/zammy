# The Vercel deployment

Plan A of [RESEARCH-VERCEL-SUPABASE](../../docs/RESEARCH-VERCEL-SUPABASE.md), adopted in
[ADR-0015](../../docs/adr/0015-all-in-on-vercel-hobby-shaped.md) and phased in
[VERCEL-ALL-IN-SCOPE §9](../../docs/VERCEL-ALL-IN-SCOPE.md). **Phase 1 is deployed and Phase 2's
code has landed**: the api serves as one Function, the ingest queue has a push-mode consumer, and
the chores are still manual. Phases 3–5 (the Redis quota governor and rate-limit store, the chores
route, cutover) are scoped and unbuilt.

The configuration itself lives at the repository root, because that is where Vercel looks:
[`vercel.json`](../../vercel.json), [`api/index.ts`](../../api/index.ts),
[`api/queues/ingest.ts`](../../api/queues/ingest.ts) and
[`.vercelignore`](../../.vercelignore). This file is the part that would not fit in JSON.

## The shape, and why

One project, one origin. The browser fetches `/api/v1/*` relative
([api.ts](../../apps/web/src/api.ts)), so a single project means no CORS, no preflight and no
build-time API base URL — the property §1.1 picked this layout to protect.

| Piece | Where |
| --- | --- |
| The SPA | `pnpm build` → `apps/web/dist`, served as static output |
| The api | `api/index.ts` → `apps/api/src/vercel.ts` → `buildApp(config, { consumer: false })` |
| The ingest consumer | `api/queues/ingest.ts` → `apps/api/src/vercel-queue.ts` → `buildServices` + `ingestDispatch` |
| Routing | three rewrites in `vercel.json`, **not** the function's filename |
| Fixtures | `includeFiles` on **both** functions — the consumer ingests, so it reads the corpus too |

**The rewrites are the catch-all, and this is the one thing about the layout that is not obvious.**
The scope doc originally specified `api/[...path].ts`; the spike found that Vercel's bare `api/`
directory parses that filename as ONE dynamic segment literally named `...path`, so `/api/v1/echo`
and anything deeper never reached the function at all. A rewrite does reach it, and — measured —
leaves the original path visible, so Fastify still routes on what the browser asked for. Use an
**unnamed** capture group: a named one (`/api/v1/:path*`) is appended to the query string, which a
route with its own `path` parameter would then receive twice.

`/healthz` and `/readyz` live outside `/api`, so they need a rewrite each. `/metrics` would have
needed a third; it is deleted instead (§7).

## Environment variables

[.env.example](../../.env.example) is the full list and the documentation for each. Set them with
`vercel env add` rather than the dashboard — there are 66 of them, and a typo boots green.

What differs from a Compose `.env`:

| Variable | Production | Preview |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **transaction** pooler, port 6543 | the preview project's, same shape |
| `DATABASE_SESSION_URL` | Supabase **session** pooler, port 5432 (migrations, chores) | ditto |
| `DATABASE_SSL` | `verify-full`, with Supabase's CA in `DATABASE_CA_CERT` | ditto |
| `DATABASE_POOL_MAX` | `1`–`2` — every instance holds its own pool | ditto |
| `REDIS_URL` | Upstash | a second, separate Upstash database |
| `INGEST_QUEUE_DRIVER` | `vercel` — the default is `bullmq`, and leaving it there publishes to a Redis queue nothing drains | `vercel` |
| `CURRENTS_MODE` | `live` (needs `CURRENTS_API_KEY`) | `fixture` — costs no upstream quota |
| `FIXTURES_DIR` | irrelevant | `fixtures` — the function's cwd is the deployment root, so the `../../fixtures` in the template is wrong here |
| `TRUSTED_PROXY_HOPS` | `1` — measured on the spike: Fastify sees `127.0.0.1` with the client one hop out in `x-forwarded-for` | `1` |
| `CORS_ORIGIN` | the deployment origin | the preview origin |

**Previews never point at production.** Fixture mode still *ingests*: a preview aimed at the
production database would write fixture articles into the real corpus and its storylines. The
preview pair (a second free-tier Supabase project and Upstash database) is what §4 decided, and a
per-PR CI step migrates it.

`pnpm` 11 needs `ENABLE_EXPERIMENTAL_COREPACK=1` set as a project environment variable, after which
Vercel reads `packageManager` from the root manifest.

## Deploying

```bash
vercel build && vercel deploy --prebuilt
```

`vercel build` alone is worth running before any push that touches the layout: it produces
`.vercel/output` locally and is the cheapest way to see whether the function's dependency trace
still resolves through the pnpm workspace. What it will NOT tell you is whether Supabase and Upstash
are reachable, so the exit criterion for a deploy is `/readyz` returning `ready` — not `degraded`,
which means Redis is down, and not `unready`, which means Postgres is.

The deployment root directory is the repository root, the build command is `pnpm build` (packages
first, then apps — the function imports `apps/api/dist`), and the output directory is
`apps/web/dist`.

## The queue

`INGEST_QUEUE_DRIVER=vercel` swaps the transport under the same seven-member interface the read path
already used. The request function publishes; `api/queues/ingest.ts` drains. Three operator-visible
consequences:

- **The consumer has no public URL.** It is reached only by the `queue/v2beta` trigger declared on
  it in `vercel.json`, which is why there is no auth on it and none is missing. The topic name in
  that trigger (`ingest`) must match the queue's name, because that name also scopes the Redis
  pending set and the trending sample lock.
- **`experimentalTriggers` is beta.** If it regresses, the pending set is still the ledger of what
  is owed (`meta.ingest`), and the fallback §3.2 names is a manual drain — not a data-loss event.
- **The message TTL is 300 s, matching the pending window.** A deploy mid-flight leaves the old
  deployment draining its own messages, because push-mode topics are partitioned by deployment id.
  Five minutes bounds how long that lasts.

Verifying it: read a cold topic and watch `meta.ingest.pendingJobs` fall to zero across polls. It
staying pinned above zero is the symptom of the trigger not firing, and the log line to look for on
the consumer is the platform's own invocation record — on Hobby it survives an hour.

## What Phase 2 does not do

- **The chores do not run.** No route, no schedule, no `chore_runs` table yet (§3.3), and the
  Supabase free-tier pause guard comes with them. Until then a deployed project's database is
  reachable only as long as something else keeps it awake.
- **The quota governor is still per-instance**, and so is the per-IP rate limit (§3.4, §3.5). Both
  are Phase 3, and both are the reason not to leave a Phase 1 deployment serving real traffic in
  `CURRENTS_MODE=live` for long.
