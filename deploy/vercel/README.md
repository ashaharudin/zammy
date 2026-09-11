# The Vercel deployment

Plan A of [RESEARCH-VERCEL-SUPABASE](../../docs/RESEARCH-VERCEL-SUPABASE.md), adopted in
[ADR-0015](../../docs/adr/0015-all-in-on-vercel-hobby-shaped.md) and phased in
[VERCEL-ALL-IN-SCOPE §9](../../docs/VERCEL-ALL-IN-SCOPE.md). **Phases 1 and 2 are deployed to
preview and verified**: the api serves as one Function, the ingest queue has a push-mode consumer
that drains and redelivers, and `POST /api/drain` is the manual fallback. **Phase 3 (the Redis quota
governor and rate-limit store) is deployed to preview**: the per-IP guard is verified shared across
six instances, and the burst ceiling is deployed but unexercised, because a fixture-mode preview
never calls the governor at all. **Phase 4 (the chores route, `chore_runs`, the pause guard) is
built and tested but SCHEDULED NOWHERE** — [supabase-cron.sql](supabase-cron.sql) has not been run
against any project, so no pass fires on a timer and nothing is keeping the database awake.
**Phase 5 (cutover) is built and unprovisioned**: the migration CI jobs, the seed and the deploy
script all exist, and there is no production Supabase project, no production Upstash database and no
production deployment for them to act on. **Nothing here is serving production traffic yet**, and
[provision-production.sh](provision-production.sh) is the twelve stages that would change that.

The configuration itself lives at the repository root, because that is where Vercel looks:
[`vercel.json`](../../vercel.json), [`api/index.ts`](../../api/index.ts),
[`api/queues/ingest.ts`](../../api/queues/ingest.ts), [`api/chores.ts`](../../api/chores.ts),
[`api/keepalive.ts`](../../api/keepalive.ts) and [`.vercelignore`](../../.vercelignore). This file is
the part that would not fit in JSON.

## The shape, and why

One project, one origin. The browser fetches `/api/v1/*` relative
([api.ts](../../apps/web/src/api.ts)), so a single project means no CORS, no preflight and no
build-time API base URL — the property §1.1 picked this layout to protect.

| Piece | Where |
| --- | --- |
| The SPA | `pnpm build` → `apps/web/dist`, served as static output |
| The api | `api/index.ts` → `apps/api/src/vercel.ts` → `buildApp(config, { consumer: false })` |
| The ingest consumer | `api/queues/ingest.ts` → `apps/api/src/vercel-queue.ts` → `buildServices` + `ingestDispatch` |
| The nightly chores | `api/chores.ts` → `apps/api/src/chore-route.ts` → `chore-runner.ts`, 202 + `waitUntil` |
| The pause guard | `api/keepalive.ts` → `apps/api/src/keepalive.ts`, one `select 1`, synchronous |
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

| Variable | Production |
| --- | --- |
| `DATABASE_URL` | Supabase **transaction** pooler, port 6543 |
| `DATABASE_SESSION_URL` | Supabase **session** pooler, port 5432 (migrations, chores) |
| `DATABASE_SSL` | `verify-full`, with Supabase's CA in `DATABASE_CA_CERT` |
| `DATABASE_POOL_MAX` | `1`–`2` — every instance holds its own pool |
| `REDIS_URL` | Upstash |
| `INGEST_QUEUE_DRIVER` | `vercel` — the default is `bullmq`, and leaving it there publishes to a Redis queue nothing drains |
| `CRON_SECRET` | a long random string — gates `/api/drain`, `/api/chores` and `/api/keepalive`; unset disables all three, **including the pause guard** |
| `CHORE_MAX_LABELS` | `50` (the default) — a count, and a count bounds the clock only if a label costs what it was sized against; `.env.example` carries the arithmetic |
| `CHORE_LABEL_BUDGET_MS` | `240000` (the default) — the bound that matches `api/chores.ts`'s 300 s `maxDuration`, leaving 60 s for the label-merge and graph passes after it. Unset on a deployment means the pass can be killed mid-night, which loses the `chore_runs` row and everything ordered after it |
| `CURRENTS_MODE` | `live` (needs `CURRENTS_API_KEY`) |
| `FIXTURES_DIR` | irrelevant |
| `TRUSTED_PROXY_HOPS` | `1` — measured on the spike: Fastify sees `127.0.0.1` with the client one hop out in `x-forwarded-for` |
| `CORS_ORIGIN` | the deployment origin |

`pnpm` 11 needs `ENABLE_EXPERIMENTAL_COREPACK=1` set as a project environment variable, after which
Vercel reads `packageManager` from the root manifest.

**There is no Preview environment.** §4 originally gave previews their own free-tier Supabase +
Upstash pair, in fixture mode, so a preview aimed at production couldn't write fixture articles
into the real corpus. That pair is retired (2026-08-26): Upstash's free tier only supports one
Redis database per project, and once that constraint forced a choice, there was no cheap way to
keep a second, isolated data plane just for previews. The 13 Preview-scoped env vars on the `zammy`
Vercel project and the `migrate (preview)` CI job are both gone with it — see
[ADR-0015](../../docs/adr/0015-all-in-on-vercel-hobby-shaped.md).

The retirement left one thing behind, fixed 2026-08-26: the git integration went on building a
preview for every PR-branch push. No Preview-scoped variable survived the retirement, so each one
answered `/readyz` with a 503 — it could not serve traffic, and the green Vercel check it hung on
the PR said nothing about whether the app worked. `vercel.json` now turns automatic branch deploys
off:

```json
"git": { "deploymentEnabled": { "**": false, "main": true } }
```

A branch matching several patterns deploys if *any* of them is `true`, so `main` — which matches
both rules — keeps its auto-deploy while every other branch stops. **That precedence rule is the
only thing keeping production deploying, so it was tested rather than assumed** (2026-08-26): a
throwaway branch pushed with `{"**": false, "claude/precedence-probe": true}` built a preview,
which is the same both-rules-match shape `main` is in. If it had lost, main would have stopped
deploying silently.

**It must be `**`, not `*`.** These are [minimatch](https://github.com/isaacs/minimatch) patterns,
and minimatch treats `/` as a path separator that a single `*` will not cross. Every branch in this
repo is `claude/<something>`, so `"*": false` matches **nothing here** and the whole block is
silently inert — it is not a config error, it just never fires. That is exactly how it was first
committed, and the branch carrying the fix built its own preview to prove it (`vercel ls`, 2026-08-26).
Vercel's own docs only ever demonstrate a slash-free pattern (`internal-*`), so the trap does not
show up until a branch name has a slash in it.

**Verifying a change to this block takes both halves, and the easy half is the useless one.**
Pushing a branch and confirming `vercel ls` gains no Preview row tests only that previews are
off — a typo in the `main` key (`"mian": true`) passes it perfectly while production auto-deploy
is dead, and nothing announces that until someone notices the site is stale. So also confirm the
positive: either watch for a new `Production` row in `vercel ls` right after the next merge to
main, or, before merging, run the probe above on a throwaway branch named to match your `true`
rule. The setting is read from the pushed commit, so the branch making the change tests itself.

Two more consequences. **Vercel reads this from the pushed commit**, so a PR branched before this
landed keeps building previews until it is rebased. And **it governs the git integration only** — a
manual `vercel deploy` without `--prod` still mints a preview URL, because that is the CLI, not the
integration. Such a deployment still boots with no `DATABASE_URL`/`REDIS_URL` and still will not
serve traffic: there is no supported way to preview this app outside production.

**What this costs: nothing exercises Vercel's Function bundling on a PR any more.** Env-less as
those previews were, they did bundle all five functions, and that was the only PR-time check on
`vercel.json`'s `functions` block — the `includeFiles: "fixtures/**"` entries and the queue's
`experimentalTriggers` registration included. `verify` runs `pnpm build`, `pnpm typecheck` and
`pnpm test`; none of them runs `vercel build`. So the first sign that a function stopped bundling,
or that `fixtures/` stopped being placed, is now the production deploy on merge — a failure
[VERCEL-PHASE-0-FINDINGS](../../docs/VERCEL-PHASE-0-FINDINGS.md) notes is only observable on a real
deployment. Adding a `vercel build` step to `verify` would restore the check without deploying
anything, and is the obvious move if this ever bites.

## Deploying

```bash
./deploy/vercel/deploy.sh --prod
```

**Or not at all: the project is git-linked, so a push to main deploys production on its own** (the
deployment carries the `zammy-git-main-<scope>.vercel.app` alias). Main is now the only branch
that deploys — see `git.deploymentEnabled` above. `deploy.sh` is for deploying local or
uncommitted state, and its `.git`-excluded copy is what makes a *CLI* deploy work at all — the raw
commands below land BLOCKED from inside the repository:

```bash
vercel build && vercel deploy --prebuilt
```

**Run both from a copy of the tree with `.git` excluded.** Vercel stamps a deployment with the
*commit author* rather than the account that owns the project, so a deploy from the repository
returns `readyState: BLOCKED` (`TEAM_ACCESS_REQUIRED`) — rendered as `UNKNOWN` by `vercel ls`, with
`vercel inspect --logs` printing nothing (VERCEL-ALL-IN-SCOPE, "What the Phase 1 deploy corrected").
An `rsync -a --exclude .git --exclude node_modules --exclude .vercel` into a scratch directory, plus
a copy of `.vercel/project.json`, is the whole workaround. **Do not add `--exclude dist` to that
list without also deleting `*.tsbuildinfo`.** The build info files sit beside each `tsconfig.json`,
not inside `dist`, so a copy that drops the output but keeps them leaves `tsc -b` believing every
project is up to date: it prints `Done` for all nine, emits nothing, and `vercel build` reports
`status: ok` having produced functions with no code in them. The only visible symptom before the
deploy is `apps/web` failing to resolve `@zammy/shared` — the one package whose consumer typechecks
against `dist`. Confirm with `vercel inspect <url>`
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
- **`experimentalTriggers` is beta, and redelivery depends on a platform number we only measured.**
  Delivery and redelivery both work as of 2026-08-25, but the retry latency is server-assigned and
  has already moved once — 30× in three days, which silently broke retries when it did (see below).
  The pending set is the ledger of what is owed (`meta.ingest`), which is what keeps a regression
  here a recoverable state rather than a data-loss event.
- **The message TTL is 900 s, and the pending window matches it.** A deploy mid-flight leaves the
  old deployment draining its own messages, because push-mode topics are partitioned by deployment
  id; fifteen minutes bounds how long that lasts. Both numbers descend from the measured 300 s
  redelivery lease — the TTL is 3× it, the pending window is held at the TTL so the ledger outlives
  the message. **Do not re-derive either from the other**: the TTL being pinned to the pending
  window is exactly the bug that stopped redelivery.

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
- **`meta.ingest` stays noisy for the whole retry, on purpose.** The stale prune was 5 minutes
  against an attempt 2 that lands at 5 minutes 5 seconds, so the ledger used to stop reporting a job
  the queue still intended to retry — and a topic that reads `complete` is a topic the API caches
  mid-fill. The prune is now 15 minutes, past the whole ~610 s budget. The visible cost is the other
  way round: a topic whose consumer genuinely died sits at `in_progress` for 15 minutes.
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
  younger than 900 s, and a topic with traffic prunes its own ledger 900 s after a read.
  Work sitting there is work on a topic nobody has read in fifteen minutes.
- **`truncated: true`** means a bound stopped the pass with entries left; run it again. `?limit=`
  lowers the 50-job cap for a cautious first run.
- **Schedule it every 5–15 minutes** via Supabase Cron if you want cold topics covered promptly.
  Hobby's Vercel cron (once a day, ±59 min) is too coarse to be the primary driver.

### What the first live drain found — 2026-08-26

**Four 500s: two scheduled, two by hand.** The route had never run outside its unit tests, and it
failed the moment Supabase Cron first called it. Worth reading as a shape, because nothing about the
symptom pointed at the cause:

- `cron.job_run_details` said **`succeeded`** for every fire. That status describes the SQL
  statement, not the HTTP request — `select public.zammy_cron_post(...)` returned a row, so pg_cron
  was satisfied. The 500 was in `net._http_response`, one table over.
- `/readyz` said `redis.ok: true` throughout, because the request function was warm.
- `/api/keepalive` answered 200, because it touches only Postgres.
- The response body was `{"error":"drain failed"}` and nothing else, and `vercel logs` returned
  **no lines at all** on Hobby.

The cause is a race that only a hosted Redis is slow enough to lose. `buildServices` builds its
client with `lazyConnect: true`, `enableOfflineQueue: false` and a deliberately **un-awaited**
`redis.connect()` — correct for the request path, where Redis is pure cache and awaiting an ~800 ms
Upstash handshake would sit in front of every cold read. The drain is the one caller for which that
does not hold: `listOutstanding` is a `SCAN` issued microseconds after the boot returns, Redis is its
*input* rather than its cache, and with the offline queue disabled ioredis does not wait for the
stream — it throws `Stream isn't writeable and enableOfflineQueue options is false`. `runDrain` does
not guard that call, because a ledger it cannot read is not a pass it can run.

The unit tests could not have caught it. They drive a real local Redis over loopback, ready before
the first command is written.

**The fix** is a bounded wait in the drain's boot (`waitForRedis`, 10 s), not a change to
`buildServices` — the request path's posture is deliberate and worth keeping. An unreachable Redis
now becomes a 503 with a reason instead of a 500 or a function that runs to `maxDuration`.

**The push-mode consumer had the same race, and it was fixed pre-emptively — 2026-08-26.** It calls
the same `buildServices` and then dispatches immediately, so it too can reach Redis on a client that
is still shaking hands. It has never actually failed, and the reason is *timing luck* rather than any
ordering guarantee: both handlers happen to make a Postgres round trip before their first Redis
command (`processSegmentJob` reads the topic before `tryAcquire`; `processSampleJob` upserts one),
and a warm same-region pooler query has been beating a cold handshake. The Supabase cutover made that
margin **narrower**, not wider — production Postgres is now us-east-1 beside `iad1`, so the Postgres
half of the race got faster while the handshake did not. The consumer's boot now awaits the same
helper, which moved to `apps/api/src/redis-ready.ts` so a route no longer exports a utility the other
one imports.

Worth knowing as an operator because of how it *would* have presented: not a 500, but a job that
fails and is redelivered at +305 s and +610 s before being given up on, logging an error three lines
from the legitimate `segment ... is locked; retrying later`. It would have read as lock contention.
A boot that rejects instead names Redis and is retried whole on the next delivery.

`/api/chores` does **not** need this and deliberately does not have it: no chore pass touches Redis,
`ChoreDeps` has no client, and its boot never calls `buildServices`.

**Verified on deployment `dpl_GJ9xwKPDw9J7ZQDNpwqpmyMpeHfv`** with a cold `?q=avalanche`: 13
deliveries, 12 settled, `meta.ingest` reaching `complete` / `pendingJobs: 0`, and **no
`Stream isn't writeable` on `POST /api/queues/ingest` at all**. The same deployment logged that error
three times on the REQUEST path — twice on a cold `GET /api/v1/timeline`, once on a cold `/readyz`,
which answered `degraded` and then `ready` on the second probe. Two paths, one client, different
postures on purpose; that contrast is the evidence, and it is the thing to re-check after any change
to `buildServices`.

The one redelivery in that run was unrelated and is worth knowing about: a segment sitting on the
30-day lookback boundary at plan time is out of range by the time the consumer runs it, so Currents
answers `400 date_range: Max lookback is 30 days`. It came back at `deliveryCount: 2` and settled —
the clamp had moved the window back into range — so it costs a five-minute delay rather than a lost
job. `deliveryCount` never exceeded 2, and never exceeded 1 for anything else.

**Verified on a scheduled fire, not just a curl.** The fires at 21:00, 21:10 and 21:20 UTC were 500;
the deploy landed at ~21:26; the **21:30 fire returned 200**. That is the evidence that matters here —
a manual `POST` proves the route, while a cron row proves the whole path: pg_cron → `pg_net` → TLS →
a cold Node boot → the route, inside the 15 s `timeout_milliseconds`.

**Two things changed alongside it, both because the diagnosis was harder than the bug.** The 500 body
now carries `reason` — safe, since every caller has already presented `CRON_SECRET`, and on Hobby the
log that would otherwise hold it is gone within the hour. And `/readyz` answering `degraded` with
*this exact string* on a cold read is now a known-good state rather than a puzzle: it is the same
race, on a path that tolerates it.

**The tripwire that would have caught it sooner**: `net._http_response.status_code`, not
`cron.job_run_details.status`. Worth checking after any change to the cron jobs or the routes they
call:

```sql
select id, status_code, left(coalesce(error_msg, ''), 80) as err, created
  from net._http_response order by created desc limit 20;
```

## The chores — `/api/chores` and `/api/keepalive`

Both are `CRON_SECRET`-gated, both are driven by Supabase Cron, and
[docs/chores.md](../../docs/chores.md) has the behaviour and the reasoning. The operator's half:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$URL/api/chores?pass=storylines"
```

- **Scheduling is one paste.** [supabase-cron.sql](supabase-cron.sql) creates all four jobs
  (retention, storylines, keep-alive, drain) after two placeholders are replaced, keeps the bearer
  token in Vault rather than inline in `cron.job.command`, and sets `timeout_milliseconds` to 15 s.
  **Raising that timeout is not optional** — pg_net defaults to 2 s, and a cold 202 is a Node boot
  plus TLS on top of a ~550 ms platform container floor. A timed-out request is a night that silently
  did not run.
- **A 202 is not evidence the pass ran.** The route answers before the work starts, on purpose, so
  `net._http_response` can only tell you the request arrived. `chore_runs` is the record — read it
  with `pnpm chores status` against `DATABASE_SESSION_URL`, or:
  ```sql
  select pass, source, started_at, finished_at, outcome, model_calls
    from chore_runs order by started_at desc limit 20;
  ```
- **`finished_at IS NULL` on an old row means the pass never came back** — a function killed at
  `maxDuration`, most likely the label pass. That is the state the row exists to make visible, and the
  reason it is opened before the work rather than written at the end.
- **Any pass runs on demand**: `retention`, `storylines`, and the six steps —
  `dormancy`, `bridges`, `late-candidates`, `labels`, `label-merge`, `graph`. `?max-labels=` and
  `?changed-only=` are the query twins of the CLI flags. Naming `late-candidates` runs the sweep
  regardless of `STORYLINE_LATE_CANDIDATE_SWEEP`, which is the deliberate act that gate protects.
- **A laptop run and a scheduled run contend.** `pnpm chores` takes the same advisory lock as the
  route, so re-running the label pass by hand mid-night skips rather than doubling the Gemini bill —
  and the skip is recorded as `outcome: 'skipped'` rather than as nothing.
- **The keep-alive is deliberately not a chore.** Supabase does not promise pg_cron's own activity
  prevents the 7-day free-tier pause; it prescribes external requests. Folding the ping into the
  chores would make "the database stays awake" a downstream consequence of the most complex nightly
  job in the system. It answers synchronously — a ping whose result is not in the response cannot
  tell a paused project from a healthy one.
- **The reindex sweep rides on `pass=retention`.** ~2 s of non-blocking `REINDEX TABLE CONCURRENTLY`
  that returns 22% of the database (findings §5). Its tripwire is `reindex.invalidIndexes` in the
  report: an interrupted rebuild leaves a `_ccnew` twin that is never read and still maintained on
  every write, and nothing in Postgres complains about it. Non-empty wants a `DROP INDEX` by hand.

## The cutover — Phase 5

Three scripts and a wizard. Run the wizard; it calls the other two at the right moments.

```bash
./deploy/vercel/provision-production.sh
```

**Twelve stages, and the first eleven happen in order.** It creates nothing on your behalf that a
browser is needed for — it opens each page, says what to click, captures what you copy back, and
writes the values where they belong (a gitignored `deploy/vercel/.env.production`, the Vercel
Production environment, and three GitHub Actions secrets). Ctrl-C is safe at any point: re-running
offers everything already captured as a default.

| Stage | What it does |
| --- | --- |
| 1 | Preflight — `vercel`, `gh`, `docker`, and whether the dev corpus container is up |
| 2–4 | The production Supabase project: create it in **us-east-1**, both pooler URLs, the CA certificate |
| 5 | The production Upstash database — `rediss://`, and it checks |
| 6 | `CRON_SECRET` (generated), and the Currents/Gemini keys carried from the dev `.env` |
| 7 | Sixteen environment variables onto the Vercel **Production** environment |
| 8 | [seed-production.sh](seed-production.sh) — the corpus, then the migration-ledger check |
| 9 | The three GitHub Actions secrets `ci.yml`'s migration jobs read |
| 10 | [deploy.sh](deploy.sh) `--prod`, then `/readyz` twice, then the **stable production alias** |
| 11 | [supabase-cron.sql](supabase-cron.sql) — the step that has never been run anywhere |
| 12 | `zammy.info` at the registrar, then `CORS_ORIGIN` and a redeploy |

**The three shapes it refuses at the prompt**, each of which has already cost a deploy cycle on the
preview pair: a Postgres URL carrying `?sslmode=` (`@zammy/config` rejects one outright, because
node-postgres then silently ignores `DATABASE_SSL`), the two pooler ports swapped, and a `redis://`
Upstash URL where `rediss://` was needed. Catching them at the prompt is a moment; catching them at
`/readyz` is a deploy cycle each.

**And a fourth, which fails later and quieter than any of them.** Stage 10 wants the *stable
production alias*, not the per-deployment URL `deploy.sh` prints. `zammy-<hash>.vercel.app` names one
immutable deployment; the same value goes into Supabase Vault as `zammy_base_url` in stage 11, so
cron pinned to it keeps hitting that one deployment after every later deploy — answering 202 from
stale code against whatever environment it was built with, until Vercel eventually prunes it.
Nothing in `chore_runs` or `net._http_response` would read as wrong. The wizard recognises the
hash-segment shape and asks again.

### Seeding — `seed-production.sh`

One-time, and it refuses a target that already has tables. Measured against a scratch database:
**23.8 MB out, 4.2 s round trip**, all sixteen tables' row counts matching.

It restores a **full** custom-format dump rather than running the migrations and restoring
`--data-only`. That is not a preference: a data-only restore into a schema whose foreign keys
already exist needs `--disable-triggers`, and disabling a table's internal FK triggers is
superuser-only, which Supabase does not grant. The full dump's own ordering — tables, data, then
constraints and indexes — sidesteps the question. The dump carries `kysely_migration` with it, so
`pnpm db:migrate` afterwards printing **"Nothing to migrate"** is the verification that the restored
schema is the one the code expects. Anything else there means stop.

`mine` is excluded (`SEED_EXCLUDE_TABLES`): 413 rows of scratch from the storyline pile cleanup that
**no migration creates**, and which would otherwise become a permanent fixture of the production
schema that the ledger has never heard of. Add the next one to that variable rather than finding it
in production.

### Deploying — `deploy.sh`

```bash
./deploy/vercel/deploy.sh --prod      # production
./deploy/vercel/deploy.sh --preview   # a preview URL with NO data plane behind it
```

**The target is not optional, and it used to default to preview.** That default could only ever
produce a broken deployment once the Preview environment was retired, so the script now refuses to
guess. `--preview` still works and warns: it is good for checking that the build and the function
dependency trace still resolve, and good for nothing else, because the deployment has no
`DATABASE_URL` and no `REDIS_URL` and will answer `unready` to every probe.

The `.git`-excluded copy described under [Deploying](#deploying) above, as a script instead of a
paragraph people re-read. It runs `vercel inspect` afterwards, because the CLI's exit code is not a
signal — a BLOCKED deployment exits 0.

### Migrations in CI

`ci.yml` carries `migrate (production)`, on pushes to main. It gates on `verify`: a migration is
the one thing here a rollback cannot undo, since Instant Rollback rolls code back and leaves the
schema where it is. It fails loudly on a missing secret rather than running against no URL. It
reads two repository secrets, both set by stage 9 of the wizard:

| Secret | Used by |
| --- | --- |
| `PRODUCTION_DATABASE_SESSION_URL` | `migrate (production)` |
| `SUPABASE_CA_CERT` | `DATABASE_SSL=verify-full` needs something to verify against |

The job does not deploy — but the git integration does. A push to main produces a production
deployment on its own, and it does not wait for this job, nor this job for it. That is exactly the
non-atomicity §6 describes, and expand/contract discipline is what makes it safe: additive
migrations land before the code that needs them, destructive ones after the code that stopped.

The workflow's `cancel-in-progress` is now conditional — pull requests still cancel superseded runs,
pushes to main queue instead. A main run carries a migration, and cancelling one mid-DDL leaves the
deploy racing it against a database one migration short.

There used to be a matching `migrate (preview)` job here, on pull requests, gated the same way,
reading a `PREVIEW_DATABASE_SESSION_URL` secret. Both the job and the secret are gone (2026-08-26) —
see "There is no Preview environment" above.

#### One push is one batch, and that is what decides how long the lock is held

Kysely runs **every pending migration in one transaction**, so a single push to main takes whatever
locks that whole batch needs and holds them until the last one commits. Two migrations that are
individually cheap can therefore be expensive together, and the difference is not visible in either
one's own timing.

Merging two migration PRs **separately** is what keeps them apart, and the workflow cooperates:
`concurrency: ci-${{ github.ref }}` with `cancel-in-progress` false for pushes means two back-to-back
merges to main **queue** rather than cancel, so the second `migrate (production)` starts after the
first has finished. What it does NOT protect against is one push carrying both — a stacked branch
merged directly, or a squash of two PRs — because that is one batch by construction.

The worked example, measured against a clone of the dev archive (32,279 articles):

| deploy | migrations | ACCESS EXCLUSIVE on `sightings` |
| --- | --- | --- |
| separately, first | `0021` + `0022` | 377 ms |
| separately, second | `0023` | none of its own — no `ALTER TABLE`, row locks only |
| together, one push | `0021`–`0023` | **4.4–10.0 s**, during which `sightings` answers no reads |

`0023` re-keys every article's `alt_key` in TypeScript, a page at a time; run beside `0022` it
inherits `0022`'s table lock for its whole duration. So when two branches each carry a migration,
**merge them one at a time and let each `migrate (production)` finish before merging the next** —
and say so in the PR description, because this constraint lives in the migrations' own comments and
nobody merging a PR reads those.

## What is still not done

- **Nothing is in production.** Phase 2 is verified on *preview* only. Production has no seeded
  corpus and no `INGEST_QUEUE_DRIVER`, so leaving it at the `bullmq` default there would publish to
  a Redis queue nothing drains. Phase 5's code exists; the accounts it acts on do not.
- ~~**The drain has never run against a live deployment.**~~ It has now, and it **failed on the
  first four attempts** — see below. Fixed and verified 2026-08-26. A real fill is still unproven:
  every pass so far has answered `scanned: 0`, which is the healthy answer and not an exercise of
  the fill path.
- **The chores are built and nothing schedules them.** The route, the table and the pause guard all
  exist as of Phase 4; [supabase-cron.sql](supabase-cron.sql) is written and **has not been run**.
  Until it is, no pass fires on a timer and a deployed project's database is reachable only as long
  as something else keeps it awake. It is stage 11 of the wizard.
- **The production data plane does not exist.** No Supabase project, no Upstash database, and the
  Production environment carries exactly one variable (`ENABLE_EXPERIMENTAL_COREPACK`). Stages 2–7.
- **The quota governor has never governed anything on a deployment.** Phase 3 ships it and a
  fixture-mode preview cannot exercise it: `CURRENTS_MODE=fixture` returns `FixtureCurrentsClient`,
  which builds its own unmetered governor and ignores the injected one. `/readyz` reporting
  `dailyRemaining: 1000, burstRemaining: 60, observed: false` is that unmetered governor answering,
  not evidence the shared window works. Closing it needs `CURRENTS_MODE=live` and a key on the
  preview, with `CURRENTS_BURST_CALL_LIMIT` temporarily lowered to ~3 so the probe costs a handful
  of calls instead of 61 (VERCEL-ALL-IN-SCOPE, "Phase 3 as it stands"). Until then this stays the
  reason not to leave a preview serving real traffic in `CURRENTS_MODE=live` for long.
- **Both guards fail OPEN on a Redis fault, and both now say so.** The posture is deliberate and
  unchanged — Redis down costs the ceiling, never the request — but it is no longer silent. Grep the
  function log for either warning:
  - `rate limit fail-open; this instance is not counting requests against the ceiling` — the per-IP
    limiter admitted a request without counting it, so the deployment-wide ceiling is
    `RATE_LIMIT_PER_MINUTE ÷ the healthy fraction of the fleet` rather than the number configured.
    Throttled to one line a minute per instance, so read the fields, not the line count:
    - `redisStatus` answers **"was the client still broken when we looked?"**, not "why did it
      throw?" — it is read after the response, so a fault that healed in the meantime shows as
      healed. That is the point: the healed ones are the routine ones.
      - **`ready` — routine, and by far the most common.** The client is built `lazyConnect` with
        the connect deliberately not awaited, so a request landing inside the handshake fails open
        on a client with nothing wrong with it, which then finishes connecting before the response
        does. No `redis error` accompanies it because nothing errored. Measured locally at 10 of 16
        cold starts, all reading `ready`. Not worth acting on.
      - **`reconnecting` / `close` / `end` — chase this one.** The client was still unusable at the
        moment we looked, which is the blind instance of
        [MEASUREMENT-RATE-LIMIT-FAIL-OPEN](../../docs/MEASUREMENT-RATE-LIMIT-FAIL-OPEN.md) §3.2, and
        it stays blind for as long as it stays there. One `end` at the tail of an instance's life is
        an ordinary shutdown; a stream of any of these is not.
      - **`connecting` / `connect` / `wait` — ambiguous. Do NOT read this as routine.** It is both
        a cold start still in its ~800 ms Upstash handshake *and* a handshake that is timing out and
        never going to finish. Measured with the client's production options: a **timing-out**
        handshake reads `connecting` **99.6%** of the time (n=275) and a refused connection reads
        `reconnecting` **98.1%** (n=157) — both blind, both throwing on every command. The status
        names whichever phase is long, not how bad the fault is: ECONNREFUSED fails in under a
        millisecond so the retry backoff dominates, while ETIMEDOUT hangs for ioredis' full 10 s
        `connectTimeout`. **The 7 `connect ETIMEDOUT` fail-opens recorded two bullets below would
        every one of them log `connecting`.**

        The obvious cross-check does not work in the moment: a timing-out handshake emits no
        `redis error` event until `connectTimeout` expires (measured t=10.0 s, then t=20.1 s), so
        for ten seconds it is indistinguishable from a healthy cold start on both signals. What to
        do instead: look for a `redis error` on the **same instance about ten seconds later**, and
        treat a *sustained run* of `connecting` from one instance as an incident — a benign cold
        start resolves in about a second and cannot produce one.
    - `failOpen` is a per-instance count of uncounted requests since boot, including the ones the
      throttle kept out of the log. It is an absolute number, not a rate: to turn it into a
      fraction, compare it with that instance's request count over the same window.
  - `shared burst window unavailable; counting in-process` — the quota governor on the same client.

  The underlying signal is unchanged and still visible from outside: `x-ratelimit-remaining` coming
  back at the full limit, a value `INCR` cannot produce — but it cannot tell the two mechanisms
  apart, which is why `redisStatus` is in the line. Measured on the Phase 3 deploy, a 24-request
  burst that forced scale-out took the fail-open path **7 times**, with `connect ETIMEDOUT` on the
  cold instances' Upstash handshake; production measured ~3% on an
  ordinary day and roughly half the traffic during one 8.5-minute episode
  ([MEASUREMENT-RATE-LIMIT-FAIL-OPEN](../../docs/MEASUREMENT-RATE-LIMIT-FAIL-OPEN.md) §3). A burst
  is exactly when the guard matters, so read a clean `x-ratelimit-remaining` sequence as the healthy
  case and a full-limit one as "Redis was not there for that request".
