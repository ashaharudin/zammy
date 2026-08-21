# Scope — going all in on Vercel

Companion to [RESEARCH-VERCEL-SUPABASE.md](RESEARCH-VERCEL-SUPABASE.md), which weighed Plan A (all
in on Vercel) against Plan B (a persistent host for the api) and recommended B. **This document does
not revisit that recommendation; it prices A.** Every codebase claim carries a file:line from a
sweep of `apps/api`, `packages/news-client` and the web client; every platform claim carries a
source at the bottom. Scoped 2026-08-21.

**Bottom line: 7–12 focused days, and one piece of it is not in the research doc.** Two things
changed the shape of this since that doc was written:

1. **Vercel Queues** went to public beta — first-party, at-least-once, idempotency keys, and
   consumers that are air-gapped from the internet. That is a much closer match to BullMQ's
   semantics than the third-party HTTP-push queue the research doc assumed, and it turns §3.2 from a
   redesign into an implementation of the existing six-method interface.
2. **The quota governor is in-process and always was.**
   [quota.ts:104–110](../packages/news-client/src/quota.ts) says §5.4's Redis-held snapshot is
   "designed and NOT built". ARCHITECTURE §9.1 nevertheless claims the consumer "draws from the
   shared quota snapshot (§5.4), so adding tasks cannot breach the 60/60s burst ceiling." That claim
   is already untrue at two replicas; elastic instances make it acute. **Plan A cannot ship without
   building it**, and no phase in §13 carries it.

And one thing that does *not* change: **Redis stays.** The page cache, the single-flight lock, the
per-topic daily cap and the ingest pending-set are all still Redis, on any plan. What Plan A removes
is BullMQ's idle polling — which is the thing that made Redis cost $10/month (§8).

---

## 1. Target topology

| Unit | Today (Compose) | All-in on Vercel |
| --- | --- | --- |
| `web` | Vite dev server | static build, same project, same origin |
| `api` HTTP surface | Fastify in a container | `api/[...path].ts` → the Fastify app as one Function |
| §9.1 consumer | in-process BullMQ worker | `api/queues/ingest.ts`, a **push-mode Vercel Queues consumer** (no public URL) |
| Nightly chores | `pnpm chores` on a timer | `api/chores.ts`, 202 + `waitUntil`, driven by Vercel Cron or Supabase Cron |
| Postgres | container | Supabase — transaction pooler for requests, session pooler for migrations/chores (landed) |
| Redis | container | Upstash (page cache, locks, counters, pending set — **not** a queue any more) |
| Quota governance | in-process per replica | **Redis-held snapshot (§5.4), to be built** |
| Per-IP rate limit | in-process counters | Vercel WAF, or the counters move to Redis |
| `/metrics` | Prometheus scrape | nothing scrapes an ephemeral instance — decide (§7) |
| Migrations | `pnpm db:migrate` | a CI step before the deploy that needs it (§6) |

### 1.1 Project shape — one project, two candidate layouts

Same-origin is worth protecting: the browser fetches `/api/v1/*` relative
([api.ts:86–114](../apps/web/src/api.ts)), so one origin means no CORS, no preflight, and no
build-time API base URL. Two layouts get there:

- **A single project, Vite preset for the SPA plus an `api/` directory** (recommended). One deploy,
  one origin, no proxy hop, and `vercel.json` carries per-function `maxDuration`, the `crons` entry
  and the queue trigger in one place. `api/[...path].ts` as a catch-all means Fastify sees the real
  request path, with no rewrite rewriting it out from under the router.
- **Two projects joined by a rewrite** — `web` static, `api` on Vercel's zero-config Fastify preset,
  with the web project proxying `/api/*` to the api project. Cleaner separation, but it adds a proxy
  hop to every request and a second hop to `X-Forwarded-For`, so `TRUSTED_PROXY_HOPS` becomes 2 and
  the per-IP ceiling depends on getting that exactly right.

**This is spike #1 (§9, Phase 0), and everything else rests on it.** Vercel's Vite documentation
steers Vite projects toward Nitro for functions rather than the bare `api/` directory, so the
combination "Vite preset + `api/` functions + a `queue/v2beta` trigger" needs proving on a throwaway
deployment before anything else is built. If it does not hold, the fallback is the two-project
layout, which costs the hop and the hop count but nothing structural.

---

## 2. Change classes at a glance

| Class | Meaning | Where |
|---|---|---|
| **New code** | Files that do not exist yet | the function entrypoint, the queue consumer route, the chore route, the Redis quota governor |
| **Reimplement behind the interface** | Same contract, different mechanism | `ingest-queue.ts` (BullMQ → Vercel Queues), `ingest-queue.test.ts` |
| **Split** | One function becomes two | `buildApp` — the consumer must not start in a request instance ([server.ts:201](../apps/api/src/server.ts)) |
| **Decide** | Something stops working and needs an honest answer | the per-IP rate limit, `/metrics` |
| **Config only** | No code | `vercel.json`, ~60 environment variables, CI, cutover |
| **Unchanged** | Genuinely untouched | all of `packages/storage`, the grouping/storyline engine, the timeline SQL, `packages/*-client` |

The last row is the reassuring one and it is large: the storage layer, the linker, the labeller and
every provider adapter do not know where they run and do not change. This is a deployment-shape
migration, not a rewrite — the opposite of
[HEATWAVE-MIGRATION-SCOPE.md](HEATWAVE-MIGRATION-SCOPE.md)'s verdict for MySQL.

---

## 3. The five pieces of new code, priced

### 3.1 The function entrypoint, and splitting `buildApp` — ~1–2 days

`buildApp` currently does two jobs in one call: it builds the HTTP surface *and* starts the queue
consumer ([server.ts:201](../apps/api/src/server.ts)). In a request instance the second must not
happen — a BullMQ-shaped worker in a function that scales to zero is exactly the failure the
research doc describes. The split is small and it is the same seam §9.1 already names ("it stays
structured as a separable unit"):

- `buildApp(config, { consumer: false })`, or a `buildRoutes` the entrypoints share.
- `api/[...path].ts`: a module-scope `let app: Promise<App>` singleton, `await app.ready()`, then
  hand the request to `app.server.emit("request", req, res)` — the standard Fastify-on-serverless
  pattern. Module scope is what makes the pool, the Redis client and the fixture store survive
  across invocations on a warm instance.
- `apps/api/src/index.ts` stays exactly as it is. It is the Compose and Plan-B entrypoint, and
  `listen()` plus the SIGTERM drain remain correct there. Nothing about local development changes.

Watch items: cold-start cost of `buildApp` (Zod config parse, `createNewsClient`, route
registration) is unmeasured and sits in front of the first timeline read; `/healthz` and `/readyz`
live outside `/api` so they need two rewrites; and the 4.5 MB response cap is far above any timeline
page but worth knowing.

### 3.2 The queue: BullMQ → Vercel Queues (push mode) — ~2–3 days

The surface is genuinely narrow, which is why this is days and not weeks:
[ingest-queue.ts](../apps/api/src/ingest-queue.ts) is 187 lines, its test is 105, and there are six
call sites — all through the `IngestQueue` *type*
([timeline-service.ts:233, 293, 333, 638](../apps/api/src/timeline-service.ts),
[trending-service.ts:109, 128](../apps/api/src/trending-service.ts)).

| What BullMQ gives us | Vercel Queues equivalent | Note |
|---|---|---|
| `jobId` content-dedup ([`ingestJobId`](../apps/api/src/ingest-queue.ts)) | idempotency key on publish | Dedup window is the message TTL (60s–7d, default 24h) rather than "the pending window". Billed at 2× the operation. |
| `attempts: 3`, exponential backoff from 200 ms | `retryAfterSeconds` + the SDK `retry` handler on `deliveryCount` | Forced exponential backoff after 32 attempts. No DLQ; a poisoned message is acknowledged in the handler. |
| At-least-once via BLMOVE + reaper | at-least-once by contract, 60 s default visibility timeout (0–3600 s configurable, `ExtendLease` for more) | §4.1 called at-least-once a deployment requirement. It survives. |
| Worker concurrency | max concurrency per consumer group | Useful ceiling for a quota-bearing consumer (§3.4). |
| A `Worker` in-process | `api/queues/ingest.ts` with a `queue/v2beta` trigger in `vercel.json` | **Air-gapped: no public URL, no auth code to write.** Better than a signed webhook. |
| `obliterate()` in tests | — | Tests change shape (below). |

**The pending set stays in Redis, deliberately.** `pendingCount` is what `meta.ingest` reports and
what the client polls against (§6.5), and it already tolerates Redis being down. Keeping the
`ZADD NX` / `STALE_PENDING_MS` mechanism ([ingest-queue.ts:47](../apps/api/src/ingest-queue.ts))
means the progressive-delivery contract is untouched by the transport swap — the smallest possible
blast radius for the riskiest change.

Two consequences to accept explicitly:

- **Topics are partitioned by deployment ID in push mode.** A deploy mid-flight leaves the old
  deployment draining its own messages. That is *better* than what we have (BullMQ jobs outlive the
  code that wrote them), but it is a different failure mode: work published by a deployment that is
  then rolled back is consumed by a deployment nobody is serving from.
- **`ingest-queue.test.ts` cannot test a hosted queue the way it tests BullMQ.** The 105 lines
  currently assert real retry and dedup behaviour against Redis. That splits into unit tests for the
  pure parts (`ingestJobId`, `samplePendingId`, the pending-set arithmetic) plus a fake for the
  transport, with delivery semantics trusted to the platform. This is a real loss of test power and
  should be recorded as one.

### 3.3 The chores as an HTTP route — ~1 day

The passes are already exported (`runRetentionChore`, `runStorylinePass` in
[chores.ts](../apps/api/src/chores.ts)) and the session-mode connection they need is already wired
([`createConfiguredDb(config, { session: true })`](../apps/api/src/wiring.ts)), so this is a wrapper:

- `api/chores.ts` — verify `Authorization: Bearer $CRON_SECRET`, pick the pass from the query or
  from the `x-vercel-cron-schedule` header, **return 202 immediately and run the pass in
  `waitUntil`**. Returning first is what makes the scheduler's own timeout irrelevant, which matters
  because `pg_net` (Supabase Cron's transport) aborts on its own timeout long before a label pass
  finishes.
- `vercel.json` gives that one path a `maxDuration` of 300 s (Hobby ceiling) or 800 s (Pro).
- `--max-labels` becomes a deployment parameter, not an operator convenience. At
  `GEMINI_MAX_RPM=15` a label is ≥4 s of pacing plus model latency, so an unbounded night exceeds
  300 s well before it exceeds Gemini's daily quota. The pass is resumable across nights, so a bound
  costs latency, not labels.
- **Scheduler: Supabase Cron, not Vercel Cron, on the free tier.** Minute precision instead of
  Hobby's once-per-day ±59 min, and it doubles as the keep-alive that stops a Free project pausing
  after 7 days. Vercel Cron is the choice on Pro, where per-minute precision comes with the plan.
- The advisory lock still does its job, and is still the only thing standing between two schedulers
  and a doubled label bill — which is now more likely, not less, because cron delivery on Vercel is
  documented as best-effort and occasionally duplicated.

### 3.4 The Redis quota governor — ~1–2 days, and non-optional

[quota.ts:78–110](../packages/news-client/src/quota.ts) is honest about what in-process costs: "a
restart forgets the day's spend", self-corrected on the next response *for a provider that reports
headers*. Serverless turns "a restart" into "every cold start", and that splits by provider:

- **Currents** reports `x-ratelimit-*` on every response, so the daily count is wrong for exactly
  one call after each cold start. Tolerable.
- **GNews reports nothing** ([quota.ts:99](../packages/news-client/src/quota.ts)) — a count that
  restarts "is simply wrong until the day's budget runs out and a 403 arrives, which is precisely
  the outcome pre-flight refusal exists to avoid." With instances recycling constantly, GNews's
  100/day pre-flight refusal effectively never engages. `GNEWS_ENABLED=false` is the default, so
  this is a blocker for enabling the second provider rather than for day one.
- **The burst ceiling (60/60 s) is per-instance**, so N concurrent instances can breach it N times
  over. This is the one that bites on day one, because the consumer and the request path now scale
  independently.

The interface is ready for the fix — "three async methods, and `createNewsClient` already accepts
per-provider governors through `deps.quota`" — so this is a contained build: a Redis-backed
`QuotaGovernor` with per-provider keys, a day-rolling counter, a sliding burst window, and the
observed-snapshot write. It needs its own tests, and `quota.test.ts` gives the behavioural spec to
port.

### 3.5 The per-IP rate limit — ~0.5 day, a decision more than a build

[server.ts:106](../apps/api/src/server.ts) registers in-process counters, with a comment explaining
why that was right: "a Redis-held counter would add a shared failure mode to the request path for
precision nobody needs." Elastic instances make the effective ceiling
`RATE_LIMIT_PER_MINUTE × instances`, and §9.4 leans on this limit as a budget guard against
novel-fingerprint spam minting topics. Two honest answers: Vercel WAF rate limiting (Pro, keeps the
request path clean), or move the counter to Redis and accept the coupling the comment warned about.
Doing neither means the guard is decorative, which is worth saying out loud rather than discovering.

---

## 4. Config, secrets, and previews — ~0.5 day

- **~60 environment variables** in [.env.example](../.env.example) become Vercel project env vars
  across Production/Preview/Development. `vercel env pull`/`add` from the CLI, not the dashboard, or
  this becomes an afternoon of typing and a typo that boots green.
- **Previews should run `CURRENTS_MODE=fixture`.** This is a genuine win: preview deployments cost
  zero upstream quota against a 1000/day budget. It needs `functions.includeFiles` for `fixtures/`
  (352 KB, 7 files) because `FIXTURES_DIR` is read at runtime and nothing traces it.
- **`TRUSTED_PROXY_HOPS=1`** for the single-project layout (2 for the two-project one), and
  `CORS_ORIGIN` set to the deployment origin. Both are documented in the template already; the
  deploy sets them.
- **pnpm 11 needs `ENABLE_EXPERIMENTAL_COREPACK=1`**, after which Vercel reads `packageManager` from
  the root manifest and applies it across the workspace. The build command must build the packages
  before the app (`pnpm build` already does exactly that).
- Postgres TLS and the pooler split are already in the code — `DATABASE_SSL=verify-full` with
  Supabase's CA, `DATABASE_URL` on 6543, `DATABASE_SESSION_URL` on 5432, `DATABASE_POOL_MAX=1–2`.

---

## 5. What the read path costs when polling is metered — worth measuring, not fixing

Progressive delivery has the client poll up to **40 times over ~60 s**
([useTimeline.ts:16](../apps/web/src/useTimeline.ts)) while background jobs land. On a long-lived
server those polls are nearly free. On Vercel each one is an invocation, a Postgres round trip
through the pooler and a Redis round trip — so one cold-topic read can cost 40 of each.

Hobby includes 1M invocations and 4 CPU-hrs of active CPU, so this is not a cost problem at personal
scale; it is a *shape* change worth knowing before the first bill. Two cheap mitigations if it
bites: raise the poll interval, or have the poll response carry a hint about how long to wait.
Note in passing that `INGEST_POLL_MAX=8` in config is not the 40 the client uses — the two drifted,
and the server's value is not what bounds the client.

On the Redis side, Upstash's free tier is 256 MB and **500K commands/month (~16K/day)**. At roughly
5–10 commands per read (cache get, lock, budget counter, pending-set read) that is ~2K reads/day
with the 40-poll sequences counted in. Plausible for this app, tight enough that it should be
watched rather than assumed.

---

## 6. Migrations and deploys — the one thing that gets genuinely worse

ADR-0003 requires migrations as a discrete step, never on boot. Vercel's git integration builds and
promotes a deployment on push; it has no outbound post-deploy hook. So the deploy and the migration
cannot be made atomic:

- A GitHub Actions job runs `pnpm db:migrate` against `DATABASE_SESSION_URL` — the CLI already
  prefers it and announces which URL it used.
- Whichever order you pick, there is a window where one of the two is ahead. That makes
  **expand/contract migration discipline a requirement rather than a good habit**: additive
  migrations deploy before the code that needs them, destructive ones after the code that stopped
  needing them.
- Instant Rollback rolls code back and cannot roll a migration back, and rolled-back deployments do
  not update cron jobs.

This is a real regression against a container deploy that can run a migration task and then flip
traffic, and it is the item most likely to cause a bad afternoon later. Price it as discipline, not
as code.

---

## 7. What is lost, plainly

- **`/metrics` stops meaning anything.** `prom-client` counters are per-process
  ([server.ts:137](../apps/api/src/server.ts)) and there is no stable scrape target. Either push to
  a gateway, lean on Vercel's own observability and delete the endpoint's story, or keep it knowing
  a scrape samples one instance's fragment of the day. §12 needs updating either way.
- **Runtime logs retain for 1 hour on Hobby**, 1 day on Pro. Debugging a nightly chore that ran at
  03:00 from a laptop at 09:00 is not possible on Hobby without shipping logs somewhere.
- **The SIGTERM drain path stops being exercised.** It stays correct for Compose, but §4.1's "the
  drain path is exercised constantly in development" no longer describes production.
- **Cold starts sit in front of the timeline read**, in a path already budgeted to 1200 ms
  (`SYNC_FILL_DEADLINE_MS`).
- **Single region by default (`iad1`)** — the Supabase project must be co-located or every query
  pays a cross-region round trip.
- **A public-beta dependency in the load-bearing position.** `queue/v2beta` and
  `experimentalTriggers` are explicitly beta; the queue is the piece the whole plan turns on.
- **Hobby is personal, non-commercial use only.**

---

## 8. Cost

| | Hobby-shaped | Pro-shaped |
|---|---|---|
| Vercel | $0 — 1M invocations, 4 CPU-hrs, 360 GB-hrs, 100 GB transfer | $20/mo + usage |
| Queues | operation-metered; idempotent sends bill 2× | same, higher included credit |
| Supabase | $0 Free (500 MB, 5 GB egress, pauses at 7 d idle — the cron prevents it) | $25/mo Pro (8 GB, no pausing, 7-day backups) |
| Redis (Upstash) | **$0** — the free tier is plausible once BullMQ's idle poll is gone (§5) | $10/mo Fixed if the command budget is exceeded |
| Chore scheduling | $0 Supabase Cron | $0 Vercel Cron |
| **Total** | **$0**, with real ceilings | **$45–55/mo** |

The $0 column is the honest headline of Plan A and the reason to consider it: it is a genuinely free
production deployment, where Plan B has a floor of ~$5–10/month for the api host plus $10 for a
Redis that BullMQ keeps awake. What the free column buys with that saving is 1-hour logs, a 500 MB
database, a 300 s ceiling on the nightly pass, and a queue trigger in beta.

---

## 9. Phases

Each phase ends with something demonstrable; none of them is "and then we cut over and hope".

| Phase | Work | Exit criterion |
|---|---|---|
| **0. Spikes** (0.5–1 d) | Prove the project shape (§1.1) on a throwaway deployment: Vite preset + `api/` function + a `queue/v2beta` trigger firing. Measure `buildApp` cold start. Measure `chores storylines` wall-clock at 90 days of corpus, bounded and unbounded. Measure the corpus against Supabase's 500 MB. | Three numbers and a working hello-world consumer, or a decision to use the two-project layout |
| **1. The api as a Function** (1–2 d) | §3.1. Consumer disabled, chores still manual. Preview in fixture mode. | `/readyz` green, a timeline read served from Supabase through the pooler, `degraded: "ingest_timeout"` on cold topics — the known, temporary gap |
| **2. The queue** (2–3 d) | §3.2 — new `IngestQueue` implementation, `api/queues/ingest.ts`, rewritten tests. | A cold topic fills behind the reader; `meta.ingest` drains to zero; a killed consumer redelivers |
| **3. Quota + limits** (1.5–2.5 d) | §3.4 and §3.5. | The burst ceiling holds with the consumer and the request path both running; the per-IP guard is real, or documented as removed |
| **4. Chores** (1 d) | §3.3 + Supabase Cron. | Both passes run on schedule, twice-triggered runs skip on the lock, and the report shows up in the logs |
| **5. Observability + cutover** (1–2 d) | §7's decisions, the migration CI job (§6), env vars (§4), DNS. | Production traffic, and someone can answer "did last night's chores run?" without SSH |

**Total: 7–12 days.** The spread is almost entirely Phase 0's spike outcome and Phase 2.

---

## 10. Open questions

1. **Does the recommended project shape actually work?** (§1.1.) Everything else assumes it. Spike
   first, and be willing to take the two-project layout.
2. **How long is `chores storylines` at 90 days of corpus?** If the bounded pass cannot fit 300 s,
   Hobby is out for the nightly work and Plan A starts at $20/month.
3. **Is the corpus under 500 MB?** One `pg_total_relation_size` sweep decides whether Supabase Free
   is a starting point or a dead end.
4. **Does the breadth sample still paint?** §10.1's first-visitor lock elects one enqueuer per stale
   window; with the sample now a queue message, the landing page's first visitor waits for a
   consumer round trip rather than an in-process job. Check against `SAMPLE_REFRESH_MINUTES` before
   assuming the cloud fills.
5. **What replaces `/metrics`?** Deciding is cheap; discovering after cutover that nothing watches
   the quota is not.
6. **Is a beta queue trigger acceptable in the load-bearing position?** If not, Plan A is not ready,
   because the alternatives (a cron drain on Pro, `waitUntil` without delivery guarantees) are each
   worse than what §4.1 asked for.

---

## Sources

- [Vercel Queues](https://vercel.com/docs/queues), [concepts](https://vercel.com/docs/queues/concepts), [pricing and limits](https://vercel.com/docs/queues/pricing) — push mode, at-least-once, idempotency keys, visibility timeout, retries, air-gapped consumers, `queue/v2beta` triggers, deployment partitioning
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations) and [Fluid compute](https://vercel.com/docs/fluid-compute) — durations by plan, `waitUntil`, instance sharing, bundle and payload caps
- [Fastify on Vercel](https://vercel.com/docs/frameworks/backend/fastify), [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [project configuration](https://vercel.com/docs/project-configuration)
- [Managing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs) and [usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) — `CRON_SECRET`, best-effort and occasionally duplicated delivery, no retries, Hobby's once-per-day ±59 min
- [Vercel limits](https://vercel.com/docs/limits) and [Hobby plan](https://vercel.com/docs/plans/hobby) — included usage, 1-hour log retention, non-commercial fair use
- [Supabase Cron](https://supabase.com/blog/supabase-cron) and [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) — minute precision, HTTP request jobs, async with its own timeout
- [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) and [billing](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Upstash Redis pricing](https://upstash.com/pricing/redis) — 256 MB / 500K commands per month on free
