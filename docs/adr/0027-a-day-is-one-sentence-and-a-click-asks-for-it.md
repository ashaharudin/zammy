---
status: accepted
---

# A day is one sentence, and a click asks for it

Two changes to the historical preserve
([ADR-0023](0023-a-days-coverage-is-preserved-as-a-sentence.md)), taken together
because the first is what makes the second affordable:

1. **The six-hour quarters are gone.** A storyline-day is summarised by one
   model call over its own articles. It was four calls over four quarters plus
   a fifth over their sentences.
2. **Opening a storyline submits its unsummarised days.** The click that already
   queues a refresh ([ADR-0017](0017-opening-a-storyline-queues-its-own-refresh.md))
   and a deepening fetch ([ADR-0019](0019-a-fetch-carries-its-own-reason-and-its-own-coverage.md))
   now queues a third thing: the arc's own qualifying days that have no sentence.

## Why the quarters go

**Nothing ever read them.** ADR-0023 shipped them as a historical record and as
the day sentence's input, and the reading half never arrived: the storyline view
draws the *day* sentence beside each day's heading and nothing else, and
ADR-0023's own consequences say why it never will — "the rail already cuts a day
into the parts of the READER's day. Four UTC quarters drawn against four local
parts is two divisions of one day on top of each other."

So four fifths of every day's cost bought an input to the fifth call and a row
nobody would ever see. That is a defensible trade if the input is what makes the
fifth call good, and the argument that it did is the one worth examining rather
than the cost:

> The **day** call is over the quarters' own sentences: ~150 tokens instead of
> ~3,000, and consistent with them by construction.

Both halves of that are true and neither survives the quarters being unread. The
token saving is a saving *against the four calls that produced the sentences* —
it is cheap only if you have already paid for them. And "consistent with them by
construction" is consistency with rows no reader can see; what a reader can
check is the sentence against the day's coverage, which is exactly what the
articles path compares.

**The fallback was already the real path for a third of the window.** A day past
`SUMMARY_CLIFF_DAYS` got the day sentence alone, from its articles, because
Google News drops the pubDate time beyond ~8 days and stamps 89.4% of those rows
midnight US Pacific. That path has been writing day sentences in production
since the feature shipped, under the same prompt and the same contract. This
change does not introduce it; it promotes it, and deletes the branch beside it.

**What is lost, stated rather than waved past.** A busy day used to reach the
model as four samples of eight articles and a synthesis over the four answers.
It now reaches it as one sample of twelve. That is less of a busy day's coverage
seen, and it is a real reduction in fidelity for the busiest arcs — the ones
where four quarters genuinely held four different developments. The exchange is
that every day gets a sentence far sooner: at the same token spend on the same
key, the pass writes about three times as many days an hour (see *The budget*
below), and the days that had no sentence at all were the loudest complaint the
feature had.

### What happens to the rows already written

**They stay.** The `segment` column keeps its five values, the quarter rows in
production are not deleted, and `writeStorylineDaySummary` still takes a
segment. Nothing writes a non-`day` segment any more.

This is not indecision. These rows cannot be rebuilt — the model calls that
produced them are spent and the articles behind them will age out under
retention, which is migration 0024's whole argument for the table's unusual
shape. A migration that dropped them would be the one destructive act in a
schema whose every other `down` is recoverable from `articles`, in exchange for
a column and some dead rows. `readArcDaySummaries` has always selected
`segment = 'day'`, so the reading path needed no change at all.

Two consequences follow, and both are handled rather than accepted:

- **`segmented` is carried forward, never re-derived.** The column records
  whether a day's coverage could be placed in time. Nothing new can claim that,
  so a first write is `false` — but a rewrite of a day that HAS quarter rows
  keeps whatever the row already said. Stamping `false` over a day with four
  quarter sentences beside it would make the one column whose whole job is to
  not lie about the past start lying about it.

  Two edges where it is approximate rather than exact, both narrow and both
  accepted: a pre-ADR-0027 day recomputed inside its settling window carries
  `true` onto a sentence written from 12 articles, and a day whose quarters were
  written but whose `day` call never landed gets a first write of `false` beside
  them. So `segmented = true` means "this row's day has quarter rows", which is
  what a reader of the table can act on, rather than "this sentence was built
  from them".
- **`summaries:storylines --show` still prints the segment**, with a footnote
  saying what a quarter row is. Collapsing them would make the same day appear
  twice for no stated reason.

## Why a click may spend model calls

ADR-0017 established the principle and this is an application of it: opening a
storyline is a real demand signal, the most-clicked arcs are the ones worth
keeping current, and a click is allowed to cost something. What is new is the
budget being spent. A refresh spends the news quota; this spends the model key.

**What made it affordable is the first half of this ADR.** A day cost up to five
calls and costs one, so a reader's whole click — eight days — costs about what
one and a half days used to. Proposing this against the old shape would have
meant forty calls behind a single anonymous POST.

**What the nightly pass cannot do, and this can.** The pass walks
`SUMMARY_WINDOW_DAYS` (8) back from today across every arc. A day older than
that is never selected again: ADR-0023 says "everything older is the backfill
CLI's business", and the backfill CLI is a command somebody has to type. So an
arc promoted late, or one whose back-history arrived in a burst, has days that
nothing automatic will ever summarise. A reader opening that arc is looking
straight at them.

### What a click is allowed to do, and what it is not

**The arc's whole history**, bounded by `SUMMARY_CLICK_MAX_DAYS` (8) per open,
newest day first. No window: the window exists to bound UNATTENDED spend across
every arc, and a click is one reader asking about one arc. The rest waits for
the next open, which is a deferral and not a loss — a reader who keeps coming
back to an arc is exactly the reader whose arc is worth summarising.

**First writes only**, with one consequence stated below. A click never retries
a refusal and never recomputes a day that gained articles. Both belong to the
nightly pass, and the reason is `SUMMARY_MAX_ATTEMPTS`: a refusal has three
asks before the span is retired for ever, a reader can open an arc as often as
they like, and three opens would
spend the whole budget on a table nothing can rebuild. `onlyMissing` is that
rule, and `readArcDaysAwaitingSummary` enforces it again in SQL by selecting on
the absence of a row — so a row with a null summary counts as having one.

**Today is excluded**, exactly as the nightly pass excludes it: a day is
summarised once it has finished, or the sentence describes a fraction of its own
span and then freezes.

**Nothing at all with `SUMMARIES_ENABLED=false`.** The flag exists so the feature
writes nothing unattended before an operator turns it on, and a click is no more
attended than the cron is — the reader asked for a storyline, not for a model
call. The gate is at the PLANNER, so a deployment that has not turned it on
never publishes the message.

### Where the work runs, and why it is on the ingest queue

On the existing `ingest` topic, through the existing consumer, as a fourth job
kind. That queue's subject is deferred *ingestion* and this job calls no provider
and writes no article, so the exception is worth naming: what it needs is exactly
what the queue already is — at-least-once delivery of work a request path must
not wait for, deduplicated by a content address, behind a function with 300 s
rather than the API's 60. A second topic would have bought a second Vercel Queues
topic, a second consumer deployable and a second set of redelivery semantics, to
carry one job kind arriving on the same trigger as the `deepen` beside it.

**The job's identity is the arc and the MINUTE it was asked in** —
`sum_<uuid>_<snapped ms>`. Readers opening one storyline inside a minute collapse
into one job; the next minute's click is a different message.

That clock was not in the first version of this ADR, and leaving it out was a
bug worth recording because the reasoning was plausible and wrong. The intent was
"collapse while a job is outstanding, queue again once it is not", and the
transport does not work that way: `enqueueSummarize` publishes under
`idempotencyKey: ingestJobId(job)` with `retentionSeconds:
INGEST_RETENTION_SECONDS`, so the dedup window is a fixed **900 seconds from the
publish**. `ingest-queue-vercel.ts` already said so — "a re-plan inside that
window is deduplicated against this very message and never sees a delivery — it
only re-adds the pending entry".

So under the arc-only address a cold arc drained at `SUMMARY_CLICK_MAX_DAYS` per
**fifteen minutes** however often a reader opened it, which is ~15× slower than
"the rest waits for the next open" describes. Worse, the swallowed republishes
left pending entries that only `api/drain.ts` would later collect — making the
manual drain route the click plane's real executor on a hot arc, a path nothing
here intended and nothing there is sized for.

A minute is the same grid ADR-0017's freshness gate uses, and deliberately not
`WINDOW_SNAP_MS` (15 minutes), which would reproduce the stall exactly.

**The days are planned in the CONSUMER, not in the payload.** A payload naming
its days would be a plan made at click time and executed later, so two clicks a
second apart would carry the same days and spend twice. Planning at the far end
also makes redelivery free: Vercel Queues do redeliver, a consumer's 200 proves
nothing about the lease, and the second delivery simply reads what the first one
wrote.

**The planner does not check whether there is work.** Asking "does this arc have
unsummarised days?" on the request path would put a grouped scan over the arc's
whole history on a fire-and-forget POST a reader is waiting behind, to save a
Redis publish. A warm arc costs one delivery and one query at the far end.

### One lock, per arc — and not the nightly pass's

Two different races, answered differently.

**Click against click needs a lock**, and an earlier draft of this ADR argued it
did not. That argument rested on the queue's dedup making a collision rare —
"one job per arc while one is outstanding" — and snapping the job's clock onto a
minute grid is exactly what removed that property. Two clicks either side of a
minute boundary are two live messages with different keys, and on a push-mode
queue each delivery is its own invocation: both plan the same unsummarised days,
because neither has written yet, and both call the model for every one of them.
`onlyMissing` does not prevent it — both read before either writes — so the
collision is up to `SUMMARY_CLICK_MAX_DAYS` duplicated calls, not the one the
draft claimed. The fix removing the dedup is the fix that has to restore the
guarantee, so `runSummarizeJob` takes a per-arc `tryAcquire` for the length of
the job. `storyline-deepening.ts` single-flights the same way on the same
subject.

It **returns** when the lock is held rather than throwing, which is where it
differs from the deepening consumer. A throw would spend one of three deliveries
to discover another job is already doing this arc; the days the holder does not
reach are picked up by the next open, which is the deferral this plane is built
around. The deepening consumer throws because its job names a SPAN that nothing
else will re-plan.

**Click against the nightly pass needs no lock.** It only writes days with NO
row, so the sentence it could overwrite does not exist when it plans;
`writeStorylineDaySummary` refuses in SQL to let a null summary replace one that
stands, which is the one unrecoverable outcome; and the worst collision is the
pass and a click both writing a first sentence for one day, which costs one
duplicate call and leaves a valid sentence either way. Taking
`CHORE_LOCK_KEYS.summaries` instead would drop every click during a five-minute
nightly pass to prevent that.

### The budget is sized by the DRAIN, not by the consumer

`SUMMARY_CLICK_BUDGET_MS` is 45 s, and the number comes from the tightest
function this job can land on rather than the obvious one. A job orphaned in the
pending set — a same-minute republish that arrived after that minute's job had
settled — is collected by `api/drain.ts`, whose `DRAIN_DEADLINE_MS` is 240 s
against a 300 s `maxDuration` and is checked BETWEEN jobs. Its own comment sizes
that 60 s gap as "room for one long fill plus the response". With the abort ten
seconds past the budget the worst case is ~55.5 s, which fits; at the 120 s this
first shipped with it was ~130 s, which did not, and being killed there costs
every later entry in that pass its settle.

45 s is not tight for the work — 8 calls at `SUMMARY_MAX_RPM` 18 is ~24 s
including latency. What it gives up is headroom for an unusually slow model, and
that costs a click some of its days rather than anything durable.

## The budget

`SUMMARY_DAY_SAMPLE` (12) and `SUMMARY_MAX_RPM` (18) are two halves of one
number and must move together. The key meters input tokens as well as calls —
16k a minute — and the pacer counts only calls, so a sample raised on its own
buys a rate limit nothing in the process can see. Measured under the quarters at
~490 tokens a call, an article is ~60 of that: 12 articles is ~820 tokens, and
18 calls a minute is ~14.8k, which is the ~14k the old shape sat at.

The rate went DOWN and the throughput went up. 28 calls a minute at five calls a
day was ~5.6 days a minute; 18 calls a minute at one call a day is ~18. A
275-second firing reaches ~82 days where it used to reach 14-25.

`SUMMARY_WINDOW_DAYS` keeps its 8 and loses its reason. It was deliberately equal
to `SUMMARY_CLIFF_DAYS` so that the pass covered exactly the span over which
quarters were honest, and the cliff is gone with them. What justifies it now is
the split this ADR creates: the window bounds unattended spend, the click bounds
attended spend, and completeness has its own path for the first time.

## Consequences

- **`SUMMARY_CLIFF_DAYS` is deleted.** It gated nothing else.
- **`SUMMARY_SEGMENT_SAMPLE` becomes `SUMMARY_DAY_SAMPLE`** and its default moves
  from 8 to 12. Neither is set in production, so both ship on the next deploy.
- **A click can be refused and the reader will never know**, exactly as ADR-0017
  accepted for the refresh plane: a 404 on a stale UUID, a 429 from the per-IP
  ceiling, an offline tab. The browser's fetch has no error path on purpose, and
  the un-summarised arc is the status quo this replaced.
- **The wire contract is unchanged.** No storyline shape gained a field and the
  browser was not touched: the click already POSTs to
  `/api/v1/storylines/:id/refresh`, and this is a third plane inside that route.
  The 202's body gains a `summaries` key beside `deepening`, for operators and
  tests.
- **Across ARCS the per-IP ceiling is the only bound**, and the arithmetic is
  ADR-0017's with a different unit: every open of a distinct UUID is its own 8
  calls, and UUIDs are public on every timeline page.

  The pacer is **not** a second guard, and the obvious reading that it is was in
  an earlier draft of this ADR. `createPacer` keeps its window in memory and is
  built once per process, so concurrent consumer invocations are concurrent
  pacers: `SUMMARY_MAX_RPM` bounds one job, never the key. At
  `RATE_LIMIT_PER_MINUTE` 120 the demand one IP can queue exceeds what the key
  allows in a day.

  What absorbs the excess is the model refusing, which reads here as
  `unavailable` — no row, no attempt, nothing corrupted — while the labeler's
  promotions fall back to the bigram extractor. So the failure mode is degraded
  labels rather than lost history or an unbounded bill, which is the same
  exposure ADR-0017 accepted; a global daily ceiling is the fix if it bites. The
  honest new fact is that this budget is shared with the labeler *in the same
  minutes*, where ADR-0017's refills daily.
- **`storyline open: what the click's summary job wrote` is the only report this
  plane has.** It writes no article, touches no coverage row and answers no
  request, so the consumer's log line is it. `planned` high with `stoppedBy:
  max-days` is a cold arc draining over several opens, which is the design;
  `planned: 0` on most lines is the warm archive this should settle into.
- **A refusal on a day outside `SUMMARY_WINDOW_DAYS` is retried only by hand.**
  The click writes the row and then excludes that day from every later click;
  the nightly pass never selects a day that old. So out-of-window days get one
  automatic ask rather than the three `SUMMARY_MAX_ATTEMPTS` implies, and the
  other two are reachable only through `pnpm summaries:storylines --from=…`,
  which does select them and does read the row as a retry.

  Accepted rather than fixed: before this ADR those days had no automatic ask at
  all, so the floor has risen, not fallen. The measured contract-failure rate is
  ~6.7%, which is the share of newly-reachable old days that land a refusal
  instead of a sentence.
- **A day summary written today and one written last month were produced
  differently**, and nothing in the row settles which. `model_id` and
  `generated_at` are what an operator has. `segmented` narrows it and does not
  decide it: `true` means that DAY has quarter rows, so the day was reached
  before this ADR — but the sentence beside it may still have been written today,
  because a day inside its settling window can be recomputed and carries the
  column forward. See the two edges above.
