# Scope — going all in on Vercel

Companion to [RESEARCH-VERCEL-SUPABASE.md](RESEARCH-VERCEL-SUPABASE.md), which weighed Plan A (all
in on Vercel) against Plan B (a persistent host for the api) and recommended B. This document
priced A; on 2026-08-22 **Plan A was adopted**
([ADR-0015](adr/0015-all-in-on-vercel-hobby-shaped.md)), reversing that recommendation, and the
decisions from the adoption review are folded in below. Every codebase claim carries a file:line
from a sweep of `apps/api`, `packages/news-client` and the web client (re-verified 2026-08-22);
every platform claim carries a source at the bottom. Scoped 2026-08-21. **Phase 0 ran on
2026-08-22 and moved three of the numbers below — see
[VERCEL-PHASE-0-FINDINGS.md](VERCEL-PHASE-0-FINDINGS.md), and §3.3 and §9 for what it changed.
Its deployment half finished on 2026-08-23 (findings §8), which closed the last two open questions.
**Phases 1 and 2 are now deployed to preview and verified** (2026-08-24 and 2026-08-25); Phase 2's
one failure and its fix are Q0. Nothing is in production yet — that is Phase 5.
[deploy/vercel/](../deploy/vercel/) is the operator's half of it.**

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
| Ingest message TTL | `INGEST_RETENTION_SECONDS` (15 min) — 3 × the measured 300 s redelivery lease, with `STALE_PENDING_MS` raised to match so the ledger outlives the message. §0's "≈ `STALE_PENDING_MS` (5 min)" pinned the TTL to the lease and broke redelivery entirely | §3.2 |
| Cutover data | Production Supabase is **seeded from the dev corpus** (dump/restore, session pooler) | §9 Phase 5 |

---

## 1. Target topology

| Unit | Today (Compose) | All-in on Vercel |
| --- | --- | --- |
| `web` | Vite dev server | static build, same project, same origin |
| `api` HTTP surface | Fastify in a container | `api/index.ts` → the Fastify app as one Function, reached by rewrite (below) |
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
- `api/index.ts`: a module-scope singleton, `await app.ready()`, then hand the request to
  `app.server.emit("request", req, res)` — the standard Fastify-on-serverless pattern. Module scope
  is what makes the pool, the Redis client and the fixture store survive across invocations on a
  warm instance. (Scoped as `api/[...path].ts`; the spike found that filename is not a catch-all —
  the routing findings at the end of this section. The real file is `apps/api/src/vercel.ts`, with
  `api/index.ts` a three-line re-export, because nothing typechecks the repository root.)
- `apps/api/src/index.ts` stays exactly as it is. It is the Compose and Plan-B entrypoint, and
  `listen()` plus the SIGTERM drain remain correct there. Nothing about local development changes.

Watch items: cold-start cost of `buildApp` (Zod config parse, `createNewsClient`, route
registration) is unmeasured and sits in front of the first timeline read; `/healthz` and `/readyz`
live outside `/api` so they need two rewrites (`/metrics` also lived outside and would have been a
third — it is deleted instead, §7); and the 4.5 MB response cap is far above any timeline page but
worth knowing.

**The queue trigger fires.** `POST /api/queues/ingest 200` with `"spike": "consumer fired"` for every
message published, on a bare `api/` function in a Vite project — the combination no documentation
shows, and the one this whole plan rested on. Three details from the same log:

- **Push mode is air-gapped and deployment-partitioned, as documented.** Every consumer invocation
  arrived on the *deployment* host (`…-a7iv80q67-….vercel.app`) while the producer calls came in on
  the alias. That is §3.2's "queue topics are partitioned by deployment ID" observed rather than read.
- **A poisoned message is redelivered and then acknowledged away.** Four deliveries at +0 s, +10 s,
  +70 s, +130 s, then it stopped — the count matches the SDK `retry` handler's
  `deliveryCount > 3 → acknowledge`, so there is no infinite poison loop and no DLQ needed. The
  *timing* did not match the handler's `afterSeconds: 5`; treat the retry delay as a hint rather than
  a contract.
- **Dedup deduplicates DELIVERY, not publish.** Publishing twice with the same `idempotencyKey`
  returned two different `messageId`s — so publish is not idempotent and a `DuplicateMessageError` is
  not what a repeat looks like — but only **one** consumer invocation followed. For §3.2's purpose
  that is the property that matters, since BullMQ's `jobId` also prevents duplicate *processing*
  rather than duplicate enqueueing. Worth one more deliberate test before relying on it.

**Three things the spike settled about routing** (2026-08-22, `zammy-vercel-spike`):

- **`api/[...path].ts` is not a catch-all.** Vercel's bare `api/` directory parses the filename as
  ONE dynamic segment literally named `...path`, so `/api/healthz` and `/api/v1` reached the function
  while `/api/v1/echo` and anything deeper returned Vercel's own `NOT_FOUND` and never invoked it.
  Every real route here is `/api/v1/<something>`, so the layout as written would have 404ed all of
  them. **A `rewrites` rule is the catch-all the filename is not**, and it preserves the property
  this section depends on: a rewrite leaves the original path visible, measured —
  `/api/v1/echo/deep/path?q=1` arrives at Fastify as exactly that. §1.1's recommended layout stands;
  only the mechanism changes.
- **A *named* rewrite capture is appended to the query string.** `/api/v1/:path*` made Fastify see
  `...?q=1&path=echo%2Fdeep%2Fpath`. Harmless here, a latent collision in the real app — a route
  taking its own `path` query parameter would receive two. Use an unnamed group, `/api/v1/(.*)`.
- **`TRUSTED_PROXY_HOPS=1`.** With `trustProxy` off, Fastify reported `request.ip` as `127.0.0.1`
  with the real client in `x-forwarded-for` — exactly one hop in front. This is not a detail: §3.5's
  per-IP limit moves to Redis precisely because Hobby has no WAF, and a limiter keyed on
  `127.0.0.1` would put every visitor in one bucket.

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
| `jobId` content-dedup ([`ingestJobId`](../apps/api/src/ingest-queue.ts)) | `idempotencyKey` on `send` | Dedup window is the message TTL rather than "the pending window", and the TTL also bounds redelivery — so **publish with `retentionSeconds: 900`** (`INGEST_RETENTION_SECONDS`, 3 × the measured lease), not the 24h default and *not* the 300 s §0 chose here: 300 s equalled the lease and closed the retry window to zero. TTL is per-message (60s–7d). Billed at 2× the operation. |
| `attempts: 3`, exponential backoff from 200 ms | the SDK `retry` callback on `deliveryCount` | Forced exponential backoff after 32 attempts. No DLQ; a poisoned message is acknowledged in the handler. **Retry TIMING is not ours to set.** `retryAfterSeconds` *is* a documented `vercel.json` trigger option (default 60 s) — the earlier "Nitro-only" note here was wrong about that — but it is **measured inert**: a topic declared with `retryAfterSeconds: 20` redelivered at +305 s and +305 s, identical to one that omitted it. The `retry` callback's `afterSeconds` is not honoured for the first redelivery either. What governs it is the visibility lease (next row). |
| At-least-once via BLMOVE + reaper | at-least-once, **delivered by visibility-lease expiry at a measured +305 s** — not by the callback's response code | §4.1 called at-least-once a deployment requirement. It survives, but only if the message TTL outlives the lease: see the redelivery note below, which is what §10 question 0 turned out to be. The SDK's `visibilityTimeoutSeconds` governs lease EXTENSION while the handler runs, not the first lease, which is server-assigned. |
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

**What the implementation added to the seven members, and what it kept.** Three notes from the
build (2026-08-25), none of which changed the shape above:

- **`IngestQueue` became an interface with two implementations, not one replacement.** BullMQ stays
  as the Compose driver, chosen by `INGEST_QUEUE_DRIVER` (default `bullmq`). The reason is the loss
  of test power this section already records: `ingest-queue-bullmq.test.ts` still asserts real dedup
  and real redelivery against a real Redis, so the semantics stay pinned on the deployment that can
  pin them, and local development keeps a queue a single `pnpm dev` can both serve and drain. The
  hosted driver's suite is what this section predicted — pure parts asserted directly, pending-set
  arithmetic against Redis, transport faked.
- **An eighth member, `settle`.** BullMQ cleared a pending entry from its own worker events because
  the worker was in this process. A push-mode consumer is a different deployable and has to be told,
  so the counterpart to enqueue is now on the interface rather than hidden inside one driver.
- **A failed delivery IS redelivered — once the message outlives its lease. Fixed 2026-08-25.** For
  three days this section recorded that redelivery simply did not happen, on the strength of two
  measurements against a poisoned message that was each delivered exactly once. Both measurements
  were real; the explanation was wrong. The cause is a platform timing change interacting with a
  margin we did not know we were relying on — and the fix is entirely on our side.

  **The mechanism.** A failed delivery comes back when its **visibility lease expires**, and that
  lease is assigned by the queue service before any of our code runs — it arrives in the
  `ce-vqsvisibilitydeadline` header at exactly **300 s** past `ce-vqscreatedat`. So the first
  redelivery lands at **+305 s**, every time. Nothing on our side moves it: the callback's response
  code does not (500 and 200 behave identically), `retryAfterSeconds` in `vercel.json` does not
  (measured inert), and the SDK's `visibilityTimeoutSeconds` does not (it governs lease *extension*).

  **The collision.** §0 decided the message TTL should be `≈ STALE_PENDING_MS` so the dedup window
  would match the pending-set semantics, and the driver published with `retentionSeconds: 300`. The
  platform "permanently deletes messages when their retention period expires, regardless of
  processing state". A 300 s TTL against a 305 s first redelivery therefore left a retry window of
  **exactly zero** — the message was garbage-collected five seconds before it was due back.

  **And the 305 s is new.** This is the half that is not our fault and the half worth watching. On
  2026-08-22 the spike measured a poisoned message redelivering at +0 s, +10 s, +70 s and +130 s —
  four deliveries inside the same 300 s TTL, which is only possible if the first-retry latency was
  then ~10 s. Today, on that same project and that same unmodified deployment, it is 305 s. So
  §0's TTL was not a mistake when it was made: it had a 30× margin over the redelivery latency of
  the day. The platform's first-retry latency grew by a factor of ~30 underneath it, the margin went
  negative, and redelivery stopped. Vercel's docs still say the visibility timeout defaults to 60 s;
  in push mode on this account it is 300 s, so the number that moved is not one we can cite, only
  one we can measure.

  **Which makes the shape of the fix matter more than its value.** 900 s is not "300 plus headroom",
  it is `MAX_INGEST_DELIVERIES` × the *measured* lease — but it is still a constant chasing a
  platform number that has already moved once. If the lease grows past 300 s again the same failure
  returns, silently and in exactly the same way. **That is an argument for building §3.2's manual
  drain rather than holding it as a fallback**, and for treating "`deliveryCount` never exceeds 1"
  as a tripwire worth checking after any Queues change, not as a settled fact.

  **The controlled measurement (2026-08-25, five topics, two deployments).** Every probe threw on
  every delivery; only the marked variables differed.

  | Retention | `retryAfterSeconds` | Deliveries | Gaps |
  |---|---|---|---|
  | 900 s | default | 3 | 305 s, 305 s |
  | 900 s | default (+ SDK `retry` callback) | 11 | 305 s, then 60 s × 9 |
  | 900 s | default (+ SDK `visibilityTimeoutSeconds: 30`) | 11 | 305 s, then 60 s × 9 |
  | 900 s | **20** | 3 | 305 s, 305 s |
  | **300 s** | 20 | **1** | never |

  The last row is production, reproduced exactly. The row above it is the same wiring with only the
  TTL changed, and it redelivers. That is the whole finding.

  **Confirmed on the `zammy` project itself, 2026-08-25 20:01–20:12 UTC.** The probes above ran on
  the throwaway spike project, so the A/B was repeated on a real preview deployment of this
  codebase — the real consumer, the real Supabase and Upstash, a well-formed segment job naming a
  fingerprint no topic row has (so `parseIngestJob` accepts it and `processSegmentJob` throws
  "segment job for unknown topic" every time):

  | Arm | Retention | Deliveries | Log |
  |---|---|---|---|
  | A | **300 s** (the old value) | **1** — `dc=1` 20:01:39, HTTP 500, then the message expired | one `ingest delivery` |
  | B | **900 s** (the fix) | **3** — `dc=1` 20:01:41, `dc=2` 20:06:46 (+305 s), `dc=3` 20:11:51 (+305 s) | three `ingest delivery`, then `ingest job failed every delivery; giving up` at HTTP 200 |

  Arm B is the first time `deliveryCount` has been observed above 1 on this project, and the first
  time `MAX_INGEST_DELIVERIES` and the give-up-and-settle path have been exercised outside a fake —
  the third delivery settled the pending entry and acknowledged the message, exactly as
  [vercel-queue.ts](../apps/api/src/vercel-queue.ts) says it should. Arm A reproduces the reported
  symptom on the same deployment in the same minute, which is what makes the TTL the cause rather
  than a correlate.

  **The fix is one constant**, `INGEST_RETENTION_SECONDS` = `MAX_INGEST_DELIVERIES` × the 300 s lease
  = 900 s ([ingest-queue-vercel.ts](../apps/api/src/ingest-queue-vercel.ts)). No consumer code
  changed: `shouldRetryDelivery` and the give-up-and-settle path were already correct and are now
  genuinely exercised, with a poisoned job delivered at +0 s, +305 s and +610 s and the third
  settling. **At-least-once is being met on the primary path**, which is what §4.1 asked for.

  **Three things this cost, all of which should be read as cost rather than as footnote:**

  - **The dedup window widened from 300 s to 900 s**, because on this platform the TTL *is* the
    dedup window. A job that exhausts its three attempts cannot be re-enqueued under the same
    content key for up to 15 minutes, where §0's choice would have freed it in 5. The trade is
    deliberate — it buys the primary path at the price of slowing the fallback — but it is a real
    regression in the fallback, and it is the half of §0's reasoning that this change discards.
  - **The retry budget is only guaranteed for a job that fails FAST.** A job that fails slowly
    spends its lease being extended rather than expiring, so its attempts are pushed out and the
    budget can be truncated by the TTL instead of by `shouldRetryDelivery`. A job whose every
    attempt burns 300 s gets two, not three.
  - **`STALE_PENDING_MS` expired while a retry was still owed — resolved the same day by raising it
    to 900 s.** The stale prune fired at 5 minutes and attempt 2 did not arrive until 5 minutes and
    5 seconds, so a pending entry was deleted as crashed-consumer residue 5 s before the queue
    retried the job it named. It is now `INGEST_RETENTION_SECONDS`, so the ledger outlives the
    message it describes; `ingest-queue-vercel.test.ts` pins the inequality, since `ingest-queue.ts`
    cannot import the driver to write it as an expression.

    **Two things in the first reading of this were wrong, and both are worth recording**, because
    together they are what made it look deferrable:

    - *"The client stops polling early."* It does not, and cannot: `INGEST_POLL_MAX` gives the web
      client 40 polls at 1.5 s, so it stops asking after ~60 s — 240 s before the prune could fire.
      The poll loop is structurally incapable of observing this race. What observed it was
      [`timeline-service`](../apps/api/src/timeline-service.ts)'s cache gate, which writes only a
      `complete` page: a pruned count reads `complete`, so **an incomplete page was cached as
      settled — up to 24 h on the historical freshness tier.**
    - *"Under-reporting is the fail-open direction, as in §3.4 and §3.5."* Not here. Those degrade
      toward *answering with less*. This degrades toward *persisting something untrue*.
      `pendingJobs > 0` can only suppress a cache write and hold `in_progress` longer — latency and
      quota, never a wrong answer; `pendingJobs == 0` with work still owed writes the wrong answer
      into Redis. Over-reporting is the safe side of this particular number, which is why it went up.

    The cost accepted: a genuinely crashed consumer holds a topic at `in_progress` for 15 minutes
    rather than 5. It stayed one shared constant rather than becoming per-driver — BullMQ's retry
    budget is ~600 ms, so 15 minutes is far past what that transport needs — because under BullMQ
    this window is pure crashed-consumer GC, and a crashed consumer costs deploy-recycle time, the
    same wall clock under both transports.

  **What was wrong in the earlier diagnosis, for the record.** The two original measurements were
  right; the inferences drawn from them were not. `changeVisibility` "succeeding" was read as proof
  the queue had been told to redeliver — it had, but a lease reduction does not shorten the first
  window. The spike's contrasting four-delivery run was read as a **per-project** difference; it was
  a **per-date** one, and re-running that same unmodified deployment on 2026-08-25 produced exactly
  one delivery. That single re-run is what collapsed the whole question, and it cost one `curl`: the
  discriminator between "this project is wired wrong" and "the platform moved" was available the
  whole time and was never run, because the spike was believed to be a control when it was really
  the only other data point. The lesson worth keeping is that the 300 s in `retentionSeconds` and the
  300 s in the lease were never compared — one was a decision, the other was never measured.

- **The pending set is best-effort under the hosted driver, and could not have been under BullMQ.**
  There, Redis *was* the queue, so a Redis outage failed the enqueue and there was nothing finer to
  say. Here the message is already durable in the topic and the pending set is a progress hint — so
  a ledger operation that fails is logged and the read still answers, rather than 500ing. That is
  the same direction §3.4 and §3.5 take.

  **But it applies to reads only, and treating a lost WRITE the same way was a real hazard**
  (fixed 2026-08-25). An enqueue is two operations that do not fail together: the publish is durable
  and throws, the ledger `ZADD` is swallowed. A Redis blip lasting one command therefore left work
  genuinely owed with nothing recording it — and the cost was not the under-reported spinner the
  comment claimed. `pendingCount` would answer a clean `0` from a **healthy** Redis, so
  `timeline-service` read `complete` and its cache gate wrote a page missing the segment that job was
  about to fetch: up to 24 h on the historical freshness tier, with nothing in `degraded` to explain
  it and the blip long over. Nor did it need a full outage — `server.ts`'s cache client sets
  `enableOfflineQueue: false` and the queue's client does not, so the two fail independently per
  command.

  `VercelIngestQueue` now remembers lost ledger writes in memory and adds them back to every count,
  expiring them on `STALE_PENDING_MS` — the same clock the ZSET member would have been pruned on. It
  works because the read that caches is usually the read that enqueued (`timeline-service` plans,
  enqueues, counts and caches in one request), so the instance holding the note is the instance about
  to make the mistake. **The residual, asserted in the tests rather than left as prose:** a
  *different* instance serving that read still sees the honest-looking `0`. Nothing local can fix
  that and there is nowhere durable to put the note, since Redis is what refused it — so that case
  stays as it was, bounded by `STALE_PENDING_MS`.

**The beta is accepted, and the named fallback is now BUILT (§0, ADR-0015).** The pending set is our
own at-least-once ledger: if the `queue/v2beta` trigger regresses, `meta.ingest` keeps reporting what
is owed, and the drain performs the fills inline. It shipped as `POST /api/drain`
([drain.ts](../apps/api/src/drain.ts)) — a route **beside** the chores rather than a pass inside
them, because [chores.ts](../apps/api/src/chores.ts) holds "no pass touches Redis" as a property and
`ChoreDeps` has no client to give one, while the drain is nothing but a Redis read followed by
upstream fills. [docs/chores.md](chores.md) is the operator's map of both.

Two properties of it are worth stating here because they are what keep a fallback from being worse
than no fallback. It only touches entries older than `INGEST_RETENTION_SECONDS`, so it can never
fill a segment the platform is still retrying and double-spend the quota. And it settles a failed
fill anyway — one attempt per entry — because there is no dead-letter queue and an entry left in the
ledger would be re-filled on every pass forever. What that costs is nothing observable: the entry is
already past the TTL, so the next `meta.ingest` read would have pruned it as stale residue.

It also turns out to cover exactly the case incidental recovery does not. The stale prune lives
inside `PendingSet.count` and therefore fires on read, so a topic with traffic erases its own ledger
within fifteen minutes while a topic with none keeps its entries indefinitely — leaving the drain
blind to hot topics and sighted for cold ones, which is the right way round, since hot topics are
where the next reader re-plans the gap immediately. Fifteen, not five: while the prune fired at 5
minutes it erased a read topic's entries *before* `DRAIN_MIN_AGE_MS` (900 s) would let this route
touch them, so the drain was blind to hot topics for a second and accidental reason on top of the
deliberate one. `drain.test.ts` now pins `STALE_PENDING_MS >= DRAIN_MIN_AGE_MS`. If the trigger is withdrawn entirely, the exits are a cron-driven pull
drain (Pro) or the two-project layout — both worse than what §4.1 asked for, which is the bet the
ADR records.

**The 2026-08-25 redelivery episode is the first time that bet was called, and it is worth reading as
evidence rather than as a scare.** The pending set did its job: nothing was lost that a later read
could not re-plan. But the failure was invisible for three days, it was caused by a platform number
changing rather than by anything in the changelog, and the thing that would have caught it early —
noticing `deliveryCount` never exceeded 1 — was recorded as a curiosity rather than as an alarm. The
`STALE_PENDING_MS` misalignment above was the same class of problem one layer in: a constant that
agreed with another constant, which had itself stopped agreeing with the platform. That is what
moved the manual drain from "fallback" to **built** (`POST /api/drain`, §3.2); §10 Q0 records the
argument.

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
  is a Phase 4 exit criterion. **Measured on the spike: 669 ms cold, 225 ms warm**, for a route with
  no `buildApp` behind it — so the default 2 s is not comfortably clear of the real one, which
  carries a ~360 ms local boot on top of a ~550 ms platform floor (findings §7.1, §8).
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
  **And it is not a deployment problem at all — it is off** (findings §2.5, §2.6). `CANDIDATE_LIMIT`
  binds on 12,266 of 12,366 window groups, discarding ~90% of the candidate set by recency, while the
  replay that pinned the linking thresholds has no cap: production ran a capped decision against
  thresholds certified uncapped. Correcting the retrieval is free and lossless, and it went to the
  *birth* path — **and as of 2026-08-23 that correction is gated too and off by default**
  (`STORYLINE_NARROW_RETRIEVAL`), because the replay that said the birth path was safe was not
  modelling the merge (findings §2.5) — but running the corrected sweep over the full window is a
  **runaway**, 124 → 1,347
  groups in one arc across four passes, because the 200-row cap had been doing the bounding K=2 was
  believed to be doing. **So the sweep is gated off** (`STORYLINE_LATE_CANDIDATE_SWEEP=false`),
  blocked on re-measuring K, and `--late-candidates` runs it deliberately. Both a changed-set filter
  and a joined-group re-offer were built and are also off by default; the filter measurably makes the
  runaway *worse*. **Phase 4 therefore inherits no sweep.** With that phase switched off the
  storyline pass fits 300 s with room to spare — every remaining phase is sub-second bar a bounded
  label pass. What Phase 4 keeps is only the `REINDEX CONCURRENTLY` sweep and the ordinary chore
  wiring; the bound and cursor become a safety valve for whenever the sweep is switched back on,
  worth building then rather than now. A denormalized sort key was tested and rejected at 8% (§2.2).
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
  per-PR CI step (§6) — **not yet built**; the first pass was run by hand from a laptop
  (2026-08-24), all 17 migrations through the session pooler under `verify-full` in 8.2 s.
- **The preview pair is provisioned** (2026-08-24): a Supabase project in `us-east-2` and an
  Upstash database, wired to the `zammy` project's Preview environment. Twelve variables, not
  66 — `@zammy/config` defaults everything except `DATABASE_URL`, `REDIS_URL` and
  `CURRENTS_USER_AGENT`, and hand-setting the other 55 is 55 chances at the typo that boots
  green. Two shapes bite here and both cost a deploy cycle: `REDIS_URL` must be `rediss://`
  (Upstash is TLS-only, and a plaintext URL validates and boots before failing at `/readyz`),
  and any `?sslmode=` Supabase appends must be stripped, because `@zammy/config` refuses a
  Postgres URL carrying one — node-postgres silently ignores `DATABASE_SSL` when the URL sets
  it. Note Vercel Hobby deploys to `iad1` (us-east-1) while the database is us-east-2, so every
  pooler query takes a cross-region hop. See §9's Phase 1 notes.
- **`TRUSTED_PROXY_HOPS=1`** for the single-project layout (2 for the two-project one), and
  `CORS_ORIGIN` set to the deployment origin. Both are documented in the template already; the
  deploy sets them. `CORS_ORIGIN` is the awkward one on previews: the origin does not exist
  until the deployment does, and every redeploy mints a new hostname, so a CLI-deployed preview
  has nothing stable to point at and was left at the template default. Git-linked previews get
  a branch alias (`zammy-git-<branch>-<scope>.vercel.app`) which is the value to use.
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
- **The Queues line is available but still unpublished.** Availability is now measured rather than
  read: the spike account is on the `hobby` plan (`/v2/user` reports `billing.plan: "hobby"`), and
  on it a topic was created, published to, and consumed — so a Hobby project can do the thing §8's
  $0 column needs. What remains undocumented is the *allowance*: the pricing page lists the five
  operation types and 4 KiB metering, then defers included usage to the plan pages, and the Hobby
  included-usage table still has no Queues row while listing Workflows (built on Queues) at 50,000
  events/month. So the risk moved from "this may be impossible" to "this may start billing", which
  is a much smaller one and is watched rather than resolved (§10, question 2).

---

## 9. Phases

Each phase ends with something demonstrable; none of them is "and then we cut over and hope".

| Phase | Work | Exit criterion |
|---|---|---|
| **0. Spikes** (0.5–1 d) ✅ | Prove the project shape (§1.1) on a throwaway deployment: Vite preset + `api/` function + a `queue/v2beta` trigger firing. Measure `buildApp` cold start. Measure `chores storylines` wall-clock at 90 days of corpus, bounded and unbounded. Measure the corpus against Supabase's 500 MB — a **now**-question, since production is seeded from it (Phase 5). Confirm Queues' Hobby allowance in the dashboard (§8). | **Done, both halves.** The three numbers ([VERCEL-PHASE-0-FINDINGS.md](VERCEL-PHASE-0-FINDINGS.md)): cold start ~360 ms local, 947 ms on the platform of which ~550 ms is container start (§7.1); `chores storylines` ~3.5 h unbounded, with the **late-candidate sweep at ~506 s the phase that breaks the ceiling** — since found to be a linking bug and gated off; corpus 190 MB with the 500 MB tripwire at ~1,485 articles/day after a reindex. The deployment half (findings §8): the Vite preset builds the SPA and the `api/` directory together, the `queue/v2beta` trigger fires on a bare `api/` function **on a Hobby account**, `waitUntil` outlives the 202, and the cron entry validates. The rewrite correction (§3.1) is the one thing it changed structurally. |
| **1. The api as a Function** (1–2 d) ✅ | §3.1. Consumer disabled, chores still manual. Preview in fixture mode against the preview data plane (§4). | **Done, deployed and verified 2026-08-24** (commit `8be3fa9`). `/readyz` returns `{"status":"ready"}` with `postgres.ok` and `redis.ok` both true. The three halves only a deploy could exercise all came back: **Supabase through the transaction pooler** — a `/api/v1/timeline` read whose `servedFrom` moves `upstream` → `store` across polls, so the rows were written and read back through 6543; **Upstash** — reachable, after the scheme fix below; **`includeFiles` does place `fixtures/`** — a fresh topic answers `servedFrom: "upstream"` with recorded fixture content, and an absent directory would have failed the boot into a 503 instead. Cold start **993 ms**, warm 190–298 ms — close to Phase 0's 947 ms on the platform (§7.1). All 17 migrations applied through the session pooler under `verify-full` in 8.2 s. **One third of the criterion as written was unreachable and is struck** — `degraded: "ingest_timeout"`, see below. |
| **2. The queue** (2–3 d) ✅ | §3.2 — new `IngestQueue` implementation (eight members counting `settle`), `api/queues/ingest.ts`, a **900 s** message TTL (not the 5 min §0 planned — see Q0), rewritten tests, and `POST /api/drain`. | **All three criteria met, deployed and verified 2026-08-25.** A cold topic fills behind the reader; `meta.ingest` drains to zero — a delivery logs `ingest delivery` then `ingest job settled` for one message id, which is the evidence, not the 200; and **a failed delivery now redelivers** at +0 s, +305 s and +610 s, the third settling and giving up. Getting the third took a day: it failed first, and the cause was a 300 s TTL colliding with a 305 s visibility lease (Q0). Two things this phase added beyond its scope, both because the failure showed they were needed: per-delivery logging, and the manual drain promoted from fallback to built. **The drain has never run against a live deployment** — its logic is unit-tested only. |
| **3. Quota + limits** (1–2 d) | §3.4 (burst-only, fail-open) and §3.5 (Redis store, fail-open). | The burst ceiling holds with the consumer and the request path both running; the per-IP guard is real; both degrade to in-process when Redis is down |
| **4. Chores** (1–1.5 d) | §3.3 + Supabase Cron + `chore_runs` + the keep-alive ping, **plus what Phase 0 added**: the `REINDEX CONCURRENTLY` sweep in the retention chore. The late-candidate sweep is gated off (findings §2.6), so this phase no longer carries a deadline problem; if it is ever switched back on, the bound and persisted cursor come back with it. | All scheduled passes run on schedule and write `chore_runs` rows, any pass runs on demand by query param, twice-triggered runs skip on the lock, the 202 arrives from cold within pg_net's configured timeout, **and a gated night reports `skipped: true` rather than a clean `offered: 0`** |
| **5. Observability + cutover** (1–2 d) | The migration CI jobs (§6, prod + preview), env vars (§4), **seed production from the dev corpus** (a 24 MB `pg_dump -Fc`, measured at 1.9 s out and 1.1 s in — findings §4), DNS. Drain the 2,981-storyline label backlog first (§3.3). | Production traffic against the seeded corpus, and "did last night's chores run?" is answered by a `chore_runs` query |

**Total: 7–13 days.** Phase 0's measurements added the reindex sweep to Phase 4 and took the
late-candidate sweep's deadline problem out of the plan altogether — it was a linking bug, its fix
exposed a runaway, and the pass is now gated off (findings §2.6). Phase 0's deployment half and
Phase 1 have both since run and neither moved the estimate; the remaining spread is Phase 2.

### Phase 2 as it stands

**Done and deployed to preview; not in production.** All three exit criteria are met (§9's table).
The queue publishes, drains and — after a same-day fix — redelivers. Two things were added beyond
the phase's scope because the redelivery failure showed they were needed: **per-delivery logging**
(without it a consumer 200 is unreadable) and **`POST /api/drain`**, promoted from §3.2's named
fallback to built code.

**What is not verified:** the drain has never run against a live deployment — ten unit tests, no
real Redis `SCAN` and no real fill. `?limit=1` exists for a cautious first pass. And **production
carries none of this**: no seeded corpus, no `INGEST_QUEUE_DRIVER` on the production environment,
no cutover. That is Phase 5.

**The standing tripwire:** the 900 s TTL is sized against a platform latency that has already moved
30× once (Q0). If the visibility lease passes 900 s, redelivery breaks again, silently and
identically. The signal is `deliveryCount` never exceeding 1 in the consumer's logs — worth checking
after any Queues change.

### What the Phase 2 deploy proved, and what it did not

**The trigger fires against the real app.** `queue/v2beta` on `api/queues/ingest.ts` was the piece
the whole plan turned on, and it works outside the spike: the request function publishes, the
consumer drains, and `meta.ingest` reaches zero. `vercel build` puts the trigger in
`.vercel/output` with the topic and an auto-derived consumer group
(`api_Squeues_Singest_Dts`), which is the cheapest place to check the wiring before deploying.

**"Drained" needs a topic that has gone quiet, and this is easy to misread as a stall.** A topic
being actively polled sits at `pendingJobs: 1` indefinitely, because §6.4's refresh-on-read enqueues
a fresh top-up whenever `coverage.to` trails `now` — and the consumer advancing coverage is exactly
what makes the *next* read find a new sliver. That is the design working, not a queue that will not
empty. The witness has to be a topic whose read is served from cache: `?q=wildfire` went 1 → 0 and
stayed 0 across five polls, while `?q=climate` oscillated at 1 the whole time.

**`/readyz` reads `degraded` on the first cold request even when `REDIS_URL` is correct.** The
error is `"Stream isn't writeable and enableOfflineQueue options is false"` — the *same string* the
Phase 1 notes below record as the symptom of a `redis://` URL, because the lazy connect simply has
not finished when the health check probes (Upstash handshakes in ~800 ms). Every subsequent request
reads `ready`. **So one `degraded` immediately after a deploy proves nothing**; re-probe before
concluding the scheme is wrong.

**Redelivery on failure was then tested deliberately, failed, and was fixed the same day.** A
throwaway deployment carrying a publisher for a poisoned segment job — a well-formed payload naming
a fingerprint nothing had upserted, so `processSegmentJob` fails on every delivery — produced
exactly one delivery under both callback shapes. The first reading of that was **wrong in an
instructive way**: it was recorded here as "the beta risk ADR-0015 accepted, arriving", i.e. a
platform fault we would have to live behind the pending set. It was a one-constant bug in our own
driver (Q0). Both experiments had held the TTL fixed at the value that *was* the bug, so neither
could see it; what exposed it was re-running the **spike's own unmodified deployment**, which
redelivered four times three days earlier and once that day. The lesson worth keeping is the
control, not the constant: when two variants of your own code both fail, the next move is the
untouched baseline, not a third variant.

**A 200 from the consumer never meant "success", and the logging now says which it was.** The SDK
answers 200 for a success, for a message it rescheduled after a throw, AND for one given up on — so
the earlier reading of "six 200s, zero warnings" as six successes was under-evidenced. The consumer
now logs one `ingest delivery` line per delivery (with `deliveryCount`) and an `ingest job settled`
line on the success path. On Hobby that log is the only observability the queue has, `/metrics`
being deleted and `chore_runs` covering only the chores.

**Q3 could not be exercised on the day**, for two compounding reasons worth separating: nothing
drained the queue yet, and `SAMPLE_REFRESH_MINUTES` elects one enqueuer per language with a
`SET NX PX` lock whose TTL is 60 minutes, which was already held. Waiting the lock out is the only
lever from here — `vercel env pull` redacts sensitive values, so the preview Redis URL is not
recoverable from the CLI and the lock cannot be cleared directly. Both blockers cleared later the
same day; **Q3 is now half answered** and §10 carries the measurement.

### What the Phase 1 deploy corrected

**`degraded: "ingest_timeout"` cannot happen, and is no longer this phase's criterion.**
`DegradedReason` in `packages/shared/src/timeline.ts` lists it, but
`apps/api/src/timeline-service.ts` narrows its own `meta.degraded` to `"quota" | "upstream" | null`
and the sole assignment sets only `quota` (on `NewsQuotaError`) or `upstream`. The string survives
in the shared union and in a comment at `apps/api/src/server.ts`. What it was pointing at is real
and is observable elsewhere: a cold `?q=climate` sat at
`meta.ingest = {state: "in_progress", pendingJobs: 1}` across four polls and never drained — which
is what Phase 2's criterion already measures. The signal needs a topic that **defers** a segment;
`?q=elections` filled synchronously from fixtures and reported
`{state: "complete", pendingJobs: 0}`, showing nothing at all. `"ingest_timeout"` was deleted from
`DegradedReason` on 2026-08-25; judge the undrained queue on `meta.ingest`.

**`REDIS_URL` must be `rediss://`.** Upstash is TLS-only, and a `redis://` URL is the worst shape of
wrong: it passes `@zammy/config`'s `RedisUrl` check (a scheme of redis/rediss plus a host is all
that is verified), boots green, and surfaces only as `/readyz` → `degraded` carrying
`"Stream isn't writeable and enableOfflineQueue options is false"`. Measured: `rediss://` PINGs in
797 ms, `redis://` never connects.

**CLI deploys are blocked by the git commit author, and the CLI will not say so.** Every remote
build from a repository worktree returns `readyState: BLOCKED` with
`seatBlock.blockCode = TEAM_ACCESS_REQUIRED`, because Vercel stamps the deployment with the commit
author rather than the account that owns the project. `vercel ls` renders this as `UNKNOWN`,
`vercel inspect --logs` prints nothing, and `vercel deploy` itself sat on `Building…` for **3 h
20 m** before exiting **0** with `"reason": "deploy_failed", "message": "fetch failed"`. The cause
appears only in `GET /v13/deployments/{id}` → `readyStateReason`. Deploying from a copy of the
tree with `.git` excluded clears it. **This lands on Phase 5**, whose migration CI jobs deploy
the same way: give that step an explicit timeout and assert `readyState == "READY"` against the
API, because the CLI's exit code is not a signal.

**Preview URLs are SSO-gated** (`ssoProtection: all_except_custom_domains`), so plain `curl` 302s to
`vercel.com/sso-api` and never reaches the app — a redirect that reads like an app bug.
`vercel curl <url>` authenticates through the CLI session and needs neither a settings change nor a
bypass secret; curl's own flags need a `--` separator or they are swallowed.

---

## 10. Open questions

Two were settled by the adoption review (§0, ADR-0015), two by the Phase 0 measurements
(2026-08-22) and two more by its deployment half (2026-08-23), all in
[VERCEL-PHASE-0-FINDINGS.md](VERCEL-PHASE-0-FINDINGS.md), and Q0 by measurement on 2026-08-25.
**One remains, and it is now half answered** — Q3, whose queue-shaped half the Phase 2 fix let us
measure and whose remaining half is blocked on something that is not the queue.

**The `Qn` labels are stable identifiers, not list positions, and they are written out for a
reason.** These were an ordered list until 2026-08-25, which Markdown renumbers from 1 regardless of
the digits in the source — so once Q0 was inserted in the middle, the item *written* `4.` *rendered*
as the fifth, and "question 4" meant two different things depending on whether you were reading the
source or the page. That had already caused one stale cross-reference (PHASE-0-FINDINGS §5's
"question 3" means Q5, the corpus one, under the older numbering). Numbers are never reused or
reassigned; new questions take the next free one.

- **Q0.** ~~Why does a failed delivery never come back?~~ **Settled 2026-08-25: a platform timing
  change ate a margin we did not know we depended on.** Not a per-project difference and not an
  unstated push-mode semantic. A failed delivery returns when its visibility lease expires, and that
  latency **grew from ~10 s to 305 s between 2026-08-22 and 2026-08-25** — measured on the spike's
  own unmodified deployment, which redelivered four times on the first date and once on the second.
  The driver published with `retentionSeconds: 300` (§0's "TTL ≈ `STALE_PENDING_MS`"), which had a
  30× margin when it was chosen and went negative when the latency moved; the platform deletes on
  TTL regardless of processing state, so the retry window became **exactly zero**. Raising the TTL
  to 900 s restores redelivery with no consumer change — a controlled A/B differing only in the TTL
  gave 1 delivery at 300 s and 3 at 900 s — run on the throwaway spike project and then **confirmed
  on a real `zammy` preview deployment**, where arm B delivered at +0 s, +305 s and +610 s and the
  third settled and gave up (§3.2 has both tables). **At-least-once is now met on the primary
  path**, measured on the deployable rather than inferred from a probe.

  Two things this leaves open and one it closed, all recorded in §3.2. Open: the dedup window is now
  900 s rather than 300 s; and **the fix is a constant chasing a platform number that has already
  moved once** — which is why the manual drain is now built (`POST /api/drain`, §3.2) rather than
  held as a fallback. Closed the same day: the TTL change had left `STALE_PENDING_MS` pruning at
  300 s while attempt 2 landed at 305 s, so the ledger was deleting work the queue still intended to
  deliver; it was raised to 900 s so the ledger outlives the message.

- **Q1.** ~~Does the recommended project shape actually work?~~ **Settled: yes, with one
  correction.** The Vite preset builds the SPA and the `api/` directory together, the function
  serves, and the `queue/v2beta` trigger fires on it. The correction is that `api/[...path].ts` is
  not a catch-all — routing is three rewrites in `vercel.json` (§3.1) — and the two-project fallback
  was not needed. `TRUSTED_PROXY_HOPS=1`.

- **Q2.** ~~Is Queues available on Hobby, and at what allowance?~~ **Available: settled by
  measurement** on a `hobby`-plan account. **The allowance is still unpublished** (§8), so the
  residual risk is metering rather than feasibility — worth watching on the first bill after Phase
  2, not worth blocking on.

- **Q3.** **Does the breadth sample still paint? Half answered 2026-08-25; the open half is not
  about the queue.** §10.1's first-visitor lock elects one enqueuer per stale window, and the worry
  was that with the sample now a queue message the landing page's first visitor waits for a consumer
  round trip rather than an in-process job.

  **The round trip is not the problem.** Measured on preview `zammy-jf76lc9bn` once the queue fix
  landed: a cold `/api/v1/trending` elected the enqueuer and reported `pendingJobs: 1`, and the next
  poll — under 8 s later — read `complete` / `pendingJobs: 0`. The sample is taken well inside any
  plausible page-load patience, so the deferral this question was raised about does not bite. It
  could not be measured before Phase 2 for two compounding reasons: nothing drained the queue, and
  the `SET NX PX` election lock had to expire first.

  **What is still unanswered is whether the CLOUD fills, and the blocker is the labeller.** `terms`
  stayed `0` across every poll, and that is upstream of everything here:
  [trending-storylines.ts](../packages/storage/src/trending-storylines.ts) selects `where s.label is
  not null`, and the preview corpus holds **61 storylines with 0 labels** (64 articles, 7 topics).
  Labels come from the Gemini labelling chore, which has never run against preview — so the cloud
  reads empty however well the sample works, and a test run there would measure the labelling gap
  rather than this question.

  Closing it therefore needs labelled storylines in preview: run `chores storylines` there (bounded
  — the free tier is 500/day **per model**), seed them directly, or accept the split answer. The
  queue-shaped risk this question existed to catch is answered; the remainder is Phase 4's.

  One operational note for anyone re-running it: `SAMPLE_REFRESH_MINUTES` is unset on Preview, so it
  defaults to 60 and the election is repeatable only once an hour. Setting it to `1` there makes the
  test repeatable in seconds.

- **Q4.** ~~How long is `chores storylines` at 90 days of corpus?~~ **Settled, and not as
  expected.** ~3.5 h unbounded, of which the late-candidate sweep was ~506 s — and that turned out
  to be a **linking-correctness bug rather than a deployment cost**: `CANDIDATE_LIMIT` discarded
  ~90% of the candidate set on 99% of groups. Correcting it exposed a runaway in the sweep, so **the
  sweep is now gated off** and the pass fits 300 s with room to spare (findings §2.6). The label
  pass fits at `--max-labels` 40–60. Nothing here is Phase 4 work any more.

- **Q5.** ~~Is the corpus under 500 MB?~~ **Measured**: 190 MB today at 15 corpus-days, 125 MB
  restored, and the useful form is a tripwire rather than a number — 500 MB is reached at ~1,485
  articles/day sustained over 90 days *if* the reindex sweep runs, ~1,214 if it does not, against an
  observed 742–1,747/day (findings §4, §5).

- **Q6.** ~~What replaces `/metrics`?~~ **Settled**: deleted; platform observability plus the
  `chore_runs` record carry what mattered (§7).

- **Q7.** ~~Is a beta queue trigger acceptable in the load-bearing position?~~ **Settled**:
  accepted, with the pending set as backstop and a manual drain as fallback (§3.2, ADR-0015).

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
