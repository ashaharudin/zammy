# Phase 0 findings — the spikes that price Plan A

What [VERCEL-ALL-IN-SCOPE.md](VERCEL-ALL-IN-SCOPE.md) §9 Phase 0 asked for, measured on 2026-08-22
against the dev corpus (31,308 articles, 26,010 storylines, 15 corpus-days, 39 days of published
span). Every number here is a measurement, not an estimate; where something is arithmetic on top of
a measurement it says so. Two of the five Phase 0 items are **not** answered here because they need
a Vercel account — see §6.

**The headline is not the one the scope doc expected.** It priced the nightly label pass as the
thing Hobby's 300-second ceiling bounds, and named `--max-labels` as the deployment parameter that
does the bounding ([ADR-0015](adr/0015-all-in-on-vercel-hobby-shaped.md), "Hobby's ceilings"). The
label pass turns out to be the *easy* half. The pass that actually blows the ceiling is the
**late-candidate sweep**, it does so every night, and unlike the label pass it has **no bound to
set** — `runStorylinePass` never passes `maxGroups`, so the sweep always runs at its 20,000
default ([chores.ts:181](../apps/api/src/chores.ts), [chores.ts:458](../apps/api/src/chores.ts)),
and the runner has no flag for it either
([chores-cli.ts:77](../apps/api/src/chores-cli.ts)).

---

## 1. `chores storylines` against the 300-second ceiling

Measured phase by phase, on a restored clone of the dev corpus so the mutations were throwaway. The
label pass's model calls were **not** made: its wall clock is pacing, not compute, so once the
candidate count is known the duration is arithmetic — and the free-tier Gemini quota is worth more
than a number we can derive.

| # | Phase | Measured | Notes |
|---|---|---|---|
| 1 | dormancy | **99 ms** | |
| 2 | bridge sweep | **9 ms** | found 0; the write path's cascade had already done the work |
| 3 | **late-candidate sweep** | **41 ms × 12,338 groups ≈ 506 s** | linear across bounds of 250/500/1000/2000; §2 |
| 4a | label pass — the scan | **60 ms** | 8 batches over 3,938 promoted storylines |
| 4b | label pass — the model calls | **2,986 × 4 s ≈ 11,944 s** | pacing at `GEMINI_MAX_RPM=15`; §3 |
| 5 | label merge | **323 ms** | 43 shared labels, 42 merges, 32 plans |
| — | `chores retention` (the other pass) | **4 ms** | nothing yet at the 90-day horizon |

**Unbounded, the pass is ~3.5 hours.** Four of the five phases together are under half a second.
The whole cost is in two places, and they are different kinds of problem.

## 2. The late-candidate sweep is the real ceiling problem

The sweep offers **every group in the trailing DF window** to the linker, one group per iteration
([chores.ts:183](../apps/api/src/chores.ts) bounds the window at `STORYLINE_DF_WINDOW_DAYS`, 14
today). Today that is **12,338 groups**, and at a measured **41 ms per group** the sweep alone is
**~506 s — 1.7× Hobby's 300 s ceiling, every night**, before any other phase runs and before the
function's own cold start.

Three properties make this worse than a big number:

- **It does not shrink with retention.** The window is a fixed 14 days, so unlike the corpus-size
  question (§4) this does not improve by pruning. It scales with *daily volume*, which is the one
  input we expect to grow.
- **It is latency-bound, not CPU-bound.** Measured: **4.36 database round trips per group**
  (2,180 transactions over 500 groups) and **6.2 ms of Node CPU per group** (3.1 s user time over
  500) — so of the 41 ms, roughly 6 ms is compute and the rest is waiting on Postgres. Against a
  Docker Postgres on loopback that wait is nearly free. Against Supabase's pooler it is not:
  **every additional millisecond of round-trip time adds 4.4 ms per group, which is 54 s over the
  full window.** A 2 ms RTT — unremarkable for a pooler in the same region — puts the sweep at
  ~615 s. This is the one phase where moving Postgres off the loopback makes the deadline problem
  materially worse rather than neutral.
- **It has no deployment parameter.** `runLateCandidateChore` accepts `maxGroups`
  ([chores.ts:181](../apps/api/src/chores.ts)) but `runStorylinePass` calls it with the bare deps
  ([chores.ts:458](../apps/api/src/chores.ts)), `StorylinePassDeps` has no field for it, and the
  runner's usage line offers only `--label-rate` and `--max-labels`
  ([chores-cli.ts:77](../apps/api/src/chores-cli.ts)). So the lever ADR-0015 relies on for the
  label pass does not exist for the pass that needs it more.

A bound alone is not enough, either. At ~290 s of usable budget the sweep covers ~7,000 of 12,338
groups — so a plain `--max-groups` would cover the newest 7,000 every night and **never reach the
rest**, because the sweep restarts from the window's start each run
([chores.ts:193](../apps/api/src/chores.ts) seeds the cursor from the window, not from where the
last run stopped). Bounding it without making it resumable converts an over-deadline pass into a
silently incomplete one, which is worse: the tally would report a clean `offered: 7000` every night.

**This is unscoped work.** It is not large — a `maxGroups` on `StorylinePassDeps`, a `--max-groups`
flag, and a persisted cursor — but it belongs in Phase 4 and it was not there.

## 3. The label pass: a backlog, not a nightly cost

The scan says 2,986 of 3,938 promoted storylines want a label, which at 15 RPM is 3.3 hours. That
number is real but it is **not** the nightly steady state, and the split matters:

| | Count |
|---|---|
| Promoted storylines (`status <> 'provisional'`, not merged) | 3,934 |
| **Never labelled** (`label_at is null`) | **2,981** |
| Has a label baseline | 953 |
| **Drifted** (group count ≥ baseline × `STORYLINE_LABEL_DRIFT_FACTOR`, 2) | **0** |

So the drift trigger — the thing the nightly pass exists to serve
([ADR-0011](adr/0011-a-storyline-is-a-persistent-arc-of-one-event.md)) — currently fires for
**nobody**. The 2,981 is a one-time backlog, and it is quota-bound rather than deadline-bound: at
the Gemini free tier's 500 calls/day/model it is about six days of quota no matter where it runs.

Two consequences for Plan A:

- **The nightly label phase fits 300 s comfortably** once the backlog is not in it. Its steady-state
  work is new promotions plus genuine drift, and `--max-labels` bounds it exactly as ADR-0015 says.
  At 4 s per call, the arithmetic is stark and worth writing down: **75 labels is the entire 300 s
  window**, so `--max-labels` for a Hobby deployment lives around 40–60, not the 500 default
  ([chores.ts:394](../apps/api/src/chores.ts)).
- **The backlog must not run inside the chore route.** It is `backfill:storylines`/`label:storylines`
  work — an operator command against the session pooler, not a scheduled 202 + `waitUntil`. Draining
  it before cutover is the cheaper order, since Phase 5 seeds production from this corpus.

## 4. The corpus against Supabase Free's 500 MB

Today: **190 MB live**, 125 MB after a dump/restore. Comfortably under 500 MB — and that is the
least interesting way to state it, because the corpus is only **15 corpus-days and 9 ingest-days
deep** while `RETENTION_DAYS=90`. Retention has never pruned anything, so today's size is not a
steady state and cannot be read as one.

What is stable is the **cost per article**, which lets the cap be stated as a tripwire instead of a
guess. Splitting the schema into tables bounded by the DF window (`story_token_days` and friends —
fixed, ~30 MB after a reindex) and tables that scale with retention (`articles`, `sightings`,
`storylines`, `storyline_days`, `storyline_groups`, `storyline_bridges`, `topic_articles`):

| State | Bytes/article (retention-scaling) | Articles/day that reaches 500 MB at 90 days | …that reaches 400 MB |
|---|---|---|---|
| Live, with accumulated bloat | 4,294 | **1,214** | 942 |
| After `REINDEX` (§5) | 3,690 | **1,485** | 1,170 |
| Freshly restored (what production starts at) | 3,511 | **1,619** | 1,287 |

Observed ingest on the days the machine was actually running: **742–1,747 new articles/day**
(2026-08-10 → 08-21, excluding two initial backfill days of 11,404 and 10,297). That straddles the
tripwire. The honest answer to the scope doc's open question 3 is therefore **"yes today, and it
depends on one operational habit at 90 days"** — and the habit is §5, not the ingest rate.

**Phase 5's dump/restore is a non-event.** The whole corpus is a **24 MB** custom-format dump,
written in **1.9 s** and restored in **1.1 s** (35 indexes, 1 trigger, 189 functions, row counts
matching). Seeding production through the session pooler is a 24 MB upload, not a 190 MB one.

## 5. Index bloat is 22% of the database, and a 2-second chore recovers it

The gap between 190 MB live and 125 MB restored is bloat, and it is concentrated in exactly the
table the design churns hardest:

| Table | Live | Restored | |
|---|---|---|---|
| `story_token_days` | 52 MB | 12 MB | 605,268 deletes against 84,550 live rows |
| `articles` | 66 MB | 48 MB | 308,663 updates, 78,878 of them HOT |
| `storylines` | 14 MB | 12 MB | 208,275 updates |
| everything else | ~58 MB | ~53 MB | |

Autovacuum is keeping up on dead tuples (`n_dead_tup` is 0 on `story_token_days`) — it just does not
return the space, and index pages are the bulk of what is not returned. `REINDEX TABLE
CONCURRENTLY` recovers it, non-blocking:

- `story_token_days` alone: **355 ms**, indexes 30 MB → 7 MB.
- All seven scaling tables: **2.0 s total**, database 190 MB → 149 MB.

**41 MB — 22% of the database — for two seconds of non-blocking work, on a 500 MB budget.** That is
the difference between the tripwire in §4 reading 1,214 articles/day and 1,485. It belongs in the
retention chore, and it is the second piece of unscoped Phase 4 work this spike turned up.

## 6. What still needs a Vercel account

Two of the five Phase 0 items cannot be done from here. There is no Vercel CLI installed and no
authenticated session, and both items are outward-facing actions on the user's account:

1. **Prove the project shape** (§1.1 — Vite preset + an `api/` directory + a `queue/v2beta` trigger
   firing). The trigger syntax is confirmed from the docs and is a `functions` entry keyed by the
   route file, with `experimentalTriggers: [{ "type": "queue/v2beta", "topic": "…" }]`; the SDK is
   `@vercel/queue`, authenticating over OIDC, with `send(topic, payload)` and
   `handleCallback(async (payload, metadata) => …)`. What is **not** confirmed is the combination
   this plan needs: every documented example is Next.js App Router, and Vercel's Vite guidance
   steers Vite projects toward Nitro rather than a bare `api/` directory. That is precisely the
   thing the throwaway deployment exists to settle. A ready-to-deploy scaffold is in
   [deploy/vercel-spike/](../deploy/vercel-spike/) — one `vercel deploy` and one curl.
2. **Confirm Queues' Hobby allowance.** This is worse than unmeasured, it is **undocumented**: the
   Queues pricing page lists the five operation types, the 4 KiB metering and every service limit,
   but defers included usage to the plan pages — and the Hobby included-usage table has **no Queues
   line at all**, while listing Workflows (which is built on Queues) at 50,000 events/month. The
   Queues docs also carry a "Permissions Required" marker. So whether a Hobby project can create a
   topic at all is an open question that only the dashboard answers, and **§8's $0 column rests on
   it**.

Also worth recording from the same reading, because nothing in the plan had priced it: **Hobby
includes 4 CPU-hours of Active CPU and 360 GB-hours of provisioned memory per month.** The sweep's
5.7% CPU utilisation (54 s of CPU across 950 s of wall clock) means the nightly chores are nowhere
near the CPU allowance — roughly 3 CPU-minutes a night against a 480 CPU-second daily budget. The
wall-clock ceiling is the only binding constraint, which is a useful thing to know for certain.

## 7. Cold start: ~0.38 s, and a quarter of it is already scheduled for deletion

Median of five runs each, one measurement per fresh process, from process start to first served
request (`app.inject` on `/healthz`):

| Stage | Live mode | Fixture mode |
|---|---|---|
| Node boot floor | 60 ms | 60 ms |
| `@zammy/config` import | 28 ms | 28 ms |
| `loadConfig()` — Zod over 66 vars | 16 ms | 16 ms |
| `./server.js` import graph | **199 ms** | 195 ms |
| `buildApp()` | 48 ms | 59 ms |
| first request | 8 ms | 8 ms |
| **total** | **~359 ms** | **~366 ms** |
| 20 warm requests | 2.3 ms | 2.3 ms |

`buildApp` itself is cheap; the import graph is 55% of the total. Fixture mode costs ~11 ms more in
`buildApp` (the fixture store loads at boot), which matters only for previews.

The useful part is what the already-scoped deletions recover. Marginal cold-import cost, measured in
the order `server.ts` loads them:

| Dependency | Marginal ms | |
|---|---|---|
| `fastify` | 60 | |
| `kysely` | 58 | |
| **`bullmq`** | **58** | removed by §3.2 |
| `zod` | 41 | |
| `ioredis` | 27 | stays — cache, locks, pending set |
| **`prom-client`** | **14** | removed by §7 |
| `pg` | 11 | |
| `@fastify/rate-limit` | 8 | |
| `@fastify/cors` | 4 | |

**§3.2 and §7 take ~72 ms off a ~360 ms cold start** — a fifth of it, as a side effect of work
already priced. On a Fluid instance with a slower CPU and a cold filesystem, expect 2–3× these
figures, so ~0.8–1.1 s today and ~0.6–0.9 s after the deletions. Both are comfortably inside
`pg_net`'s configurable timeout for the chore route (§3.3's 2-second default concern is real but the
margin is not thin), and both are irrelevant to the sweep's deadline problem, which is 500 s of
round trips.

---

## Method, and what to distrust

- **Corpus**: `pg_total_relation_size` per table, `pg_database_size`, `pg_stat_user_tables`, against
  the live dev database and against a `pg_dump -Fc` / `pg_restore` clone.
- **Chore phases**: each exported phase called directly against the clone, timed with
  `performance.now()`. The label phase's model calls were never made; its duration is
  `candidates × 60000/GEMINI_MAX_RPM`, which is what `labelPass` itself computes
  ([storyline-backfill.ts:378](../apps/api/src/storyline-backfill.ts)).
- **Sweep rate**: `runLateCandidateChore` with `labeler` omitted, at `maxGroups` of 250/500/1000/2000
  on freshly restored clones; 41.3, 41.3, 40.0, 41.3 ms/group respectively, plus 61.7 at 250 where
  fixed setup is amortised over fewer groups. Round trips from `pg_stat_database.xact_commit`
  deltas; CPU from `/usr/bin/time`.
- **Cold start**: five fresh processes per mode, `performance.now()` deltas around each `import`.

Distrust these:

- **The machine is not the platform.** Everything here ran on an M-series Mac against Postgres on
  loopback. The sweep's projection is the number most sensitive to that, and §2 gives the
  sensitivity rather than a single figure for exactly that reason.
- **One contended measurement ran 6× slow.** Two sweep runs taken while the container was under
  memory pressure (336 MB of a 512 MB limit) and autovacuuming a fresh restore measured 258 ms/group
  rather than 41. It did not reproduce afterwards — fresh, analyzed, warm and thrice-repeated clones
  all returned 41 ms. It is recorded because a shared free-tier Supabase instance is a contended
  database by construction, and 6× is what contention cost here.
- **The corpus is 9 ingest-days old with two backfill days in it.** §4's articles/day input is the
  weakest number in this document, which is why §4 states a tripwire rather than a projection.
- **The dev corpus has had these passes run against it nightly**, so phases 1, 2 and 5 measured
  near-empty work. Their cost on a night with real work to do is unmeasured — but all three are
  sub-second on a full window, so the ceiling question does not turn on them.

## Sources

- [Vercel Queues](https://vercel.com/docs/queues), [quickstart](https://vercel.com/docs/queues/quickstart), [pricing and limits](https://vercel.com/docs/queues/pricing) — the `experimentalTriggers` / `queue/v2beta` shape, `@vercel/queue`'s `send`/`handleCallback`, OIDC auth, the TTL (60 s–7 d) and visibility (0–60 min) ranges, 4 KiB metering, 2× billing for idempotency keys, and the absence of a published Hobby allowance
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) — 300 s function maximum, 4 CPU-hours Active CPU, 360 GB-hours provisioned memory, 1 hour of runtime logs, WAF limits, and the non-commercial fair-use clause
