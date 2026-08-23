# Scope — going all in on Vercel

Companion to [RESEARCH-VERCEL-SUPABASE.md](RESEARCH-VERCEL-SUPABASE.md), which weighed Plan A (all
in on Vercel) against Plan B (a persistent host for the api) and recommended B. This document
priced A; on 2026-08-22 **Plan A was adopted**
([ADR-0015](adr/0015-all-in-on-vercel-hobby-shaped.md)), reversing that recommendation, and the
decisions from the adoption review are folded in below. Every codebase claim carries a file:line
from a sweep of `apps/api`, `packages/news-client` and the web client (re-verified 2026-08-22);
every platform claim carries a source at the bottom. Scoped 2026-08-21. **Phase 0 ran on
2026-08-22 and moved three of the numbers below — see
[VERCEL-PHASE-0-FINDINGS.md](VERCEL-PHASE-0-FINDINGS.md), and §3.3 and §9 for what it changed.**

**Bottom line: 7–12 focused days, and one piece of it no delivery phase carried.** Two things
changed the shape of this since the research doc was written:

1. **Vercel Queues** went to public beta — first-party, at-least-once, idempotency keys, and
   consumers that are air-gapped from the internet. That is a much closer match to BullMQ's
   semantics than the third-party HTTP-push queue the research doc assumed, and it turns §3.2 from a
   redesign into a reimplementation of the existing `IngestQueue` surface (§3.2 counts it honestly:
   seven public members on a class, not an interface).
2. **The quota governor is in-process and always was.**
   [quota.ts:104–110](../packages/news-client/src/quota.ts) says §5.4's Redis-held snapshot is
   "designed and NOT built", and ARCHITECTURE §13's "Designed but unbuilt" list names it — so the
   gap is documented, not undiscovered. But ARCHITECTURE §9.1 nevertheless claimed the consumer
   "draws from the shared quota snapshot (§5.4), so adding tasks cannot breach the 60/60s burst
   ceiling" (since corrected). That claim was already untrue at two replicas; elastic instances
   make it acute. **Plan A cannot ship without the burst half of it**, and no delivery phase
   carried it until this one.

And one thing that does *not* change: **Redis stays.** The page cache, the single-flight lock, the
per-topic daily cap and the ingest pending-set are all still Redis, on any plan. What Plan A removes
is BullMQ's idle polling — which is the thing that made Redis cost $10/month (§8).

## 0. Decisions — 2026-08-22 adoption review

Settled in the review that adopted this plan (ADR-0015 carries the why; the sections below carry
the how). One naming rule up front: **"queue topic" means Vercel Queues' topic**, never Zammy's
**Topic** (a canonicalized search, CONTEXT.md) — the two collide in this document otherwise.

| Decision | Answer | Where |
|---|---|---|
| Plan posture | Hobby-shaped; Pro is the escape hatch, not the start | §8 |
| Beta queue in the load-bearing position | Accepted; pending set is the backstop, manual drain is the fallback | §3.2 |
| Chore-run visibility | A durable `chore_runs` record per pass run — **new code**, non-optional on Hobby | §3.3 |
| Preview data plane | A second free-tier Supabase + Upstash pair; previews never touch production | §4 |
| Preview migrations | A per-PR CI step migrates the preview DB (doubles as a pooler rehearsal) | §6 |
| Quota governor scope | Burst-window-only + Currents observed snapshot; daily ledger deferred with GNews | §3.4 |
| Governor failure mode | Fail-open to in-process counting when Redis is unreachable | §3.4 |
| Per-IP rate limit | Moves to Redis (fail-open); WAF is Pro-only and off the table | §3.5 |
| `/metrics` | Deleted, story and all; quota spend lands in `chore_runs`, latency in platform observability | §7 |
| Chores routing | Scheduled as today (Supabase Cron), **plus** all seven passes addressable by query param | §3.3 |
| Supabase pause guard | A dedicated daily keep-alive ping through the pooler, independent of chore health | §3.3 |
| Ingest message TTL | ≈ `STALE_PENDING_MS` (5 min), so the dedup window matches the pending-set semantics | §3.2 |
| Cutover data | Production Supabase is **seeded from the dev corpus** (dump/restore, session pooler) | §9 Phase 5 |

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
| Quota governance | in-process per replica | **Redis burst window, fail-open (§3.4) — to be built** |
| Per-IP rate limit | in-process counters | the counters move to Redis, fail-open (§3.5) |
| `/metrics` | Prometheus scrape | **deleted** — platform observability + `chore_runs` (§7) |
| Supabase pause guard | n/a | a daily keep-alive ping through the pooler (§3.3) |
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
| **New code** | Files that do not exist yet | the function entrypoint, the queue consumer route, the chore route + `chore_runs` record, the keep-alive ping, the Redis quota burst window, the Redis rate-limit store |
| **Reimplement behind the interface** | Same contract, different mechanism | `ingest-queue.ts` (BullMQ → Vercel Queues), `ingest-queue.test.ts` |
| **Split** | One function becomes two | `buildApp` — the consumer must not start in a request instance ([server.ts:209](../apps/api/src/server.ts)) |
| **Decided** | Something stopped working and got an honest answer (§0) | the per-IP rate limit (→ Redis), `/metrics` (→ deleted) |
| **Config only** | No code | `vercel.json`, 66 environment variables, CI, cutover |
| **Unchanged** | Genuinely untouched | all of `packages/storage`, the grouping/storyline engine, the timeline SQL, `packages/*-client` |

The last row is the reassuring one and it is large: the storage layer, the linker, the labeller and
every provider adapter do not know where they run and do not change. This is a deployment-shape
migration, not a rewrite — the opposite of
[HEATWAVE-MIGRATION-SCOPE.md](HEATWAVE-MIGRATION-SCOPE.md)'s verdict for MySQL.

---

## 3. The new code, priced

### 3.1 The function entrypoint, and splitting `buildApp` — ~1–2 days

`buildApp` currently does two jobs in one call: it builds the HTTP surface *and* starts the queue
consumer ([server.ts:209](../apps/api/src/server.ts)). In a request instance the second must not
happen — a BullMQ-shaped worker in a function that scales to zero is exactly the failure the
research doc describes. The split is small and it is the same seam §9.1 already names ("it stays
structured as a separable unit"):

- `buildApp(config, { consumer: false })`, or a `buildRoutes` the entrypoints share. Note the split
  is not only about `startConsumer` — the request entrypoint must still construct the
  `IngestQueue` for its publish side, because the read path enqueues (§3.2's call sites) and the
  trending service scopes Redis keys by the queue's `name`.
- `api/[...path].ts`: a module-scope `let app: Promise<App>` singleton, `await app.ready()`, then
  hand the request to `app.server.emit("request", req, res)` — the standard Fastify-on-serverless
  pattern. Module scope is what makes the pool, the Redis client and the fixture store survive
  across invocations on a warm instance.
- `apps/api/src/index.ts` stays exactly as it is. It is the Compose and Plan-B entrypoint, and
  `listen()` plus the SIGTERM drain remain correct there. Nothing about local development changes.

Watch items: cold-start cost of `buildApp` (Zod config parse, `createNewsClient`, route
registration) is unmeasured and sits in front of the first timeline read; `/healthz` and `/readyz`
live outside `/api` so they need two rewrites (`/metrics` also lived outside and would have been a
third — it is deleted instead, §7); and the 4.5 MB response cap is far above any timeline page but
worth knowing.

### 3.2 The queue: BullMQ → Vercel Queues (push mode) — ~2–3 days

The surface is genuinely narrow, which is why this is days and not weeks — but count it honestly:
[ingest-queue.ts](../apps/api/src/ingest-queue.ts) is 187 lines, its test is 105, and `IngestQueue`
is an exported **class**, not an interface, so the contract is structural. The real surface a
reimplementation must satisfy is **seven public members across ten usages**: the six service call
sites ([timeline-service.ts:233, 293, 333, 638](../apps/api/src/timeline-service.ts),
[trending-service.ts:109, 128](../apps/api/src/trending-service.ts)), plus `startConsumer`/`close`
in [server.ts:209, 228](../apps/api/src/server.ts) and test-support — and the easy one to miss,
the **`name` getter**, which [trending-service.ts:67, 70](../apps/api/src/trending-service.ts)
uses to scope the trending/sample-lock Redis keys. Miss it and trending locks silently diverge.

| What BullMQ gives us | Vercel Queues equivalent | Note |
|---|---|---|
| `jobId` content-dedup ([`ingestJobId`](../apps/api/src/ingest-queue.ts)) | `idempotencyKey` on `send` | Dedup window is the message TTL rather than "the pending window" — so **publish with `retentionSeconds: 300`** (≈ `STALE_PENDING_MS`), not the 24h default, or a failed run's segment cannot be re-enqueued for a day. TTL is per-message (60s–7d). Billed at 2× the operation. |
| `attempts: 3`, exponential backoff from 200 ms | the SDK `retry` callback on `deliveryCount` | Forced exponential backoff after 32 attempts. No DLQ; a poisoned message is acknowledged in the handler. **`retryAfterSeconds` is Nitro-only** — a `nitro.config.ts` trigger option, not a `vercel.json` one, so on the bare `api/` layout the `retry` callback is the whole mechanism. |
| At-least-once via BLMOVE + reaper | at-least-once by contract; **the SDK's `visibilityTimeoutSeconds` defaults to 300 s and auto-extends the lease while the handler runs** (the raw API's 60 s does neither) | §4.1 called at-least-once a deployment requirement. It survives. |
| Worker concurrency | max concurrency per consumer group | Useful ceiling for a quota-bearing consumer (§3.4). |
| A `Worker` in-process | `api/queues/ingest.ts` with a `queue/v2beta` trigger in `vercel.json` | **Air-gapped: no public URL, no auth code to write.** Better than a signed webhook. Use `QueueClient#handleNodeCallback`, not the top-level `handleCallback` — the latter returns a Web-standard `POST` handler and an `api/` function on the Node runtime is handed `(req, res)`. |
| `obliterate()` in tests | — | Tests change shape (below). |

**The pending set stays in Redis, deliberately.** `pendingCount` is what `meta.ingest` reports and
what the client polls against (§6.5), and it already tolerates Redis being down. Keeping the
`ZADD NX` / `STALE_PENDING_MS` mechanism ([ingest-queue.ts:52](../apps/api/src/ingest-queue.ts))
means the progressive-delivery contract is untouched by the transport swap — the smallest possible
blast radius for the riskiest change.

Two consequences to accept explicitly:

- **Queue topics are partitioned by deployment ID in push mode.** A deploy mid-flight leaves the old
  deployment draining its own messages. That is *better* than what we have (BullMQ jobs outlive the
  code that wrote them), but it is a different failure mode: work published by a deployment that is
  then rolled back is consumed by a deployment nobody is serving from.
- **`ingest-queue.test.ts` cannot test a hosted queue the way it tests BullMQ.** The 105 lines
  currently assert real retry and dedup behaviour against Redis. That splits into unit tests for the
  pure parts (`ingestJobId`, `samplePendingId`, the pending-set arithmetic) plus a fake for the
  transport, with delivery semantics trusted to the platform. This is a real loss of test power and
  should be recorded as one.

**The beta is accepted, with a named fallback (§0, ADR-0015).** The pending set is our own
at-least-once ledger: if the `queue/v2beta` trigger regresses, `meta.ingest` keeps reporting what
is owed, and the manual drain is an authenticated chores-route pass that reads the pending set and
performs the fills inline. If the trigger is withdrawn entirely, the exits are a cron-driven pull
drain (Pro) or the two-project layout — both worse than what §4.1 asked for, which is the bet the
ADR records.

### 3.3 The chores as an HTTP route — ~1–1.5 days

The passes are already exported — **all seven of them**: retention, dormancy, late-candidate,
bridge-sweep, label-merge, storyline-label and the storyline pass, in
[chores.ts](../apps/api/src/chores.ts) — and the session-mode connection they need is already wired
([`createConfiguredDb(config, { session: true })`](../apps/api/src/wiring.ts)), so this is a
wrapper plus one new table:

- `api/chores.ts` — verify `Authorization: Bearer $CRON_SECRET`, pick the pass from the query or
  from the `x-vercel-cron-schedule` header, **return 202 immediately and run the pass in
  `waitUntil`**. Every one of the seven passes is individually addressable by query parameter
  (§0): the schedule drives the same nightly set `pnpm chores` runs today, and "re-run just the
  label pass from a laptop" is a curl, not an SSH. Returning first is what makes the scheduler's
  own timeout irrelevant to the *pass* — but not to the *request*: `pg_net`'s default timeout is
  **2 seconds**, plausibly shorter than a cold `buildApp` plus TLS, so the cron job sets
  `timeout_milliseconds` ≥ 10 000 explicitly, and "202 returned from cold within pg_net's timeout"
  is a Phase 4 exit criterion.
- **Every run writes a `chore_runs` row** (pass, started/finished, report summary, quota spend) at
  pass end. This is not optional on Hobby: the route always answers 202, the scheduler never sees
  failure, and logs retain for 1 hour — without a durable record, "did last night's chores run?"
  is unanswerable by design. The row is also where §7's quota-headroom number survives, and it
  guarantees a nightly write through the pooler (see keep-alive below).
- `vercel.json` gives that one path a `maxDuration` of 300 s (Hobby ceiling) or 800 s (Pro).
- `--max-labels` becomes a deployment parameter, not an operator convenience. At
  `GEMINI_MAX_RPM=15` a label is ≥4 s of pacing plus model latency, so an unbounded night exceeds
  300 s well before it exceeds Gemini's daily quota. The pass is resumable across nights, so a bound
  costs latency, not labels. **Phase 0 puts the figure at 40–60**: 75 labels is the entire 300 s
  window, against a default of 500 ([chores.ts:394](../apps/api/src/chores.ts)).
- **The late-candidate sweep is the phase that actually blows the ceiling.** Measured at
  **41 ms × 12,338 groups ≈ 506 s** — 1.7× Hobby's 300 s, every night, on loopback Postgres. It is
  one query: `readCandidateStorylines` is 34 of the 41 ms, and its cost tracks profile width, from
  2.5 ms at p10 to 76 ms at p90 (findings §2.1). Round trips are a surcharge on that, not the cause.
  **And most of it is not a deployment problem at all** (findings §2.5): `CANDIDATE_LIMIT` binds on
  399 of 400 groups, discarding ~83% of the candidate set by recency, while the replay harness that
  pinned the linking thresholds has no cap — so production runs a capped decision against thresholds
  certified uncapped. Narrowing the retrieval to the anchor-eligible tokens is free, lossless by
  proof, and takes the sweep to **~275 s, inside the ceiling**; it is a linking-correctness fix that
  happens to remove this phase's deadline problem, and it is being handled outside this plan. What
  remains for Phase 4 is therefore smaller than it looked: **the bound as a safety valve** — a
  `maxGroups` on `StorylinePassDeps`, a `--max-groups` flag and a persisted cursor, since the cursor
  is seeded from the window's start ([chores.ts:193](../apps/api/src/chores.ts)) and a bound without
  one would sweep the newest 7,000 nightly, never reach the rest, and report a clean tally while
  doing it — plus **validating the drain**, because the corrected retrieval unblocks a backlog of
  linking that changes the storyline graph over several nights. Offering fewer groups (a changed-set
  filter, or the inverted birth-trigger shape
  [PR #114](https://github.com/ashaharudin/zammy/pull/114) used for the label-agreement merge)
  stays worth having but is no longer load-bearing here, and its case rested on a yield figure
  measured under the cap. A denormalized sort key was tested and rejected at 8% (§2.2).
- **The label backlog must not run in this route.** 2,981 of 3,934 promoted storylines have never
  been labelled and **zero have drifted**, so the nightly drift pass is nearly free while the
  backlog is 3.3 hours of paced calls — quota-bound, ~6 days of Gemini free tier. It is
  `backfill:storylines` work against the session pooler, and draining it before cutover is the
  cheaper order since Phase 5 seeds production from this corpus (findings §3).
- **A `REINDEX TABLE CONCURRENTLY` sweep joins the retention chore.** Index bloat is 22% of the
  database at 15 days — 41 MB, of which 23 MB is `story_token_days` alone — and 2.0 s of
  non-blocking work recovers all of it. On a 500 MB budget that is the difference between the
  storage tripwire reading 1,214 articles/day and 1,485 (findings §4, §5).
- **Scheduler: Supabase Cron, not Vercel Cron, on the free tier.** Minute precision instead of
  Hobby's once-per-day ±59 min. Vercel Cron is the choice on Pro, where per-minute precision comes
  with the plan.
- **The keep-alive is its own job, not a chore side effect.** Supabase's docs do not promise that
  pg_cron's internal activity prevents the 7-day free-tier pause — they define inactivity as
  insufficient *user* database activity and prescribe external requests. The chore route's own
  pooler queries qualify, but only on nights the chore runs and reaches the database. So the guard
  is a separate trivial route (`SELECT 1` through the pooler) on its own daily cron (§0): "the
  database stays awake" must not share a failure mode with the most complex nightly job.
- The advisory lock still does its job, and is still the only thing standing between two schedulers
  and a doubled label bill — which is now more likely, not less, because cron delivery on Vercel is
  documented as best-effort and occasionally duplicated.

### 3.4 The Redis quota governor — ~1 day burst-only (decided), and non-optional

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
per-provider governors through `deps.quota`" — and the adoption review scoped it down (§0):

- **Build the sliding burst window and the Currents observed-snapshot write. Defer the day-rolling
  local ledger.** The burst breach is the day-one problem; the daily ledger's only customer is a
  headerless provider, GNews is not on the horizon, and Currents self-corrects its daily count from
  response headers after one call per cold start — which quota.ts itself calls tolerable. The
  deferral lives here, next to the `GNEWS_ENABLED=false` default it depends on: **enabling GNews
  requires building the Redis daily ledger first.** (The 60/60s figure is Currents' ceiling
  specifically; burst limits are per-provider config.)
- **Fail-open.** When Redis is unreachable, the governor falls back to the in-process counting that
  exists today — an Upstash blip degrades to exactly current behaviour, matching the posture the
  page cache and pending set already take toward Redis-down. It never fails the provider call
  closed.

It needs its own tests, and `quota.test.ts` gives the behavioural spec to port for the burst half.

### 3.5 The per-IP rate limit — ~0.5 day, decided: the counters move to Redis

[server.ts:116](../apps/api/src/server.ts) registers in-process counters, with a comment explaining
why that was right: "a Redis-held counter would add a shared failure mode to the request path for
precision nobody needs." Elastic instances make the effective ceiling
`RATE_LIMIT_PER_MINUTE × instances`, and §9.4 leans on this limit as a budget guard against
novel-fingerprint spam minting topics. Hobby removes the Vercel WAF option (Pro-only), which
collapses the choice: **the counter moves to Redis** (`@fastify/rate-limit` takes a Redis store
natively, ~2 extra commands per request), **fail-open** on Redis errors to match §3.4's posture
(§0). The comment's warning about coupling is accepted with eyes open, because this guard protects
the thing that actually runs out — the Currents daily quota — and leaving it decorative would mean
one spammer's novel fingerprints drain the day's budget. The comment at server.ts:111–115 should be
updated to record why the trade reversed.

---

## 4. Config, secrets, and previews — ~0.5 day

- **66 environment variables** in [.env.example](../.env.example) become Vercel project env vars
  across Production/Preview/Development. `vercel env pull`/`add` from the CLI, not the dashboard, or
  this becomes an afternoon of typing and a typo that boots green.
- **Previews run `CURRENTS_MODE=fixture` against their own data plane** (§0): a second free-tier
  Supabase project and Upstash database, because fixture mode still *ingests* — a preview pointed
  at production would write fixture articles into the real corpus and its storylines. Fixture mode
  is a genuine win regardless: preview deployments cost zero upstream quota against a 1000/day
  budget. It needs `functions.includeFiles` for `fixtures/` (352 KB, 7 files) because
  `FIXTURES_DIR` is read at runtime and nothing traces it. The preview database is migrated by a
  per-PR CI step (§6).
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
Note in passing that `INGEST_POLL_MAX=8` in config is not drift from the client's 40 — it is a
**dead knob**: nothing reads it. The client hardcodes 40; the config value has no consumer. If the
poll response ever carries a wait hint (the second mitigation), that knob is the natural thing to
wire or delete.

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
- **A per-PR step migrates the preview database** (§4's second free-tier pair) before the preview
  deploy. Beyond keeping migration-bearing PRs' previews working, this is the rehearsal the missing
  atomicity wants: every migration runs against a real Supabase session pooler once before it
  touches production. The initial *setup* of each Supabase project — schema on the preview pair,
  schema plus the seeded corpus on production (§9 Phase 5) — is one-time; the CI steps are what
  carry the 16-migrations-in-10-days cadence after that.
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

- **`/metrics` stops meaning anything, so it is deleted** (§0; ARCHITECTURE §12 updated).
  `prom-client` counters are per-process ([server.ts:147](../apps/api/src/server.ts)) and there is
  no stable scrape target — and nothing scrapes this system today anyway. Latency and invocations
  come from Vercel's observability; the one number that must not be lost — quota headroom — lands
  in the nightly `chore_runs` record (§3.3), and the remaining §12 numbers become structured log
  fields.
- **Runtime logs retain for 1 hour on Hobby**, 1 day on Pro. Debugging a nightly chore that ran at
  03:00 from a laptop at 09:00 is not possible on Hobby without shipping logs somewhere — the
  `chore_runs` record (§3.3) preserves *what happened*; the logs of *why* are still gone, and
  re-running the pass on demand is the debugging tool that remains.
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
| Supabase | $0 Free (500 MB, 5 GB egress, pauses at 7 d idle — the keep-alive ping's pooler query prevents it, §3.3) | $25/mo Pro (8 GB, no pausing, 7-day backups) |
| Redis (Upstash) | **$0** — the free tier is plausible once BullMQ's idle poll is gone (§5) | $10/mo Fixed if the command budget is exceeded |
| Chore scheduling | $0 Supabase Cron | $0 Vercel Cron |
| **Total** | **$0**, with real ceilings | **$45–55/mo** |

The $0 column is the honest headline of Plan A and the reason it was adopted (ADR-0015): it is a
genuinely free production deployment, where Plan B has a floor of ~$5–10/month for the api host
plus $10 for a Redis that BullMQ keeps awake. The preview stack (§4) is a second free-tier
Supabase + Upstash pair, also $0. What the free column buys with that saving is 1-hour logs, a
500 MB database, a 300 s ceiling on the nightly pass, and a queue trigger in beta.

Two things Phase 0 pinned down about that column:

- **The compute allowances are not the constraint.** The nightly sweep runs at 5.7% CPU utilisation
  — 54 s of CPU across 950 s of wall clock, because it is round-trip-bound — so the chores land
  around 3 CPU-minutes a night against Hobby's 4 CPU-hours/month, and provisioned memory is
  similarly slack. **Wall clock is the only Hobby ceiling that binds**, which is worth knowing for
  certain before designing around the wrong one (findings §2, §6).
- **The Queues line is worse than unconfirmed — it is undocumented.** The docs' pricing/limits page
  lists the five operation types, 4 KiB metering and every service limit, then defers included
  usage to the plan pages; the Hobby plan's included-usage table has **no Queues row**, while
  listing Workflows (which is built on Queues) at 50,000 events/month. The Queues docs also carry a
  "Permissions Required" marker. So whether a Hobby project can create a topic at all is open, and
  this whole column rests on it (§10, question 2).

---

## 9. Phases

Each phase ends with something demonstrable; none of them is "and then we cut over and hope".

| Phase | Work | Exit criterion |
|---|---|---|
| **0. Spikes** (0.5–1 d) | Prove the project shape (§1.1) on a throwaway deployment: Vite preset + `api/` function + a `queue/v2beta` trigger firing. Measure `buildApp` cold start. Measure `chores storylines` wall-clock at 90 days of corpus, bounded and unbounded. Measure the corpus against Supabase's 500 MB — a **now**-question, since production is seeded from it (Phase 5). Confirm Queues' Hobby allowance in the dashboard (§8). | **The three numbers are measured** ([VERCEL-PHASE-0-FINDINGS.md](VERCEL-PHASE-0-FINDINGS.md)): cold start ~360 ms (a fifth of it deleted by §3.2 + §7); `chores storylines` ~3.5 h unbounded, with the **late-candidate sweep at ~506 s the phase that breaks the ceiling**, not the label pass; corpus 190 MB with the 500 MB tripwire at ~1,485 articles/day after a reindex. The deployment half — the queue trigger on a bare `api/` function, and whether Hobby can create a topic at all — is scaffolded and **still to run**: [deploy/vercel-spike/](../deploy/vercel-spike/) |
| **1. The api as a Function** (1–2 d) | §3.1. Consumer disabled, chores still manual. Preview in fixture mode against the preview data plane (§4). | `/readyz` green, a timeline read served from Supabase through the pooler, `degraded: "ingest_timeout"` on cold topics — the known, temporary gap |
| **2. The queue** (2–3 d) | §3.2 — new `IngestQueue` implementation (all seven members), `api/queues/ingest.ts`, 5-min message TTL, rewritten tests. | A cold topic fills behind the reader; `meta.ingest` drains to zero; a killed consumer redelivers |
| **3. Quota + limits** (1–2 d) | §3.4 (burst-only, fail-open) and §3.5 (Redis store, fail-open). | The burst ceiling holds with the consumer and the request path both running; the per-IP guard is real; both degrade to in-process when Redis is down |
| **4. Chores** (1.5–2.5 d) | §3.3 + Supabase Cron + `chore_runs` + the keep-alive ping, **plus what Phase 0 added**: the sweep's bound and persisted cursor as a safety valve (§3.3), and the `REINDEX CONCURRENTLY` sweep in the retention chore. Assumes the retrieval fix (findings §2.5) has landed separately; without it this phase inherits a 506 s pass and the estimate goes back up. | All scheduled passes run on schedule and write `chore_runs` rows, any pass runs on demand by query param, twice-triggered runs skip on the lock, the 202 arrives from cold within pg_net's configured timeout, **and the storyline pass finishes inside `maxDuration` without the sweep quietly stopping short of its window** |
| **5. Observability + cutover** (1–2 d) | The migration CI jobs (§6, prod + preview), env vars (§4), **seed production from the dev corpus** (a 24 MB `pg_dump -Fc`, measured at 1.9 s out and 1.1 s in — findings §4), DNS. Drain the 2,981-storyline label backlog first (§3.3). | Production traffic against the seeded corpus, and "did last night's chores run?" is answered by a `chore_runs` query |

**Total: 7.5–13.5 days.** Phase 0's measurements added the reindex sweep and the sweep's safety-valve
bound to Phase 4, but took the sweep's deadline problem back out of the plan entirely — it is a
linking bug with its own fix (findings §2.5), and this plan now depends on that landing rather than
carrying it. The remaining spread is Phase 0's *deployment* outcome — still unrun — and Phase 2.

---

## 10. Open questions

Two were settled by the adoption review (§0, ADR-0015) and two by the Phase 0 measurements
(2026-08-22, [VERCEL-PHASE-0-FINDINGS.md](VERCEL-PHASE-0-FINDINGS.md)). Three remain, and only one
of them is still a question about the plan rather than about a dashboard.

1. **Does the recommended project shape actually work?** (§1.1.) Everything else assumes it. **Still
   open** — it needs a deployment, and the throwaway is scaffolded at
   [deploy/vercel-spike/](../deploy/vercel-spike/) with each answer's meaning written down. Be
   willing to take the two-project layout.
2. **Is Queues available on Hobby, and at what allowance?** Promoted from a line item in Phase 0 to
   an open question, because it turns out to be **undocumented rather than merely unchecked**: the
   Queues pricing page defers included usage to the plan pages, and the Hobby table has no Queues
   row while listing Workflows (built on Queues) at 50,000 events/month. §8's $0 column rests on
   this. One curl from the spike answers it.
3. **Does the breadth sample still paint?** §10.1's first-visitor lock elects one enqueuer per stale
   window; with the sample now a queue message, the landing page's first visitor waits for a
   consumer round trip rather than an in-process job. Check against `SAMPLE_REFRESH_MINUTES` before
   assuming the cloud fills. **Still open** — it needs the queue working first (Phase 2).
4. ~~How long is `chores storylines` at 90 days of corpus?~~ **Measured**: ~3.5 h unbounded, and the
   binding phase is not the one this document expected. The label pass fits 300 s at
   `--max-labels` 40–60; the late-candidate sweep is ~506 s — and most of that turned out to be a
   **linking-correctness bug rather than a deployment cost**: `CANDIDATE_LIMIT` discards ~83% of the
   candidate set on 399 of 400 groups, and correcting the retrieval takes the pass to ~275 s,
   inside the ceiling (findings §2.5). Being fixed outside this plan; what stays in Phase 4 is the
   bound as a safety valve and validating the drain (§3.3).
5. ~~Is the corpus under 500 MB?~~ **Measured**: 190 MB today at 15 corpus-days, 125 MB restored,
   and the useful form is a tripwire rather than a number — 500 MB is reached at ~1,485
   articles/day sustained over 90 days *if* the reindex sweep runs, ~1,214 if it does not, against
   an observed 742–1,747/day (findings §4, §5).
6. ~~What replaces `/metrics`?~~ **Settled**: deleted; platform observability plus the `chore_runs`
   record carry what mattered (§7).
7. ~~Is a beta queue trigger acceptable in the load-bearing position?~~ **Settled**: accepted, with
   the pending set as backstop and a manual drain as fallback (§3.2, ADR-0015).

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
