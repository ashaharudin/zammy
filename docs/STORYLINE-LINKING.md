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

## The anchor ceiling cannot reach a big running story

Found 2026-08-17, chasing a search for `hormuz` that returned three separate
"Strait of Hormuz Crisis" storylines. The dev archive held that coverage as
**25 live arcs** whose entire shared vocabulary was `{hormuz, strait, iran}` —
mass 10.7 against a floor of 20, every token at 2.1–4.1% of a 17,028-article
fortnight against a 0.2% ceiling. No group could bridge them: the story's own
name had outgrown the rule meant to recognize it, so no bridge was ever
recorded and the K-bridge cure never fired.

Reshaping the ceiling does not fix it either — replayed over all 22,154
groups:

| share | mass | hormuz arcs | biggest arc | largest storyline | empty-profile arcs |
| --- | --- | --- | --- | --- | --- |
| **0.002** | **20** | **71** | 13g | 77 (0.35%) | 0 |
| 0.005 | 16 | 56 | 31g | 109 (0.49%) | 2 |
| 0.01 | 12 | 27 | 36g | 208 (0.94%) | 10 |
| 0.02 | 8 | 9 | 168g | 315 (1.42%) | 58 |

Every setting loose enough to collapse the Hormuz component also builds a
315-group `com, investing` storyline and 58 storylines where no token is
shared by half the members — the entity-and-beat failure ADR-0011 already
forbids, just tripped by a different knob. A coherence floor on the candidate
profile does not rescue it either: at 0.02/8 it pushed thin arcs from 281 to
1,344, because a group refused at its best candidate just lands in a worse
one.

This is what the label-agreement merge (ADR-0011's amendment,
`storyline-label-merge.ts`) exists to reach. The labeler had already told the
Hormuz component apart from the Q2-earnings component sharing the same
failure shape: six of the 25 arcs were independently handed the identical
name "Strait of Hormuz Crisis" by a model reading their headlines — the
semantic judgement no df statistic can make. Run against the dev archive:
`sharedLabels 2 · planned 1 · merged 5 · refused 1` — the Hormuz six
collapsed into one 31-group arc spanning 2026-07-27 → 2026-08-17, relabelled
"Hormuz Strait Crisis"; the Q2 component refused for carrying no grounded
name.

## The merge that never fired

Found 2026-08-17, against the live dev archive rather than the sweep — and the
sweep is why it survived so long. **The K-bridge merge had never fired once.**

`countBridges` had exactly one caller, inside `recordBridgesAmong`, gated on a
bridge row having just been INSERTED. That is the only moment the linker asks
whether a pair has reached K. But a merge **re-points** the loser's bridges onto
the winner (`mergeStorylines`), so a third storyline holding one bridge to each
side of a merging pair ends up holding two to the survivor — K, reached with no
insert, and nothing looking. Found in the archive:

| bridges on the pair | live pairs | merged |
| --- | --- | --- |
| 1 | 1,627 | — |
| **2** | **25** | **0** |
| **3** | **6** | **0** |

Thirty-one pairs at or above K, none merged, every one involving a storyline
that had absorbed merges. No future insert would ever have revisited them.

**The in-memory replay does not reproduce it**, which is why the table at the top
of this page overstates what production achieved: `storyline-replay.ts` resolves
aliases and re-keys its bridge map on merge, so the sweep's `merges` column
measures a linker more correct than the one that shipped. A measurement harness
that reimplements storage will agree with the storage it imagines, not the
storage there is.

A second, narrower miss sat next to it: `countBridges` was called with the ids
the caller had retrieved candidates under, while `recordBridge` alias-resolves
before inserting. A merge earlier in the same loop therefore left later pairs
counted under a stale id — zero rows, check skipped.

**The fix**, in three parts:

- `mergeStorylines` returns `repointed`: the third storylines whose evidence just
  moved. Storage does not know K, so it reports the change and the caller decides.
- `cascadeMerge` in the linker drains those pairs against K after every merge,
  to a fixed point. This is **not** the transitive linking ADR-0009 refused —
  every step is still paid for by K independent groups bridging that exact pair;
  what was broken is that the evidence was on the table and nobody read it.
- `runBridgeSweep` enforces the invariant "no two live storylines hold K
  bridges" over the whole archive, nightly and after a backfill. It is both the
  repair for what accumulated and the backstop for whatever the write path still
  misses.

`recordBridge` now returns the resolved pair it actually wrote, so there is one
place that resolves and no way to count under the wrong id.

The regression test is the archive's own shape: three arcs, one bridge from the
third to each of the other two, then two straddlers merging the first pair.
Before the fix it produced one merge and left the survivor sitting at K for ever;
it now produces two.

## One bug the tests caught, worth remembering

The first version re-homed an already-linked group: on a replay it treated the
group's *real* storyline as a birth storyline and absorbed it into whatever the
group also qualified for — a merge with **no bridge evidence at all**, which is
precisely the percolation K exists to prevent. Re-linking now records bridges
(idempotent by primary key) and leaves the group where it lives. Retroactive
attachment of an already-homed group is S5's concern; the backfill replays from
scratch, so every group is born fresh there.

## What the anchor rule cannot see

Found 2026-08-18, chasing 2-group storylines built out of vocabulary
coincidence: an off-duty officer shot outside a Pennsylvania lounge joined to a
Los Angeles father shot by an off-duty ICE officer (`73dbc49f`, "Fatally
Shot"); a £90 ticket for a Lidl EV charger joined to a new charger at The Lodge
in Canberra (`8899bfdf`, "Charging Ev"); Stephen Curry's Golden State
**Warriors** joined to Nigeria's El-Kanemi **Warriors** (`cd876389`, 4 groups).

**The anchor rule is not the defect, and no rearrangement of the token evidence
is the fix.** That is a measured claim, and this section is the measurement.

Dev archive, 2026-08-18: **27,733 articles in 23,004 groups over 35 days**;
3,135 live non-provisional storylines, largest 97 groups.

### The evaluation set the campaign left behind

The labelling campaign is what makes this measurable. Asked to name every
storyline the bigram fallback had labelled or left bare, a model named 1,189 and
declined 382. Those 382 are **339 live rows carrying `label_source = 'bigram'`
plus 43 that have since merged away**, and reading them confirms the report:
they are dominated by two unrelated articles sharing a word.

So the linker finally has a labelled set in *both* directions — the thing this
document's own anchor-share finding says it never had ("a sweep table cannot
tell you whether a storyline is coherent").

| set | meaning | live | at 2 groups |
| --- | --- | --- | --- |
| **declined** (`bigram`) | a model saw it and could not name it | 339 | 88 |
| **named** (a model id) | a model named it; holds every large correct arc | 1,189 | 164 |
| unjudged (`null`) | never offered to a model — no verdict, no set | 1,608 | 774 |

`scoreJudged` (`storyline-judged.ts`) scores a replay against both, and
`measure:storylines-v2` now prints them as `PILES-FORMED` and `NAMED-INTACT`
on every row of the grid. Baselines are **relative**: the replay substitutes
storage and models neither the label-agreement merge nor the nightly bridge
sweep, both of which built the archive's biggest arcs, so it reassembles about a
third of the named sets exactly. Compare candidates against the pinned row in
the same harness; the absolute figure is not a grade.

### The reported shape was wrong

The hypothesis was that these piles rest on a **single** anchor, and that
requiring a second piece of evidence at formation — the equivalent of
`STORYLINE_MERGE_BRIDGES=2`, which formation indeed lacks — would remove them.
Both named examples refute it on their own evidence:

| storyline | shared tokens (df) | ceiling | mass | sub-ceiling anchors |
| --- | --- | --- | --- | --- |
| `73dbc49f` | fatally(10) shot(100) **off-duty(3)** officer(153) outside(84) | 31 | 30.9 | **2** |
| `8899bfdf` | **charging(10) ev(13) charger(8)** | 17 | 20.1 | **3** |

Neither is thin evidence. Both clear every threshold in the design comfortably,
with room to spare, and the second one's *entire* shared vocabulary is anchors.
The declined set as a whole carries a median of 1 and a mean of 1.94 sub-ceiling
anchors; the named set carries 2 and 2.49. The distributions overlap almost
completely.

### Thirty-one settings, five families, one result

Every candidate discriminator was scored the same way over the 88 declined and
164 named storylines at 2 groups, where formation is unambiguous — the later
group's profile against the earlier group's, under the corpus as it stood on the
later group's day. A useful rule blocks the left column and spares the right.

Fourteen of the thirty-one are shown; the omitted ones are further
parameter values of the same families, and none of them behaves differently.

| candidate rule | blocks declined | **destroys named** |
| --- | --- | --- |
| ≥2 sub-ceiling anchors *(the hypothesis)* | 46 (52.3%) | **45 (27.4%)** |
| ≥3 sub-ceiling anchors | 68 (77.3%) | **101 (61.6%)** |
| ≥5 shared tokens | 60 (68.2%) | **68 (41.5%)** |
| overlap coefficient ≥ 0.30 | 62 (70.5%) | **67 (40.9%)** |
| Jaccard ≥ 0.15 | 63 (71.6%) | **75 (45.7%)** |
| mass ≥ 25 | 61 (69.3%) | **50 (30.5%)** |
| rarest anchor df ≤ 5 | 49 (55.7%) | **62 (37.8%)** |
| anchor is a proper noun (`properNounEvidence`) | 67 (76.1%) | **81 (49.4%)** |
| any shared token is a proper noun | 49 (55.7%) | **55 (33.5%)** |
| anchor appears in both TITLES | 53 (60.2%) | **61 (37.2%)** |
| proper-noun anchor in both titles | 79 (89.8%) | **110 (67.1%)** |
| the two groups are not from one domain | 35 (39.8%) | **35 (21.3%)** |
| an anchor concentrated in ≤2 days of the window | 64 (72.7%) | **80 (48.8%)** |
| an anchor with df/days-present ≥ 1.5 | 12 (13.6%) | **29 (17.7%)** |

**Not one of them separates the sets.** The ratio sits near 2:1 across every
family — overlap size, rarity, lexical class, provenance, temporal
concentration — and the last row is worse than doing nothing. Requiring a second
anchor, specifically, buys 46 piles for 45 real storylines.

### Confirmed on the whole archive, not just the pairs

Replayed over all 23,004 groups (`--days=40`, K=2), the same trade appears in
the grid, and the direction is unambiguous:

| share | mass | largest | share% | piles formed | named intact | groups kept | piles per arc destroyed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **0.002** | **20** | **76** | **0.330** | **245/338 (72.5%)** | **362/1189 (30.4%)** | **63.1%** | — *(pinned)* |
| 0.002 | 25 | 58 | 0.252 | 162 (47.9%) | 230 (19.3%) | 55.6% | **0.63** |
| 0.002 | 30 | 46 | 0.200 | 127 (37.6%) | 158 (13.3%) | 46.4% | **0.58** |
| 0.001 | 20 | 75 | 0.326 | 224 (66.3%) | 324 (27.2%) | 57.1% | **0.55** |
| 0.0005 | 20 | 75 | 0.326 | 193 (57.1%) | 299 (25.1%) | 53.1% | **0.83** |
| 0.003 | 20 | 81 | 0.352 | 244 (72.2%) | 370 (31.1%) | 64.8% | *looser: −1 pile, +8 arcs* |

Every tightening destroys **more real storylines than it prevents piles** —
under one pile per arc, in all four directions tested. The looser setting is
marginally better on both counts, which is the same finding the anchor-share
section already recorded from the other side.

**Percolation was never the binding constraint here.** The largest storyline is
76 groups, 0.330% of the corpus, and no candidate in this investigation moved it
past 0.4%. ADR-0009's alarm is quiet; this failure is invisible to it.

### The two cheaper hypotheses, also refuted

**A content-quality floor on anchoring articles.** `50e2a392` ("Snow Melt") is
two Buffalo News stubs whose whole body is "Click here to view this item from
buffalonews.com", and it is a genuine anecdote — but it is an anecdote:

| | declined (338) | named (1,189) |
| --- | --- | --- |
| holds a "click here to view this item" stub | **1 (0.3%)** | 0 |
| holds any article with an empty or <40-char description | 10 (3.0%) | **143 (12.0%)** |
| holds an article with no description at all | 5 (1.5%) | **112 (9.4%)** |

Content-free bodies are **four times more common in the storylines the model
could name**. A floor here removes one pile and puts 143 real storylines at
risk. Refused.

**Source chrome in `story_tokens`.** This one is real and worth recording.
Site furniture reaches the linker's vocabulary — `pennlive`, `com` from a title
suffix; `buffalonew`, `click`, `view` from a stub; `welcome hill defense natsec
beacon` is the *entire* shared evidence of `d5444871`, two unrelated Hill
newsletters linked by their own masthead; `c101eb76` is two `r/Stocks` daily
threads sharing 20 tokens of template. Stripping each article's own
source-identity tokens, replayed over the whole archive:

| | largest | piles formed | named intact | groups kept |
| --- | --- | --- | --- | --- |
| pinned | 76 | 245 | 362 | 63.1% |
| source identity stripped | 77 | **235 (−10)** | **352 (−10)** | 62.9% |

Ten piles for ten real storylines — 1:1, the same trade as every threshold, for
the price of re-deriving `story_tokens` across the archive and rebuilding
`story_token_days`. Not shipped. (It may still be right on other grounds; it is
not a fix for *this*.)

Wire and journal boilerplate is likewise real and likewise a minority: 41 of the
338 declined storylines (12.1%) are built entirely from press-release, filings,
analyst-note or preprint domains, against 24 of 1,189 named (2.0%). The domain
skew is sharp — marketbeat 5.20% of declined member articles against 1.22% of
named, globenewswire 4.66% against 0.57%, frontiersin.org 2.80% against 0.28%,
akipress 2.00% against 0.07%, hkexnews 1.27% against 0.03% — and this is the
**known residue** the anchor-share section already recorded, grown but not new.

### What the declined set is actually made of

Reading it is what explains why no statistic works. Four categories, and only
the last is "coincidence" in the sense the report assumed:

- **an entity two stories share.** `1175e940` — Diddy countersues a producer,
  Diddy pays his lawyers $8M. `718f3ed2` — two unrelated Marco Rubio stories.
  `f4ba18f9` — two Star Trek episodes. `4335e242` — Gaza rubble removal and Gaza
  beekeepers. This is exactly what ADR-0011 forbids: *"'Trump Iran War' is a
  storyline; 'Donald Trump' is not."*
- **a beat or a market.** Two skincare listicles (`4bd2f6d0`), two watch
  launches (`8afb34f8`), two `fool.ca` dividend columns (`4611d35f`).
- **a source's recurring template.** The Hill newsletters, `r/Stocks` daily
  threads, two `bizjournals` winery listicles sharing 19 template tokens.
- **a turn of phrase.** "cordoned" joining two unrelated police cordons
  (`712d234f`); "off-duty"/"fatally"; "charging"/"ev"/"charger".

Every one of these is a *semantic* distinction — same happening versus same
subject — and document frequency cannot make it. A name specific to one event
and an ordinary word that is merely infrequent in news both sit at df 2–30:
`ogbah`, `doubleverify`, `myer` alongside `biweekly`, `wearable`, `psychologist`,
`cross-border`, `monoculture`. The anchor's premise is "there is a name here";
its implementation is "this token is rare"; the archive says those are different
propositions.

### Where the fix belongs

ADR-0011 wrote the answer down in advance. The linking seam "is explicitly where
an LLM verdict could slot in later if token evidence proves insufficient", and
it does not ship "while auto-merge exists to heal its misses". **The evidence
above is that proof, and the misses in question are not the kind a merge
heals** — the label-agreement merge cures over-narrow formation, and this is the
opposite failure.

The verdict is also, already, being computed and thrown away. A promotion makes
exactly one model call. A model shown two unrelated articles and *told* they
cover one story — the shipped prompt opens "These headlines all cover ONE news
story" — either invents a name or writes a sentence, `validateLabel` refuses it,
and the storyline keeps a bigram label and stands. The 382 declines ARE the
verdict, arriving as a formatting failure and discarded as one.

`storyline-coherence.ts` is the pure half: a prompt that stops asserting the
conclusion and offers the decline, and `readCoherenceReply`, which returns
**three** cases and never collapses them.

| reply | meaning | what may act on it |
| --- | --- | --- |
| `named` | a usable, grounded label | use the name |
| `incoherent` | the model explicitly said NOT ONE STORY | **the only case that may refuse a formation** |
| `unusable` | unavailable, timed out, out of quota, contract broken | keep the storyline; bigram fallback — today's behaviour, unchanged |

That three-way split is the whole safety argument, and it is not theoretical:
the dev key is free tier, its ceiling is **500 requests per day per model**, and
the labelling campaign exhausts it — this investigation hit the wall mid-run.
An implementation that read silence as a refusal would dissolve the archive on a
quiet Tuesday.

### The verdict, measured (2026-08-18)

Run on **`gemini-3.1-flash-lite`, the configured model**, once the free-tier day
rolled over:

```bash
pnpm measure:storyline-coherence --size=2 --per-set=88   # resumable; 500/day/model
pnpm measure:storyline-coherence --report                # matrix, no calls
```

**At two groups — where formation happens — it works.**

| set | answered | NOT ONE STORY |
| --- | --- | --- |
| declined | 88 | **75 (85.2%)** |
| named | 86 | 27 (31.4%) |

The 31.4% is **not** a 31.4% loss, and finding that out required reading all 27.
The named set is contaminated, because naming is an easier question than
coherence and the shipped prompt *tells* the model the coverage is one story —
so the namer produced a plausible label by describing whichever article it found
most nameable. Adjudicated by one unblinded reader (me), the 27 break down as
**~22 coincidence piles the namer papered over, ~4 borderline entity-or-beat, and
1 clear error** (`bdfc89eb`, two UFC 330 build-up pieces). Several are not
judgement calls:

| campaign label | what the two articles actually are |
| --- | --- |
| "Philadelphia House Horror" | *"You're gonna need a better shark"* + the Philly house of horrors |
| "European Climate Court Case" | a Russian climate case + *"20 SPECTACULAR EUROPEAN LANDMARKS FOR YOUR BUCKET LIST"* |
| "Calgary Zoo Bear Escape" | a house fire 7 children escaped + a grizzly escaping Calgary Zoo |
| "Trump Tariff Loophole Closure" | a tariff court ruling + Zac Brown Band giving away a cruise |
| "Obama Retirement Advice" | an Obama quote-of-the-day + a Reddit *"feeling broke"* thread |

So the true false-positive cost at two groups is **1–5 of 86 (1.2%–5.8%)**, not 27.
The gate is the first candidate in this whole investigation that is not a
bidirectional trade.

The 13 declined it *named* cut the same way: ~3 are storylines the **campaign**
got wrong (`56ce166f`, the Maple Ridge bear attack covered twice; `66cb6c4d`,
the US-Iran deal expiring; `30111d24`, two nearly identical winery listicles), and
~7 are genuine misses (two Diddy stories, two Star Trek pieces, two market
week-ahead columns).

**Second-order finding, and the more important one.** If ~26% of the sampled
two-group *named* storylines are piles, the reported failure is materially
**larger than 382** — and the `NAMED-INTACT` column above preserves a set that
itself contains piles. It remains the right metric for comparing settings, since
the contamination is constant across them; it is not clean ground truth, and no
future reader should treat it as one.

### …and on mature arcs it must never run

The same verdict, over **all 21 named arcs at 20 groups or more** — the "check
what a change destroys" test:

| refused | arc |
| --- | --- |
| — | Tropical Storm Lala (97g), Trump Secret Plane Swap (93g), FedEx St Jude Championship (86g), Strait of Hormuz Crisis (47g), USS Lincoln Conditions Inquiry (43g), European Total Solar Eclipse (41g), Infantino FIFA Leadership Crisis (37g) |
| **REFUSED, correctly** | Y Intercept Hong Kong Filings (31g), Canadian Q2 Earnings Season (25g) — *the known boilerplate residue* |
| **REFUSED, wrongly** | Adley Rutschman Red Sox Trade (35g), Google Pixel Tag Launch (30g), Lok Sabha Session Logjam (26g), Michigan Senate Democratic Primary (25g), Albanese Melon Controversy (23g), Air Canada Stock Surge (22g), El-Sayed Michigan Senate Race (22g) |

**9 of 21 refused — 43%.** Two of those are the residue this document already
records and the gate is right about them. Seven are genuine event arcs, and one
of them, `el-sayed / michigan / primary / senate`, is a profile the anchor-share
section holds up as the *model* of event-shaped coverage.

The mechanism is not mysterious: a ten-headline sample of a 35-group arc spans
rumour, reaction, analysis and adjacent players, and the prompt's disqualifier
list — "share only a person, a place, a team, a market" — makes the model
suspicious of exactly the breadth a mature arc earns. Precision at formation is
bought with recall on long arcs.

This is a **load-bearing constraint on the wiring, not a reason to abandon the
gate**, because the gate only ever needed the two-group moment. But note what it
rules out: `labelStoryline` fires on `promotion`, `merge` AND `drift`, and drift
fires on every doubling of membership. Wiring the verdict into that call
unscoped would put it on mature arcs and dissolve 43% of them. **The verdict may
be consulted only where the storyline is not yet real.**

### The write path, as built

Wired 2026-08-18. `STORYLINE_COHERENCE_GATE=true` by default, and inert without a
`GEMINI_API_KEY` — with no model there is no verdict to wait for, and deferring
would only lose formations.

**It DEFERS, it does not revert.** On the fresh path the arriving group's birth
storyline is absorbed by **merge-with-alias** (`storyline-linker.ts`), so undoing
a promotion is the split ADR-0011 deliberately does not build. Where the winner
is still a provisional-of-one the linker therefore withholds the merge, reports
`pendingFormation`, and returns; the state that would need unwinding is never
created. Everything else about that decision is unchanged, including the bridges
— "this group qualified for both of these" is a fact about those storylines
whatever happens to the formation, and suppressing it would leave the K-bridge
merge blind.

`resolveFormation` (`storyline-formation.ts`) runs in the tail that already
labels — off the latency path, started and not awaited — and spends **no extra
model call**: the promotion label was already one call, and a model that can name
the story has thereby said it is one.

| verdict | what happens |
| --- | --- |
| explicit `NOT ONE STORY` | a refusal is recorded; both groups keep their own provisional storylines and keep rendering as ordinary slots |
| a usable name | the withheld merge is performed, the storyline promoted, and that name written (`label_source` = the model id) |
| **anything else** | the withheld merge is performed, promoted, bigram fallback — **exactly the pre-gate outcome** |

The third row is the one production depends on. A 429, a timeout, a spent daily
quota or a contract-breaking answer must all form the storyline: the archive's own
key has a 500-request DAILY ceiling that the labelling campaign exhausts, and a
gate reading silence as a refusal would dissolve storylines on a quiet Tuesday
rather than on evidence.

Three more properties, each measured or argued above:

- **Scoped to the two-group moment.** `mayRefuseFormation` admits a `promotion`
  whose winner held one group and nothing else, per the 43% false-refusal rate on
  mature arcs. `resolveFormation` re-checks it at resolution time too, because
  another arrival may have attached while the tail was queued — a formation that
  is no longer a formation is simply performed, unjudged.
- **Refusals are durable, and keyed on GROUPS** (migration 0015,
  `storyline_formation_refusals`). Without that the nightly late-candidate sweep
  re-offers the pair and buys the same refusal every night. Groups rather than
  UUIDs because a provisional storyline-of-one is an identity a group is wearing:
  it can be merged away, and a refusal keyed on it would then name nothing.
  A refusal bars only that FORMATION — not the group from ever joining that arc
  once it is real and wide, which is a different question the gate is bad at.
- **The backfill does not gate.** A budget decision, not a doubt: replaying the
  archive produces thousands of formations at one call each. It rebuilds what the
  token evidence says and leaves verdicts to the live path. Refusals survive it,
  being keyed on groups.

The sweep is deliberately unchanged and still measures the **token** decision. It
has no model and cannot have one — a grid of 30 settings over 23,000 groups is
hundreds of thousands of decisions — so `PILES-FORMED` and `NAMED-INTACT` answer
"what would the anchor rule build", which is still the question when a threshold
moves.

### The retroactive cleanup, applied (2026-08-19)

`pnpm dissolve:storyline-piles` — dry run, reviewed, then `--apply`. Scope was the
hand-verified set only: `label_source = 'bigram'` at exactly two groups.

The population had already fallen from 88 to **66** on its own, because the live
gate has been refusing formations since it shipped — 101 of them by the time this
ran, and reading a sample confirms they are what they claim (Paul Parker on a
player against Rooney's nose surgery; sharks-and-hurricanes against synthetic
tumour data).

| verdict | n | action |
| --- | --- | --- |
| NOT ONE STORY | **49** | dissolved |
| named | 7 | kept |
| no verdict (429) | 10 | untouched — quota, and quota never acts |

Both sides of all 49 verified afterwards: one group each, provisional,
unlabelled, live, day slot intact. **48 revived the departing group's original
UUID**; one minted a new identity, being an `attachGroup` formation with no alias
to revive. Live storylines 3,348 → 3,299, aliases 8,601 → 8,553, refusals 101 →
150. No group was left without a storyline, and no refused pair shares a
two-group storyline.

**The 7 keeps are the more useful half of the result, because the gate erred
toward keeping** — which is the safe direction when the action is destructive.
Two of them say the *campaign* was wrong to decline: `07c02679` is really the
Strait of Hormuz coverage, and `30111d24` is two near-duplicate winery
listicles. Three more — "South Korea AI Ambition", "Diddy Legal Battles",
"Middle East Peace Prospects" — are arguably beats rather than events, kept
piles this pass did not catch. Erring that way costs a pile that was already
there; erring the other way costs a real arc that cannot be rebuilt.

Two things this did NOT touch, both deliberate:

- **The 1,084 known-suspect storylines at 3+ groups** (250 declined, 834 never
  judged). 199 of the 250 have absorbed merges, up to 30 aliases deep, so undoing
  one asks which of N groups belong together — the split ADR-0011 refuses to
  build. Only a full gated relink reaches them, and that re-points all 8,553
  aliases, so it is a decision rather than a chore.
- **The ~26% of model-named two-group storylines the validation found are piles.**
  A real target, and a bad first one: no hand-checked ground truth stands behind
  them.

A pre-existing gap surfaced while verifying, unrelated to any of this: **7 groups
(9 articles, last seen 2026-07-31) hold no storyline at all**, so they take no
timeline slot. They were already unlinked in the pre-cleanup snapshot.
`pnpm backfill:storylines` is what re-offers them.
