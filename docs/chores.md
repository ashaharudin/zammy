# Chores and the ingest drain

The scheduled background work: what runs, what it depends on, and why the ingest drain sits beside
it rather than inside it. Source of truth is [chores.ts](../apps/api/src/chores.ts) (what a pass
does), [chore-runner.ts](../apps/api/src/chore-runner.ts) (the lock and the record),
[chore-route.ts](../apps/api/src/chore-route.ts) and [chores-cli.ts](../apps/api/src/chores-cli.ts)
(the two entrypoints), and [drain.ts](../apps/api/src/drain.ts); this page is the map, not a second
copy of the reasoning in those files.

## Two things on a schedule, and they have nothing in common

| | Chores | Ingest drain |
|---|---|---|
| Entry point | `chores-cli.ts` (Compose) and `api/chores.ts` (Vercel), sharing [chore-runner.ts](../apps/api/src/chore-runner.ts) | `api/drain.ts` → [drain.ts](../apps/api/src/drain.ts) |
| Touches | Postgres, and Gemini for labels | **Redis**, and the upstream news API |
| Exactly-once | Postgres advisory lock, two domains | none needed — see below |
| Cadence | nightly | as often as every ~5 min, if you want hot topics covered |
| Spends money | yes, the label pass | yes, every fill |
| Built? | yes, both — **not scheduled anywhere yet** | **yes, as a route** |

They are on this page together because they are both "work on a timer that no user is waiting for",
and that is the *only* thing they share. Every dependency, bound and failure mode differs.

## The chores

Two composites are what a scheduler points at — `retention` and `storylines` — and every step of
them is also addressable on its own, for a re-run that must not drag the whole night with it:
`dormancy`, `bridges`, `late-candidates`, `labels`, `label-merge`, `graph`. Eight names, one
[pass table](../apps/api/src/chore-runner.ts), reached identically as `pnpm chores <name>` and as
`POST /api/chores?pass=<name>`.

The runner takes a session-scoped Postgres advisory lock — `pg_try_advisory_lock`, so a second
concurrent run *skips* rather than queues. That lock is what replaced BullMQ's exactly-once when the
clock moved outside the app, and it matters most for the label pass, which spends real money per
call.

**There are two lock domains, not eight keys.** Retention has its own; every storyline-family pass
shares one. A key per pass is the obvious shape and is wrong, because `storylines` *contains*
`labels` — a per-pass key would let "re-run just the label pass" run it twice at once while the
scheduler was midway through the night. The keys are the ones `chores-cli.ts` has always used, which
is what makes a laptop run and a scheduled run contend rather than both spending the budget. `graph`
takes no lock at all: it is a read, and locking it would make the percolation alarm unreadable during
exactly the multi-hour pass you would want to read it during.

**`retention`** runs [`runRetentionChore`](../apps/api/src/chores.ts:90). It reports; it does not
delete. Deletion is a separate deliberate decision (ADR-0001), so the numbers have to be visible long
before any code acts on them. Two things under the report *do* change, and both are about derived
rows rather than about the corpus: the trailing-corpus prune (`story_token_days` past the linker's
window), and the `REINDEX TABLE CONCURRENTLY` sweep.

**The reindex sweep is a storage chore, not a latency one**, which is worth saying because the name
reads the other way. Autovacuum keeps up with dead tuples here and does not return the pages;
index pages are the bulk of what it does not return, and that was **22% of the database** at 15
corpus-days — 41 MB across the database, 23 MB of it on `story_token_days` alone (its indexes go 30 MB to 7). On Supabase's free 500 MB it is the
difference between the storage tripwire reading 1,214 articles/day and 1,485, against an observed
742-1,747 (VERCEL-PHASE-0-FINDINGS §4, §5). It runs *after* the prune in the same pass, because that
prune is the largest single source of the bloat it reclaims, and it never throws — a table that loses
a lock race is recorded and the next one attempted, because the report is the deliverable and this is
the side effect. Its one tripwire: an interrupted `CONCURRENTLY` rebuild leaves an invalid `_ccnew`
twin that is never read and still maintained on every write. The sweep counts them and warns;
`reindex.invalidIndexes` should always be empty, and anything in it wants a `DROP INDEX` by hand.

**`storylines`** runs [`runStorylinePass`](../apps/api/src/chores.ts:786), which is six steps
in a deliberate order, sequential and awaited because from step 2 down each step's input is what the
previous step just changed:

1. [`runDormancyChore`](../apps/api/src/chores.ts:137) — marks storylines quiet past
   `storylineDormancyDays` (~90, ADR-0011). Reads the same knob the linker's gate reads, so the
   column cannot disagree with the bar.
2. [`runBridgeSweepChore`](../apps/api/src/chores.ts:434).
3. [`runLateCandidateChore`](../apps/api/src/chores.ts:194) — **gated off by default.** It is behind
   `STORYLINE_LATE_CANDIDATE_SWEEP` / `--late-candidates` because correcting a `CANDIDATE_LIMIT`
   bug exposed a runaway in it; with the gate off the whole pass fits the 300 s ceiling with room to
   spare. A skipped sweep still reports a zero tally rather than being absent, because "ran and
   changed nothing" and "did not run" are different facts and a report that conflates them is how a
   flag left off by accident survives a month of clean-looking logs.
4. [`runStorylineLabelChore`](../apps/api/src/chores.ts:527) — ADR-0011's drift trigger. The one pass
   that costs money per call, bounded on the clock by `CHORE_LABEL_BUDGET_MS` and on
   count by `--max-labels` / `CHORE_MAX_LABELS` — at the ~1.4 s a label was measured to
   cost on 2026-08-28 the budget admits roughly 40–70, so the two bounds bite at about
   the same place (STORYLINE-LABELS.md) — and paced at `GEMINI_MAX_RPM`.
5. [`runLabelMergeChore`](../apps/api/src/chores.ts:496) — **last**, because it is the only pass
   whose input is a label: a storyline named tonight should be a merge candidate tonight. This is
   what makes the whole thing converge, each night's labels being the next night's candidates.
6. [`runStorylineGraphChore`](../apps/api/src/chores.ts:652) — reads the graph's shape, changing
   nothing, so the row describes the archive the night *leaves* rather than the one it found.

**The property worth protecting: no chore touches Redis.** [chores.ts:58](../apps/api/src/chores.ts:58)
states it outright — the runner needs no cache, no queue, and no `REDIS_URL` that resolves to
anything — and `ChoreDeps` is `{ db, config, now, log }` with no client to give one. That is what
makes the chores runnable as a bare one-shot process against nothing but Postgres.

## The chores as a route — `POST /api/chores?pass=<name>`

Same passes, same lock, same record; the only thing the route adds is a way for a scheduler that
speaks HTTP to start one, and a way to re-run a single pass from a curl instead of an SSH this
deployment does not have.

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$URL/api/chores?pass=labels&max-labels=20"
```

**It answers 202 and runs the pass in `waitUntil`.** The scheduler is `pg_net` inside Supabase, which
is asynchronous with its own timeout — 2 s by default, plausibly shorter than a cold Node boot plus
TLS. Returning before the work starts is what makes that timeout a question about the *request*
rather than about the *night*: `maxDuration` (300 s on Hobby) bounds the background half, and the 202
has only to beat `timeout_milliseconds`, which the cron job sets to 15 s explicitly.

The consequence is the thing to internalise: **the response cannot tell you whether the pass worked**,
because it is sent before the pass starts. Nothing downstream of the 202 reaches the scheduler at all.
A 202 in `net._http_response` means the request arrived, and nothing more.

- **`CRON_SECRET` gates it, fail-closed.** Unset disables the route rather than opening it — a pass
  spends Gemini quota and rewrites the storyline graph. The `x-vercel-cron-schedule` header is read
  for pass *selection* and is never an authenticator; it is client-settable, and Vercel's own cron
  sends the bearer token for that.
- **GET and POST both**, unlike the drain's POST-only. The drain refuses GET against a crawler
  following a link by accident; this route is behind the same bearer check, and Vercel's own cron
  sends GET and nothing else.
- **An unknown pass is the one thing that is not a 202.** It answers 400 and lists the names, because
  the 202 contract would otherwise swallow a scheduler misconfiguration forever. There is deliberately
  no default pass: the two composites cost hours and money respectively, and "the cron entry lost its
  query string" must not silently become "run the expensive one".
- **`?max-labels=` and `?changed-only=`** are the query twins of `--max-labels` and
  `--changed-only`/`--full`. Naming `late-candidates` as the pass runs the sweep regardless of
  `STORYLINE_LATE_CANDIDATE_SWEEP` — that IS the deliberate operator act the gate protects.

## `chore_runs`, and why it is not optional

Migration 0018. Every run writes a row: pass, source (`route` or `cli`), started/finished, outcome,
the report summarized, and the label pass's model calls hoisted into their own column — the one
number in a report that is a *cost* and gets summed across rows.

"Summarized" is a size bound, and it is load-bearing: several report members are the identities of
everything a pass touched — the retention report's idle-topic fingerprints, the bridge sweep's
survivors, the label merge's survivors and refusals — and on a backlog night that is thousands of
UUIDs per row, in a table with no prune. Any array past `REPORT_ARRAY_CAP` becomes `{count, sample}`,
as a general rule rather than a list of known members: a per-shape summarizer is a thing five report
types can each grow past without anybody noticing, and the failure is silent and cumulative.

It exists because the two properties above compound. The route always answers 202, so the scheduler
never sees a failure — and Hobby retains logs for **one hour**, so a pass that failed at 03:00 leaves
no trace by 04:01. "Did last night's chores run?" is unanswerable by construction without this table.

**The row is opened before the pass and closed after it**, which is one write more than the scope doc
specified and buys the failure that write could not record: a function killed at `maxDuration` runs
no `finally`, so an end-only write would leave nothing at all — and a killed night would look exactly
like a night nothing was scheduled. `finished_at IS NULL` on an old row is a positive statement
instead. `outcome` is `ok | failed | skipped`, and `skipped` is first-class because the lock makes it
a *normal* outcome: recorded as a failure it would train an operator to ignore failures, recorded as
a success it would hide a run that never finishes and therefore makes every later night skip.

The CLI writes here too. A table that only knew about the route would answer the question for the
Vercel half of the system and lie by omission about the other half — and they share a database.

```bash
pnpm chores status --pass=storylines --limit=5
```

## The pause guard — `POST /api/keepalive`

A `select 1` through the transaction pooler, on its own daily schedule, deliberately sharing no code
path with the chores. Supabase does not promise that pg_cron's internal activity prevents the 7-day
free-tier pause: it defines inactivity as insufficient *user* database activity and prescribes
external requests. The chore route's own pooler queries qualify — but only on nights the chore runs
and reaches the database, which would make "the database stays awake" a downstream consequence of the
most complex nightly job in the system. A label pass failing for a week is a bad week; a label pass
failing for a week that also lets the database pause is a bad week that ends with the deployment down.

Unlike the chores it answers **synchronously**, and that is the point: a ping whose result is not in
the response cannot tell a paused project from a healthy one. It is authenticated by the same secret,
with the same fail-closed rule — and the cost is worth being explicit about: **a project with no
`CRON_SECRET` has no pause guard**.

**Not scheduled yet.** [supabase-cron.sql](../deploy/vercel/supabase-cron.sql) is written and has not
been run against any Supabase project, so as of now nothing fires any of this on a timer.

## The ingest drain

`POST /api/drain`, authenticated with `Authorization: Bearer $CRON_SECRET`.

**What it is for.** A failed ingest delivery is retried by the platform three times over ~610 s and
then given up on (VERCEL-ALL-IN-SCOPE §3.2). After that, recovery is *incidental*: the pending entry
is left unsettled, `meta.ingest` reports the work owed, and the next reader of that topic re-plans
the gap against §6.3's coverage frontier. That works beautifully for a topic somebody reads again
soon, and not at all for one nobody does. This route is the deliberate version.

**Why a route and not a chore pass.** The drain is a Redis read followed by upstream fills, which is
exactly the dependency the chores are built not to have. Making it a pass would mean widening
`ChoreDeps` for one member and giving `chores-cli.ts` a hard Redis dependency it currently does
without. It borrows the chores' *shape* — one authenticated endpoint, a structured tally in the log,
no user waiting — and none of their dependencies.

**The age floor is the whole safety argument.** It only considers entries older than
`DRAIN_MIN_AGE_MS`, which is `INGEST_RETENTION_SECONDS` exactly — the TTL every message is published
with. An entry past it names work whose message has certainly expired from the topic. Below that
line the platform may still be retrying, and a fill there would spend upstream quota on a segment
the queue is about to deliver anyway: the one failure mode that would make this route worse than not
having it. This is asserted directly in [drain.test.ts](../apps/api/src/drain.test.ts), not left to
a comment.

**Which topics it can actually help, and why that is lucky.** The stale prune is not a background
job — it is a `zremrangebyscore` inside `PendingSet.count`, so it fires *on read*. A topic with
traffic calls `count` on every `meta.ingest` read and therefore erases its own ledger within five
minutes; a topic with no traffic never calls it, so its entries persist indefinitely. The drain is
consequently blind to hot topics and sighted for cold ones — which is the right way round, because
hot topics are exactly where incidental recovery already works. The two mechanisms are
complementary rather than redundant.

**One attempt per entry, settled either way.** There is no dead-letter queue, so the bound lives in
the drain: a failed fill is settled anyway. Leaving it would re-fill the same poisoned segment on
every pass and spend quota each time. It costs nothing observable, because the entry is already past
the TTL and the next `meta.ingest` read would have pruned it as stale residue regardless — and the
gap it named is still re-planned by the next reader.

**Bounds.** `DRAIN_MAX_JOBS` (50, overridable downward with `?limit=`) and `DRAIN_DEADLINE_MS`
(240 s inside the 300 s ceiling). The deadline is checked *between* jobs and never inside one: a
fill that has started has already spent its quota, so abandoning it would lose work already paid
for. A truncated pass says so in its report and the next pass picks up the rest.

**No advisory lock, deliberately.** Two concurrent drains would each read the ledger and race on the
same entries, and the cost of losing that race is one duplicated fill — which ingestion is already
idempotent against (§7.4), the same property that makes at-least-once delivery safe. A lock would
buy nothing the fills do not already give, and would need the Postgres connection the drain
otherwise does not hold open.

**Fail-closed auth.** `CRON_SECRET` is optional in config and mandatory at the route: unset disables
the drain rather than opening it. This is the only surface in the system that spends upstream quota
without a user having asked, which is also why it is `POST` — a `GET` is the shape a crawler or link
preview follows by accident.

**Requires `INGEST_QUEUE_DRIVER=vercel`,** and refuses to boot otherwise. Not for symmetry with the
consumer: `DRAIN_MIN_AGE_MS` is derived from the *hosted* driver's retry budget, and under BullMQ the
budget is three attempts of exponential backoff from 200 ms, so a 900 s floor would describe nothing
that driver does. A drain there would also be redundant, because Redis *is* the queue and its
retries work.

## Scheduling both

Supabase Cron (pg_net) is the intended driver for both, at minute precision. Hobby's Vercel cron is
once a day ±59 min, which is fine for the chores and useless for the half of the drain's job that
needs a tighter cadence.

[supabase-cron.sql](../deploy/vercel/supabase-cron.sql) is the whole thing, ready to paste into the
SQL editor after two placeholders. **It has not been run against any project yet**, so nothing is on
a timer today.

| | Schedule | Why |
|---|---|---|
| `/api/chores?pass=retention` | `0 3 * * *` | a report, not an action — and the schedule this pass has always run on |
| `/api/chores?pass=storylines` | `0 4 * * *` | converges night over night; the label pass costs money. An hour after retention, because the prune moves the corpus the linker judges against |
| `/api/keepalive` | `0 12 * * *` | daily, not weekly: a guard with one chance a week has no margin for the week it fails |
| `POST /api/drain` | `*/10 * * * *` | anything slower and only cold topics are ever covered |

Two things that are easy to get wrong and are written into that file. **`timeout_milliseconds` must
be raised** — pg_net's default is 2000, and a cold 202 is a Node boot plus TLS plus config parsing
against a ~550 ms platform container floor; a timed-out request is a night that silently did not run.
And **pg_cron reads these expressions in the database's timezone**, UTC on Supabase, which is what the
passes' day bucketing assumes.

## The pending window, and why it is 15 minutes

Raising the ingest message TTL to 900 s left `STALE_PENDING_MS` at 5 minutes, **shorter than the
retry budget it used to bound**: the stale prune fired at 300 s and the second delivery did not land
until 305 s, so a pending entry was deleted as crashed-consumer residue 5 s before the queue retried
the job it named. **Resolved 2026-08-25 by raising `STALE_PENDING_MS` to 15 minutes**, matching
`INGEST_RETENTION_SECONDS`. The reasoning is worth keeping, because the obvious reading of it is
wrong twice.

**The consequence was not an early-stopping poll loop.** That is what the code comments said, and
`INGEST_POLL_MAX` disproves it: the web client polls 40 times at 1.5 s and gives up after ~60 s —
240 s before the prune could ever fire. No spinner was ever cut short. What saw the premature prune
was [`timeline-service`](../apps/api/src/timeline-service.ts)'s cache gate, which writes only a
`complete` page. A pruned count reads `complete`, so an incomplete page was **written to the cache as
settled — for up to 24 hours on the historical freshness tier**, and the retry's fill stayed
invisible until it expired.

**So under-reporting was not the fail-open direction here.** `pendingJobs > 0` can only suppress a
cache write and hold `in_progress` longer; it costs latency and quota and cannot serve a wrong
answer. `pendingJobs == 0` when work is still owed persists one. That inverts the §3.4/§3.5
comparison the deferral rested on — those fail open toward *answering with less*, not toward
*writing something untrue* — and it is why the window went up rather than staying put.

The price, paid deliberately: a genuinely crashed consumer now holds a topic at `in_progress` for 15
minutes rather than 5, suppressing caching for that whole time.

**Why it stayed one shared constant.** `PendingSet` is shared with the BullMQ driver, whose retry
budget is ~600 ms (`attempts: 3`, exponential from 200 ms), so 15 minutes is far past anything that
transport needs — a per-driver window is the alternative. It was not taken because under BullMQ this
window is pure crashed-consumer GC, and what a crashed consumer costs is a function of deploy-recycle
time, the same wall clock under both transports. Per-driver buys a faster local-dev recovery and
nothing else.

**What it fixed for this route.** The drain's floor is `INGEST_RETENTION_SECONDS` (900 s), so the
prune and the floor now coincide. The safety argument is untouched — the floor is against the message
TTL, and that has not moved — but while the prune fired at 5 minutes it erased every entry on a read
topic *before* the drain was allowed to look at it, so this route could only ever have helped topics
nobody reads. `drain.test.ts` now pins `STALE_PENDING_MS >= DRAIN_MIN_AGE_MS` so that cannot come
back.
