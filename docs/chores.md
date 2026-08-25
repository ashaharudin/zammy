# Chores and the ingest drain

The scheduled background work: what runs, what it depends on, and why the ingest drain sits beside
it rather than inside it. Source of truth is [chores.ts](../apps/api/src/chores.ts),
[chores-cli.ts](../apps/api/src/chores-cli.ts) and [drain.ts](../apps/api/src/drain.ts); this page
is the map, not a second copy of the reasoning in those files.

## Two things on a schedule, and they have nothing in common

| | Chores | Ingest drain |
|---|---|---|
| Entry point | `chores-cli.ts` (Compose) / §3.3's route (unbuilt) | `api/drain.ts` → [drain.ts](../apps/api/src/drain.ts) |
| Touches | Postgres, and Gemini for labels | **Redis**, and the upstream news API |
| Exactly-once | Postgres advisory lock, one key per pass | none needed — see below |
| Cadence | nightly | as often as every ~5 min, if you want hot topics covered |
| Spends money | yes, the label pass | yes, every fill |
| Built? | yes as a CLI, **not** as a route | **yes, as a route** |

They are on this page together because they are both "work on a timer that no user is waiting for",
and that is the *only* thing they share. Every dependency, bound and failure mode differs.

## The chores

`chores-cli.ts` exposes two passes, `retention` and `storylines`, and the seven exported chore
functions distribute across them. The runner takes a session-scoped Postgres advisory lock per pass
([chores-cli.ts:58](../apps/api/src/chores-cli.ts:58)) — `pg_try_advisory_lock`, so a second
concurrent run *skips* rather than queues. That lock is what replaced BullMQ's exactly-once when the
clock moved outside the app, and it matters most for the label pass, which spends real money per
call.

**`--pass retention`** runs [`runRetentionChore`](../apps/api/src/chores.ts:90) alone. It reports;
it does not delete. Deletion is a separate deliberate decision (ADR-0001), so the numbers have to be
visible long before any code acts on them.

**`--pass storylines`** runs [`runStorylinePass`](../apps/api/src/chores.ts:786), which is six steps
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
   that costs money per call, bounded by `--max-labels` (40–60 fits) and paced at
   `GEMINI_MAX_RPM`.
5. [`runLabelMergeChore`](../apps/api/src/chores.ts:496) — **last**, because it is the only pass
   whose input is a label: a storyline named tonight should be a merge candidate tonight. This is
   what makes the whole thing converge, each night's labels being the next night's candidates.
6. [`runStorylineGraphChore`](../apps/api/src/chores.ts:652) — reads the graph's shape, changing
   nothing, so the row describes the archive the night *leaves* rather than the one it found.

**The property worth protecting: no chore touches Redis.** [chores.ts:58](../apps/api/src/chores.ts:58)
states it outright — the runner needs no cache, no queue, and no `REDIS_URL` that resolves to
anything — and `ChoreDeps` is `{ db, config, now, log }` with no client to give one. That is what
makes the chores runnable as a bare one-shot process against nothing but Postgres.

**Not built yet:** the §3.3 HTTP route, its schedule, and the `chore_runs` table. Until those land
the chores run only as a CLI, which on a Vercel deployment means they do not run at all — and the
Supabase free-tier pause guard comes with them.

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

| | Suggested | Why |
|---|---|---|
| `chores --pass retention` | nightly | a report, not an action |
| `chores --pass storylines` | nightly | converges night over night; the label pass costs money |
| `POST /api/drain` | every 5–15 min | anything slower and only cold topics are ever covered |

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
