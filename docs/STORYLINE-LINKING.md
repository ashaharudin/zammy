# The storyline linker — what the sweep said

Measured record for storylines-v2 S3 (ADR-0011's Linking and Lifecycle
sections). Every default in `packages/config` marked MEASURED comes from here.
Dev archive, 2026-08-14: **22,987 articles in 19,027 groups over 31 days**,
`APP_TIMEZONE=UTC`, 14-day trailing corpus (docs/TRAILING-CORPUS.md).

```bash
pnpm measure:storylines-v2 --days=31
```

The sweep replays the real decision functions — `qualifyingStorylines`,
`groupProfile`, `bridgePairs` — over the live corpus chronologically. Only the
*storage* is substituted: an inverted index for the GIN scan, map surgery for
attach and merge. Each group is judged against the fortnight before **it**
arrived, not against today.

## The pinned values

| knob | value | status |
| --- | --- | --- |
| `STORYLINE_ANCHOR_MAX_SHARE` | 0.002 | measured |
| `STORYLINE_MASS_THRESHOLD_V2` | 20 | measured |
| `STORYLINE_MERGE_BRIDGES` (K) | 2 | measured |
| `STORYLINE_ANCHOR_DF_FLOOR` | 10 | **unmeasured** — never binds in English |
| `STORYLINE_DORMANCY_DAYS` | 90 | **unmeasured** — archive too short |
| `STORYLINE_DORMANT_STRICTNESS` | 1.5 | **unmeasured** — same reason |

## Percolation: the alarm never rings

ADR-0009's transitive first cut absorbed **1,179 of a day's 1,190 groups** —
a 99% largest-storyline share — and that failure is the specification's north
star. Across the entire grid the largest storyline never exceeds **2.13%** of
the corpus, and at the pinned values it is **0.18%** (35 groups of 19,027).
Err-narrow formation holds. That is the single most important number here, and
it is not close.

## Anchor share × mass (K=2)

| share | mass | storylines | promoted | attached | merges | largest | share% | p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.001 | 16 | 9,977 | 3,520 | 8,552 | 498 | 32 | 0.17 | 13 |
| 0.002 | 12 | 6,042 | 3,584 | 11,917 | 1,068 | 64 | 0.34 | 22 |
| 0.002 | 16 | 8,371 | 3,474 | 9,830 | 826 | 63 | 0.33 | 19 |
| **0.002** | **20** | **10,603** | **3,039** | **7,834** | **590** | **35** | **0.18** | **16** |
| 0.002 | 25 | 12,815 | 2,535 | 5,826 | 386 | 37 | 0.19 | 15 |
| 0.003 | 16 | 7,621 | 3,319 | 10,349 | 1,057 | 71 | 0.37 | 24 |
| 0.005 | 16 | 6,905 | 3,106 | 10,769 | 1,353 | 88 | 0.46 | 34 |
| 0.01 | 16 | 6,443 | 2,931 | 10,994 | 1,590 | 153 | 0.80 | 37 |
| 0.02 | 8 | 1,987 | 1,780 | 14,672 | 2,368 | 291 | 1.53 | 83 |

## The finding that pinned the anchor share

**A sweep table cannot tell you whether a storyline is coherent.** Reading what
each setting builds is what pinned this, and the numbers alone would have
chosen wrong — 0.01/16 and 0.002/20 have similar-looking rows.

At **0.005 and above the linker builds entity and beat storylines**, which
ADR-0011 explicitly forbids ("'Trump Iran War' is a storyline; 'Donald Trump'
is not"). Three of the top eight at 0.01/16:

- `house, karoline, leavitt, press, secretary, trump, white` — 95 groups. The
  press-secretary *beat*: every briefing regardless of subject, "Leavitt takes
  questions on U.S.-Saudi nuclear deal, China's AI tech, New Jersey voter
  rolls".
- `exchange, hk, hong, kong, stock` — 87 groups of formulaic filings from
  unrelated companies. Not an event at all.
- `price, rating, research, stock, target` — 85 groups of analyst-rating
  boilerplate, the marketbeat family ADR-0009 already knew about.

At **0.002 these are gone** and the top of the distribution is event-shaped:

| profile | groups | days |
| --- | --- | --- |
| `carolina, graham, late, lindsey, south` | 35 | 8 |
| `doug, ford, ontario, premier` | 33 | 14 |
| `fausto, hawaii, hurricane, storm, tropical` | 33 | 6 |
| `abdul, democratic, el-sayed, haley, michigan, primary, senate, steven` | 32 | 11 |
| `david, larry, life` | 31 | 10 |

Below 0.002 real coverage starts fragmenting: at 0.001 the largest genuine
storyline halves (32 groups) and single stories split into pieces.

**Mass is NOT the lever against boilerplate — it makes it worse.** Syndicated
legal disclaimers share *many* moderately-rare tokens, so their mass is high by
construction. Raising mass from 16 to 20 promoted the Hong Kong filings
storyline up the rankings, its profile now visibly the disclaimer itself:
`accuracy, announcement, arising, clearing, completeness, content, disclaim,
expressly, howsoever, liability`. The anchor share is the lever; mass controls
attachment volume (52% of groups attach at 16, 41% at 20).

**Known residue**: two boilerplate families survive at the pinned values — the
HK exchange filings and a Central Asian wire's regional column series. Both are
syndication artefacts rather than linking failures, both are visible in the
sweep, and neither approaches the percolation alarm. Recorded, not fixed; S4's
labeler will make them conspicuous, since neither can be named in a few words.

## K, the bridge count

At 0.002/16:

| K | storylines | promoted | merges | largest | share% |
| --- | --- | --- | --- | --- | --- |
| 1 | 7,100 | 2,773 | 3,416 | 70 | 0.37 |
| **2** | **8,371** | **3,474** | **826** | **63** | **0.33** |
| 3 | 8,651 | 3,679 | 350 | 40 | 0.21 |
| 4 | 8,746 | 3,761 | 189 | 41 | 0.22 |

K=1 **quadruples** merges (826 → 3,416) — single-bridge percolation exactly as
ADR-0011 predicted, one ambiguous roundup chaining storylines together. K=2 is
where it settles, and ADR-0011's starting value survives contact with the data.

An aside worth recording: aggressive merging *reduces* the largest storyline
(K=1's largest is smaller than K=2's). Merging recomputes the profile as the
majority over the enlarged membership, which **tightens** the vocabulary and
makes the storyline harder to join. That is the percolation damper ADR-0011
claimed for majority profiles, visible in the data.

## Dormancy: honestly unmeasured

The dev archive is 31 days. Dormancy windows of 30, 90 and 365 days replay
**identically** — nothing in the archive is ever dormant — and only a 7-day
window moves the numbers at all, which measures nothing about a 90-day rule.

ADR-0011's starting knobs are kept unchanged and marked unmeasured in
`packages/config`. The full-history backfill (S5) is the first thing that can
measure them, and it should.

`STORYLINE_ANCHOR_DF_FLOOR` is unmeasured for a different reason: 0.002 of a
16,000-article window is 32, so the floor of 10 only binds for a language whose
fortnight holds under ~5,000 articles. The archive has no such language.

## One bug the tests caught, worth remembering

The first version re-homed an already-linked group: on a replay it treated the
group's *real* storyline as a birth storyline and absorbed it into whatever the
group also qualified for — a merge with **no bridge evidence at all**, which is
precisely the percolation K exists to prevent. Re-linking now records bridges
(idempotent by primary key) and leaves the group where it lives. Retroactive
attachment of an already-homed group is S5's concern; the backfill replays from
scratch, so every group is born fresh there.
