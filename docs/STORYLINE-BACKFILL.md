# The storyline backfill — what the archive actually built

Measured record for storylines-v2 S5 (ADR-0011's Rollout). Dev archive on
2026-08-14: **24,541 articles in 20,332 groups** over 31 days,
`APP_TIMEZONE=UTC`, 14-day trailing corpus, at the thresholds S3's sweep
pinned (docs/STORYLINE-LINKING.md). That corpus is ~7% larger than the one S3
swept — a dev API server had been ingesting live articles into the shared
database in between — so counts are comparable in shape, not row for row.

```bash
pnpm story:df --rebuild --days=35     # the corpus the linker measures against
pnpm backfill:storylines --restart    # build every storyline from scratch
```

## What it is

A replay of the linker over the whole archive in publication order, building
`storylines`, `storyline_groups` and `storyline_days` from nothing — then one
labelling pass over what got promoted.

It runs `linkGroup`, the same function live ingest calls. That is the point:
the sweep has an in-memory reimplementation of the *storage* because measuring
a dozen threshold combinations through Postgres would take longer than
regretting them, but a backfill has no such excuse, and a second implementation
of the decision would be a second set of rules to keep in step. What is in
`storyline-backfill.ts` is a loop, a cursor and a report.

**Existing `articles.storyline_id` is ignored entirely.** It is the old
day-bounded model's state and ADR-0011 supersedes it whole; nothing here reads
it or writes it. It dies in S9.

## Resumability without a checkpoint

Progress is **derived, not recorded**. Every group the linker has reached has a
`storyline_groups` row — birth is the first thing that happens to a group, and
the seed-own-identity discipline guarantees it — so "how far did we get" is a
question the join table already answers. There is no checkpoint table to fall
out of step with the work, and no way for a crash to leave the marker ahead of
the writes.

The cursor resumes **at** the last linked group rather than after it. A run can
die between a group's birth and its bridges, and only re-running that group
finishes the job; `linkGroup` is idempotent for exactly this reason. Every read
after the first is exclusive, or each batch would redo its predecessor's last
group.

Ctrl-C stops at the next group boundary and prints the report for what it did.

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
absorbed 1,179 of a day's 1,190 groups — a 99% largest-storyline share, and the
specification's north star. The backfill's 0.14% is below even the sweep's
0.18%, which is the safe direction. Err-narrow formation holds when the linker
runs for real, through Postgres, over the whole archive.

The remaining gaps are the corpus difference and the storage the sweep
substitutes: it has no `CANDIDATE_LIMIT`, and it models absorb-into-winner
slightly differently from the real merge path.

### 6,555 aliases is not 6,555 merges

Only **295** are merges between established storylines. The other ~6,260 are
groups leaving their birth storyline to join a real one — the absorb path,
where a provisional storyline-of-one whose only group found its arc is merged
away so the group does not render twice. Reading the alias count as merge
events would badly overstate what K=2 permits.

### Throughput

**705s for 20,332 groups — 29 groups/s.** Controlled 60- and 120-second samples
during the run gave 1,432/min and 1,741/min, so throughput holds as the table
grows rather than decaying. Per group the linker spends ~10 round trips; the
heaviest single read is candidate retrieval at ~27ms, where the GIN overlap
itself is ~1ms and the rest is two correlated subqueries computing
`last_coverage` and `group_count` for every matching storyline before the
`LIMIT 200` (the ORDER BY needs them). Denormalising both onto the storyline
row — maintained by the same refresh that maintains `profile_tokens` — is the
obvious fix, and it belongs with whoever next touches that read.

## It is nearly, but not exactly, reproducible

Two from-scratch runs over the *same static archive* built worlds that differ
by **2 storylines in 13,777 (0.015%), 1 promoted, 3 day slots**. Measured by
hashing every surviving storyline's (group count × day count) shape:
`b843f6ea…` vs `03df9cc9…`.

The cause is identity. `qualifyingStorylines` breaks mass ties on
`candidate.id`, `readCandidateStorylines` orders its `LIMIT 200` by
`(last_coverage, id)`, and `pickWinner` breaks size ties the same way — and a
storyline's UUID is freshly random on every rebuild. Chronological **order** is
canonical, as ADR-0011's Rollout says; the **outcome** is not bit-identical
across rebuilds, because the tie-breaker is not stable across them.

Recorded rather than fixed. The tie-break lives in S3's decision function, and
changing it changes which storylines form — which would invalidate the sweep
that pinned every threshold. 0.015% is the measured size of the problem.

## Labels

The archive's labels come from the **bigram extractor**, not the model: 2,779
of 2,782 promoted storylines (99.89%), 3 unnameable. Coverage is real; quality
is the floor S4 measured, and it shows — `Price Target`, `Earnings Call`,
`Intercept Hong`, `Uss Abraham`.

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
  2 groups). That is the non-unique-label collision ADR-0011 built the
  date-span disambiguator for, arriving unprompted in real data — and evidence
  of err-narrow fragmentation. S6/S7 will meet it.
- **`European Athletics 2026` and `Clacton by-election`** exercise S4's two
  contract fixes — digits admitted, internal hyphens kept — in the first twenty
  live labels.
- **Latency, not the rate limit, binds.** 142s for 20 labels is **7.1s each**,
  matching S4's measurement, at a 500ms spacing setting. A full relabel of
  2,782 storylines is therefore **~5.5 hours serially** for ~$0.59. Whoever
  runs the production relabel should parallelise the pass first; the archive
  is left on fallback labels deliberately rather than spending five hours to
  prove a point the rehearsal already proved.

## Operating it

```bash
pnpm backfill:storylines                    # resume
pnpm backfill:storylines --restart          # wipe v2 state and rebuild
pnpm backfill:storylines --no-labels        # link only
pnpm backfill:storylines --labels-only      # label what is already linked
pnpm backfill:storylines --max-groups=500   # rehearse on a slice
pnpm backfill:storylines --labels-only --relabel   # re-name everything
pnpm backfill:storylines --label-rate=30    # model calls per minute
```

`--restart` is the only flag that discards state.

`--relabel` is how an operator says "the model config changed": it relabels
every storyline the **configured model** did not name, judged by
`storylines.label_source` (migration 0011), which holds the model id, the string
`bigram`, or null for unknown provenance. Skipping by provenance rather than by
the drift clock is what makes the campaign RESUMABLE — the first version
ignored every skip condition, so a five-and-a-half-hour relabel that died at
hour four started over from the top and spent the whole bill again. A campaign
long enough to need resume was the only one that did not have it. `--relabel-all`
is the escape hatch for a PROMPT change, where every label is stale however it
was produced.

Provenance is also queryable, which the run reports alone never were:

```sql
select label_source, count(*) from storylines
where merged_into is null and label is not null group by 1;
```

The label pass is
rate-limited by wall-clock spacing because a full archive is precisely when an
API's per-minute ceiling is met — 3,000 promoted storylines is 3,000 calls —
and both the ordinary pass and a relabel campaign are resumable — the first via
the drift clock, the second via provenance.

### It refuses to run against an empty trailing corpus

The silent-failure case, and worth a hard stop: with no `story_token_days`
rows, every rarity decision is refused, every group keeps its own storyline,
and the report reads "19,027 storylines, 0 promoted" — which looks like a
threshold problem rather than a missing command. The backfill probes the corpus
first and refuses with the command that fixes it.
