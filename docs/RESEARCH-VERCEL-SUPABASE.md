# Research — running Zammy on Vercel + Supabase

Companion to [DEPLOYMENT-OCI.md](DEPLOYMENT-OCI.md), which is now archival: OCI was abandoned for
lack of Always Free Ampere capacity, so the question "where does this actually run" is open again.
This document prices **Vercel (compute + CDN) + Supabase (Postgres)** against the app as it is
written today. Every claim about the codebase carries a file:line; every claim about the platforms
carries a source at the bottom. Researched 2026-08-21.

**Bottom line: `web` and Postgres map cleanly and could move this week. The `api` does not — not
because Fastify cannot run on Vercel (it can, zero-config), but because the api is a process with a
queue consumer inside it, and Vercel has no always-on process to put one in.** Neither platform
sells Redis, so a third vendor appears no matter which shape is chosen. The realistic choices are:

| | What it costs | What it changes in the code |
|---|---|---|
| **A. All-in on Vercel + Supabase** | $0–20/mo Vercel, $0–25/mo Supabase, $0–10/mo Redis | Replaces the queue transport, turns two CLIs into HTTP routes, re-wires TLS and pooling. ~1–2 days. |
| **B. Split — `web` on Vercel, Postgres on Supabase, `api` on a persistent host** | ~$5–10/mo for the api host, plus the above | TLS and pooling only. Hours. |

Plan B is the shortest path to a running app and keeps §4.1's "the in-process consumer is viable"
promise intact. Plan A is viable, and is the only one of the two that gets to zero persistent
infrastructure, but it is an architecture change, not a deployment — §9.1's consumer becomes an HTTP
push target and the app's shape changes with it.

---

## 1. Service mapping

| Unit | Local dev (Compose) | Vercel + Supabase |
| --- | --- | --- |
| `web` (React + Vite SPA) | Vite dev server :5173 | Vercel static build — the good case, see §2 |
| `api` (Fastify HTTP surface) | container | Vercel Function (Fastify is zero-config, one function, Fluid compute) |
| **in-process consumer (§9.1)** | same container | **no home** — see §3 |
| Postgres | `postgres:17` container | **Supabase Postgres**, via Supavisor — see §4 |
| Redis | `redis:7` container | **not sold by either** — Upstash/Redis Cloud via Vercel Marketplace, see §5 |
| Nightly chores (03:00/04:00 UTC) | `pnpm chores` by hand | Vercel Cron → HTTP route, or Supabase Cron → HTTP route — see §6 |
| Migrations (`pnpm db:migrate`) | host command | CI step against the session-mode pooler — see §4.3 |
| Secrets | gitignored `.env` | Vercel project env vars |
| Logs | stdout | Vercel Runtime Logs (1h retention on Hobby, 1 day on Pro) |

---

## 2. What moves cleanly

**`web` is the easy win, and it is better on Vercel than in the AWS plan.** The browser calls
`/api/v1/...` relative — [api.ts:86–114](../apps/web/src/api.ts) — so serving `web` and `api` from
one Vercel project makes them same-origin. That deletes two of §4.1's "two places local and
production genuinely differ":

- **`web`'s API base URL** stops being build-time configurable. A `vercel.json` rewrite sends
  `/api/*` to the function; relative fetches work in dev (Vite proxy,
  [vite.config.ts:12](../apps/web/vite.config.ts)) and in production unchanged.
- **CORS** stops mattering. `CORS_ORIGIN` ([.env.example:209](../.env.example)) becomes the
  same-origin value, and `@fastify/cors` is left registered against a boundary nothing crosses.

**Postgres is a like-for-like move.** Supabase is stock Postgres with the extensions on top, so
none of the six load-bearing mechanisms priced in
[HEATWAVE-MIGRATION-SCOPE.md](HEATWAVE-MIGRATION-SCOPE.md) are in play: `RETURNING`, the `xmax = 0`
insert-vs-update detection, arrays, CTEs, the group-identity trigger and all 16 migrations run as
written. This is the exact opposite of the HeatWave verdict — the storage layer does not change
shape, only its connection string and its TLS does (§4).

**Bundle size is a non-issue.** `fixtures/` is 352 KB across 7 files, and the function limit is
250 MB uncompressed. If `CURRENTS_MODE=fixture` is ever wanted in a deployed preview, the directory
needs `functions.includeFiles` in `vercel.json` — it is not traced automatically, because
`FIXTURES_DIR` is read at runtime, not imported.

---

## 3. The blocker: §9.1's consumer has nowhere to live

[server.ts:191](../apps/api/src/server.ts) starts a BullMQ worker inside the api process:

```ts
queue.startConsumer((job) =>
  job.kind === "sample" ? processSampleJob(trendingDeps, job) : processSegmentJob(deps, job),
);
```

§4.1 explicitly licensed this — "Fargate keeps CPU allocated for the life of a task, so the
in-process consumer is viable in production" — and named the condition under which it stops being
true: "a later target suspends CPU between requests." **Vercel is that target.** Container-based
functions are documented as stateless and request-scoped, scaling to zero after five minutes idle in
production; there are no always-on background workers. A `Worker` constructed at module scope
([ingest-queue.ts:124](../apps/api/src/ingest-queue.ts)) will draw jobs only while some instance
happens to be warm, and BullMQ's blocking poll runs against Redis whether or not anyone is reading —
billable idle work on a platform that bills for it (§5).

What breaks, concretely, is **progressive delivery (§6.5)**. The client polls up to 40 times over
~60s waiting for background jobs to land ([useTimeline.ts:16](../apps/web/src/useTimeline.ts)); with
no consumer, every cold topic paints page 1 from the synchronous deadline-bounded fill and then sits
until the client gives up with `degraded: "ingest_timeout"`. The deferred backfill, the breadth
sample that feeds the landing-page wordcloud (§10.1), and refresh-on-read (§6.4) all stop happening.
Nothing is *corrupted* — §11's design holds, the next reader re-plans the gap — but the product
degrades to "whatever one synchronous call could fetch."

Four ways out, in increasing order of how much they change:

1. **`waitUntil` the work in the request that planned it.** Fluid compute's documented background
   processing continues execution after the response is sent, bounded by the function's max duration
   (300s Hobby, 800s Pro). This is the smallest change: `enqueueSegment` becomes "do it after
   responding" for the same-instance case. It gives up at-least-once delivery — §4.1 called that a
   *deployment requirement* — and it makes the reader's function pay for the fill, so a burst of
   cold topics multiplies concurrent invocations rather than queueing behind a bounded consumer.
2. **A drain route on a cron.** Keep BullMQ, keep the queue, and replace the blocking worker with
   `POST /internal/drain` that processes up to N jobs and returns. Preserves at-least-once and the
   quota guards; costs a scheduler tick of latency. **Needs Pro** — Hobby cron is once per day
   (§6), which is not a queue drain, it is a nightly batch. Supabase Cron can hit it every minute on
   the free plan instead (§6).
3. **Replace the transport with a push queue** — **Vercel Queues** (public beta: first-party,
   at-least-once, idempotency keys, and consumers with no public URL) or Upstash QStash. The
   queue calls a route per job; retries, backoff and dedup move to the vendor. This is the idiomatic
   serverless answer and it is where `IngestQueue`'s seam already points — the interface is narrow
   (`enqueueSegment`, `enqueueSample`, the pending set) and §9.1 already says "moving it out is a
   deployment decision with no code change." It does mean the pending-set semantics
   ([ingest-queue.ts:47](../apps/api/src/ingest-queue.ts)'s `samplePendingId`, the `NX` timestamp,
   `STALE_PENDING_MS`) get re-implemented against a different primitive, and dedup-by-content —
   which is what stops a popular cold topic multiplying quota spend — has to survive the move.
4. **Keep a persistent consumer somewhere else** (Plan B). Zero application change.

---

## 4. Supabase Postgres — three things need re-wiring

### 4.1 Pooler mode is not one choice, it is two

Supabase offers a direct connection (port 5432, **IPv6 only** unless the IPv4 add-on is bought), a
Supavisor **session-mode** pooler (port 5432 on the pooler host, IPv4 on every tier), and a
Supavisor **transaction-mode** pooler (port 6543). Transaction mode is the serverless one, and it
comes with two documented losses: **no prepared statements**, and **no session-level Postgres
features — advisory locks included**, because connections are reused between clients.

That last one lands directly on three call sites, and they do not all land the same way:

| Site | Lock | Transaction mode? |
|---|---|---|
| [coverage.ts:35](../packages/storage/src/coverage.ts) | `pg_advisory_xact_lock` | **Safe.** Transaction-scoped, and a transaction is pinned to one backend for its duration. |
| [migrator.ts:71](../packages/storage/src/migrator.ts) | `pg_advisory_lock` on a pinned connection | **Broken.** Session-scoped; the pin is a pool pin, not a backend pin. |
| [chores-cli.ts:135](../apps/api/src/chores-cli.ts) | `pg_try_advisory_lock` | **Broken.** Same reason — and this one is a correctness guard, not a backstop: it is what makes a chore pass exactly-once now that the schedule lives outside the app. |

So the deployment needs **two connection strings**, not one:

- **`api` requests → transaction mode (6543).** Kysely over `pg` is fine here: node-postgres only
  issues a named prepared statement when a query supplies `name`, and nothing in `packages/storage`
  does. No `?pgbouncer=true`-style escape hatch is needed.
- **Migrations and the chore runner → session mode (5432 on the pooler host).** IPv4-reachable, so
  CI can use it; session state survives, so both advisory locks behave. The direct connection would
  also work but is IPv6-only, and GitHub Actions runners are IPv4 — that alone rules it out for
  `pnpm db:migrate` in CI.

Neither `Config` nor `createDb` can express that split today: there is one `DATABASE_URL`
([index.ts:56](../packages/config/src/index.ts)). The cheapest honest fix is a second optional
setting — `DATABASE_SESSION_URL`, read only by `migrate-cli.ts` and `chores-cli.ts` — validated at
boot like everything else (§12) so a missing one is a refusal rather than a chore that silently
takes a lock on the wrong backend.

### 4.2 TLS is currently unspecified, and `pg` will not warn

Both pool constructions pass a connection string and nothing else —
[server.ts:86](../apps/api/src/server.ts) (`max: 10`) and
[database.ts:328](../packages/storage/src/database.ts) (`max: 10` by default,
[chores-cli.ts:109](../apps/api/src/chores-cli.ts) overrides to 4). Against Compose that is correct;
against Supabase it needs deciding, and there is a trap: **when the URL carries `sslmode`,
node-postgres silently ignores the `ssl` options object.** A connection string ending
`?sslmode=require` therefore cannot be hardened later by adding `ssl: { ca, rejectUnauthorized:
true }` — the object is dropped, and nothing logs that it was.

The correct shape is a clean URL plus an explicit `ssl` object carrying Supabase's root CA, which
means `createDb` grows an `ssl` option and `server.ts`'s `Pool` takes the same. Small change, but it
is the difference between verified TLS and "it connected, so presumably it's encrypted."

### 4.3 Pool sizing meets Fluid compute

`max: 10` per pool was sized for a small fixed number of Fargate tasks. On Fluid compute the
instance count is elastic, each instance holds its own pool, and functions share a 1,024
file-descriptor ceiling across concurrent executions. Transaction mode absorbs a lot of this — that
is what it is for — but the pool max wants to come down (1–2) for the request path, and the
`api`-side number should be config, not a literal, so it can differ from the chore runner's 4.

### 4.4 The free plan is tight, in two specific ways

- **500 MB database.** §4.1's own estimate is "a few hundred MB at 90-day retention." That fits
  until it doesn't, and the failure is not graceful. Either run a shorter `RETENTION_DAYS` on Free
  or budget for Pro ($25/mo, 8 GB).
- **Free projects pause after 7 days of inactivity.** Any API request resets the clock, so a
  nightly chore keeps it awake — but this makes the chore schedule load-bearing for *availability*,
  not just for retention. Note the trap §9.1 already warns about: nothing in the app reports a chore
  that never ran. On Free, a schedule that quietly stops now also means a database that quietly
  pauses. Pro projects do not pause.

---

## 5. Redis: neither platform sells it, and BullMQ is the wrong shape for the ones that do

Redis has to come from the Vercel Marketplace (Upstash, Redis Cloud) or straight from a vendor.
Upstash is the default pairing and is a real option — its own docs confirm BullMQ works over the
Redis protocol — with one warning that matters here: **"BullMQ accesses Redis regularly, even when
there is no queue activity,"** so Upstash recommends a **Fixed** plan rather than pay-per-request.

That reprices things. The free tier is 256 MB / 500K commands per month — an idle BullMQ worker's
poll loop can consume that on its own, and this app is explicitly designed to be idle ("**0 when
idle**", §9.2). The first Fixed tier is **$10/mo for 250 MB**. So the *idle* cost of keeping BullMQ
is roughly the cost of the persistent api host in Plan B — which is a strong argument that if the
queue stays BullMQ, the consumer should stay in a process too.

What Redis is used for is otherwise unchanged and all of it is fine on a hosted Redis: the page
cache, the single-flight lock ([single-flight.ts](../apps/api/src/single-flight.ts)), the quota
counters and the per-topic daily cap. Every one of those degrades to "not held / miss" on failure by
design (§7.1, §11), so a vendor outage costs latency and quota, never correctness. Note that
`REDIS_URL` is required and *shape-validated* at boot ([index.ts:57](../packages/config/src/index.ts))
even for the chore runner, which touches no Redis at all ([chores.ts](../apps/api/src/chores.ts)
says so explicitly) — so a chores function still needs a well-formed value in its environment.

---

## 6. Scheduling the chores

The two passes are one-shot CLIs — `chores-cli.ts` reads `process.argv`, exits with EX_USAGE/EX_CONFIG
codes, and logs JSON lines. There is no HTTP surface, so **every serverless scheduling option needs
a route wrapper** that maps `?pass=retention|storylines` onto `runRetentionChore`/`runStorylinePass` and
returns the report the CLI currently prints. That is a small file, but it is a new entrypoint, and it
must build the same objects `wiring.ts` insists on — a route that constructs its own
`createLinkerConfig` differently judges Monday's groups by rules the live path never used.

Then there are two schedulers to choose between:

| | Vercel Cron | Supabase Cron (`pg_cron` + `pg_net`) |
|---|---|---|
| Precision | Hobby: **once per day, ±59 min**. Pro: per-minute. | Per-minute, on the free plan |
| Target | An HTTP route in the same project | Any HTTPS endpoint (`net.http_post`) |
| Ceiling | 100 jobs/project | ~200 req/s; responses kept 6h |
| Notes | Same function limits apply | Keeps the free project from pausing (§4.4) by definition |

Hobby's ±59 min is survivable for these two passes — the advisory keys are already separate
(`7226461502`/`7226461503`) precisely so an overrunning retention run cannot eat the storyline
pass's night — but it is not survivable for a queue drain (§3, option 2). **Supabase Cron is the
better fit on the free tier**: minute precision, no plan upgrade, and it doubles as the keep-alive.

**The duration ceiling is the real constraint.** Hobby caps a function at 300s, and there is no
raising it; Pro reaches 800s. The storyline pass ends in a label pass paced at `GEMINI_MAX_RPM=15`
— one call every ~4s minimum, plus model latency — so an unbounded night of labels exceeds 300s
long before it exceeds Gemini's quota. `--max-labels=N` has to become a *deployment* parameter, not
an operator's convenience flag, and the pass must be safe to resume across nights (it is: the label
pass is idempotent per storyline). Retention's prune is a bounded delete and should fit either way,
but it has not been measured at 90 days of corpus.

---

## 7. Smaller findings, each of which needs a decision

- **The per-IP rate limit stops meaning what §9.4 says it means.** `@fastify/rate-limit` is
  registered with in-process counters on purpose ([server.ts:106](../apps/api/src/server.ts) — "a
  Redis-held counter would add a shared failure mode to the request path"). With one Fargate task
  that reasoning holds. With elastic Fluid instances, the effective ceiling is
  `RATE_LIMIT_PER_MINUTE × instances`, and §9.4 leans on this limit as a budget guard against
  novel-fingerprint spam minting topics. The platform substitute is Vercel's WAF rate limiting
  (Pro), or the counter moves to Redis and accepts the coupling.
- **`TRUSTED_PROXY_HOPS` must become 1.** It defaults to 0 ([.env.example:100](../.env.example)),
  which is correct with nothing in front. On Vercel there is exactly one hop we operate, and the
  comment's own warning applies: over-counting trusts a client-supplied `X-Forwarded-For` entry and
  hands every caller an unlimited bucket.
- **`/metrics` becomes decorative.** `prom-client` counters are per-process
  ([server.ts:137](../apps/api/src/server.ts)); on ephemeral instances a scrape samples one random
  instance's life so far, and there is no stable scrape target to point Prometheus at. §12's
  observability story needs a push-based replacement or it needs dropping honestly.
- **Graceful SIGTERM drain becomes dead code** ([index.ts:29–56](../apps/api/src/index.ts)). Not
  harmful — it stays correct for Compose and for Plan B — but it stops being exercised.
- **pnpm 11 needs Corepack.** `packageManager: pnpm@11.20.0` is ahead of Vercel's supported table
  (which tops out at pnpm 10); the documented route is `ENABLE_EXPERIMENTAL_COREPACK=1`, after which
  Vercel reads `packageManager` from the root `package.json` and applies it across the monorepo.
- **Hobby is personal, non-commercial use only**, per Vercel's fair-use guidelines — fine for this
  project today, worth knowing before it is ever pointed at a domain that sells something.
- **Single region by default (`iad1`).** Fine, but the Supabase project should be in the same region
  or every query pays a cross-region round trip on a path that already has a 1200ms
  `SYNC_FILL_DEADLINE_MS` budget.

---

## 8. Cost, honestly

| | Plan A (all-in) | Plan B (split) |
|---|---|---|
| Vercel | $0 Hobby (4 CPU-hrs, 1M invocations, 100 GB transfer) — **but a queue drain needs Pro at $20/mo** unless Supabase Cron drives it | $0 Hobby (static `web` only) |
| Supabase | $0 Free (500 MB, 5 GB egress, pauses at 7d idle) → $25/mo Pro | same |
| Redis | $0 Upstash Free only if BullMQ is gone; $10/mo Fixed if it stays | $10/mo Upstash Fixed, or a container on the api host |
| api host | — | ~$5–10/mo (Fly.io, Railway, Render) |
| **Floor** | **$0** (Hobby + Free + QStash/Workflows, no BullMQ) | **~$5–10/mo** |
| **Realistic** | **$20–55/mo** | **$15–35/mo** |

Plan A's $0 floor is real but it is the floor of a *different application* — the one where §9.1's
queue is an HTTP push target and nothing runs unless a request or a cron says so. Plan A at $20/mo
(Pro, for the drain cron and the 800s ceiling) buys the least code change of the serverless options.

---

## 9. Recommendation

**Do the uncontroversial half now, and decide the consumer's fate separately.** Moving `web` to
Vercel and Postgres to Supabase is a small, reversible change that deletes the API-base-URL and CORS
divergences and gets the durable tier onto managed infrastructure with backups. It needs, and only
needs:

1. `DATABASE_SESSION_URL` alongside `DATABASE_URL`, with `migrate-cli.ts` and `chores-cli.ts`
   reading the session-mode one (§4.1).
2. An explicit `ssl` option on both pool constructions, and clean URLs with no `sslmode` (§4.2).
3. Configurable pool max, defaulting lower for the request path (§4.3).
4. `TRUSTED_PROXY_HOPS=1` and a same-origin `CORS_ORIGIN` (§7, §2).

Those four are worth doing under either plan, and none of them is a bet.

**Landed 2026-08-21.** 1–3 are in the code; 4 is documented rather than set, because
`TRUSTED_PROXY_HOPS=1` and a same-origin `CORS_ORIGIN` are *deployment* values and the local
template's `0` / `http://localhost:5173` stay correct for Compose — over-counting hops is precisely
the bug the setting exists to avoid, so it is the deploy that sets it, not the repo. What the code
now has:

- `DATABASE_SESSION_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL` and `DATABASE_CA_CERT` in
  [@zammy/config](../packages/config/src/index.ts), with a **refusal for any Postgres URL carrying
  `sslmode`/`sslnegotiation`** — the one config error that could not otherwise be seen, since
  node-postgres drops the `ssl` object without a word when the URL sets either.
- [`databaseSsl`](../packages/storage/src/database.ts) as the single translation from those settings
  to what `pg` gets handed, and an `ssl` option on `createDb`.
- [`createConfiguredDb`](../apps/api/src/wiring.ts) — the chore runner and all nine operator CLIs
  build their handle through one factory now, so TLS and the URL choice cannot differ per
  entrypoint. `session: true` is the chore runner's, and only the two callers holding a
  session-scoped lock may ask for it.
- [`migrate-cli`](../packages/storage/src/migrate-cli.ts) prefers `DATABASE_SESSION_URL` and prints
  which URL and which TLS mode it used; the chore runner logs the same before it takes its lock.

**Plan A is now scoped in full** in [VERCEL-ALL-IN-SCOPE.md](VERCEL-ALL-IN-SCOPE.md): 7–12 days,
with Vercel Queues' push mode turning §3's option 3 from a redesign into an implementation of the
existing interface — and one item this document missed, namely that §5.4's shared quota snapshot is
*designed and not built* ([quota.ts:104](../packages/news-client/src/quota.ts)), which elastic
instances make non-optional.

**For the api, Plan B is the recommendation** — a persistent host for `api` + consumer + Redis,
because that is the shape §4.1 designed for and it keeps at-least-once delivery, the bounded
consumer, the in-process rate limiter and the working `/metrics` without re-litigating any of them.
Choose Plan A instead if the actual goal is *no persistent infrastructure at all*; in that case the
honest scope is "replace the queue transport (§3 option 3) and add an HTTP entrypoint for the
chores (§6)", not "deploy the api to Vercel."

---

## 10. Open questions

1. **How long does `chores storylines` actually take** against 90 days of corpus, with
   `--max-labels` unbounded and bounded? Until that is measured, §6's 300s/800s ceilings are a guess
   about whether Hobby is even usable for the nightly pass.
2. **How large is the corpus at 90-day retention, really?** §4.1 says "a few hundred MB"; Supabase
   Free stops at 500 MB. One `pg_total_relation_size` sweep on the staging database settles whether
   Free is a starting point or a dead end.
3. **Does the breadth sample survive a serverless consumer?** §10.1's first-visitor lock elects one
   enqueuer per stale window; under Plan A's option 1 (`waitUntil`) the elected visitor's function
   pays for `SAMPLE_PAGES` upstream calls inside their own request budget. Worth checking against
   `SYNC_FILL_DEADLINE_MS` before assuming the landing page still paints.
4. **Where does the Currents/GNews quota governor live** if instances are ephemeral? The counters are
   in Redis and the daily ceiling is observed from upstream's `x-ratelimit-*` headers, so this is
   probably fine — but "probably" is doing work in a sentence about a 1000-call/day budget.

---

## Sources

- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations) — max duration, memory, bundle size, file descriptors
- [Vercel Fluid compute](https://vercel.com/docs/fluid-compute) — `waitUntil` background processing, instance sharing, per-plan defaults
- [Fastify on Vercel](https://vercel.com/docs/frameworks/backend/fastify) and [How to ship a Fastify app on Vercel](https://vercel.com/kb/guide/ship-a-fastify-app-on-vercel) — entrypoint detection, single-function model, cron guidance
- [Does Vercel support Docker deployments?](https://vercel.com/kb/guide/does-vercel-support-docker-deployments) — container functions are stateless, request-scoped, scale to zero; no always-on workers
- [Vercel Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) — Hobby once/day ±59 min, Pro per-minute
- [Vercel Limits](https://vercel.com/docs/limits) — Hobby included usage, log retention, Git-org restriction
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) — personal, non-commercial fair use
- [Vercel package managers](https://vercel.com/docs/package-managers) and [Improved support for pnpm, Corepack, and monorepos](https://vercel.com/changelog/improved-support-for-pnpm-corepack-and-monorepos) — `ENABLE_EXPERIMENTAL_COREPACK`
- [Supabase — Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) — direct vs session vs transaction mode, IPv4/IPv6, prepared statements, session-level features
- [Supavisor session-mode deprecation on 6543](https://supabase.com/changelog/32755-supabase-connection-pooler-deprecating-session-mode-on-port-6543-on-february-28) — session mode is port 5432
- [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase) and [Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) — Free limits, 7-day pause
- [Supabase Cron](https://supabase.com/blog/supabase-cron) and [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) — minute precision, HTTP request jobs, ~200 req/s
- [BullMQ with Upstash Redis](https://upstash.com/docs/redis/integrations/bullmq) — supported; idle polling drives command count, Fixed plan recommended
- [Upstash Redis pricing](https://upstash.com/pricing/redis) — Free 256 MB/500K commands, Fixed 250 MB at $10/mo
- [node-postgres SSL](https://node-postgres.com/features/ssl) and [issue #3355](https://github.com/brianc/node-postgres/issues/3355) — `sslmode` in the URL silently overrides the `ssl` object
