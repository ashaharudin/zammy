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
default ([chores.ts:181](../apps/api/src/chores.ts), [chores.ts:508](../apps/api/src/chores.ts)),
and the runner has no flag for it either
([chores-cli.ts:79](../apps/api/src/chores-cli.ts)).

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
| 3 | **late-candidate sweep** | **41 ms × 12,338 groups ≈ 506 s** — now **switched off** (§2.6) | linear across bounds of 250/500/1000/2000; §2 |
| 4a | label pass — the scan | **60 ms** | 8 batches over 3,938 promoted storylines |
| 4b | label pass — the model calls | **2,986 × 4 s ≈ 11,944 s** | pacing at `GEMINI_MAX_RPM=15`; §3 |
| 5 | label merge | **323 ms** | 43 shared labels, 42 merges, 32 plans |
| — | `chores retention` (the other pass) | **4 ms** | nothing yet at the 90-day horizon |

**Unbounded, the pass is ~3.5 hours.** Four of the five phases together are under half a second.
The whole cost is in two places, and they are different kinds of problem.

## 2. The late-candidate sweep is the real ceiling problem

**Resolved, and not by fitting it.** This section is left in the order it was learned, because the
order is the lesson. Read §2.6 first if you only want the answer: the sweep is gated off by default,
so the storyline pass fits Hobby's 300 s with room to spare — every remaining phase is under half a
second between them (§1) plus a bounded label pass (§3). The ceiling question was never really a
deployment question.

The sweep offers **every group in the trailing DF window** to the linker, one group per iteration
([chores.ts:183](../apps/api/src/chores.ts) bounds the window at `STORYLINE_DF_WINDOW_DAYS`, 14
today). Today that is **12,338 groups**, and at a measured **41 ms per group** the sweep alone is
**~506 s — 1.7× Hobby's 300 s ceiling, every night**, before any other phase runs and before the
function's own cold start.

Three properties make this worse than a big number:

- **It does not shrink with retention.** The window is a fixed 14 days, so unlike the corpus-size
  question (§4) this does not improve by pruning. It scales with *daily volume*, which is the one
  input we expect to grow.
- **It is one query, and that query has a fat tail.** `readCandidateStorylines` is 34 of the 41 ms;
  everything else in the sweep together is under 2 ms per group, and the per-call cost runs from
  2.5 ms at p10 to 76 ms at p90 (§2.1).
- **It has no deployment parameter.** `runLateCandidateChore` accepts `maxGroups`
  ([chores.ts:181](../apps/api/src/chores.ts)) but `runStorylinePass` calls it with the bare deps
  ([chores.ts:508](../apps/api/src/chores.ts)), `StorylinePassDeps` has no field for it, and the
  runner's usage line offers only `--label-rate` and `--max-labels`
  ([chores-cli.ts:79](../apps/api/src/chores-cli.ts)). So the lever ADR-0015 relies on for the
  label pass does not exist for the pass that needs it more.

§2.4 is what to do about it, and it is not the obvious thing. **§2.5 is why: the query at the centre
of this has been running a retrieval that discards ~90% of its candidates, which makes the ceiling
problem a symptom of a linking-correctness bug rather than a cost of the deployment target.** And
§2.6 is how that turned out — not with a faster sweep, but with the sweep switched off, which
answers the ceiling question by removing the phase rather than by fitting it.

### 2.1 Where the 41 ms goes

Attributed with Kysely's own `log` hook, so every statement in the sweep is measured rather than
inferred. 400 groups, per group:

| ms/group | calls | mean ms | statement |
|---|---|---|---|
| **33.99** | 400 | 33.99 | **`readCandidateStorylines`** ([storylines.ts:994](../packages/storage/src/storylines.ts)) |
| 0.69 | 400 | 0.69 | `readStoryDf` — the trailing corpus |
| 0.61 | 400 | 0.61 | `readGroupStorylines` |
| 0.47 | 400 | 0.47 | the `story_corpus_days` size sum |
| 0.17 | 1 | 66.48 | `readLinkableGroups` — one batch of 500 |
| 0.10 | 67 | 0.62 | `linkGroup`'s own-group count |
| ~0.09 | 76 | — | alias resolution, bridges, transaction control |

96% of wall clock is inside a driver call (14,451 ms of 15,095); only 644 ms is JavaScript. **One
query is 90% of the sweep**, and everything else together is under 2 ms per group.

That query's cost is not evenly spread. Per call, over the same 400 groups:

| | p10 | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| duration | 2.5 ms | 5.8 ms | **75.9 ms** | 93.6 ms | 114.6 ms |
| profile tokens | 12 | 19 | 29 | — | 51 |

**The mean is almost entirely tail.** The driver is profile *width*: `profile_tokens && $1` probes
one GIN key per token and unions the bitmaps, so a 51-token profile costs 114 ms while a 12-token
one costs 2.5. `CANDIDATE_LIMIT` ([storyline-linker.ts:128](../apps/api/src/storyline-linker.ts))
capped the 200 rows returned, not the ~1,200 scanned — that constant reads 4,000 today, raised by
the fix in §2.5; every number in this section predates it — the median group's profile overlaps 1,145
storylines (mean 1,194, max 3,681 over a 300-group sample), and `qualifyingStorylines` then
discards nearly all of them in TypeScript.

That last sentence is where this section stopped too early. "Caps the rows returned, not the rows
scanned" is a statement about cost; the same fact is also a statement about **correctness**, because
the 200 kept are chosen by recency rather than by anything the linking rules weigh. §2.5.

**Round trips are a second-order term, contrary to what this section first claimed.** The count is
real — 4.36 per group, from `pg_stat_database.xact_commit` deltas — so a pooler's RTT does add
~4.4 ms per group, or ~54 s over the full window per added millisecond. But that is a surcharge on
a cost that is dominated by one query executing, not by waiting for the network.

### 2.2 A denormalized sort key: tested, 8%, rejected

Worth recording as a negative result, because the plan shape is suggestive enough that someone will
try it again. `readCandidateStorylines` ordered by a correlated subquery
([storylines.ts:1015](../packages/storage/src/storylines.ts)):

```
Sort  Sort Key: ((SubPlan 1)) DESC NULLS LAST, s.id
  ->  Bitmap Heap Scan on storylines  (actual time=2.922..38.192 rows=459)
      SubPlan 1
        ->  Aggregate (actual time=0.061..0.061 rows=1 loops=459)
```

A computed sort key stops the `LIMIT` pushing below the sort, so the subquery ran once per
overlapping storyline rather than once per returned row. Denormalizing it onto
`storylines.last_coverage` — written by `refreshDaySlots` in the same statement that derives the
slots, backfilled exactly (0 mismatches across 26,010 storylines) — fixes the plan and does help
the query: at a median-width profile, `EXPLAIN` goes from 8.8 ms to 3.7 ms.

It does **not** help the sweep enough to matter. A/B on one clone, baseline measured first:

| | 500 groups | 2000 groups |
|---|---|---|
| subquery sort key | 42.5 ms/group | 40.4 ms/group |
| `last_coverage` column | 39.0 ms/group | 37.7 ms/group |

**~8%** — a uniform slice off every call, which leaves the tail intact and the sweep at ~465 s
instead of ~506.
Reverted: 8% does not earn a denormalized column with three maintenance sites. The lesson is the
one §2.1 records — the fix has to attack profile width or the number of groups offered, not the
per-call constant.

### 2.3 What the sweep achieves — measured under the bug §2.5 found

Worth putting beside the cost, because it is what decides whether the answer is "make it faster" or
"do less of it". Attachments per groups offered:

| Run | Offered | Attached | Merges |
|---|---|---|---|
| First sweep of a restored clone | 500 | 20 | 1 |
| First sweep of a restored clone | 2,000 | 68 | 4 |
| Re-sweeping the same clone | 500 | 0 | 0 |
| Re-sweeping the same clone | 2,000 | 2 | 0 |

Read at face value: ~3.5% of offers change anything on a first pass, and re-offering the same groups
with no new coverage between runs changes almost nothing — so most of the 506 s buys nothing, and
doing less of it is the obvious answer.

**That reading is wrong, and §2.5 is why.** Every number in this table was produced by a retrieval
that discards ~83% of the candidate set before the rules ever see it. Under a corrected retrieval the
same clone attaches 30.8% and merges 16.2%, and the re-sweep does *not* go quiet — it keeps attaching,
because there is a backlog of linking the thresholds already certified. The sweep is not mostly
pointless work; it is work that mostly could not complete. The table is left here because it is what
was measured, and because the gap between it and §2.5 is the finding.

### 2.4 What the unscoped work actually is

Something has to change. Three candidates, and §2.5 reordered them — what looked like the cautious
option turned out to be both the largest win and the one that needs no trade at all.

**1. Narrow the candidate retrieval to the tokens that can anchor (§2.5).** Free and lossless by
proof, and a correctness fix rather than an optimisation, which is why it stopped being third on this
list. Its condition was never the retrieval but the *drain*, and the drain is what settled this
whole section: validating it on graph shape rather than on speed is what found the runaway in §2.6.
**It did not make the sweep faster.** It shipped for the birth path and the sweep was switched off.

**2. Offer fewer groups.** What §2.3 pointed at, and still worth having — a filter for groups whose
candidate set could have changed, or the inverted form that offers late candidates when a storyline
changes rather than sweeping for them nightly (the shape
[PR #114](https://github.com/ashaharudin/zammy/pull/114) used for the label-agreement merge). But its
case rested on a yield figure measured under the cap, so the "96.5% of this buys nothing" argument no
longer holds as stated, and it now competes against a sweep that already fits. Follow-up research
prices the inverted form at ~3–4 days and puts it third of four, behind a cheaper forward re-offer
when a *group's* membership changes; it also **requires** option 1 first, or it hands correct offers
to a `linkGroup` whose capped retrieval cannot act on them.

**3. Bound it and make it resumable.** `runLateCandidateChore` already accepts `maxGroups`
([chores.ts:181](../apps/api/src/chores.ts)); it would need a field on `StorylinePassDeps`, a
`--max-groups` flag, and a persisted cursor, because the sweep restarts from the window's start on
every run ([chores.ts:193](../apps/api/src/chores.ts) seeds the cursor from the window, not from
where the last run stopped). A bound *without* the cursor turns an over-deadline pass into a silently
incomplete one: at ~290 s of usable budget it would offer the newest ~7,000 of 12,338 groups every
night, never reach the rest, and report a clean `offered: 7000` while doing it.

This third one changes no decision and needs no argument to justify, which was its whole merit while
the pass did not fit. It is now moot in the near term for a different reason: the pass does not run
(§2.6). It comes back the day the sweep is switched on again, and on that day it is not optional —
§2.6's runaway was found by removing exactly this kind of bound.

### 2.5 The cap that made the sweep look necessary

Follow-up research into option 2 turned up the reason option 1 exists. The load-bearing claims below
were re-verified here rather than taken from it, because two projections earlier in this document's
own history were wrong by 4× and 12× from extrapolating a single sample.

**`CANDIDATE_LIMIT` is not a safety valve.** `readCandidateStorylines` retrieves by
`profile_tokens && $tokens` ordered by last coverage, `limit 200` —
[storyline-linker.ts:128](../apps/api/src/storyline-linker.ts), whose comment describes it as
protection against a pathological token. Measured, it binds on **399 of 400** groups. §2.1 already
recorded the input without drawing the conclusion: the median group's profile overlaps 1,145 live
storylines, so the limit discards ~83% of the candidate set on a typical group, ordered by recency
rather than by anything the linking rules weigh.

**The harness that pinned the thresholds has no cap.**
[storyline-replay.ts:149](../apps/api/src/storyline-replay.ts) unions candidates over every profile
token with no limit, and its comment says the retrieval is "exactly what `profile_tokens &&
story_tokens` returns" — accurate about the predicate, silent about the `limit 200` the service adds.
So production has been running a **capped** decision against thresholds certified on an **uncapped**
one. Both halves of this were read directly.

**The fix is a necessary condition, not a second decision.** `qualifyingStorylines` rejects a
candidate when `evidence.anchorDf > bar.ceiling`, and `anchorDf` is the df of the *rarest shared*
token ([storyline-link.ts:214](../apps/api/src/storyline-link.ts),
[storyline-link.ts:150](../apps/api/src/storyline-link.ts)). So a qualifier must share at least one
token whose window df is at or below `anchorCeiling(corpusSize, rules)` —
`max(anchorDfFloor, corpusSize × anchorMaxShare)`, today `max(10, ~15,000 × 0.002)` ≈ 30
([storyline-link.ts:90](../apps/api/src/storyline-link.ts)). The dormant bar only divides that
ceiling further, so the non-dormant ceiling is the loosest bar any candidate faces. Probing with that
subset is the same kind of bound `profile_tokens &&` already is, and it is free: `readTrailingCorpus`
runs before the retrieval, so the df map is already in hand.

Measured, and then re-measured on a full census rather than a sample: the cap binds on **12,266 of
12,366** window groups (99%), median overlap 1,903 storylines, so the truncation is ~90% rather than
the ~83% a 300-group sample suggested. The anchor-eligible subset is 7 tokens at p50 against a
19-token profile, and the query goes **34.9 → 2.2 ms mean** (15.8×), with **0 qualifiers lost and
1,147 gained** over 800 groups. §2.2's denormalized column bought 8% on the same query and needed a
schema change; this needs neither.

**One implementation condition, and it is where this would quietly go wrong.** `linkEvidence` scores
a token absent from the df map as `Math.max(1, … ?? 1)` — df 1, "genuinely the rarest thing there is"
— so an absent token is *always* anchor-eligible. The filter must read "df ≤ ceiling **or** absent
from the map", never as a pass over the map's entries. Measured 0 absent across 8,243 profile tokens
on this corpus, and it is close to guaranteed by construction since the df counters are written on
the same write as the tokens — but that is corpus luck plus a gap `recordStoryDfForArticles`
explicitly tolerates, and the failure mode is a silently missed link on the rarest vocabulary there
is.

### 2.6 The drain, and why the sweep is switched off

The outstanding question in §2.5 was whether the unblocked backlog is safe. It is not, and the way
that was missed twice is the most transferable thing in this document: **every measurement that
looked safe was a single pass, or was bounded to 2,000 groups.**

Run the corrected sweep repeatedly over the full window, which is what a nightly chore does:

| | largest arc | live storylines |
|---|---|---|
| baseline, any number of passes | 124 | 17,008 |
| narrowed, bounded to 2,000 groups, four passes | **124** | converges cleanly |
| narrowed, full window, pass 1 | 588 | |
| narrowed, full window, pass 2 | 906 | |
| narrowed, full window, pass 3 | 1,214 | |
| narrowed, full window, pass 4 | **1,347** | 10.7% of the window in one arc |

The `maxGroups: 2000` bound is what hid it — the same four passes under that bound never leave 124.
An intermediate run at that bound saw 124 → 157 → 201 and read it as mild; the full window is a
runaway. And **per-offer cost *improves* as the graph degrades** (17 → 4 ms), because a collapsing
graph has fewer distinct arcs to retrieve — so "the sweep now fits the ceiling" was reading the one
metric that gets better as the thing gets worse. That is why the ~275 s figure this section used to
carry is gone rather than merely revised.

The mechanism: `bridgePairs` is the full O(n²) cross-product over a group's qualifiers, so widening
the qualifier set grows pairs superlinearly, more pairs reach `STORYLINE_MERGE_BRIDGES` (K=2), each
merge unions two profiles, and a wider profile overlaps more on the next pass. A feedback loop
*across* passes, which single-pass measurement cannot see. **The 200-row cap was doing the bounding
K was believed to be doing.** Re-offering the same group is *not* the driver —
`recordBridge` inserts with `onConflict().doNothing()` on `(lo, hi, group_id)`, so a repeat offer is
idempotent; the driver is qualifier width feeding a quadratic pair generator.

Hand-reading the results says both things are true at once: the new 151-group FIFA/Infantino arc is
coherent across all 151 groups, a genuine link the cap was suppressing, while the 201-group arc
chains Gaza, the Israel-Iran war and Russia-Ukraine through shared diplomatic vocabulary. The replay
at the pinned bar says the largest arc should be **50**.

**So the fix split in two.** The retrieval narrowing ships unconditionally, because it repairs the
*birth* path to match the candidate set the thresholds were certified against — and the replay is a
faithful proxy for that path, a single pass in publication order with no re-offer, which is exactly
why it says 50 where the sweep says 1,347. The sweep is gated off behind
`STORYLINE_LATE_CANDIDATE_SWEEP=false`, blocked on re-measuring K against a replay that re-offers,
with `--late-candidates` to run it deliberately and a gated night reporting `skipped: true` rather
than `offered: 0`.

A changed-set filter was also built and measured against this, and it is worth recording that it
makes things **worse, not safer**: a merge is what marks an arc dirty, so a filter that offers only
marked groups selects for the feedback loop. Head to head over four passes, unfiltered ends at 1,347
and filtered at **1,782**. It is off by default too.

### 2.7 The hybrid state — the one residual nothing has tested

The retrieval fix ships on the birth path on the strength of the replay, and the replay builds the
archive **from scratch**: every storyline in it was formed by the narrowed decision. Production's was
formed by the capped one. Those are different populations.

Under the cap, a group that should have joined an existing arc was often truncated out of its own
candidate list, so it seeded a **new arc instead**. Production therefore holds more arcs, each
narrower, and each one's `profile_tokens` is the majority vocabulary of a membership the correct
decision would never have assembled. From now on, new arrivals are judged by the narrowed retrieval
against those cap-shaped profiles. Neither measurement covers the mixture: the replay is
all-narrowed, and pre-fix production was all-capped.

**The replay cannot be made to see this by running it longer.** A from-scratch replay contains no
cap-created fragments, so it has nothing to fuse — and fragments that should be one arc, suddenly
able to see each other, is the whole content of the hybrid. Seeing each other is precisely the bridge
condition: `bridgePairs` records a pair per combination of a group's qualifiers, K merges a pair, each
merge unions two profiles, and a wider profile overlaps more next time.

Which means **the sweep was never the cause of §2.6's runaway, only the accelerant.** The same loop
runs on the birth path — at roughly a tenth the rate, ~1,300 new groups a day against the sweep's
~12,000 re-offers a night — and it starts from a state deliberately rich in fragments to fuse. So
§2.6's "50 versus 1,347" is not apples to apples: **50 is the steady state of a correctly built
archive**, and production is a cap-built archive having correct decisions applied forward. That
trajectory is unmeasured.

The likely outcome is benign, and worth stating so the risk is not overdrawn: these merges are
*repairs*, undoing fragmentation the cap caused, converging toward the replay's 50. The failure mode
is that fusing fragments widens profiles past the point the thresholds certify. Nobody knows which,
and the uncertainty points the same way that has already been wrong twice in this section.

**What to do, in order.**

1. **Measure it.** Entirely in memory, no database: replay from scratch *with the cap in place* to
   reproduce production's arc population, then switch to narrowed retrieval and continue with
   subsequent days, birth-only. Watch largest arc, arc count and merges per simulated day. It is the
   one configuration nobody has run, and it is a small extension of the re-offering harness the K
   re-measurement builds — the same instrument minus the re-offer, plus a cap-built starting state.
   **Held deliberately until that harness exists**, rather than building a second simulator; a forked
   simulator drifting from the service is how §2.5's bug survived.
2. **Then choose: repair, or converge.** `backfill:storylines --restart` calls `resetStorylines` and
   rewrites every storyline, eliminating the hybrid by construction — and discards all label history,
   ~3,934 promoted storylines to relabel at the free tier's 500/day, so about **eight days of quota**,
   against an ADR-0015 that calls the arcs and label history "the product". Letting it converge is
   free and probably right, but it is the option step 1 exists to justify. Choosing it before
   measuring would be the same mistake as the 2,000-group bound.
3. **Instrument it either way, and this one need not wait.** `largestStoryline` is reported in exactly
   one place — [storyline-backfill-cli.ts:246](../apps/api/src/storyline-backfill-cli.ts) — during a
   backfill. The nightly pass reports `dormant`, `bridges`, `lateCandidates`, `labels` and
   `labelMerge`; merges from the *birth* path appear in no report at all. So ADR-0011's percolation
   alarm exists only as a number a human reads after manually running a backfill or the replay
   harness, which is why §2.6 took four sessions and two wrong projections to find. Three numbers on
   the nightly report — largest arc, arc count, merges per night — turn this class of problem from
   "discovered by accident later" into "visible the week it starts". With `/metrics` deleted (§7) the
   home is the pass's structured log and the `chore_runs` row Phase 4 adds.

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
  on freshly restored and `ANALYZE`d clones; 41.3, 41.3/42.5, 40.0, 41.3/40.4 ms/group, plus 61.7 at
  250 where fixed setup is amortised over fewer groups. Round trips from
  `pg_stat_database.xact_commit` deltas; CPU from `/usr/bin/time`.
- **Sweep attribution (§2.1)**: a `Kysely` built with a `log` hook in place of `createDb`, summing
  `queryDurationMillis` per statement shape over 400 groups, plus every candidate call's duration
  and parameter length kept individually for the distribution. Overlap sizes from a 300-group sample
  of real profiles counted against `profile_tokens &&`. Both plans re-checked with
  `EXPLAIN (ANALYZE)` at a p10-width and a median-width profile — the second because the first
  measurement was taken at p10 and read as typical, which is the error §2.2 exists to record.
- **Cold start**: five fresh processes per mode, `performance.now()` deltas around each `import`.

Distrust these:

- **The machine is not the platform.** Everything here ran on an M-series Mac against Postgres on
  loopback. The sweep's projection is the number most sensitive to that, and §2.1 gives the
  sensitivity rather than a single figure for exactly that reason.
- **One sample is not a distribution.** §2.2 is in this document because the first attempt at §2.1
  reasoned from a single hand-picked `EXPLAIN`, which happened to sit at the p10 of a distribution
  whose p90 is 30× larger, and produced a projection that was wrong by a factor of four. Any per-call
  figure quoted here without a percentile beside it should be read as suspect for the same reason.
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
