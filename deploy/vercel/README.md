# The Vercel deployment

Plan A of [RESEARCH-VERCEL-SUPABASE](../../docs/RESEARCH-VERCEL-SUPABASE.md), adopted in
[ADR-0015](../../docs/adr/0015-all-in-on-vercel-hobby-shaped.md) and phased in
[VERCEL-ALL-IN-SCOPE §9](../../docs/VERCEL-ALL-IN-SCOPE.md). **Phases 1 and 2 are deployed to
preview and verified**: the api serves as one Function, the ingest queue has a push-mode consumer
that drains and redelivers, and `POST /api/drain` is the manual fallback. The chores are still
manual. Phases 3–5 (the Redis quota governor and rate-limit store, the chores route, cutover) are
scoped and unbuilt — so **nothing here is serving production traffic yet**.

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
| `CRON_SECRET` | a long random string — gates `POST /api/drain`; unset disables that route | ditto, and a DIFFERENT string |
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

`INGEST_QUEUE_DRIVER=vercel` swaps the transport under the same eight-member interface the read path
already used. The request function publishes; `api/queues/ingest.ts` drains. Three operator-visible
consequences:

- **The consumer has no public URL.** It is reached only by the `queue/v2beta` trigger declared on
  it in `vercel.json`, which is why there is no auth on it and none is missing. The topic name in
  that trigger (`ingest`) must match the queue's name, because that name also scopes the Redis
  pending set and the trending sample lock.
- **`experimentalTriggers` is beta, and its timings move under you.** Delivery and redelivery both
  work, but the redelivery lease grew 30x in three days once already and silently broke retries when
  it did (see below). The pending set is still the ledger of what is owed (`meta.ingest`), which is
  what keeps a regression here a recoverable state rather than a data-loss event.
- **The message TTL is 900 s (`INGEST_RETENTION_SECONDS`), and it deliberately no longer matches the
  5-minute pending window.** Those two being equal is precisely the bug that stopped redelivery, so
  do not "tidy" them back together. A deploy mid-flight leaves the old deployment draining its own
  messages, because push-mode topics are partitioned by deployment id — 15 minutes now bounds how
  long that lasts.

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

**A failed job IS retried, but slowly — and the retry is not free of consequences.** This section
recorded the opposite until 2026-08-25. A failed delivery returns when its visibility lease expires,
measured at **+305 s**, and the driver was publishing with a **300 s** TTL, so the message was
deleted five seconds before it could come back. The TTL is now 900 s
(`INGEST_RETENTION_SECONDS`) and redelivery works. VERCEL-ALL-IN-SCOPE §3.2 has the measurements and
§10 question 0 the history.

**Treat the 305 s as a number that moves.** On 2026-08-22 the same probe measured ~10 s; three days
later, on the same unmodified deployment, 305 s. The 900 s TTL is sized against today's measurement,
so if it moves again past 300 s redelivery breaks again, silently and identically. **`deliveryCount`
never exceeding 1 in the logs is the tripwire** — check it after any Queues change rather than
assuming this stays fixed.

What that means when you are watching a deploy drain:

- **A retry takes five minutes.** Measured on a preview deployment of this project, 2026-08-25: a
  poisoned job was delivered at +0 s, +305 s and +610 s, the first two answering 500 and the third
  answering 200 with `ingest job failed every delivery; giving up`. If you enqueue something that
  fails and go looking 30 seconds later, one delivery is the expected picture, not a broken one —
  wait out the lease before concluding anything. The 300 s lease is server-assigned and cannot be shortened from our side:
  `retryAfterSeconds` in `vercel.json` is measured inert, and the SDK's `visibilityTimeoutSeconds`
  only governs lease extension.
- **`meta.ingest` can go quiet while a retry is still owed.** The pending set's stale prune is 5
  minutes and attempt 2 lands at 5 minutes 5 seconds, so the ledger stops reporting a job the queue
  is still going to retry. It under-reports rather than over-reports — the client stops polling
  early, the fill still lands — but do not read an empty `meta.ingest` as "nothing outstanding".
- **A failed job cannot be re-enqueued for 15 minutes.** The TTL is also the dedup window, so the
  same content key is deduplicated for the full 900 s. A job that exhausted its three attempts is
  not re-enqueueable until then; the gap it named is re-planned by the next reader after that.
- **Three attempts are guaranteed only for a job that fails fast.** One that fails slowly spends its
  lease being extended rather than expiring, so the TTL can truncate the budget to two.

## The manual drain — `POST /api/drain`

The deliberate counterpart to "the next reader re-plans the gap". It reads the pending set, fills
what has been outstanding longer than the 900 s message TTL, and settles it —
[docs/chores.md](../../docs/chores.md) has the full behaviour and the reasoning.

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$URL/api/drain"
```

It answers a JSON tally — `{scanned, filled, failed, unreadable, truncated}` — and logs the same
line as `ingest drain complete`. Operating notes:

- **`CRON_SECRET` must be set in the environment or the route refuses every request.** Fail-closed
  is deliberate: this is the only surface that spends upstream quota without a user asking. An unset
  secret disables the drain, it does not open it.
- **`INGEST_QUEUE_DRIVER` must be `vercel`** or the boot refuses with a listed reason. The age floor
  is derived from the hosted driver's retry budget and means nothing under BullMQ.
- **It will usually report `scanned: 0`, and that is healthy.** It deliberately ignores anything
  younger than 900 s, and a topic with traffic prunes its own ledger within five minutes of a read.
  Work sitting there is work on a topic nobody has read in fifteen minutes.
- **`truncated: true`** means a bound stopped the pass with entries left; run it again. `?limit=`
  lowers the 50-job cap for a cautious first run.
- **Schedule it every 5–15 minutes** via Supabase Cron if you want cold topics covered promptly.
  Hobby's Vercel cron (once a day, ±59 min) is too coarse to be the primary driver.

## What Phase 2 does not do

- **Nothing is in production.** Phase 2 is verified on *preview* only. Production has no seeded
  corpus and no `INGEST_QUEUE_DRIVER`, so leaving it at the `bullmq` default there would publish to
  a Redis queue nothing drains. Cutover is Phase 5.
- **The drain has never run against a live deployment.** Its logic is unit-tested; the real Redis
  `SCAN` and a real fill are not. Use `?limit=1` for the first pass.
- **The chores do not run.** No route, no schedule, no `chore_runs` table yet (§3.3), and the
  Supabase free-tier pause guard comes with them. Until then a deployed project's database is
  reachable only as long as something else keeps it awake.
- **The quota governor is still per-instance**, and so is the per-IP rate limit (§3.4, §3.5). Both
  are Phase 3, and both are the reason not to leave a Phase 1 deployment serving real traffic in
  `CURRENTS_MODE=live` for long.
