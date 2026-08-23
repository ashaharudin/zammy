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

**A fourth has since been built, and it is the one §2.5 and §2.6 point at rather than any of the
three above.** `STORYLINE_MAX_BRIDGING_QUALIFIERS` bounds how many of a group's qualifiers may
BRIDGE — the input to `bridgePairs`' O(n²) cross-product, which is the quadratic term the other three
leave untouched. **Default 0, unbounded, so nothing changes until it is set.** Measured on the same
instrument, retrieval narrowed, at the top 2: the birth path's largest arc goes 2,591 → **22** with
nothing above 49 groups in the distribution, and post-hoc converges flat at 128 where unbounded
converges at 4,668. It is not free — birth-path merges fall 3,408 → 475 and the FIFA/Infantino crisis
comes out as about forty arcs instead of one — and there is no gentle setting, since 3 leaves 2,760
and 5 leaves 4,145. docs/STORYLINE-LINKING.md, "Bounding what one group may bridge", has the tables,
the hand-read arcs and the cost.

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

**Gated as of 2026-08-23, and this section used to say it shipped unconditionally.**
`STORYLINE_NARROW_RETRIEVAL`, **default off**; off is the pre-#117 behaviour exactly.

The reason is §2.7 step 1, run — and then run again, correctly. The harness that measured the
birth-only trajectory reported a largest arc of **72** groups, and it **did not model
`mergeStorylines`**: the service re-points a merge loser's bridges onto the winner
([storylines.ts:434](../packages/storage/src/storylines.ts), *"it re-points rather than dying with the
alias"*), which is the mechanism that makes merging self-reinforcing, and the harness modelled
neither the re-pointing nor the drop. With both modelled, **birth-only** at the pinned bar leaves a
largest arc of **2,591 groups — 9.96%**. So the evidence that the birth path was safe came from a
simulator that skips the merge, which is §2.5's own mistake one level up: a decision certified against
a model of itself that omits the part doing the damage. (Both figures are recorded from that
re-measurement; **this change did not re-run them**, and the harness for it is the one §2.6's K
re-measurement needs.)

The archive is **not** damaged, which is why this is a gate and not a repair. Re-verified on
2026-08-23, grouping `storyline_bridges` by pair and counting distinct groups: **1,913 pairs, one
bucket, one bridge each — nothing at K=2**, so no merge is pending and nothing has to be undone.
(**Superseded the same day**: a later pass left seven pairs at or above K, and the unflagged nightly
bridge sweep merges them — 124 → 143. The archive is still not damaged, but "nothing at K=2" is a
snapshot, and it was never the same claim as "no merge is pending" — §2.7, "The live archive,
re-read".) What makes the precaution worth taking anyway is that a bad merge is unrecoverable —
ADR-0011 refuses to build a split, and the only repair is `backfill:storylines --restart`, which
costs the whole label history (§2.7 step 2 prices it at about eight days of free-tier quota).

**The flag switches a PAIR, and getting that wrong would be worse than not gating at all.** #117
changed two things: the probe tokens, *and* `CANDIDATE_LIMIT` from 200 to 4,000 — a value censused
against the *narrowed* probe. Gate only the narrowing and production runs whole profile + 4,000: the
broad probe, whose p50 overlap is 1,903 storylines and max 8,054, with its only bound effectively
removed, feeding the O(n²) `bridgePairs` cross-product §2.6 describes. That is more percolation-prone
than the old behaviour *and* than the new one. So both halves come out of one function —
`candidateRetrieval` in `storyline-link.ts`, one object literal per mode — and `LinkerConfig` carries
no other retrieval input; the pair is unreachable rather than merely discouraged.

`storyline-replay.ts` reads the same flag, so the harness models whichever mode is configured; #117's
proven property was that the two narrow identically, and letting that lapse is the root cause of
everything in this section. Verified on the 2026-08-23 corpus (29,658 articles in 24,655 groups,
read-only against `zammy`): the **pre-#117 replay**, the gated replay **off**, and the gated replay
**on** produce a byte-identical 30-row threshold grid, storyline-for-storyline — so the off path is
genuinely the pre-#117 grid, and the on path is the no-op #117 claimed. The row cap is the half the
replay still does not apply; it now **reports** it as `cappedGroups`, and the report is this section
in one number: **12,734 of 24,655** groups exceed the off mode's 200 rows, **0** exceed the on mode's
4,000 — 0 at the pinned bar and every row near it, rising to 1–3 groups only at anchor shares of
0.01–0.02, five to ten times the pinned value and already refused for building beat storylines. The
census behind 4,000 is a census at the bar that ships, and that is where it holds.

The recommended real fix — a top-2-qualifiers bound on what may bridge — is deliberately **not** in
this change. It is a different decision with its own evidence, and the flag is what buys the time to
gather it.

**That evidence has since been gathered and the bound is built** —
`STORYLINE_MAX_BRIDGING_QUALIFIERS`, its own knob, **default 0 (unbounded)**, applied inside
`bridgePairs` where the cross-product is generated. It is a PAIR with this flag in practice rather
than in the type system, and the numbers are what make that the right shape: the bound bites on 26% of
the live archive's bridging groups with the retrieval narrowed and on **0.5%** without it (max 4
qualifiers broad, against 53 narrowed), so turned on alone it is close to a no-op, and turned on
together with narrowing it takes the birth path's largest arc from 2,591 groups to 22. Unlike the
probe-and-cap pair here, no combination of the two is worse than both — broad-and-bounded is merely
stricter than today — so welding them would buy no safety and would cost the ability to re-run the
unbounded baseline every number in docs/STORYLINE-LINKING.md was taken at. See "Bounding what one
group may bridge" there, including the two corrections it makes to the cost this fix was priced at.

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
at the pinned bar says the largest arc should be **50** — a figure the note at the end of this
section withdraws, because the replay reaches it only by not modelling the merge.

**So the fix split in two.** The retrieval narrowing shipped on the birth path — the argument being
that it repairs that path to match the candidate set the thresholds were certified against, and that
the replay is a faithful proxy for it: a single pass in publication order with no re-offer, which is
exactly why it says 50 where the sweep says 1,347. **That argument did not survive re-measurement, and
the narrowing is now gated too** (`STORYLINE_NARROW_RETRIEVAL`, default off — §2.5): the replay
behind it was not modelling the merge, and birth-only with the merge modelled is 2,591 groups, not 72.
The sweep is gated off behind
`STORYLINE_LATE_CANDIDATE_SWEEP=false`, blocked on re-measuring K against a replay that re-offers,
with `--late-candidates` to run it deliberately and a gated night reporting `skipped: true` rather
than `offered: 0`.

A changed-set filter was also built and measured against this, and it is worth recording that it
makes things **worse, not safer**: a merge is what marks an arc dirty, so a filter that offers only
marked groups selects for the feedback loop. Head to head over four passes, unfiltered ends at 1,347
and filtered at **1,782**. It is off by default too.

> **The K re-measurement this section blocks on has since been done, and it relocated the problem
> rather than settling it** — docs/STORYLINE-LINKING.md, "K, re-measured against a replay that
> re-offers". A replay that re-offers confirms the sweep must stay off: interleaved, one pass a
> night, with the retrieval **narrowed** (`STORYLINE_NARROW_RETRIEVAL=true`, which §2.5 has since
> made the non-default), the largest arc reaches **4,540 groups (17.46% of the window)** and is still
> climbing when the corpus runs out. But building that harness exposed why this section's own "the
> replay says 50" is not a safe baseline: **the replay does not model `mergeStorylines` re-pointing
> the loser's bridges onto the winner**, which is the mechanism `cascadeMerge` exists to drain.
> Modelled, the pinned bar builds a **2,591-group arc on the BIRTH path alone** — the path PR #117
> corrected unconditionally and PR #128 has since gated. So K is not the binding constraint, the
> sweep is not the only thing that needed gating, and the residual risk this section names ("a
> from-scratch replay does not exercise it") turns out to point the other way: the from-scratch
> replay is the pessimistic case, and the live archive is safe only because the cap built it.
>
> **Corrected 2026-08-23**, and the correction is in this document's own genre: the first version of
> that measurement reported **5,927 groups (22.79%)** because its harness counted a doubly-homed
> group's membership TWICE where `mergeStorylines` counts it once. Only the re-offer figures were
> affected — the 2,591 above is birth-only and reproduces exactly — and the direction is the one
> that matters here: the sweep's amplification falls from 2.3x to **1.75x**, so the birth path is
> **57%** of the final arc rather than 44%. Every conclusion above survives; the load-bearing one
> got stronger. The bug is written up where the numbers are.

### 2.7 The hybrid state — the one residual nothing has tested

The retrieval fix went to the birth path on the strength of the replay — it is behind
`STORYLINE_NARROW_RETRIEVAL` and off by default as of 2026-08-23 (§2.5), so what follows is the
question that turning it on re-opens, and step 1 below is the measurement that gated it. The replay
builds the archive **from scratch**: every storyline in it was formed by the narrowed decision.
Production's was formed by the capped one. Those are different populations.

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

**That guess was wrong, and step 1 below is where it was measured.** A cap-built archive swept with
the retrieval corrected does not converge toward 50; it converges at 4,668, which is where the
from-scratch run ends up too. The benign reading is refuted — the second failure mode is the one that
happens.

**The live archive, re-read 2026-08-23, and it says something §2.5 above has wrong.** §2.5 records
"1,913 pairs, one bucket, one bridge each — nothing at K=2, so no merge is pending". That is no longer
true and the second clause would not follow from the first anyway. Counted with exactly
`readBridgedPairs`' own predicate: **1,865 live pairs, 1,858 at K=1, five at K=2 and two at K=3** —
sixteen observations across seven pairs. The archive is still quiet by the percolation alarm (largest
arc **124**, exactly one arc over 100, and 997 of 26,006 groups doubly homed with none triply), but
those seven pairs are **pending merges, not stranded evidence**. Three facts, each verified against the
code rather than inferred:

- `countBridges` and `readBridgedPairs` count rows. Neither looks at membership at all, so an
  observation by a group that is now a member of one side still counts toward K.
- `runBridgeSweepChore` is called **unconditionally** in `runStorylinePass` — unlike the late-candidate
  sweep it has no flag — and it merges every live pair at or above K. The next `chores storylines` run
  merges all seven. First-order, no cascade, that takes the largest arc from **124 to 143**, and
  several of the pairs' own labels agree they should be one (`Hayden Panettiere` with
  `Hayden Panettiere`, two spellings of the FedEx St Jude Championship).
- The home-exclusion rule — "bridge evidence only from arcs the group is NOT a member of" — is
  enforced on the **retroactive** branch only, and there only against memberships that existed before
  the call. On the fresh path `recordBridgesAmong` runs over the FULL qualifier cross-product
  *including* `qualified[0]`, the arc the group has just joined.

So the mechanism that looked like it might make the benign reading true is real, structural, and does
not do what it was hoped to do. Self-homed bridge evidence is the **default, not the exception**: a
group with *m* qualifiers writes `m(m-1)/2` pairs of which `m-1` touch its new home, so the predicted
self-homed share is exactly `2/m` — and the archive lands on that closed form in four independent
buckets (m=2: 99.9% observed against 100%; m=3: 68.0% against 66.7%; m=4: 53.0% against 50%; m=5:
40.0% against 40%). **85.4% of all K=1 observations are self-homed**, 1,494 of them written in the same
`linkGroup` call as the membership. It is not an artifact of a young archive — the same-call mechanism
needs no elapsed time and was already at 86% within the first hour of the first backfill — but it is
also not *stranding*, because nothing downstream reads membership. Retroactive attachment explains only
6 of the 16. The replay models this faithfully (`independentEnough` counts marks, `offerGroup`'s fresh
path bridges among all qualifiers including the winner), so the trajectory in step 1 already contains
it.

Worth stating plainly, because it bears on what K means: if a bridge is supposed to be evidence from a
group with no stake in either arc, then 85% of the archive's evidence does not qualify — and the
recommended top-2-qualifiers bound would not fix that, since at m=2 the single surviving pair is
always self-homed.

**What to do, in order.**

1. **Measure it.** Entirely in memory, no database: replay from scratch *with the cap in place* to
   reproduce production's arc population, then switch to narrowed retrieval and continue with
   subsequent days, birth-only. Watch largest arc, arc count and merges per simulated day. It is the
   one configuration nobody has run, and it is a small extension of the re-offering harness the K
   re-measurement builds — the same instrument minus the re-offer, plus a cap-built starting state.
   Not a second simulator — a forked simulator drifting from the service is how §2.5's bug survived.
   It is `replayHybrid` in `storyline-replay.ts`, on the same `offerGroup` as everything else, behind
   `measure:storylines-v2 --hybrid`.

   **That harness now exists, and its `--capped-build=200` control answers the half of this that
   decides the choice in step 2.** `ReplayFidelity.cappedRetrievalLimit` builds the archive under the
   pre-#117 retrieval — whole-profile probe, 200-row cut APPLIED, the only place this replay applies
   the cut at all — and then sweeps it with the retrieval corrected. No database, no second
   simulator, one `offerGroup`. Measured (docs/STORYLINE-LINKING.md, "The trajectories"): a cap-built
   archive starts at a largest arc of **31** and the corrected retrieval takes it to **4,668**,
   converged by pass 5. **So the hopeful reading is refuted.** These merges are not repairs
   converging toward the replay's 50; a cap-built archive and a from-scratch one end up in the same
   place — 4,668 against the from-scratch interleaved 4,540 — because the corrected retrieval is what
   puts them both there. Fusing cap-created fragments does widen profiles past the point the
   thresholds certify, which was the failure mode this section named and could not choose between.

   **What that control did not answer was the BIRTH path, and that is now measured — 2026-08-23. It
   drifts.** `replayHybrid` builds under the cap, flips the retrieval on a day boundary, and continues
   birth-only — one offer per group, no sweep, which is what production runs today with all three
   re-offer flags off. Read-only against `zammy`, no model quota, 26,006 groups over the full window
   at the pinned bar (share 0.002, mass 20, K=2, cascade+re-pointing modelled).

   One offer per group is not §2.6's single-pass shortcut, and the distinction is worth keeping
   straight because they look alike. What §2.6 caught was a *measurement* that could not see a feedback
   loop, not a rule against offering once: the loop is that a merge widens the survivor's profile so
   the next offer retrieves more, and here it runs across DAYS instead of across sweep passes — each
   day's arrivals are judged against the archive the previous day's merges left. Ten runs, thirty
   simulated days each, and the trajectory is reported per day for exactly that reason. Bounding it to
   2,000 groups, or to `--days=31`, is the shortcut — see below, where the second one nearly happened.

   Every row of the next table is at the **unbounded** bridge cross-product, which is
   `STORYLINE_MAX_BRIDGING_QUALIFIERS`' default; the bound is priced against the same instrument two
   tables down, and it changes the answer.

   | corrected days | archive at the switch | largest at the end | share% | live arcs | post-switch merges | of which fuse two cap-shaped arcs |
   | --- | --- | --- | --- | --- | --- | --- |
   | **0** — flag stays off | 24 | **31** | 0.12 | 21,755 | 38 | — |
   | 3 (from 08-19) | 25 | **78** | 0.30 | 21,148 | 317 | 308 |
   | 7 (from 08-15) | 24 | **71** | 0.27 | 20,408 | 667 | 645 |
   | 11 (from 08-11) | 20 | **818** | 3.15 | 16,595 | 2,500 | 2,322 |
   | 14 (from 08-08) | 7 | **1,699** | 6.53 | 15,674 | 3,161 | 2,926 |
   | all — from scratch | — | **2,591** | 9.96 | 15,430 | 420† | 0 |

   Row 0 is `STORYLINE_NARROW_RETRIEVAL=false` — the cap and the broad probe are a PAIR, so the cut
   stays applied across the switch and that run is the flag never being turned on. Its 38 merges are
   the capped birth path's own over the last seven days, which is the number every row above compares
   against. † the from-scratch row's 420 is likewise its last seven days, for that comparison; over the
   whole window it makes 3,408, and it is the committed grid's own figure reproduced exactly.

   **The rate is invariant and it does not decay, which is what makes this a drift rather than a
   drain.** Normalise by arrivals rather than days — this corpus's days hold between 108 and 3,265
   groups, so days are the wrong denominator — and the corrected retrieval produces **0.26, 0.256,
   0.234, 0.252 merges per group born** across those four switch points. A backlog being repaired
   would show a rate that starts high and decays as the fragments run out; a constant rate, invariant
   to how much of the archive was cap-built, is the corrected retrieval's steady-state output on the
   birth path. The flag-off control over the same seven days and the same arrivals is **0.015** — so
   turning the flag on multiplies the birth path's merge rate **~17×** and keeps it there. Day by day
   over the seven corrected days: +25, +36, +153, +143, +88, +101, +121. Nothing is tapering.

   **So the hopeful reading is refuted a second time, and by a different route than the sweep
   control's.** It does not converge toward the from-scratch figure from above; it climbs toward it
   from below, and the from-scratch figure is itself still climbing when the corpus runs out (+98
   merges and +146 groups on the last night of a 2,591-group arc). There is no measured ceiling for
   the birth path either. At production's ~1,300 groups a day the seven corrected days above are
   about **two** production days, and the 11-day column about **eight** — so the shape to expect is a
   largest arc in the tens after a couple of nights and in the high hundreds within a fortnight, which
   is precisely the interval §2.6's "a fortnight of nightly graph rows" was going to watch.

   **§2.7's own reasoning survives contact, and it is now a number rather than an argument.** The
   claim was that a from-scratch replay cannot see this by running longer, because it holds no
   cap-created fragments to fuse. Measured: **645 of the 667** post-switch merges (96.7%) fuse two
   arcs that both carry cap-shaped vocabulary, against **0 of 420** in the from-scratch control over
   the same days — where it is 0 by construction, which is the point. Fusing cap-created fragments is
   not a side effect of the hybrid, it is 97% of what the hybrid does.

   **What it is NOT is a percolation collapse, and the distribution is where that shows.** Over the
   seven corrected days the arc-size buckets (2–4 / 5–9 / 10–19 / 20–49 / 50–99 / 100+) go
   1,293 / 192 / 26 / 3 / 0 / 0 → 1,945 / 269 / 59 / 18 / 1 / 0. The merges are spread across the
   distribution rather than
   feeding one arc: 1,341 groups also simply *attached* to a cap-shaped arc, which cannot chain the
   way a merge does. The 100+ bucket stays empty for a week and the maximum is jumpy — 3 corrected
   days ends at 78 and 7 ends at 71, which is one arc's worth of noise and the reason the maximum is
   not reported alone here.

   **Hand-read, the merges are about half repairs.** Of the ten largest arcs the 7-day hybrid builds,
   three are one story and would be a genuine repair of the cap's fragmentation: the **SpaceX Falcon 9
   lunar impact** (27 groups — the crater images, Danuri's before-and-after, the NASA LRO capture, all
   one event), the **Wisconsin Democratic gubernatorial primary** (24 groups, 4 days, Hong v Crowley
   from the previews to the result), and the **Canada–U.S. tariff talks** (36 groups, LeBlanc and Greer
   meeting by meeting). One more is defensible as a running story: **Europe's wildfire season** (40
   groups, France/Spain/Greece/Balkans), with a West Bank fire leaking in. The other six are not
   stories. The largest arc the hybrid builds — **71 groups, profile `doug, ford, ontario, premier` —
   is an entity magnet**, chaining Ford's wildfire remarks, data-centre policy, tariff reprisals and a
   hotel-expense scandal because they share a name; `kinew, manitoba, premier` (33) is the same defect
   with an obituary attached, and `jong, kim, korea` (25) spans several separate stories. Two are pure
   **boilerplate**: 39 groups of unrelated HKEX filings joined by disclaimer vocabulary
   (`accuracy, arising, disclaim, expressly, howsoever, liability`) and 26 GlobeNewswire press
   releases joined by `globe, newswire, vancouver` — the mechanism the "| Globalnews.ca" suffix
   already demonstrated, at scale. One is a **genre** pile: 44 WNBA box scores on `beat, night, point,
   scored`. The judged columns say the same thing without the reading: declined piles formed goes
   **76.9% → 81.3%** turning the flag on, and the boilerplate piles exist at flag-off too (HK filings
   at 17 groups) — the flag does not create them, it merges them with each other.

   **Two shortcuts this measurement nearly took, both of which have their own history in §2.6.**
   `--days=31` is the CLI's default and it silently cuts **1,446 groups** off the front of a 39-day
   archive; the full window is `--days=41`, and the from-scratch reference reproduces at
   **exactly 2,591 / 9.96% / 3,408 merges** only on the full window. And `--share`/`--mass` default to
   an exploration focus of 0.01/16, **not** the pinned 0.002/20 — at that bar the from-scratch birth
   path reads **13,799 (56% of the window)** on the 31-day slice where the pinned bar reads 2,034, so a
   trajectory read against it is an order of magnitude of nothing. The `--hybrid` header now
   prints the bar and says whether it is the pinned one. The calibration check that matters: with no
   cap and the retrieval narrowed, `replayHybrid` reproduces the committed birth-only grid exactly, so
   the new instrument is the old decision plus a switch.

   **What is still not measured.** The cap-built archive is the replay's, not production's: it carries
   no label-agreement merges, no coherence-gate withholdings, and profiles derived by the replay's
   majority rule rather than storage's union rule, which is measurably wider (STORYLINE-LINKING.md,
   "Three things this contradicts"). All three point the same way — production's starting state is
   *broader* than the one this builds — so **0.25 merges per arrival is a floor**. And the corrected
   phase can be at most ~14 simulated days before the corpus runs out, which is why the endpoint above
   is a trajectory and not a ceiling.

   **The recommendation, and it is a recommendation rather than a change.** Nothing here justifies
   turning `STORYLINE_NARROW_RETRIEVAL` on *by itself*: the birth path alone, from production's own
   starting state, merges 17× more and shows no sign of stopping, and the largest thing it builds in
   the first week is a pile rather than a story. All flags stay at their defaults. What *would* change
   the answer is the lever §2.6 names and PR #130 has since built — a bound on how many qualifiers one
   group may bridge — because the drift is 97% cap/cap fusion driven by `bridgePairs`' cross-product.

   **And that bound now exists, so the interaction is measured rather than recommended.**
   `STORYLINE_MAX_BRIDGING_QUALIFIERS` (PR #130, default 0 — unbounded — so today's behaviour exactly)
   caps how many of a group's qualifiers may pair. On the SWEEP control it already turns 4,668 into
   24 → 67 → 103 → 123 → **161, flat from pass 4** (0.62%). On the birth path, at the top 2 and
   everything else held:

   | 7 corrected days | cross-product | largest at end | post-switch merges | per arrival | cap/cap | piles | named | kept |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | flag off | unbounded | 31 | 38 | 0.015 | — | 76.9% | 38.2% | 64.3% |
   | flag off | top 2 | 24 | 24 | 0.009 | — | 76.3% | 37.3% | 63.5% |
   | **hybrid** | unbounded | **71** | 667 | **0.256** | 645 | 81.3% | 38.7% | 66.1% |
   | **hybrid** | **top 2** | **22** | 89 | **0.034** | 75 | 80.7% | 37.2% | 62.9% |
   | from scratch | unbounded | 2,591 | 420 | — | 0 | 74.1% | 31.1% | 62.0% |
   | from scratch | top 2 | **22** | 117 | — | 0 | 69.8% | 26.8% | 57.5% |

   **The bound removes the drift on the birth path, and it is not close.** 0.034 merges per arrival
   against 0.256 — a **7.5× reduction** — and the largest arc ends at **22**, *below* where leaving the
   flag off leaves it (31 unbounded, 24 bounded). Fourteen corrected days bounded reach 39, against
   1,699 unbounded. Piles formed barely moves (80.7% against 81.3%), so the bound is not buying the
   alarm at the cost of the pile count; `named` and `kept` do fall, which is what §2.6 warns to expect
   when percolation stops inflating them rather than a cost to weigh against it.

   **And the hybrid question DISSOLVES under the bound, which is the strongest thing here.** Bounded,
   the cap-built archive and the from-scratch one both end at **22** — the same number, where unbounded
   they end at 71 and 2,591. §2.7 exists because those two starting states are different populations;
   with the pair count bounded they are no longer distinguishable in the outcome, because the mechanism
   that made them differ was the cross-product. So the two flags are **not independent decisions**:
   narrowed retrieval on the birth path is a 17× drift unbounded and a smaller archive than today's
   bounded. Which to enable, and in what order, is still a decision for someone with a fortnight of the
   nightly graph rows in front of them — this measurement says only that enabling the retrieval WITHOUT
   the bound is the one combination the evidence refuses.

   With `STORYLINE_NARROW_RETRIEVAL` and `STORYLINE_MAX_BRIDGING_QUALIFIERS` both at their defaults,
   none of this is running, which is what buys the time to watch a fortnight of the nightly graph rows
   rather than guess at them.
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

   **Done, with one of the three numbers deliberately absent.** `runStorylineGraphChore`
   ([chores.ts](../apps/api/src/chores.ts)) reads `readStorylineStats` at the end of every pass and
   logs largest arc, arc count and the size distribution on the bucket edges
   [STORYLINE-LINKING.md](STORYLINE-LINKING.md)'s "Graph shape" table already uses (1 / 2–4 / 5–19 /
   20–99 / 100+), plus the standing bridge count — the leading indicator, since K bridges are what
   merge a pair. Measured **16–21 ms** on 27,083 `storyline_groups` rows, which is *less* than the
   stats read cost before the distribution was added: the seven arc-size numbers come out of one
   aggregate where `largest` and `promoted` used to make two. **Merges per night is not there**:
   birth-path merges are recorded nowhere and the schema has no merge timestamp, so counting them is
   a schema change rather than a field, and the snapshot series carries the same signal — arc count
   falling while largest arc climbs *is* the merge rate, seen where it has a consequence. And **no
   threshold was set**: 1,179 was 99% of a single day's groups and cannot be reused as an
   archive-wide count without changing what it measured, while 50 and 1,347 bracket a range nothing
   has measured — production's 124 is cap-built and §2.7 above is precisely the question of which way
   it drifts. A fortnight of these rows is what a threshold should come off.

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
already priced.

### 7.1 On the platform: the estimate was right and the reasoning was wrong

This section used to predict "2–3× these figures, so ~0.8–1.1 s" by scaling our own boot for a
slower CPU. Measured on `zammy-vercel-spike` (`iad1`, after 7.5 minutes idle so the instance was
genuinely reclaimed):

| | end to end | app boot (`buildMs`) |
|---|---|---|
| cold | **947 ms** | 71 ms |
| the next request, same instance | 330 ms | 71 ms |

The ~0.8–1.1 s prediction landed, and it landed for the wrong reason. **A ~620 ms cold penalty
containing only 71 ms of application boot means ~550 ms is Vercel's own container start, before any
of our code runs.** Cold start is therefore a platform floor our imports sit *on top of*, not a
figure that scales with them — so for the real `buildApp`, whose import graph is ~195 ms of its
~360 ms locally, the platform number will be **higher** than this section predicted rather than
proportional to it. The spike is a six-route Fastify app with no `pg`, no `ioredis`, no BullMQ and no
news client; 947 ms is the floor plus almost nothing, and must not be quoted as zammy's.

Two consequences:

- **§3.3's `pg_net` concern is real, and now has a number.** Its default timeout is 2 s. A cold chore
  route is already ~1 s empty; the real one is more. `timeout_milliseconds ≥ 10000` was already the
  recommendation and this is why — at the default the margin is thin, which is the opposite of what
  this section said before it had platform data.
- **The 330 ms warm figure is mostly geography**, Calgary to `iad1`, not compute. It is a note about
  where to put the deployment, not about the read path.

Both remain irrelevant to the sweep's deadline problem, which was never compute either.

Two caveats, since one measurement is not a distribution: this is a single cold start in one region,
and `warm` in that JSON is broken — the handler stamps it before Fastify sees the request, so it
always reads `true`. The two `buildMs` values agreeing at 71 is what identifies the second request as
the same instance.

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
- **The hybrid trajectory (§2.7 step 1)**: `measure:storylines-v2 --days=41 --hybrid
  --capped-build=200 --switch-after=N --share=0.002 --mass=20`, read-only against `zammy`, one run per
  switch point at N ∈ {3, 7, 11, 14} plus the two controls (`STORYLINE_NARROW_RETRIEVAL=false` for
  flag-off, `--capped-build` omitted for from-scratch). No `labeler` is reachable from this CLI, so no
  model quota was spent. Row counts on `articles`, `storylines`, `storyline_groups` and
  `storyline_bridges` were compared before and after and are unchanged.
- **The live archive's bridges (§2.7)**: `storyline_bridges` grouped by pair under
  `readBridgedPairs`' own join, cross-referenced against `storyline_groups` per observation for
  membership and against `attached_at` / `observed_at` for the ordering. The `2/m` prediction was
  tested by bucketing observations on pairs-per-group rather than fitted.

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
- **A faster replay is not a healthier one.** §2.6 records per-offer cost *improving* from 17 to 4 ms
  as the graph collapsed, because a collapsing graph has fewer distinct arcs to retrieve. No wall-clock
  figure is quoted for the §2.7 runs and none should be: the run that percolates hardest is the one
  that finishes first.
- **The archive has had only two linker passes.** Every write in `storyline_bridges` came from a
  backfill on 2026-08-21 and a second run on 2026-08-22, which bounds how much retroactive attachment
  could have accumulated — 6 of the 16 K≥2 observations. It does not soften §2.7's `2/m` finding, which
  needs no elapsed time, but any claim there about how self-homing *accumulates* is 48 hours deep.
- **The dev corpus has had these passes run against it nightly**, so phases 1, 2 and 5 measured
  near-empty work. Their cost on a night with real work to do is unmeasured — but all three are
  sub-second on a full window, so the ceiling question does not turn on them.

## Sources

- [Vercel Queues](https://vercel.com/docs/queues), [quickstart](https://vercel.com/docs/queues/quickstart), [pricing and limits](https://vercel.com/docs/queues/pricing) — the `experimentalTriggers` / `queue/v2beta` shape, `@vercel/queue`'s `send`/`handleCallback`, OIDC auth, the TTL (60 s–7 d) and visibility (0–60 min) ranges, 4 KiB metering, 2× billing for idempotency keys, and the absence of a published Hobby allowance
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) — 300 s function maximum, 4 CPU-hours Active CPU, 360 GB-hours provisioned memory, 1 hour of runtime logs, WAF limits, and the non-commercial fair-use clause
