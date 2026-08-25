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

**Run both from a copy of the tree with `.git` excluded.** Vercel stamps a deployment with the
*commit author* rather than the account that owns the project, so a deploy from the repository
returns `readyState: BLOCKED` (`TEAM_ACCESS_REQUIRED`) — rendered as `UNKNOWN` by `vercel ls`, with
`vercel inspect --logs` printing nothing (VERCEL-ALL-IN-SCOPE, "What the Phase 1 deploy corrected").
An `rsync -a --exclude .git --exclude node_modules --exclude .vercel` into a scratch directory, plus
a copy of `.vercel/project.json`, is the whole workaround. Confirm with `vercel inspect <url>`
showing `● Ready`; the CLI's exit code is not a signal.

`vercel build` alone is worth running before any push that touches the layout: it produces
`.vercel/output` locally and is the cheapest way to see whether the function's dependency trace
still resolves through the pnpm workspace. What it will NOT tell you is whether Supabase and Upstash
are reachable, so the exit criterion for a deploy is `/readyz` returning `ready` — not `degraded`,
which means Redis is down, and not `unready`, which means Postgres is.

**Probe `/readyz` twice.** The first request after a deploy is a cold start, and the Redis client
connects lazily — Upstash handshakes in ~800 ms, which the health check can beat. It answers
`degraded` with `"Stream isn't writeable and enableOfflineQueue options is false"`, which is
character-for-character the symptom of a `redis://` URL where `rediss://` was needed. Measured
2026-08-25: cold read `degraded`, every read after it `ready`, on a URL that was correct all along.

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
- **`experimentalTriggers` is beta, and one part of it is already not behaving.** Delivery works;
  REdelivery does not (see the known gap below). The pending set is still the ledger of what is owed
  (`meta.ingest`), which is what keeps this a recoverable state rather than a data-loss event.
- **The message TTL is 300 s, matching the pending window.** A deploy mid-flight leaves the old
  deployment draining its own messages, because push-mode topics are partitioned by deployment id.
  Five minutes bounds how long that lasts.

Verifying it (done 2026-08-25, current deployment `zammy-k2y801sfm`): read a cold topic and watch
`meta.ingest.pendingJobs` fall to zero. **Pick a topic that then goes quiet.** A topic you keep
polling sits at `pendingJobs: 1` forever and that is correct — §6.4 enqueues a fresh top-up whenever
coverage trails `now`, so the consumer advancing coverage is what makes the next read find a new
sliver. `?q=wildfire` went 1 → 0 and stayed there; `?q=climate`, polled continuously, never left 1.

The other half of the proof is `vercel logs <deployment>`, and **read the log lines, not the status
code**. The SDK answers 200 for a success, for a message it rescheduled after a throw, and for one
given up on, so `POST /api/queues/ingest 200` on its own tells you nothing. The consumer logs
`ingest delivery` (with `deliveryCount`) on every delivery and `ingest job settled` on the success
path; a drain is the pair, for one message id.

**Known gap: a failed job is lost, not retried.** Measured 2026-08-25 against a deliberately
poisoned message — exactly one delivery, whether the SDK `retry` callback reschedules (200) or the
error propagates (500), watched past the 300 s retention in both cases. `deliveryCount` has never
been observed above 1. What contains it is the pending set: a failed job is never settled, so
`meta.ingest` keeps reporting it owed until the five-minute stale prune and the next reader re-plans
the gap. Do not treat this queue as at-least-once until VERCEL-ALL-IN-SCOPE §10 question 0 is
answered.

## What Phase 2 does not do

- **The chores do not run.** No route, no schedule, no `chore_runs` table yet (§3.3), and the
  Supabase free-tier pause guard comes with them. Until then a deployed project's database is
  reachable only as long as something else keeps it awake.
- **The quota governor is still per-instance**, and so is the per-IP rate limit (§3.4, §3.5). Both
  are Phase 3, and both are the reason not to leave a Phase 1 deployment serving real traffic in
  `CURRENTS_MODE=live` for long.
