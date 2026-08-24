# Inverting the late-candidate sweep — is a change-triggered offer sound, and is it worth it?

The question [VERCEL-PHASE-0-FINDINGS.md §2.3](VERCEL-PHASE-0-FINDINGS.md) left open, asked against
the template that already answered it once for a different pass: PR #114 (`760abe1`,
`c690a13`) moved the label-agreement merge from the clock to the collision, and its own framing is
the standard held to here — *"The decision is unchanged by construction — one planner, one grounding
guard, one grace window, one component valve — the trigger changes when, never whether"*
([storyline-label-merge-trigger.ts:29-38](../apps/api/src/storyline-label-merge-trigger.ts)) — while
keeping the nightly pass as an unscoped backstop.

Measured 2026-08-22 against the same dev corpus as Phase 0 (31,308 articles, 26,010 storylines,
17,008 of them live, 15 corpus-days), read-only against `zammy` and mutating only a `pg_restore`
clone that has since been dropped.

**The answer is not the one the question expected.** The inversion is sound, cheap and indexed — the
retrieval costs **2.9 ms and returns 2.05 groups** where the forward query costs 35 ms and returns a
truncated 200. But pricing it turned up something that makes the inversion the *second* thing to do:
`CANDIDATE_LIMIT` binds on **399 of 400 groups**, the pinned thresholds were measured against an
**uncapped** retrieval, and narrowing the retrieval array to the tokens that can actually anchor a
link is **14.5× faster on the hot query and finds 11.9× more qualifiers while losing none**. The
sweep's famous 3.5% yield is substantially an artifact of that cap. So the honest verdict is
**feasible-with-conditions, and deprioritised**: fix the retrieval first, then take the cheap
nightly filter, and probably never build the ingest-tail trigger.

> **Status, 2026-08-23. Read this before the body: five of this document's numbers are dead and its
> ordering is spent.** Everything below was measured in one session on 2026-08-22 and then tested by
> five more. What follows is what survived, what did not, and what is actually open. §10 carries the
> current recommendation; the body is kept for its reasoning, not its figures.
>
> **What survived, and shipped.** The `CANDIDATE_LIMIT` finding, the uncapped-replay divergence, the
> necessary-condition argument for the anchor-eligible subset, and the conclusion that **the 200-row
> cap was doing the bounding K was believed to be doing.** That conclusion turned out to be truer
> than written: it held on the *birth* path too, not only under re-offers.
>
> **What did not survive.**
>
> - **"The percolation alarm does not fire" is wrong** — it fires from the second pass. Every
>   measurement here is a single pass or bounded to 2,000 groups, and `maxGroups: 2000` is exactly
>   what hides it.
> - **"41% faster end to end, ~275 s" does not reproduce.** The first pass is *slower*. And per-offer
>   cost *improves* as the graph degrades, so speed was the wrong metric to read throughout.
> - **§3's inverse retrieval is unsound as specified.** Its predicates are functions of `N` and `df`,
>   both functions of which fortnight you stand in; it reaches **38.9%** of the pairs the forward
>   decision qualifies. The sound form reaches 87.4% but names **105.6 groups per arc**, not 2.05 — a
>   3.4× narrowing, not 24×. **This is the number that changes the design**, not just the estimate.
> - **§9's changed-set filter makes things worse, not safer.** A merge is what marks an arc dirty, so
>   a filter that offers only marked arcs selects *for* the feedback loop: 1,782 against the
>   unfiltered 1,347, larger at every pass.
> - **The mechanism was misdiagnosed.** Not bridges "re-recorded on every re-offer" — `recordBridge`
>   is idempotent per group — but qualifier *width* feeding `bridgePairs`' O(n²) cross-product. And
>   `maxGroups` already existed.
>
> **What has been settled since, and matters more than any of the above.** A replay that models
> `mergeStorylines`' bridge re-pointing — which this document's harness did not — says the **birth
> path alone** reaches 2,591 groups (9.96%) at the pinned bar. The hybrid (cap-built archive,
> corrected retrieval, birth-only) **drifts rather than converging**: 0.25 merges per group born,
> flat, against 0.015 with the retrieval uncorrected — a ~17× standing increase, not a backlog
> draining. And **bounding the bridge cross-product to a group's top two qualifiers collapses the
> whole problem**: 0.034 merges per arrival, largest arc 22, and the cap-built and from-scratch
> archives end at the *same* 22, because the cross-product was the mechanism that made them differ.
>
> **Current state of the code:** the retrieval narrowing, the bridging bound, the sweep, the
> joined-group re-offer and the changed-set filter are all built and all **off by default**. K is
> unchanged at 2. So ADR-0011's retroactive attachment is not happening at all right now — which is
> the fact §10 turns on. See VERCEL-PHASE-0-FINDINGS.md §2.5–§2.7.

---

> **On reading §1–§9.** They are the original session's reasoning and are kept for it — the argument
> structures are what later sessions built on. But the figures in them predate five rounds of
> correction, and §3 and §9 in particular reach conclusions the status block above reverses. Treat
> any number in the body as historical unless §10 or VERCEL-PHASE-0-FINDINGS.md §2.5–§2.7 repeats it.

## 1. What the sweep is, and the half-truth in why it exists

`runLateCandidateChore` ([chores.ts:163](../apps/api/src/chores.ts)) pages every group whose
`group_published` falls inside the trailing DF window
([chores.ts:181-193](../apps/api/src/chores.ts), window from `STORYLINE_DF_WINDOW_DAYS`, 14 today at
[config/src/index.ts:302](../packages/config/src/index.ts)) and hands each to `linkGroup`
([chores.ts:208](../apps/api/src/chores.ts)). Today that is 12,338 groups at 41 ms each, ~506 s a
night, 1.7× Hobby's ceiling.

The justification is ADR-0011's *"a Wednesday storyline may pull in Monday's group"*, restated at
[chores.ts:143-152](../apps/api/src/chores.ts): the linker sees each group exactly once, at birth,
in publication order, so Monday's group is judged before Wednesday's storyline exists.

**That is only half true, and the other half is where the cost lives.** At Monday's group's birth,
`linkGroup` retrieves *every live storyline overlapping its profile*
([storyline-linker.ts:244-246](../apps/api/src/storyline-linker.ts) →
[storylines.ts:960-985](../packages/storage/src/storylines.ts)) — and every group in the archive owns
a provisional storyline-of-one ([storylines.ts:74-95](../packages/storage/src/storylines.ts)), so
Wednesday's group's arc *is already a candidate* on Wednesday, from the other side. When Wednesday's
group qualifies for Monday's, it merges its birth storyline into Monday's
([storyline-linker.ts:400-417](../apps/api/src/storyline-linker.ts)) and the pair unifies. The
retrieval is symmetric by construction.

What breaks the symmetry is the 200-row cap, and §2 is about how hard it breaks it.

## 2. The finding that reframes the question: `CANDIDATE_LIMIT` binds every time

`CANDIDATE_LIMIT = 200` ([storyline-linker.ts:97](../apps/api/src/storyline-linker.ts)) is
documented as a *"safety valve for a pathological token, not a tuning knob"*, and
`readCandidateStorylines` repeats the framing — *"`limit` is a safety valve for a pathological
token"* ([storylines.ts:951-958](../packages/storage/src/storylines.ts)) — ordering by
`last_coverage desc nulls last, s.id` so the cut *"keeps the storylines a group is most likely to
belong to"*.

Measured over 400 groups sampled at random from the trailing window, replaying the real
`groupProfile` and `qualifyingStorylines`
([storyline-link.ts:207](../apps/api/src/storyline-link.ts),
[:167](../apps/api/src/storyline-link.ts)) against the real retrieval SQL and excluding `own`
exactly as [storyline-linker.ts:246](../apps/api/src/storyline-linker.ts) does:

| | rows returned | cap binds |
|---|---|---|
| retrieval on the full group profile | p50 **200**, p90 200, mean 199.8 | **399 of 400** |

It is not a valve. It is the normal operating point, on essentially every group. §2.1 of the Phase 0
findings recorded the input to this conclusion — *"the median group's profile overlaps 1,145
storylines … `CANDIDATE_LIMIT` caps the 200 rows returned, not the ~1,200 scanned"* — and read it as
a performance fact. It is also a correctness fact, and the correctness half was not stated.

### 2.1 The threshold measurement never had the cap

The thresholds are pinned by the in-memory replay, whose whole design claim is that it is *"not a
second implementation of the decision"* — same `qualifyingStorylines`, same `groupProfile`, with only
the storage substituted ([storyline-replay.ts:11-27](../apps/api/src/storyline-replay.ts)). Its
candidate retrieval is [storyline-replay.ts:148-156](../apps/api/src/storyline-replay.ts):

```ts
// Candidate retrieval: every storyline sharing at least one token, which is
// exactly what `profile_tokens && story_tokens` returns.
const candidateIds = new Set<string>();
for (const token of profile) {
  for (const id of byToken.get(token) ?? []) {
    if (id !== own.id) candidateIds.add(id);
  }
}
```

There is no limit — `grep -n "limit\|slice(0"` over that file returns nothing. The comment is
accurate about the `&&` predicate and silent about the `limit 200` the service adds on top. **So
`STORYLINE_MASS_THRESHOLD_V2=20` and `STORYLINE_ANCHOR_MAX_SHARE=0.002`
([config/src/index.ts:503](../packages/config/src/index.ts),
[:484](../packages/config/src/index.ts)) were chosen against an uncapped candidate set, and
production has run a capped one ever since.** Whatever the cap suppresses, it suppresses below the
bar the measurement pass certified.

### 2.2 Narrowing the retrieval to the tokens that can anchor: 14.5× faster, 11.9× more qualifiers, none lost

A link requires an **anchor**: `qualifyingStorylines` rejects a candidate when
`evidence.anchorDf > bar.ceiling` ([storyline-link.ts:172-174](../apps/api/src/storyline-link.ts)),
where `anchorDf` is the df of the *rarest shared* token
([storyline-link.ts:113-124](../apps/api/src/storyline-link.ts)) and the ceiling is
`max(anchorDfFloor, corpusSize × anchorMaxShare)`
([storyline-link.ts:90-92](../apps/api/src/storyline-link.ts)) — on today's corpus
`max(10, 15,051 × 0.002) = 30.1` articles. The dormant bar divides that ceiling further
([storyline-link.ts:143-148](../apps/api/src/storyline-link.ts)), so the non-dormant ceiling is the
loosest one any candidate faces.

Therefore: **a storyline can only qualify if it shares at least one token whose window df is at or
below the ceiling.** Retrieving on that subset instead of the whole profile is a *necessary
condition*, not a second decision — the same kind of retrieval bound `profile_tokens &&` already is —
and it is free, because `readTrailingCorpus` runs *before* candidate retrieval
([storyline-linker.ts:233-242](../apps/api/src/storyline-linker.ts) vs
[:244](../apps/api/src/storyline-linker.ts)), so the df map the filter needs is already in hand. No
extra round trip, no new column, no new index.

The subset is much narrower than the profile:

| over 400 sampled window groups | p10 | p50 | p90 | p99 | max | mean |
|---|---|---|---|---|---|---|
| profile width | 11 | 19 | 29 | 44 | 85 | 19.9 |
| anchor-eligible subset | 3 | **7** | 14 | 25 | 31 | 8.2 |

And the effect on the query §2.1 of Phase 0 named as 90% of the sweep:

| `readCandidateStorylines`, ms | p10 | p50 | p90 | p99 | max | mean |
|---|---|---|---|---|---|---|
| full profile (today) | 3.66 | 6.63 | 81.3 | 123.1 | 183.5 | **35.1** |
| anchor-eligible subset | 0.99 | 1.70 | **2.92** | 5.11 | 87.4 | **2.42** |

**14.5× on the mean, and the fat tail is gone** — p90 falls from 81 ms to 2.9 ms. The full-profile
mean reproduces Phase 0 §2.1's 33.99 ms to within 4%, which is the calibration that lets the second
row be trusted.

The decision changes, and it changes in one direction only:

| over the same 400 groups | full profile | anchor subset |
|---|---|---|
| qualifiers found | 48 | **572** (11.9×) |
| qualifiers found by one and not the other | — | **0 lost**, 524 gained |
| groups with ≥1 qualifier | 43 | **207** |
| cap still binds | 399/400 | **55/400** |

Zero qualifiers are lost across 400 groups, which is what a proven necessary condition predicts. The
524 gained are storylines the `last_coverage desc` ordering pushed past row 200 — genuine qualifiers
at the pinned thresholds, discarded silently.

### 2.3 The same fix, measured end to end through the real sweep

The pure-query numbers do not price the writes the extra qualifiers cause, so the real
`runLateCandidateChore` was run against a throwaway clone, `labeler` omitted (so no model call was
ever made), with the retrieval array narrowed behind a temporary env gate that has since been
reverted:

| clone, fresh restore + `ANALYZE` | offered | ms/group | attachedTo | merges | largest storyline |
|---|---|---|---|---|---|
| baseline | 500 | **41.38** | 31 | 2 | 124 → 124 |
| narrowed | 500 | **24.37** | 145 | 73 | 124 → 124 |
| narrowed | 2,000 | **22.34** | 615 | 324 | 124 → 124 |
| narrowed, re-sweeping the same clone | 2,000 | **17.80** | 178 | 60 | 124 → 124 |

The baseline reproduces Phase 0's 41.3 ms/group exactly. Three things to read off this:

- **The sweep fits the ceiling.** 12,338 × 22.34 ms ≈ **275 s** — inside 300 s, where 506 s was not.
  That is arithmetic on a measured rate, on loopback, with no margin; see "what to distrust".
- **The 41% end-to-end saving is smaller than the 14.5× query saving would suggest**, because the
  extra qualifiers cost writes: bridges grew 1,913 → 5,801 on the 2,000-group run. §2.2 of Phase 0
  rejected a denormalized sort key at 8%; this is 41% and needs no column.
- **The percolation alarm does not fire.** The largest storyline stays at 124 groups across every
  run — the metric ADR-0011 built the replay harness to watch, and the one the 1,179-group swallow
  moved.

But it does **not** converge in one pass: the re-sweep still attached 178 and merged 60 per 2,000,
where the *baseline* re-sweep measured 0/500 and 2/2000 (Phase 0 §2.3). The cap has been holding back
a backlog of linking the thresholds already certified, and draining it takes several nights. That is
the condition on this fix, not an argument against it.

## 3. Is the inverse retrieval expressible and indexed?

Yes, in one statement, on indexes that already exist.

A group has no stored profile — `groupProfile(memberTokens)` computes the majority tokens of its
member articles ([storyline-link.ts:207-218](../apps/api/src/storyline-link.ts)) — so the inverse
cannot select on a group profile column. It does not need to. The majority profile is a **subset** of
the union of its members' `story_tokens`, so evidence computed over the union is an upper bound on
evidence computed over the profile: any group that could qualify must qualify at the union. That
makes a union-level filter a sound superset, and `articles.story_tokens` carries a GIN index
(`articles_story_tokens_idx`, [0006-storylines.ts:88](../packages/storage/src/migrations/0006-storylines.ts))
while `group_published` is denormalized onto every member and indexed
(`articles_group_timeline_idx`, [0003-article-groups.ts:76](../packages/storage/src/migrations/0003-article-groups.ts)).

Two necessary conditions are worth pushing into SQL, both of them restatements of
`qualifyingStorylines` rather than replacements for it:

1. **the anchor** — at least one shared token with window df ≤ ceiling (§2.2);
2. **the mass floor** — `Σ ln(N/df) ≥ 20`. This one has a sharp corollary nobody has written down:
   the largest weight any single token can carry is `ln(N) = ln(15,051) = 9.62`, so
   `ceil(20 / 9.62) = 3` — **a link requires at least three shared tokens, always**, and more at
   realistic df.

The statement, with the storyline's profile and its per-token weights passed as arrays (the weights
come from the same `readStoryDf` map the trigger would already have read):

```sql
with wt(tok, wgt, rare) as (select * from unnest($1::text[], $2::float8[], $3::bool[])),
hit as (
  select a.group_id, w.tok, max(w.wgt) wgt, bool_or(w.rare) rare
  from articles a
    join lateral unnest(a.story_tokens) as u(tok) on true
    join wt w on w.tok = u.tok
  where a.story_tokens && $4::text[]          -- the anchor-eligible subset: drives the GIN
    and a.group_published >= $5               -- the trailing window
  group by a.group_id, w.tok)
select group_id from hit
where group_id not in (select group_id from storyline_groups where storyline_id = $6::uuid)
group by group_id having sum(wgt) >= 20 and bool_or(rare)
```

`EXPLAIN (ANALYZE, BUFFERS)` at a median-width profile (12 tokens, 2 anchor-eligible) — the GIN
drives, the window is a heap filter, and the posting lists are tiny because the tokens are rare by
construction:

```
HashAggregate (actual time=1.378..1.380 rows=1)
  Filter: (bool_or(hit.rare) AND (sum(hit.wgt) >= '20'::double precision))
  Rows Removed by Filter: 35
  ->  Bitmap Heap Scan on articles a  (actual time=0.102..1.034 rows=48)
        Recheck Cond: (story_tokens && '{automaker,detroit}'::text[])
        Filter: (group_published >= '2026-08-08 ...')
        Rows Removed by Filter: 84
        ->  Bitmap Index Scan on articles_story_tokens_idx  (actual time=0.062 rows=132)
```

At a p90-width profile (40 tokens, 20 anchor-eligible) the planner switches to a `BitmapAnd` of the
GIN and the timeline btree on its own, and still finishes in 5.8 ms:

```
Bitmap Heap Scan on articles a  (actual time=1.501..4.520 rows=120)
  Recheck Cond: ((story_tokens && '{... 20 tokens ...}') AND (group_published >= ...))
  ->  BitmapAnd  (actual time=1.483..1.483)
```

**No index that does not exist is needed.** The one that would have been needed — a composite
`(story_tokens, group_published)` — is unnecessary precisely because the anchor filter makes the
token bitmap small enough that the window is cheap as a recheck.

The distribution, sampled 250 storylines per population, excluding each storyline's own member
groups:

| fired on | retrieval ms p10 / p50 / p90 / p99 / max / mean | groups to offer p50 / p90 / max / mean | events yielding nothing |
|---|---|---|---|
| **promoted arcs** (attach, merge) | 1.28 / 2.47 / 5.14 / 10.1 / 16.0 / **2.93** | 1 / 6 / 19 / **2.05** | 42% |
| **provisional singletons** (birth) | 1.36 / 2.16 / 3.14 / 4.24 / 5.84 / **2.23** | 0 / 2 / 13 / **0.80** | 69% |

Percentiles, per §2.2 of Phase 0's own instruction, and the tail here is genuinely thin: p90 is
2.1× the median rather than 12× as it is forward. **The inversion is the cheap direction**, and the
reason is structural: forward you probe the GIN with the whole profile, including tokens half the
archive shares; inverse you probe it with the anchor-eligible subset, because that is the only
subset that can matter.

## 4. Which storyline changes should fire it

The five candidate events are not one event, and three of them should not fire.

`refreshProfileTokens` ([storylines.ts:1228-1256](../packages/storage/src/storylines.ts)) is called
from exactly four places — `createProvisionalStoryline`
([storylines.ts:90](../packages/storage/src/storylines.ts)), `attachGroup`
([:127](../packages/storage/src/storylines.ts)), `refreshStoryline`
([:149](../packages/storage/src/storylines.ts)) and `mergeStorylines`
([:450](../packages/storage/src/storylines.ts)) — and the majority rule matters exactly as the task
suspected. A profile is *"every token carried by at least half the member groups"*, so a growing arc's
vocabulary **tightens**: the second group's arrival can only keep tokens both carry, so a wider arc
frequently qualifies *fewer* old groups, not more. `storyline-link.ts:16-19` says so
(*"the percolation damper — a growing storyline's consensus vocabulary tightens rather than
loosens"*).

- **Birth — do not fire.** §1's symmetry argument: at the newborn group's own birth `linkGroup`
  already retrieved every overlapping live storyline, including the provisional singletons of every
  old group. A birth trigger re-asks a question just answered, and the measurement agrees — 69% of
  birth-shaped events return nothing, and the 0.80 groups they do return are the ones the 200-row cap
  truncated, i.e. the *cap's* bug, curable at source (§2.2).
- **Attachment and merge — fire.** These are the only events that give an arc evidence it did not
  have when the old groups were last judged: `attachGroup` widens or re-derives `profile_tokens` and
  moves `last_coverage` via `refreshDaySlots`, and `mergeStorylines` re-derives the winner's profile
  over the union of both memberships. `last_coverage` is the *only* input that moves the dormancy half
  of the bar, because `barFor` reads `candidate.lastCoverageMs`
  ([storyline-link.ts:136-137](../apps/api/src/storyline-link.ts)) and never the clock.
- **Promotion — do not fire separately.** `promoteStoryline` writes `status`, and
  `readCandidateStorylines` does not filter on `status`
  ([storylines.ts:975-984](../packages/storage/src/storylines.ts)) — it filters on `merged_into is
  null` and the GIN overlap. A promotion changes nothing the linker reads. But note the trap: the
  1→2 group transition that *does* matter is the one that un-blocks a coherence refusal
  ([storyline-linker.ts:257-271](../apps/api/src/storyline-linker.ts) filters candidates whose
  `groupCount === 1`), and that transition can leave `profile_tokens` **byte-identical** — with two
  groups, `groups_with * 2 >= 2` passes for a token only one group carries. **So the trigger
  predicate must be "membership changed", never "profile tokens diffed."** A profile-diff trigger
  would silently miss the entire refusal-unblocking class.
- **A profile-token change with no membership change** happens only through `refreshStoryline`, which
  has **no production caller** — `grep` finds only
  [storylines.test.ts:218](../packages/storage/src/storylines.test.ts) and the definition. Nothing to
  fire on today, and worth a separate look: it exists for *"a new article landed in a member group"*
  ([storylines.ts:136-141](../packages/storage/src/storylines.ts)) and that case is currently
  unrepaired except incidentally, by a sweep offer that happens to attach.

There is a sixth event the task did not list and it is the highest-yield one: **a group's own
membership changing**. `groupArticle` moves an arriving singleton into an existing group, and
`readLinkableGroups` re-aggregates `json_agg(a.story_tokens)` on every read
([grouping.ts:340-420](../packages/storage/src/grouping.ts)), so the enlarged group's majority
profile can gain tokens — while
[grouping-service.ts:231-236](../apps/api/src/grouping-service.ts) deliberately excludes joined
articles from the linker (*"an article that JOINED a group inherited that group's storylines, so only
the ones that SEEDED a group have a decision left to make"*). That comment is true about membership
and false about qualification. A trigger on the grouping path — the group id is already in hand at
[grouping-service.ts:400](../apps/api/src/grouping-service.ts) — needs no inverse query at all: it
just re-offers that one group forward, at 41 ms (or 9 ms after §2.2). **This is the cheapest
event-driven win in the whole design space and it is not an inversion.**

## 5. Does it preserve the decision?

Mostly, with two named divergences and one that is disqualifying unless §2.2 lands first.

**Order dependence survives, per event.** `linkSeededGroups` sorts by publication order *"so a replay
of the same batch makes the same decisions"*
([storyline-linker.ts:170-176](../apps/api/src/storyline-linker.ts)), and a trigger's offer set can
be sorted the same way at no cost. What does *not* survive is order dependence *across* events: the
sweep walks the window front-to-back once a night, so tonight's offers are made in one fixed order
against one fixed database state, whereas a trigger interleaves offers with live ingest. Two runs
over the same corpus can therefore reach different assignments. That is a real divergence and it is
already true of the ingest path itself, which is why the repo's replay discipline is stated about
batches, not about wall-clock history.

**The `ownGroups > 1` guard and the retroactive path are unchanged by construction**, because the
trigger goes through `linkGroup` and changes nothing inside it. Worth restating what that buys: an
already-homed group re-offered late takes the guard at
[storyline-linker.ts:305-315](../apps/api/src/storyline-linker.ts), and gains **one** additional arc
ever — `existing.length === 1 ? qualified.find(…) : undefined`
([storyline-linker.ts:326-330](../apps/api/src/storyline-linker.ts)) — with the comment naming
precisely the failure a trigger could otherwise cause: *"a nightly sweep re-offering the same
fortnight would otherwise walk a four-qualifier group into all four arcs in four nights, which is
percolation with extra steps."* A trigger fires more often than nightly, so it would walk that
percolation faster; the guard is what stops it, and it stops a trigger exactly as well as it stops
the sweep.

**The divergence that disqualifies the trigger on today's code:** the inverse retrieval concludes
"group G should be offered to arc S", but `linkGroup` then re-derives its own candidate set for G
using the **capped full-profile** query — and per §2, that cap discards 83% of the candidate space on
399 of 400 groups. So the trigger can identify a qualifying pair and then hand it to a decision that
cannot see it. Usually S survives, because S just gained coverage and the ordering is
`last_coverage desc` — but `refreshDaySlots` derives coverage from article publication dates, not
from `now()`, so an arc that absorbed an old group can have old coverage and be truncated away.
**A trigger built before §2.2 lands would silently drop some of the offers it correctly identified.**
That is not a reason to reject the inversion; it is the reason the retrieval fix is a prerequisite
rather than an alternative.

One more, smaller: a sweep-performed formation is dropped before labelling. The `changed.push` filter
tests `attachedTo.length`, `merged.length` and `pendingFormation`
([chores.ts:224-228](../apps/api/src/chores.ts)) but not `attached` or `promoted`, so with the
coherence gate inert a sweep offer that merges two singletons and promotes the winner
([storyline-linker.ts:400-417](../apps/api/src/storyline-linker.ts)) carries no label trigger,
contradicting [chores.ts:167-172](../apps/api/src/chores.ts) (*"a retroactive promotion names the
newly-real storyline"*). A trigger must test `attached || promoted.length` too, or it inherits the
bug at higher frequency.

## 6. Termination and fan-out

PR #114 capped its convergence loop at four rounds and argued termination anyway: *"Each merging
round strictly shrinks the number of live storylines, so the loop terminates without it"*
([storyline-label-merge-trigger.ts:68-79](../apps/api/src/storyline-label-merge-trigger.ts)).

**The analogous argument here is stronger, because there are two monotone measures rather than one.**
An offer can only change something in two ways, and both consume a finite, never-replenished
resource:

1. **A merge** strictly decreases the number of live storylines
   ([storylines.ts:445-448](../packages/storage/src/storylines.ts) sets `merged_into` and empties the
   loser's profile). Bounded by 17,008 today, and monotone: nothing un-merges, because ADR-0011
   refuses to build a split.
2. **A retroactive attachment** consumes a group's single lifetime retroactive-arc slot
   ([storyline-linker.ts:326-330](../apps/api/src/storyline-linker.ts)): once `existing.length > 1`
   the `arc` is `undefined` forever. Bounded by the groups in the window (12,338), and monotone —
   a group never returns to one membership.

So the lexicographic measure (retroactive slots remaining, live storylines) strictly decreases on
every productive round, and a round that changes nothing fires nothing and ends the cascade. The
cascade terminates without a round limit, and a round limit is still worth having for PR #114's
actual reason — bounding *how much of the convergence one ingest batch pays for* — not for
termination.

Two disciplines the sweep gets from phase ordering and a trigger must supply itself. The nightly pass
runs the bridge sweep before the late-candidate sweep deliberately: *"a pair that should be one
storyline should be one BEFORE old groups are offered to it, or the offer is made against a profile
that is about to change"* ([chores.ts:436-439](../apps/api/src/chores.ts)). A trigger has no phases,
and the natural implementation fires from inside `cascadeMerge`
([storyline-linker.ts:107](../apps/api/src/storyline-linker.ts) bounds it at 32) — against a survivor
that is one hop from becoming a loser, burning a group's one retroactive slot on a UUID about to be
aliased away. So: **debounce to the end of the cascade, and alias-resolve before offering.** That is
the same discipline `runBridgeSweep` already applies for the same reason.

## 7. Cost where it lands

Per event, using the measured retrieval and the measured per-offer cost:

| | retrieval | offers | per-offer | **per event** |
|---|---|---|---|---|
| attach / merge on a promoted arc, today's linker | 2.93 ms | 2.05 | 41 ms | **~87 ms** |
| …with §2.2's narrowed retrieval | 2.93 ms | 2.05 | 22 ms | **~48 ms** |

Against the budget: `SYNC_FILL_DEADLINE_MS` defaults to 1,200 ms
([config/src/index.ts:217](../packages/config/src/index.ts)), it is a **start-gate on the next
upstream call** rather than a timeout, and the linker already spends ~190 ms of it —
*"linking one upstream page's worth of seeded groups costs ~190ms … Against the 1200ms default that
is ~16%"* ([grouping-service.ts:236-244](../apps/api/src/grouping-service.ts)), on top of ~700 ms per
upstream call ([ARCHITECTURE.md:495](ARCHITECTURE.md)) and ~27 ms of corpus maintenance
([TRAILING-CORPUS.md:117-121](TRAILING-CORPUS.md)). **Inline is out**: one or two events per page
would take the linker's share from 16% to 24–30%, and Phase 0 §2's whole complaint is that this pass
has no budget discipline.

**The tail is where it goes**, and it is a well-marked seam: `linkSeededGroups` is awaited
([grouping-service.ts:246](../apps/api/src/grouping-service.ts)), everything after it is constructed
and dropped at [grouping-service.ts:290-291](../apps/api/src/grouping-service.ts) (`void tail`),
where a single label already costs ~8 s. 48–87 ms is noise there. Two costs come with it:

- **Tail work is invisible to `meta.ingest`.** The response caches on `state === "complete"`
  ([timeline-service.ts:378](../apps/api/src/timeline-service.ts)), and a retroactive attachment
  landing after that is invisible for the TTL. This is not hypothetical — it is the measured trending
  failure at [trending-service.ts:296-310](../apps/api/src/trending-service.ts), where 61 labels
  landed in the ~3 minutes after a cloud of 3 was cached.
- **It must never throw**, per [storyline-label-service.ts:47-52](../apps/api/src/storyline-label-service.ts).
  Same contract PR #114 accepted.

**Not the queued consumer.** `startConsumer` runs at concurrency 1
([ingest-queue.ts:118-146](../apps/api/src/ingest-queue.ts),
[server.ts:209](../apps/api/src/server.ts)), and `processSampleJob` already holds that single worker
for *"~3 minutes measured"* while it awaits the label tails
([trending-service.ts:334-341](../apps/api/src/trending-service.ts)) — with segment jobs a reader is
polling on queued behind it. Adding late-candidate work there lengthens the one hold the repo already
flags as *"the first thing to revisit if §6.5 latency regresses."*

## 8. What the trigger cannot cover — the backstop's honest job

Sorted by whether an event trigger can see it at all.

**A storyline-change trigger can see** (movable off the backstop): profile widening on attach or
merge; `last_coverage` moving, the only input to the dormancy half of the bar; a candidate's
`groupCount` crossing 1→2, which un-blocks a coherence refusal
([storyline-linker.ts:252-271](../apps/api/src/storyline-linker.ts); refusals have no expiry and no
delete path — [storylines.ts:1343-1357](../packages/storage/src/storylines.ts) — and ADR-0011:133
says they exist *because* of the sweep).

**A grouping-path trigger could see, if added** (§4's sixth event): an article joining an existing
group; a group merge enlarging the winner
([grouping-service.ts:403-440](../apps/api/src/grouping-service.ts)); and the sighting fold, which
rewrites an existing article's `published` and `language`
([ingest.ts:167-193](../packages/storage/src/ingest.ts)) — changing whether the group is even inside
the sweep's window, which corpus language partition it is measured against, and the `nowMs` every
dormancy verdict is computed from.

**Only an unscoped re-offer can find these — this is the backstop's real job:**

1. **Withheld formations lost by the tail.** A withheld formation writes *nothing*: both groups keep
   their provisional singletons, `attachedTo` and `merged` are both empty, and the only carrier is
   the in-memory `LinkOutcome`
   ([storyline-linker.ts:145-162](../apps/api/src/storyline-linker.ts),
   [:380-398](../apps/api/src/storyline-linker.ts)). `resolvePendingFormations` is reachable from one
   function ([storyline-formation.ts:249-267](../apps/api/src/storyline-formation.ts) via
   [storyline-label-service.ts:98-109](../apps/api/src/storyline-label-service.ts)), and its own
   failure log says *"the late-candidate sweep will re-offer it."* The state a withheld formation
   leaves is **indistinguishable from no state at all**, so no storyline-change trigger can see it —
   the only way to rediscover it is to re-run `linkGroup` and have it re-derive the same withhold,
   which is why [chores.ts:219-230](../apps/api/src/chores.ts) lets `pendingFormation` past the
   filter. (Inert today: `coherenceGate` is `STORYLINE_COHERENCE_GATE && Boolean(GEMINI_API_KEY)`
   at [wiring.ts:84](../apps/api/src/wiring.ts) and there is no key configured — so this obligation
   becomes live the moment one is, with no code change.)
2. **Trailing-corpus drift under a fixed group.** The strongest argument for keeping a backstop, and
   the one class with no storyline anywhere in the causal chain. `pruneStoryDf` deletes buckets older
   than `windowDays + 1` ([chores.ts:101-110](../apps/api/src/chores.ts)), so a group published 12
   days ago is measured against a window reaching back 25 days whose back end is *already gone* —
   both `corpus.size` and every `df` shrink as the group ages inside the sweep window, the anchor
   ceiling tightens with `size`, and `ln(N/df)` moves data-dependently. Independently, articles are
   bucketed by `published`, not by ingest time
   ([story-df.ts:96-121](../apps/api/src/story-df.ts)), so a late-published article or a
   `rebuildStoryDf` raises df *inside* an old group's window. **Same group, same storyline, neither
   side changed, different verdict** — driven by last night's retention chore. Covering this with an
   event trigger would mean firing on "the corpus for language L changed", which is every ingest
   batch: no bound at all.
3. **Groups in no storyline whatsoever.** `linkGroup` is not one transaction, and a crash before
   birth leaves a group taking *no timeline slot* — measured: *"7 groups (9 articles) from
   2026-07-24..31 sat unlinked in the dev archive … with the cursor three weeks ahead of them"*
   ([storyline-backfill.ts:80-82](../apps/api/src/storyline-backfill.ts)). No storyline changed,
   because there is no storyline.
4. **Bridges and alias re-points lost between qualification and insert.** Every offer re-runs
   `recordBridgesAmong`, and `recordBridge`'s idempotency *is* the independence rule
   ([storylines.ts:1000-1009](../packages/storage/src/storylines.ts)), so a free re-offer repairs
   evidence a crash dropped and retires bridges pointing at merged-away UUIDs.
5. **Anything the trigger itself dropped** — a crashed tail, a dropped promise, a disabled flag, a
   deploy window. Exactly the list [chores.ts:336-338](../apps/api/src/chores.ts) already writes for
   the label-merge backstop.

**Can the backstop be bounded to fit 300 s?** Yes, and §2.2 is most of the answer: at 22.3 ms/group
the *whole* window is ~275 s unaided. With a trigger or filter carrying the common case, a resumable
bound of ~4,000 groups a night is ~90 s and covers the window every three nights — defensible
because the residual classes above are slow-moving (corpus drift moves with the retention chore's
daily cadence; a stranded group waits for the next pass either way). What that needs is the unscoped
work Phase 0 §2 already identified — `maxGroups` on `StorylinePassDeps`, a `--max-groups` flag, and a
**persisted cursor**, because [chores.ts:193](../apps/api/src/chores.ts) seeds `after` from the
window's start, so a bound without a cursor re-sweeps the newest groups forever while reporting a
clean tally.

## 9. The cheaper option, priced honestly: the same query, at 3am

The alternative the task asked to compare — *keep the sweep nightly, but offer only groups whose
candidate set could have changed* — turns out to issue **the same statement as the trigger**, batched.
"Which groups could have changed?" is the union of §3's inverse retrieval over the arcs that changed
since the last run. The two designs differ in *when*, and in almost nothing else:

| | nightly changed-set filter | ingest-tail trigger |
|---|---|---|
| retrieval query | §3's, once per changed arc | §3's, once per changed arc |
| nightly cost | ~250 events × 2.9 ms ≈ **0.7 s**, plus ~512 offers × 22 ms ≈ **11 s** | the same total, spread over 24 h |
| reader-latency exposure | **none** (3am) | 48–87 ms of dropped tail per event |
| invisible-to-`meta.ingest` risk | none | real ([timeline-service.ts:378](../apps/api/src/timeline-service.ts)) |
| fan-out / cascade discipline | none needed — it is one pass | debounce, alias-resolve, round cap (§6) |
| new state required | a "changed since" marker | none |
| freshness | up to 24 h late | minutes |

The filter's one cost is the marker, and it is not free: `storyline_groups.attached_at` looks like the
answer but is not, because `mergeStorylines` **preserves the loser's `attached_at` on repoint** —
*"when a group joined the story is a fact about the group, not about which of two UUIDs won"*
([storylines.ts:397-404](../packages/storage/src/storylines.ts)) — so a merge winner would not appear
in `attached_at > $lastRun`. It needs either a `storylines.changed_at` touched by
`refreshStorylineDerivations`, or a pair of predicates (`attached_at > $t` union `merged_into` set
since `$t`) plus the `chore_runs` row §3.3 of the scope doc already introduces.

**And freshness is the trigger's only real advantage, which is worth asking about honestly.** The
collision trigger of PR #114 earned its keep because the thing it accelerated was *visible to a
reader* — six live arcs all named "Canada US Trade Talks" standing until an operator ran the CLI
([storyline-label-merge-trigger.ts:19-22](../apps/api/src/storyline-label-merge-trigger.ts)). A late
candidate attaching within minutes rather than by morning is invisible by comparison: the group
already renders in its own timeline slot, and gaining a second arc changes a storyline page a reader
is unlikely to be looking at. **There is no measured reader-visible cost to the 24-hour delay**, and
without one the trigger is paying real complexity for freshness nobody asked for.

## 10. Verdict — rewritten 2026-08-23, after five sessions tested it

**The original verdict was "feasible-with-conditions, third in line", and its ordering is now
spent**: step 1 shipped and was gated, step 2 was built and defaulted off, step 3 was built and
measured *harmful*, step 4 became moot. What is left is a different question with a different answer.

### The situation this actually leaves

**Nothing is delivering ADR-0011's retroactive attachment.** The sweep is gated off, the changed-set
filter is off and discredited as a safety measure, the joined-group re-offer is off. That is the fact
that reorders everything below: the original verdict deferred the inversion because two cheaper
options sat in front of it, and both are now switched off — one of them permanently, since it
provably accelerates the runaway it was meant to bound.

**And the safety question has one answer for all of them.** Every offer, from any trigger, goes
through the same `bridgePairs` cross-product. Bounded to a group's top two qualifiers, the cap-built
and from-scratch archives converge on the same largest arc (22) — so the *starting state* stops
mattering and the *mechanism* is the bound. Unbounded, the birth path alone reaches 2,591 groups and
the hybrid drifts at a flat 0.25 merges per arrival. **The only combination the evidence refuses is a
corrected retrieval with an unbounded cross-product**, and that refusal applies identically to the
sweep, the trigger, and doing nothing but ingesting.

### Can the inversion be implemented? Yes, with two changes to the design

**It cannot go on the ingest tail.** §7 priced the tail at 48–87 ms per event on the strength of a
retrieval naming 2.05 groups. The sound retrieval names **105.6**, so a realistic night of 250
changed arcs names 3,698 window groups — 29.4% of the window — in 5.6 s of retrieval alone, before
any linking. At the measured per-offer cost that is seconds per storyline change, and changes come
per attachment and per merge. The home is the chores route §3.3 already built as an individually
addressable endpoint, or the queued consumer: an event-**queued** offer, not an event-**inline** one.

**And it must carry the bound.** Not as a precaution — as the thing that makes it equivalent in
safety to every other path.

Those two changes cost it most of its case. Queued rather than inline, its advantage over simply
re-enabling the bounded sweep is hours of freshness, not days.

### What to decide, and what to measure first

**The open question is no longer "is the inversion sound?" — it is "is freshness worth anything to a
reader?"** That was flagged as unmeasured in the original §7 and it is still unmeasured, and it is now
the only thing separating the two live options:

- **Re-enable the bounded sweep.** Nothing new to build. `STORYLINE_NARROW_RETRIEVAL=true` plus
  `STORYLINE_MAX_BRIDGING_QUALIFIERS=2` plus `STORYLINE_LATE_CANDIDATE_SWEEP=true`, watched against
  the nightly graph-shape row. Delivers ADR-0011's behaviour tonight.
- **Build the event-queued trigger.** ~3–4 days, and its remaining benefit over the above is latency
  measured in hours.

**Measure the freshness question before building anything.** If no reader-visible cost of the delay
exists — and §7 never found one — the honest conclusion is to enable the bounded sweep and not build
this at all. If one does exist, the trigger is implementable and the design above is the shape it
should take.

### The cost nobody should discover later

The bound is not free, and its price was hand-read rather than counted: **FIFA/Infantino goes from one
coherent 152-group arc to roughly forty fragments whose largest is 12.** It also retains only 27% of
the archive's derivable bridge observations. That is err-narrow, which ADR-0011 prefers — while also
saying the merge is the only repair it will build. Whoever turns these flags on is accepting that
trade, and it should be a decision rather than a surprise.

### The numbers that actually drove the final answer

`CANDIDATE_LIMIT` bound the cross-product on **both** paths, not just under re-offers. The birth path
unbounded reaches **2,591 groups (9.96%)**. The hybrid drifts at **0.25 merges per arrival against
0.015**, flat — a standing increase, not a backlog. Bounded at the top two: **0.034, largest arc 22,
cap-built and from-scratch identical.** And the sound inverse retrieval names **105.6 groups per arc**,
which is what moved the trigger off the tail.

> **Settled 2026-08-23. The freshness the trigger buys is worth nothing to a reader, so step 5 is
> not "for now" — it is the answer.** §7's last line said *"there is no measured reader-visible cost
> to the 24-hour delay"* and §9's table left `freshness` as the trigger's one live column. It is
> measured now, and the column is empty: the coverage a re-offer attaches is a **median 3 nights
> old** when the sweep finds it, only **40.5%** of attachments concern coverage even one night old,
> and the surfaces that would OFFER the changed arc to a reader are gated behind a label backlog of
> **2,083 unlabelled promoted arcs** against a 500/day quota. Accelerating an attachment from 3am to
> minutes accelerates nothing a reader can reach.
>
> Measured with `pnpm measure:storylines-v2 --reader-latency`, a report on the existing
> `replayWithReoffers` rather than a second instrument: `ReplayEvent` is a read-only observer on
> `addGroupTo` and `mergePair`, `undefined` by default, and the birth-only calibration still
> reproduces the committed grid's largest arc of **22** exactly. Read-only against `zammy`, no model
> call, no flag or default changed — the retrieval and the bound were passed as environment to the
> measurement process only.
>
> **Every figure below**: pinned bar (share 0.002, mass 20), K=2, retrieval **narrowed** (cap 4,000),
> bridge cross-product bounded at the **top 2**, cascade + bridge re-pointing modelled, `--days=41`
> (the full 40-day archive; the CLI's 31 truncates), interleaved — one sweep pass a night, which is
> what the chore runs. Nights from **2026-08-15** (`--from-night`), because a night's sweep reads a
> trailing 14 days and until the corpus has run that long every attachment is fresh by arithmetic
> rather than by promptness. 8 nights, 2,055 sweep attachments, 489 sweep merges.
>
> **Day-add versus day-fill: 69/31, and the 69 is smaller than it looks.** A storyline pages over
> `storyline_days`, so an attachment that adds a day the arc did not cover is a new card, and one that
> joins a day it already covers only lengthens an existing slot's member list.
>
> | re-offer event | events | day-ADD | day-FILL | add% | onto an arc already real |
> | --- | --- | --- | --- | --- | --- |
> | retroactive attach (ADR-0011's own path) | 1,945 | 1,316 | 629 | 67.7% | 72% |
> | late fresh attach (a group that found nothing at birth) | 110 | 94 | 16 | 85.5% | 93% |
> | merge | 489 | 337 | 152 | 68.9% | 98% |
>
> The 69% is not 69% of a reader's attention, because **half of those new cards do not land at the top
> of the arc**: 49.1% at rank 1, 49.8% at rank 2–3, 1.1% at rank 4–7. A retroactive card at rank 2 is
> a card a reader reaches by scrolling a page they had to be offered first.
>
> **The age distribution is the argument, and it settles it cheaply.** Nights between the attached
> coverage's own day and the sweep that attached it — a distribution, because the mean of this is
> nobody's experience:
>
> ```
> 0d:689  1d:143  2d:141  3d:149  4d:201  5d:129  6d:122  7d:147  8d:118  9d:69  10d:64  11d:36  12d:24  13d:23
> p10 0d   p50 3d   p90 9d   max 13d
> ```
>
> **59.5% of attachments are of coverage at least two nights old** — the arc has been missing that day
> since that day, and a few more hours against a two-to-nine-night delay is a rounding error on
> staleness that already exists. Per night, the median lands between 1 and 4 nights on the ordinary
> nights and at 10 on the last, and the per-night table is reported because the pooled figure is
> confounded: this corpus's days hold between 108 and 3,265 groups, and a night whose window is
> dominated by one 3,265-group day reads as all-fresh by arithmetic.
>
> **The first night the flags go on is the extreme case of the same point.** The cap-built archive's
> backlog, priced on the same instrument (`--reoffer-mode=posthoc --capped-build=200 --passes=1`):
> 7,067 attachments in one night, median age **11 nights**, **0.2%** of them one night old or less.
> A backlog is by definition a population for which latency cannot matter.
>
> **What else surfaces off these arcs — and this is where the trigger loses outright.** Three gates,
> each read from the code rather than inferred:
>
> - **The cloud never reads `storyline_days`.** `findTrendingStorylines`
>   ([trending-storylines.ts:124-180](../packages/storage/src/trending-storylines.ts)) counts articles
>   published inside `TREND_WINDOW_HOURS` (24) and orders on that count times `0.5 ^ (age / 8h)`, then
>   on `max(a.published)`. Coverage older than the window cannot move the cloud however promptly it is
>   attached — and only **33.5%** of attachments are still inside that window at the moment of the
>   sweep. It also gates on `count(distinct source_domain) >= 2` **within** the window.
> - **A promoted arc is not offerable until it is named.** `findSurfacedStorylines` requires
>   `label is not null` and `status <> 'provisional'`
>   ([storyline-timeline.ts:265-299](../packages/storage/src/storyline-timeline.ts)); the cloud
>   additionally refuses `coalesce(label_source,'') <> 'bigram'`. Counted on the live archive:
>   **2,083 of 3,850** live promoted arcs carry no label at all, 706 carry a bigram label the cloud
>   refuses, and **1,061 (27.6%)** are cloud-eligible. **27.3%** of the sweep's attachments land on a
>   provisional arc and promote it, which puts it behind those 2,083 at the free tier's 500/day — days
>   of queue against a 24-hour attachment delay.
> - **`label_words` does not move on an attachment.** A retroactive attach fires the weakest trigger,
>   `drift`, and `needsLabel` spends a call only once membership has doubled
>   (`STORYLINE_LABEL_DRIFT_FACTOR`, 2). `profile_tokens` is re-derived on every attach, and moves on
>   **92.2%** of them; the arc's newest day moves on **33.7%**; **5.9%** move neither and are invisible
>   to every offer surface.
>
> **`meta.ingest` and the cache: §7's trending precedent applies, and it applies AGAINST the
> trigger.** The cloud is cached 15 minutes in Redis and invalidated in exactly one place — the end of
> `processSampleJob` ([trending-service.ts:357](../apps/api/src/trending-service.ts)) — which is
> elected at most once per `SAMPLE_REFRESH_MINUTES` (60). The topic timeline response caches on
> `state === "complete"` with a 60 s / 10 min / 24 h TTL by window end
> ([page-cache.ts:15-20](../apps/api/src/page-cache.ts)) and **nothing invalidates it on a membership
> change**. The storyline view is not server-cached at all
> ([timeline-service.ts:465-518](../apps/api/src/timeline-service.ts)); the browser holds it 30 s.
> So the offer surfaces carry 15–60 minutes of uninvalidated staleness of their own, which swallows
> most of what a minutes-latency trigger could deliver — and a 3am write has the rest of the night for
> every tier to expire before a morning reader arrives, while a 14:00 write lands in a cache a reader
> may be holding. The invisible-tail cost §7 lists is real and it is the trigger's alone.
>
> **Reader behaviour is not measurable, and no proxy was invented for it.** There is no analytics
> dependency in `apps/web` and no client instrumentation of any kind; the schema
> ([database.ts:304-318](../packages/storage/src/database.ts)) has no requests, page-views or sessions
> table, and no storyline carries a read count or a last-read timestamp. The only reader-demand signal
> in the system is `topics.hit_count` / `last_hit_at`, and it is bumped *after* the page-cache check
> ([timeline-service.ts:187-201](../apps/api/src/timeline-service.ts)) so cached reads are invisible,
> keyed per query fingerprint rather than per storyline — a storyline view has no fingerprint and never
> reaches it — and monotonic with no time series to recover. `/metrics` is pipeline-only, in-process
> and unscraped, and ADR-0015 deletes it (it is still wired at
> [server.ts:146-147](../apps/api/src/server.ts), so that is a decision not yet executed). Vercel Hobby
> retains runtime logs for one hour. **Whether readers notice cannot be measured; what the content says
> about whether they could is above, and that is the whole of the answer available.**
>
> **The one reader-visible freshness case already has its own trigger, and it is ON.** PR #114 earned
> its keep on six live arcs all named "Canada US Trade Talks" standing until an operator ran the CLI —
> a *label* collision, which `STORYLINE_LABEL_MERGE_TRIGGER` (default 2) already inverts to the
> collision. The late-candidate sweep's merges are not that case: 98% land on an arc that is already
> real, and the duplicate-name symptom the reader could see is handled by a trigger that ships on.
>
> **Recommendation: enable the flags, do not build the trigger.** Step 5's "don't, for now" becomes
> "don't". Nothing in §9's table changes except the last row, which is now measured rather than open,
> and the ~3–4 days step 5 costs buys latency on a population that is median-3-nights stale, behind
> caches that are 15–60 minutes stale, on arcs that cannot be offered until a label pass days deep in
> quota names them.
>
> **What this does NOT say, and the flag decision still needs a human.** "Enable the flags" is the
> right arm of *this* comparison, not a verdict on the flags. Measured on the same run: the bounded
> sweep interleaved takes the largest arc from birth-only bounded's **22** to **318 (1.22%)** over the
> window, and the judged columns come out at 68.0% piles-formed / 29.7% named-intact / 58.8% kept. So
> the sweep costs something even bounded, and §2.7's "a fortnight of the nightly graph rows" is still
> the gate. This measurement says only that whichever way that goes, the *trigger* adds nothing to it.

---

## Method, and what to distrust

- **Corpus**: `zammy` on Docker Postgres 17.10, read-only (`set default_transaction_read_only = on`
  on every connection). Verified unmutated afterwards: 27,083 memberships and 17,008 live storylines
  before and after, `max(attached_at)` unchanged at a timestamp 6.5 h before this session began.
- **Query timings (§2.2, §3)**: `performance.now()` around each `pg` round trip, one measurement per
  call, every call's duration kept individually for the percentiles. Window `2026-08-08..2026-08-22`,
  `corpusSize = 15,051`, ceiling `max(10, 15051 × 0.002) = 30.1`.
- **Decision equivalence (§2.2)**: the repo's own `groupProfile`, `qualifyingStorylines` and
  `anchorCeiling` imported from `apps/api/dist`, not reimplemented, against SQL that reproduces
  `readCandidateStorylines` statement-for-statement including `order by last_coverage desc nulls
  last, s.id limit 200` and the `candidate.id !== own` filter, with `own` read as
  `readGroupStorylines(groupId)[0]`.
- **End-to-end sweep (§2.3)**: the real exported `runLateCandidateChore` against a `pg_dump -Fc` /
  `pg_restore` clone, freshly `ANALYZE`d, `labeler` **omitted** so no model call was made at any
  point in this research. The narrowing was a temporary env-gated patch to
  `storyline-linker.ts`, reverted (`git status` clean); the clone is dropped.
- **Plans (§3)**: `EXPLAIN (ANALYZE, BUFFERS)` at a median-width and a p90-width promoted profile —
  two widths deliberately, because Phase 0 §2.2 exists to record what one hand-picked plan at the p10
  of a fat-tailed distribution cost last time.

Distrust these:

- **The machine is not the platform**, and this document inherits every word of Phase 0's version of
  this caveat. Loopback Postgres on an M-series Mac. The number most sensitive to it is §2.3's
  275 s projection, which has **no margin against 300 s** — a shared free-tier Supabase instance is
  contended by construction, and Phase 0 measured one contended run at 6× slow. Read "the sweep now
  fits" as "the sweep now fits on this machine", and treat the bound-and-resume work in step 4 as
  required rather than optional.
- **The event rate is the weakest number here.** Steady-state events per night is derived, not
  measured: the dev corpus was built by one backfill on 2026-08-21 (all 26,010 storylines share a
  `created_at` day), so nightly event counts cannot be read off it. The ~250 profile-changing events
  a night comes from new groups per publication day on the days the machine was actually ingesting
  (258–719/day, excluding four backfill days of 1,011–3,161) multiplied by the archive's overall
  attach share (9,002 aliases + 1,073 extra memberships over 26,010 storylines ≈ 35%). Every cost
  figure in §7 and §9 scales linearly with it.
- **§2.3's convergence is unmeasured past two passes.** The narrowed sweep still attached 178 and
  merged 60 on its second pass over the same 2,000 groups. Whether it converges in three passes or
  thirty is not known, and the answer decides how heavy the first week after step 1 is.
- **The union-of-member-tokens filter is a superset, and its false-positive rate is not measured.**
  §3's mass and anchor conditions are evaluated over the union of a group's members' tokens, while the
  decision uses the majority profile. Sound (it can only over-offer), but the 2.05 groups per event
  is an upper bound on what would actually attach, and the gap is unquantified.
- **Two claims in the codebase that this research believes are wrong, and did not verify by
  experiment.** `chores.ts:432-434` says dormancy runs first *"so the late sweep judges candidates at
  the bar their quiet earns"* — but `readCandidateStorylines` does not read `status`
  ([storylines.ts:975-984](../packages/storage/src/storylines.ts)) and `barFor` computes dormancy from
  `lastCoverageMs` ([storyline-link.ts:136-137](../apps/api/src/storyline-link.ts)), so the ordering
  looks decorative. And `storyline-replay.ts:148-150`'s *"which is exactly what `profile_tokens &&
  story_tokens` returns"* is accurate about the predicate and silent about the `limit 200`. Both are
  reasoned from reading, not from a failing test.
- **A replay over "the full window" judges only the trailing fortnight, and this applies to every
  replay figure in this repo.** `pruneStoryDf` keeps `windowDays + 1` buckets
  ([chores.ts:101-110](../apps/api/src/chores.ts)), so `story_token_days` and `story_corpus_days` held
  `2026-08-07..08-24` — 16 days — when the 2026-08-23 measurement ran. `corpusFor` sums a 14-day
  window ending on the group's own day, and `offerGroup` returns before any decision when
  `corpus.size === 0`. So of the 26,045 groups a `--days=41` run loads, only the **12,891** published
  inside the retained window are ever judged; the other 13,154 are loaded, counted in every
  denominator, and silently skipped. `largestShare` is therefore a share of the loaded corpus and not
  of the judged one, which flatters it by about 2×. Nothing above depends on the share, and the
  per-night tables are inside the retained window by construction, but a figure read off this harness
  as "over the whole archive" is not that.
- **The pooled age distribution is confounded by arrival density and must be read per night.** This
  corpus's days hold 108 to 3,265 groups, so a night whose trailing window is dominated by one
  backfill day reads as all-fresh by arithmetic. Pooled over all 18 nights the "one night old or
  less" share is 72.1%; over the eight nights with a full trailing window it is **40.5%**. The second
  is the one reported, and `--from-night` exists so it is a flag rather than a hand-aggregation.
- **The harness cannot model the sweep with the flags OFF.** It applies the 200-row cut only in a
  build phase (`ReplayFidelity.cappedRetrievalLimit`, and `interleaved` refuses it outright), so
  there is no flags-off sweep control here. None is needed for this question — both arms of
  sweep-versus-trigger require the narrowed retrieval (§10 step 1 is a hard prerequisite for the
  trigger) — but it does mean this measurement cannot price the sweep against today's defaults.
- **`zammy` was being written to while this ran, by something else.** A dev API server on the main
  checkout was up in fixture mode and the archive grew from 31,308 to 31,348 articles across the
  session (26,006 to 26,045 groups, ~0.15%), memberships from 27,003 to 27,042 and live storylines
  from 16,924 to 16,961. Read-only from this side — neither `storyline-sweep-cli.ts` nor
  `storyline-judged.ts` holds an `insertInto`, `updateTable` or `deleteFrom`, and `max(attached_at)`
  tracks the newest ingested article rather than anything this session ran — but "verified unmutated
  afterwards" is a claim the 2026-08-22 pass could make and this one cannot. Two tables here were
  taken minutes apart and their group counts differ.

## Corrections to VERCEL-PHASE-0-FINDINGS.md §2

Four, in descending order of how much they matter.

1. **§2.1 states the cap as a performance property; it is also a correctness one.** *"`CANDIDATE_LIMIT`
   caps the 200 rows returned, not the ~1,200 scanned"* is true and incomplete: the cap **binds on
   399 of 400 groups**, and the thresholds it truncates below were pinned against an uncapped
   retrieval ([storyline-replay.ts:148-156](../apps/api/src/storyline-replay.ts)). §2.1 should say
   that the query is not merely expensive but wrong.
2. **§2.1's conclusion — *"the fix has to attack profile width or the number of groups offered, not
   the per-call constant"* — is right, and profile width was attackable all along, for free.** The
   anchor-eligible subset is derivable from the df map `readTrailingCorpus` has already fetched
   ([storyline-linker.ts:233-242](../apps/api/src/storyline-linker.ts) precedes
   [:244](../apps/api/src/storyline-linker.ts)), and it is 14.5× on the query where §2.2's
   denormalized sort key was 8%.
3. **§2.3's yield figures measure a capped retrieval and should say so.** *"~3.5% of offers change
   anything"* and *"re-offering the same groups … changes almost nothing"* are measured at 6.2%
   attach and 0.4% merge per offer (31 and 2 of 500) and become **30.8% attach and 16.2% merge**
   (615 and 324 of 2,000) with a re-sweep that does **not** converge, once the cap stops binding. *"Most of the 465 s buys nothing"* is partly an artifact of the bug rather than a fact
   about the window.
4. **§2's framing of why the sweep exists is half the story.** The linker does not see each group
   once in the sense that matters: at every *later* group's birth it retrieves every overlapping live
   storyline, including old groups' provisional singletons, so retrieval is symmetric by construction
   and it is the 200-row cut that breaks the symmetry. That reframes the sweep from "the caller
   retroactive attachment never had" to "the repair for a truncated retrieval, plus five genuinely
   late classes" (§8).

## Sources

Everything cited is in-repo; no external sources were consulted, and no model call was made at any
point. The primary reading was
[chores.ts](../apps/api/src/chores.ts),
[storyline-linker.ts](../apps/api/src/storyline-linker.ts),
[storyline-link.ts](../apps/api/src/storyline-link.ts),
[storyline-replay.ts](../apps/api/src/storyline-replay.ts),
[storyline-label-merge-trigger.ts](../apps/api/src/storyline-label-merge-trigger.ts),
[grouping-service.ts](../apps/api/src/grouping-service.ts),
[storylines.ts](../packages/storage/src/storylines.ts),
[grouping.ts](../packages/storage/src/grouping.ts),
and the commits `760abe1` / `c690a13` that this document holds itself to.
