# The storyline backfill — what the archive actually built

Measured record for storylines-v2 S5 (ADR-0011's Rollout). Dev archive on
2026-08-14: **24,541 articles in 20,332 groups** over 31 days,
`APP_TIMEZONE=UTC`, 14-day trailing corpus, at the thresholds S3's sweep pinned
(docs/STORYLINE-LINKING.md). That corpus is ~7% larger than the one S3 swept —
a dev API server had been ingesting live articles in between — so counts are
comparable in shape, not row for row.

```bash
pnpm story:df --rebuild --days=35     # the corpus the linker measures against
pnpm backfill:storylines --restart    # build every storyline from scratch
```

## What it is

A replay of the linker over the whole archive in publication order, building
`storylines`, `storyline_groups` and `storyline_days` from nothing, then one
labelling pass over what got promoted.

It runs `linkGroup`, the same function live ingest calls — the point: the sweep
reimplements the *storage* in memory because measuring a dozen threshold
combinations through Postgres would take longer than regretting them, but a
backfill has no such excuse, and a second implementation of the decision would
be a second set of rules to keep in step. `storyline-backfill.ts` is a loop, a
cursor and a report.

**Existing `articles.storyline_id` is ignored entirely.** It is the old
day-bounded model's state; ADR-0011 supersedes it whole, nothing here reads or
writes it, and it dies in S9.

## Resumability without a checkpoint

Progress is **derived, not recorded**. Every group the linker has reached has a
`storyline_groups` row — birth is the first thing that happens to a group, and
the seed-own-identity discipline guarantees it — so the join table already
answers "how far did we get". No checkpoint table to fall out of step, and no
way for a crash to leave the marker ahead of the writes.

The cursor resumes **at** the last linked group rather than after it: a run can
die between a group's birth and its bridges, and only re-running that group
finishes the job — `linkGroup` is idempotent for exactly this reason. Every
read after the first is exclusive, or each batch would redo its predecessor's
last group. Ctrl-C stops at the next group boundary and prints the report for
what it did.

## The numbers

One from-scratch run over the static archive:

```
linked this run   20332 groups
attached          6260   merges 295
storylines        13777   (+6555 aliases)
promoted          2782  20.19% of storylines
largest storyline 29 groups  0.14% of the corpus
day slots         15815
labels            2779 of 2782 promoted (99.89%), 3 asked and unnameable
runtime           link 705s, label 5s
```

### Against S3's sweep

| | sweep predicted | backfill built |
| --- | --- | --- |
| storylines | 10,603 | 13,777 |
| promoted | 3,039 | 2,782 |
| largest storyline | 35 groups, **0.18%** | 29 groups, **0.14%** |

**The percolation alarm does not ring.** ADR-0009's transitive first cut
absorbed 1,179 of a day's 1,190 groups — 99%, the specification's north star.
The backfill's 0.14% is below even the sweep's 0.18%, the safe direction:
err-narrow formation holds when the linker runs for real, through Postgres,
over the whole archive. The remaining gaps are the corpus difference and the
storage the sweep substitutes — it has no `CANDIDATE_LIMIT`, and it models
absorb-into-winner slightly differently from the real merge path.

### 6,555 aliases is not 6,555 merges

Only **295** are merges between established storylines. The other ~6,260 are
groups leaving their birth storyline to join a real one — the absorb path,
where a provisional storyline-of-one whose only group found its arc is merged
away so the group does not render twice. Reading the alias count as merge
events would badly overstate what K=2 permits.

### Throughput

**705s for 20,332 groups — 29 groups/s.** Controlled 60- and 120-second samples
gave 1,432/min and 1,741/min: throughput holds as the table grows. Per group
the linker spends ~10 round trips; the heaviest read is candidate retrieval at
~27ms, where the GIN overlap itself is ~1ms and the rest is two correlated
subqueries computing `last_coverage` and `group_count` for every matching
storyline before the `LIMIT 200` (the ORDER BY needs them). Denormalising both
onto the storyline row — maintained by the same refresh that maintains
`profile_tokens` — is the obvious fix, and belongs with whoever next touches
that read.

## It is nearly, but not exactly, reproducible

Two from-scratch runs over the *same static archive* built worlds differing by
**2 storylines in 13,777 (0.015%), 1 promoted, 3 day slots** — measured by
hashing every surviving storyline's (group count × day count) shape:
`b843f6ea…` vs `03df9cc9…`.

The cause is identity: `qualifyingStorylines` breaks mass ties on
`candidate.id`, `readCandidateStorylines` orders its `LIMIT 200` by
`(last_coverage, id)`, `pickWinner` breaks size ties the same way — and a
storyline's UUID is freshly random on every rebuild. Chronological **order** is
canonical, per ADR-0011's Rollout; the **outcome** is not bit-identical,
because the tie-breaker is not stable across rebuilds.

Recorded rather than fixed: the tie-break lives in S3's decision function, and
changing it changes which storylines form — invalidating the sweep that pinned
every threshold. 0.015% is the measured size of the problem.

## Labels

The archive's labels come from the **bigram extractor**, not the model: 2,779
of 2,782 promoted (99.89%), 3 unnameable. Coverage is real; quality is the
floor S4 measured, and it shows — `Price Target`, `Earnings Call`, `Intercept
Hong`, `Uss Abraham`.

A 20-storyline rehearsal with `gemini-3.1-flash-lite` (`--relabel`) produced
**19 model labels and 1 fallback**:

| model | groups |
| --- | --- |
| Albanese Trump Call | 6 |
| China Tariff Scam | 5 |
| Trump Drone Tariffs | 4 |
| KPMG audit scandal | 3 |
| European Athletics 2026 | 3 |
| Leavitt Press Succession | 2 |
| DHS Surveillance Probe | 2 |
| Clacton by-election | 2 |

Three things worth keeping:

- **"Trump Drone Tariffs" came back for three different storylines** (4, 3 and
  2 groups) — the non-unique-label collision ADR-0011 built the date-span
  disambiguator for, arriving unprompted, and evidence of err-narrow
  fragmentation. S6/S7 will meet it.
- **`European Athletics 2026` and `Clacton by-election`** exercise S4's two
  contract fixes — digits admitted, internal hyphens kept — in the first twenty
  live labels.
- **Latency, not the rate limit, binds — serially.** 142s for 20 labels is
  **7.1s each**, matching S4. A full relabel of 2,782 storylines is **~5.5
  hours serially** for ~$0.59; whoever runs the production relabel should
  parallelise first. The archive is left on fallback labels deliberately rather
  than spending five hours proving a point the rehearsal already proved.

  Two ceiling caveats. The rehearsal ran at 500ms spacing — **120 calls/min,
  eight times the free tier's 15** — and got away with it only because 7.1s of
  latency held the real rate near 8.5/min; the spacing setting never kept the
  run legal, which is exactly why parallelising is the dangerous half of the
  advice (four workers at 8.5/min each is 34/min, over the ceiling). The client
  now paces itself (`GEMINI_MAX_RPM`, default 15), so a parallelised pass
  inside ONE process is throttled rather than rejected — workers sharing the
  CLI's client cannot beat ~15/min between them, putting the floor for a full
  relabel at ~3 hours. That is per-process, not per-key: a relabel beside a
  live server is two pacers at 15/min on one key, ~30/min, and the API rather
  than the pacer says no. Either run against a quiet server, or pass
  `--label-rate=7` (expect ~6 hours) so the two windows add up to the ceiling.
  See STORYLINE-LABELS.md, "The rate limit, and where it is enforced".

## Operating it

```bash
pnpm backfill:storylines                    # resume
pnpm backfill:storylines --restart          # wipe v2 state and rebuild
pnpm backfill:storylines --no-labels        # link only
pnpm backfill:storylines --labels-only      # label what is already linked
pnpm backfill:storylines --max-groups=500   # rehearse on a slice
pnpm backfill:storylines --labels-only --relabel   # re-name everything
pnpm backfill:storylines --label-rate=8     # model calls per minute; slower only
pnpm backfill:storylines --groups=1,2,3     # link exactly these; cursor ignored
```

`--label-rate` defaults to `GEMINI_MAX_RPM` (15) and is useful only to go
SLOWER — asking for more buys a queue inside the client's pacer, not a faster
run. Going slower is the real use: this run's pacer knows nothing about the
server's, so `--label-rate=7` keeps the two under one 15/min ceiling on a
shared key.

`--restart` is the only flag that discards state.

`--groups` is for the one failure the resume cursor cannot see. Progress is a
keyset over `(group_published, group_id)`: a run starts AFTER the last linked
group and never looks behind itself — right for a rollout, blind to a group
stranded mid-archive with no storyline at all. Such a group takes no timeline
slot, and `--restart` would reach it only by rewriting every storyline.

Found 2026-08-19: **7 groups (9 articles) published 2026-07-24..31 held no
storyline**, the cursor three weeks past them. They were already unlinked
before that day's cleanup, so the cause is older — an ingest that died
mid-batch, or linking that threw for them once.

A targeted run **skips the bridge sweep**: a seven-group repair has no business
triggering archive-wide merges, and the nightly chore enforces that invariant
anyway. Naming a group that IS linked is safe — `linkGroup` is idempotent, so
it re-records bridges and leaves the group where it lives — and a group the
archive no longer holds is ignored rather than reported as a failure.

    pnpm backfill:storylines --groups=40855,40856,40857 --no-labels

Detecting the condition:

```sql
select count(*) from (select distinct group_id from articles) g
where not exists (
  select 1 from storyline_groups sg join storylines s on s.id = sg.storyline_id
  where sg.group_id = g.group_id and s.merged_into is null);
```

`--relabel` is how an operator says "the model config changed": it relabels
every storyline the **configured model** did not name, judged by
`storylines.label_source` (migration 0011) — the model id, the string `bigram`,
or null for unknown provenance. Skipping by provenance rather than the drift
clock makes the campaign RESUMABLE: the first version ignored every skip
condition, so a five-and-a-half-hour relabel that died at hour four started
over and spent the whole bill again — the one campaign long enough to need
resume was the only one without it. `--relabel-all` is the escape hatch for a
PROMPT change, where every label is stale however produced.

Provenance is also queryable, which the run reports alone never were:

```sql
select label_source, count(*) from storylines
where merged_into is null and label is not null group by 1;
```

The label pass spaces its calls by wall clock because a full archive is
precisely when a per-minute ceiling is met — 3,000 promoted storylines is 3,000
calls. The spacing is politeness, not the guarantee: the Gemini client paces
the key itself and sees the retries this pass cannot (docs/STORYLINE-LABELS.md,
"The rate limit"). Both the ordinary pass and a relabel campaign are resumable
— the first via the drift clock, the second via provenance.

### It refuses to run against an empty trailing corpus

The silent-failure case, worth a hard stop: with no `story_token_days` rows,
every rarity decision is refused, every group keeps its own storyline, and the
report reads "19,027 storylines, 0 promoted" — which looks like a threshold
problem rather than a missing command. The backfill probes the corpus first and
refuses with the command that fixes it.
