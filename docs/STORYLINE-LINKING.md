# The storyline linker — what the sweep said

Measured record for storylines-v2 S3 (ADR-0011's Linking and Lifecycle
sections). Every default in `packages/config` marked MEASURED comes from here.
Dev archive, 2026-08-14: **22,987 articles in 19,027 groups over 31 days**,
`APP_TIMEZONE=UTC`, 14-day trailing corpus (docs/TRAILING-CORPUS.md).

```bash
pnpm measure:storylines-v2 --days=31
```

The sweep replays the real decision functions — `qualifyingStorylines`,
`groupProfile`, `bridgePairs` — chronologically over the live corpus,
substituting only the *storage* (an inverted index for the GIN scan, map
surgery for attach and merge). Each group is judged against the fortnight
before **it** arrived, not against today.

## The pinned values

| knob | value | status |
| --- | --- | --- |
| `STORYLINE_ANCHOR_MAX_SHARE` | 0.002 | measured — but see the note below |
| `STORYLINE_MASS_THRESHOLD_V2` | 20 | measured — but see the note below |
| `STORYLINE_MERGE_BRIDGES` (K) | 2 | **measured against a merge the service does not perform** |
| `STORYLINE_ANCHOR_DF_FLOOR` | 10 | **unmeasured** — never binds in English |
| `STORYLINE_DORMANCY_DAYS` | 90 | **unmeasured** — archive too short |
| `STORYLINE_DORMANT_STRICTNESS` | 1.5 | **unmeasured** — same reason |

> **Every "measured" in this table has a caveat as of 2026-08-22, and it is the
> same one.** The replay that measured them does not model `mergeStorylines`
> re-pointing the loser's bridges onto the winner, so it under-counts merging on
> the birth path as well as the re-offer path. Modelled, the pinned bar's largest
> arc is 2,591 groups rather than 72. See "K, re-measured against a replay that
> re-offers" at the end of this document; the two sections between here and there
> were written before it and read the alarm as quiet.

## Percolation: the alarm never rings

ADR-0009's transitive first cut absorbed **1,179 of a day's 1,190 groups** (a
99% largest-storyline share); that failure is the specification's north star.
Across the entire grid the largest storyline never exceeds **2.13%** of the
corpus; at the pinned values it is **0.18%** (35 groups of 19,027). Err-narrow
formation holds.

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
each setting builds is what pinned this: 0.01/16 and 0.002/20 have
similar-looking rows, and the numbers alone would have chosen wrong.

At **0.005 and above the linker builds entity and beat storylines**, which
ADR-0011 forbids ("'Trump Iran War' is a storyline; 'Donald Trump' is not").
Three of the top eight at 0.01/16:

- `house, karoline, leavitt, press, secretary, trump, white` — 95 groups: the
  press-secretary *beat*, every briefing regardless of subject.
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

Below 0.002 real coverage fragments: at 0.001 the largest genuine storyline
halves (32 groups) and single stories split into pieces.

**Mass is NOT the lever against boilerplate — it makes it worse.** Syndicated
legal disclaimers share *many* moderately-rare tokens, so their mass is high by
construction. Raising mass 16 → 20 promoted the Hong Kong filings storyline up
the rankings, its profile visibly the disclaimer itself: `accuracy,
announcement, arising, clearing, completeness, content, disclaim, expressly,
howsoever, liability`. The anchor share is the lever; mass controls attachment
volume (52% of groups attach at 16, 41% at 20).

**Known residue**: two boilerplate families survive at the pinned values — the
HK exchange filings and a Central Asian wire's regional column series. Both are
syndication artefacts rather than linking failures, both visible in the sweep,
neither near the percolation alarm. Recorded, not fixed. (The prediction that
S4's labeler would make them conspicuous was wrong — see "An expectation this
document got wrong" below.)

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
where it settles; ADR-0011's starting value survives contact with the data.

An aside worth recording: aggressive merging *reduces* the largest storyline
(K=1's largest is smaller than K=2's). Merging recomputes the profile as the
majority over the enlarged membership, which **tightens** the vocabulary and
makes the storyline harder to join — ADR-0011's claimed percolation damper,
visible in the data.

## Dormancy: honestly unmeasured

The archive is 31 days, so dormancy windows of 30, 90 and 365 days replay
**identically** — nothing is ever dormant — and only a 7-day window moves the
numbers, which measures nothing about a 90-day rule. ADR-0011's starting knobs
are kept and marked unmeasured in `packages/config`; the full-history backfill
(S5) is the first thing that can measure them, and it should.

`STORYLINE_ANCHOR_DF_FLOOR` is unmeasured for a different reason: 0.002 of a
16,000-article window is 32, so the floor of 10 only binds for a language whose
fortnight holds under ~5,000 articles, and the archive has none.

## The anchor ceiling cannot reach a big running story

Found 2026-08-17, chasing a search for `hormuz` that returned three separate
"Strait of Hormuz Crisis" storylines. The archive held that coverage as **25
live arcs** whose entire shared vocabulary was `{hormuz, strait, iran}` — mass
10.7 against a floor of 20, every token at 2.1–4.1% of a 17,028-article
fortnight against the 0.2% ceiling. No group could bridge them: the story's own
name had outgrown the rule meant to recognize it, so no bridge was ever
recorded and the K-bridge cure never fired.

Reshaping the ceiling does not fix it — replayed over all 22,154 groups:

| share | mass | hormuz arcs | biggest arc | largest storyline | empty-profile arcs |
| --- | --- | --- | --- | --- | --- |
| **0.002** | **20** | **71** | 13g | 77 (0.35%) | 0 |
| 0.005 | 16 | 56 | 31g | 109 (0.49%) | 2 |
| 0.01 | 12 | 27 | 36g | 208 (0.94%) | 10 |
| 0.02 | 8 | 9 | 168g | 315 (1.42%) | 58 |

Every setting loose enough to collapse the Hormuz component also builds a
315-group `com, investing` storyline and 58 storylines where no token is shared
by half the members — the entity-and-beat failure via a different knob. A
coherence floor on the candidate profile does not rescue it either: at 0.02/8
it pushed thin arcs from 281 to 1,344, because a group refused at its best
candidate just lands in a worse one.

This is what the label-agreement merge exists to reach (ADR-0011's amendment,
`storyline-label-merge.ts`; rule and measurements in docs/STORYLINE-LABELS.md,
"The label as merge evidence"). Six of the 25 arcs had independently been
handed the identical name "Strait of Hormuz Crisis" — the semantic judgement no
df statistic can make. Run against the dev archive: `sharedLabels 2 · planned 1
· merged 5 · refused 1` — the Hormuz six collapsed into one 31-group arc
(2026-07-27 → 2026-08-17, relabelled "Hormuz Strait Crisis"); the Q2-earnings
component sharing the same failure shape was refused for carrying no grounded
name.

## The merge that never fired

Found 2026-08-17 against the live archive rather than the sweep — and the sweep
is why it survived so long. **The K-bridge merge had never fired once.**

`countBridges` had exactly one caller, inside `recordBridgesAmong`, gated on a
bridge row having just been INSERTED — the only moment the linker asks whether
a pair reached K. But a merge **re-points** the loser's bridges onto the winner
(`mergeStorylines`), so a third storyline holding one bridge to each side of a
merging pair ends up holding two to the survivor — K reached with no insert and
nothing looking. In the archive:

| bridges on the pair | live pairs | merged |
| --- | --- | --- |
| 1 | 1,627 | — |
| **2** | **25** | **0** |
| **3** | **6** | **0** |

Thirty-one pairs at or above K, none merged, every one involving a storyline
that had absorbed merges; no future insert would ever have revisited them.

**The in-memory replay does not reproduce it**, so the sweep table above
overstates what production achieved: `storyline-replay.ts` resolves aliases and
re-keys its bridge map on merge, so the sweep's `merges` column measures a
linker more correct than the one that shipped. A measurement harness that
reimplements storage agrees with the storage it imagines, not the storage there
is.

A second, narrower miss sat next to it: `countBridges` was called with the ids
the caller retrieved candidates under, while `recordBridge` alias-resolves
before inserting — a merge earlier in the same loop left later pairs counted
under a stale id: zero rows, check skipped.

**The fix**, in three parts:

- `mergeStorylines` returns `repointed`: the third storylines whose evidence
  just moved. Storage does not know K; it reports the change and the caller
  decides.
- `cascadeMerge` in the linker drains those pairs against K after every merge,
  to a fixed point. This is **not** the transitive linking ADR-0009 refused —
  every step is still paid for by K independent groups bridging that exact
  pair; what was broken is that the evidence was on the table and nobody read
  it.
- `runBridgeSweep` enforces "no two live storylines hold K bridges" over the
  whole archive, nightly and after a backfill — the repair for what accumulated
  and the backstop for whatever the write path still misses.

`recordBridge` now returns the resolved pair it actually wrote, so one place
resolves and nothing counts under a wrong id.

The regression test is the archive's own shape: three arcs, one bridge from the
third to each of the other two, then two straddlers merging the first pair.
Before the fix: one merge, survivor stuck at K for ever. Now: two.

## One bug the tests caught, worth remembering

The first version re-homed an already-linked group: on a replay it treated the
group's *real* storyline as a birth storyline and absorbed it into whatever the
group also qualified for — a merge with **no bridge evidence at all**, which is
precisely what K exists to prevent. Re-linking now records bridges (idempotent
by primary key) and leaves the group where it lives. Retroactive attachment of
an already-homed group is S5's concern; the backfill replays from scratch, so
every group is born fresh there.

## What the anchor rule cannot see

Found 2026-08-18, chasing 2-group storylines built out of vocabulary
coincidence: an off-duty officer shot outside a Pennsylvania lounge joined to a
Los Angeles father shot by an off-duty ICE officer (`73dbc49f`, "Fatally
Shot"); a £90 ticket for a Lidl EV charger joined to a new charger at The Lodge
in Canberra (`8899bfdf`, "Charging Ev"); Stephen Curry's Golden State
**Warriors** joined to Nigeria's El-Kanemi **Warriors** (`cd876389`, 4 groups).

**The anchor rule is not the defect, and no rearrangement of the token evidence
is the fix.** That is a measured claim; this section is the measurement. Dev
archive, 2026-08-18: **27,733 articles in 23,004 groups over 35 days**; 3,135
live non-provisional storylines, largest 97 groups.

### The evaluation set the campaign left behind

The labelling campaign made this measurable. Asked to name every storyline the
bigram fallback had labelled or left bare, a model named 1,189 and declined
382 — **339 live rows carrying `label_source = 'bigram'` plus 43 since merged
away** — and reading them confirms they are dominated by two unrelated articles
sharing a word. The linker finally has a labelled set in *both* directions,
the thing the anchor-share finding above says it never had.

| set | meaning | live | at 2 groups |
| --- | --- | --- | --- |
| **declined** (`bigram`) | a model saw it and could not name it | 339 | 88 |
| **named** (a model id) | a model named it; holds every large correct arc | 1,189 | 164 |
| unjudged (`null`) | never offered to a model — no verdict, no set | 1,608 | 774 |

`scoreJudged` (`storyline-judged.ts`) scores a replay against both;
`measure:storylines-v2` prints them as `PILES-FORMED` and `NAMED-INTACT` on
every grid row. Baselines are **relative**: the replay substitutes storage and
models neither the label-agreement merge nor the nightly bridge sweep — both of
which built the archive's biggest arcs — so it reassembles about a third of the
named sets exactly. Compare candidates against the pinned row in the same
harness; the absolute figure is not a grade.

### The reported shape was wrong

The hypothesis: these piles rest on a **single** anchor, so requiring a second
piece of evidence at formation — the equivalent of `STORYLINE_MERGE_BRIDGES=2`,
which formation indeed lacks — would remove them. Both named examples refute it
on their own evidence:

| storyline | shared tokens (df) | ceiling | mass | sub-ceiling anchors |
| --- | --- | --- | --- | --- |
| `73dbc49f` | fatally(10) shot(100) **off-duty(3)** officer(153) outside(84) | 31 | 30.9 | **2** |
| `8899bfdf` | **charging(10) ev(13) charger(8)** | 17 | 20.1 | **3** |

Neither is thin evidence: both clear every threshold comfortably, and the
second's *entire* shared vocabulary is anchors. The declined set carries a
median of 1 and mean of 1.94 sub-ceiling anchors; the named set 2 and 2.49 —
the distributions overlap almost completely.

### Thirty-one settings, five families, one result

Every candidate discriminator was scored over the 88 declined and 164 named
storylines at 2 groups, where formation is unambiguous — the later group's
profile against the earlier group's, under the corpus as of the later group's
day. A useful rule blocks the left column and spares the right. Fourteen of
thirty-one shown; the omitted ones are further parameter values of the same
families and none behaves differently.

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

**Not one separates the sets.** The ratio sits near 2:1 across every family —
overlap size, rarity, lexical class, provenance, temporal concentration — and
the last row is worse than doing nothing. Requiring a second anchor buys 46
piles for 45 real storylines.

### Confirmed on the whole archive, not just the pairs

Replayed over all 23,004 groups (`--days=40`, K=2):

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
marginally better on both counts, the anchor-share finding from the other side.

**Percolation was never the binding constraint here.** The largest storyline is
76 groups, 0.330% of the corpus; no candidate moved it past 0.4%. ADR-0009's
alarm is quiet; this failure is invisible to it.

### The two cheaper hypotheses, also refuted

**A content-quality floor on anchoring articles.** `50e2a392` ("Snow Melt") is
two Buffalo News stubs whose whole body is "Click here to view this item from
buffalonews.com" — a genuine anecdote, but an anecdote:

| | declined (338) | named (1,189) |
| --- | --- | --- |
| holds a "click here to view this item" stub | **1 (0.3%)** | 0 |
| holds any article with an empty or <40-char description | 10 (3.0%) | **143 (12.0%)** |
| holds an article with no description at all | 5 (1.5%) | **112 (9.4%)** |

Content-free bodies are **four times more common in the storylines the model
could name**. A floor removes one pile and risks 143 real storylines. Refused.

**Source chrome in `story_tokens`.** Real and worth recording: site furniture
reaches the linker's vocabulary — `pennlive`, `com` from a title suffix;
`buffalonew`, `click`, `view` from a stub; `welcome hill defense natsec beacon`
is the *entire* shared evidence of `d5444871`, two unrelated Hill newsletters
linked by their own masthead; `c101eb76` is two `r/Stocks` daily threads
sharing 20 tokens of template. Stripping each article's own source-identity
tokens, replayed over the whole archive:

| | largest | piles formed | named intact | groups kept |
| --- | --- | --- | --- | --- |
| pinned | 76 | 245 | 362 | 63.1% |
| source identity stripped | 77 | **235 (−10)** | **352 (−10)** | 62.9% |

Ten piles for ten real storylines — 1:1, the same trade as every threshold, for
the price of re-deriving `story_tokens` across the archive and rebuilding
`story_token_days`. Not a fix for *this*, and refused on that basis.

**Shipped later, on other grounds (2026-08-21, `TOKENIZER_VERSION` 6).** The
replay above stripped each article's *own* source identity, matched against its
domain. What shipped is narrower and needs no domain: `stripSourceAttribution`
peels trailing segments that are attribution-SHAPED, which catches the case this
table could not price separately — a title suffix whose tokens are worth **mass
19.88 against a floor of 20** on the trailing fortnight to 2026-08-21, so a
Global News dateline was one coincidence short of a storyline on its own. The
1:1 trade recorded here still stands as the honest expectation for the general
case; it was the *specific* arithmetic of one outlet's suffix that decided it.
The price was paid as stated — see `TOKENIZER_VERSION` in `grouping.ts` for the
three-step repair a bump like this obliges.

Wire and journal boilerplate is likewise real and likewise a minority: 41 of
338 declined storylines (12.1%) are built entirely from press-release, filings,
analyst-note or preprint domains, against 24 of 1,189 named (2.0%). The domain
skew is sharp — marketbeat 5.20% of declined member articles vs 1.22% of named,
globenewswire 4.66% vs 0.57%, frontiersin.org 2.80% vs 0.28%, akipress 2.00% vs
0.07%, hkexnews 1.27% vs 0.03% — the **known residue** already recorded above,
grown but not new.

### What the declined set is actually made of

Reading it explains why no statistic works. Four categories; only the last is
"coincidence" in the sense the report assumed:

- **an entity two stories share.** `1175e940` — Diddy countersues a producer,
  Diddy pays his lawyers $8M. `718f3ed2` — two unrelated Marco Rubio stories.
  `f4ba18f9` — two Star Trek episodes. `4335e242` — Gaza rubble removal and
  Gaza beekeepers. Exactly what ADR-0011 forbids.
- **a beat or a market.** Two skincare listicles (`4bd2f6d0`), two watch
  launches (`8afb34f8`), two `fool.ca` dividend columns (`4611d35f`).
- **a source's recurring template.** The Hill newsletters, `r/Stocks` daily
  threads, two `bizjournals` winery listicles sharing 19 template tokens.
- **a turn of phrase.** "cordoned" joining two unrelated police cordons
  (`712d234f`); "off-duty"/"fatally"; "charging"/"ev"/"charger".

Every one is a *semantic* distinction — same happening versus same subject —
and document frequency cannot make it. A name specific to one event and an
ordinary word merely infrequent in news both sit at df 2–30: `ogbah`,
`doubleverify`, `myer` alongside `biweekly`, `wearable`, `psychologist`,
`cross-border`, `monoculture`. The anchor's premise is "there is a name here";
its implementation is "this token is rare"; the archive says those are
different propositions.

### Where the fix belongs

ADR-0011 wrote the answer down in advance: the linking seam "is explicitly
where an LLM verdict could slot in later if token evidence proves
insufficient", withheld only "while auto-merge exists to heal its misses". The
evidence above is that proof, and these misses are not the kind a merge heals —
the label-agreement merge cures over-narrow formation; this is the opposite
failure.

The verdict is also already computed and thrown away. A promotion makes exactly
one model call; a model shown two unrelated articles and *told* they cover one
story (the shipped prompt opens "These headlines all cover ONE news story")
either invents a name or writes a sentence, which `validateLabel` refuses,
leaving a bigram label and a standing storyline. The 382 declines ARE the
verdict, arriving as a formatting failure and discarded as one.

`storyline-coherence.ts` is the pure half: a prompt that stops asserting the
conclusion and offers the decline, and `readCoherenceReply`, which returns
**three** cases and never collapses them:

| reply | meaning | what may act on it |
| --- | --- | --- |
| `named` | a usable, grounded label | use the name |
| `incoherent` | the model refused — the NOT ONE STORY sentinel, or one of a narrow list of start-anchored paraphrases | **the only case that may refuse a formation** |
| `unusable` | unavailable, timed out, out of quota, contract broken | keep the storyline; bigram fallback — today's behaviour, unchanged |

The three-way split is the whole safety argument, and it is not theoretical:
the dev key is free tier, ceiling **500 requests per day per model**, and the
labelling campaign exhausts it — this investigation hit the wall mid-run. An
implementation that read silence as a refusal would dissolve the archive on a
quiet Tuesday.

### The verdict, measured (2026-08-18)

Run on **`gemini-3.1-flash-lite`, the configured model**, once the free-tier
day rolled over:

```bash
pnpm measure:storyline-coherence --size=2 --per-set=88   # resumable; 500/day/model
pnpm measure:storyline-coherence --report                # matrix, no calls
```

**At two groups — where formation happens — it works.**

| set | answered | NOT ONE STORY |
| --- | --- | --- |
| declined | 88 | **75 (85.2%)** |
| named | 86 | 27 (31.4%) |

The 31.4% is **not** a 31.4% loss; finding that out required reading all 27.
The named set is contaminated — naming is an easier question than coherence,
and the shipped prompt *tells* the model the coverage is one story, so the
namer plausibly labelled whichever article it found most nameable. Adjudicated
by one unblinded reader (me): **~22 coincidence piles the namer papered over,
~4 borderline entity-or-beat, 1 clear error** (`bdfc89eb`, two UFC 330
build-up pieces). Several are not judgement calls:

| campaign label | what the two articles actually are |
| --- | --- |
| "Philadelphia House Horror" | *"You're gonna need a better shark"* + the Philly house of horrors |
| "European Climate Court Case" | a Russian climate case + *"20 SPECTACULAR EUROPEAN LANDMARKS FOR YOUR BUCKET LIST"* |
| "Calgary Zoo Bear Escape" | a house fire 7 children escaped + a grizzly escaping Calgary Zoo |
| "Trump Tariff Loophole Closure" | a tariff court ruling + Zac Brown Band giving away a cruise |
| "Obama Retirement Advice" | an Obama quote-of-the-day + a Reddit *"feeling broke"* thread |

So the true false-positive cost at two groups is **1–5 of 86 (1.2%–5.8%)**, not
27 — the first candidate in this investigation that is not a bidirectional
trade.

The 13 declined it *named* cut the same way: ~3 are storylines the **campaign**
got wrong (`56ce166f`, the Maple Ridge bear attack covered twice; `66cb6c4d`,
the US-Iran deal expiring; `30111d24`, two nearly identical winery listicles),
~7 genuine misses (two Diddy stories, two Star Trek pieces, two market
week-ahead columns).

#### The matrix above predates the current reader (2026-08-21)

Both cells were produced by a `readCoherenceReply` that has since been
**replaced twice**: once to read paraphrased refusals (issue #98), and once
again to test the declines BEFORE `validateLabel`. The numbers therefore
describe a reader that no longer exists, and a rerun is owed before either
figure is quoted as current.

The second change was not cosmetic. `NOT ONE STORY` is three words and
`validateLabel` grounds on one capitalized word, so coverage saying "story"
anywhere makes the sentinel a contract-passing label — and the transcript shows
it happening: **4 of the run's `named` verdicts carry the label `NOT ONE STORY`
literally**, one of them in the *declined* set, where the gate should have
caught the pile and instead named it after the refusal. Correcting those four
raises both columns (the catch rate and the destroy rate), so the fix does not
flatter the gate.

`--report` cannot re-derive the corrected matrix: the transcript recorded the
*verdict*, not the reply it was read from, so rows already scored `named` or
`incoherent` cannot be re-scored offline. The transcript now carries the reply
(`Row.raw`) so the next reader change can be replayed for free, but that helps
only runs from this change onward. Correcting the cells above needs a real
rerun: one model call per candidate against a 500/day/model free-tier ceiling.

**Second-order finding, the more important one.** If ~26% of the sampled
two-group *named* storylines are piles, the reported failure is materially
**larger than 382** — and `NAMED-INTACT` preserves a set that itself contains
piles. It remains the right metric for comparing settings, since the
contamination is constant across them; it is not clean ground truth, and no
future reader should treat it as one.

### …and on mature arcs it must never run

The same verdict over **all 21 named arcs at 20 groups or more** — the "check
what a change destroys" test:

| refused | arc |
| --- | --- |
| — | Tropical Storm Lala (97g), Trump Secret Plane Swap (93g), FedEx St Jude Championship (86g), Strait of Hormuz Crisis (47g), USS Lincoln Conditions Inquiry (43g), European Total Solar Eclipse (41g), Infantino FIFA Leadership Crisis (37g) |
| **REFUSED, correctly** | Y Intercept Hong Kong Filings (31g), Canadian Q2 Earnings Season (25g) — *the known boilerplate residue* |
| **REFUSED, wrongly** | Adley Rutschman Red Sox Trade (35g), Google Pixel Tag Launch (30g), Lok Sabha Session Logjam (26g), Michigan Senate Democratic Primary (25g), Albanese Melon Controversy (23g), Air Canada Stock Surge (22g), El-Sayed Michigan Senate Race (22g) |

**9 of 21 refused — 43%.** Two are the residue and the gate is right about
them. Seven are genuine event arcs, one of them — `el-sayed / michigan /
primary / senate` — the profile the anchor-share section holds up as the
*model* of event-shaped coverage.

The mechanism is plain: a ten-headline sample of a 35-group arc spans rumour,
reaction, analysis and adjacent players, and the prompt's disqualifier list
("share only a person, a place, a team, a market") makes the model suspicious
of exactly the breadth a mature arc earns — precision at formation bought with
recall on long arcs. A **load-bearing constraint on the wiring, not a reason to
abandon the gate**, which only ever needed the two-group moment. But
`labelStoryline` fires on `promotion`, `merge` AND `drift`, and drift fires on
every doubling of membership — wired there unscoped, the verdict would reach
mature arcs and dissolve 43% of them. **It may be consulted only where the
storyline is not yet real.**

### The write path, as built

Wired 2026-08-18. `STORYLINE_COHERENCE_GATE=true` by default, inert without a
`GEMINI_API_KEY` — with no model there is no verdict to wait for, and deferring
would only lose formations.

**It DEFERS, it does not revert.** The fresh path absorbs the arriving group's
birth storyline by **merge-with-alias** (`storyline-linker.ts`), so undoing a
promotion is the split ADR-0011 does not build; where the winner is still a
provisional-of-one the linker withholds the merge, reports `pendingFormation`,
and returns — the state needing unwinding is never created. Bridges are still
recorded: "this group qualified for both" is a fact whatever happens to the
formation, and suppressing it would blind the K-bridge merge.

`resolveFormation` (`storyline-formation.ts`) runs in the tail that already
labels — off the latency path, started and not awaited — and spends **no extra
model call**: the promotion label was already one call, and a model that can
name the story has thereby said it is one.

| verdict | what happens |
| --- | --- |
| a refusal — `NOT ONE STORY`, or a paraphrase on `DECLINE_PREFIXES` | a refusal is recorded; both groups keep their own provisional storylines and keep rendering as ordinary slots |
| a usable name | the withheld merge is performed, the storyline promoted, and that name written (`label_source` = the model id) |
| **anything else** | the withheld merge is performed, promoted, bigram fallback — **exactly the pre-gate outcome** |

The third row is the one production depends on: a 429, a timeout, a spent daily
quota or a contract-breaking answer must all form the storyline — the
quiet-Tuesday safety argument above, honoured on the write path.

Three more properties, each measured or argued above:

- **Scoped to the two-group moment.** `mayRefuseFormation` admits only a
  `promotion` whose winner held one group and nothing else, per the 43%
  false-refusal rate on mature arcs; `resolveFormation` re-checks at resolution
  time because another arrival may have attached while the tail was queued — a
  formation that is no longer a formation is performed unjudged.
- **Refusals are durable, and keyed on GROUPS** (migration 0015,
  `storyline_formation_refusals`); otherwise the nightly late-candidate sweep
  buys the same refusal every night. Groups rather than UUIDs because a
  provisional storyline-of-one can be merged away, leaving a UUID-keyed refusal
  naming nothing. A refusal bars only that FORMATION, not the group from later
  joining the arc once it is real and wide — a different question the gate is
  bad at.
- **The backfill does not gate.** A budget decision, not a doubt: replaying the
  archive is thousands of formations at one call each. It rebuilds what the
  token evidence says and leaves verdicts to the live path; refusals survive
  it, being keyed on groups.

The sweep is deliberately unchanged and still measures the **token** decision.
It has no model and cannot have one — 30 settings over 23,000 groups is
hundreds of thousands of decisions — so `PILES-FORMED` and `NAMED-INTACT`
answer "what would the anchor rule build", still the question when a threshold
moves.

### The retroactive cleanup, applied (2026-08-19)

`pnpm dissolve:storyline-piles` — dry run, reviewed, then `--apply`. Scope: the
hand-verified set only, `label_source = 'bigram'` at exactly two groups.

The population had already fallen from 88 to **66** on its own — the live gate
has been refusing formations since it shipped, 101 by the time this ran, and a
sample reads as claimed (Paul Parker on a player vs Rooney's nose surgery;
sharks-and-hurricanes vs synthetic tumour data).

| verdict | n | action |
| --- | --- | --- |
| NOT ONE STORY | **49** | dissolved |
| named | 7 | kept |
| no verdict (429) | 10 | untouched — quota, and quota never acts |

Both sides of all 49 verified afterwards: one group each, provisional,
unlabelled, live, day slot intact. **48 revived the departing group's original
UUID**; one minted a new identity, being an `attachGroup` formation with no
alias to revive. Live storylines 3,348 → 3,299, aliases 8,601 → 8,553, refusals
101 → 150. No group was left without a storyline; no refused pair shares a
two-group storyline.

**The 7 keeps are the more useful half of the result, because the gate erred
toward keeping** — the safe direction: a kept pile was already there, where a
wrongly dissolved arc cannot be rebuilt. Two keeps say the *campaign* was wrong
to decline (`07c02679` is really the Strait of Hormuz coverage; `30111d24` is
two near-duplicate winery listicles); three — "South Korea AI Ambition", "Diddy
Legal Battles", "Middle East Peace Prospects" — are arguably beats rather than
events, kept piles this pass did not catch.

Two things this did NOT touch, both deliberate:

- **The 1,084 known-suspect storylines at 3+ groups** (250 declined, 834 never
  judged). 199 of the 250 have absorbed merges, up to 30 aliases deep, so
  undoing one asks which of N groups belong together — the split ADR-0011
  refuses to build. Only a full gated relink reaches them, and that re-points
  all 8,553 aliases, so it is a decision rather than a chore.
- **The ~26% of model-named two-group storylines the validation found are
  piles.** A real target and a bad first one: no hand-checked ground truth
  stands behind them.

A pre-existing gap surfaced while verifying, unrelated to any of this: **7
groups (9 articles, last seen 2026-07-31) hold no storyline at all**, so they
take no timeline slot; already unlinked pre-cleanup, so the cause is older.
`pnpm backfill:storylines --groups=...` reaches them — NOT a plain resume,
whose cursor had passed them three weeks earlier (docs/STORYLINE-BACKFILL.md).

## Where the big arcs come from (2026-08-19)

Chased after the backfill report showed a largest storyline of 135 groups where
the day before it had been 97.

**First, a measurement trap worth naming.** Nothing grew by 38: `Tropical Storm
Lala` is still exactly 97, and a *different* arc overtook it — `Hormuz Strait
Crisis` went **47 → 135 groups in roughly one nightly pass**. The percolation
alarm is a number about the archive, not a storyline; across days it compares
whichever arc happened to be biggest. 135 of 23,645 groups is **0.57%** —
ADR-0009's alarm is nowhere near ringing; what moved is coherence.

### The anchor rule is not how either big arc grew

Both of the two largest problem arcs are **frozen against the anchor rule**,
for the same reason:

| arc | groups | profile | df of profile tokens |
| --- | --- | --- | --- |
| `e2c8dd39` Hormuz Strait Crisis | 135 | `{hormuz, iran, strait}` | 2.3–2.7% of the corpus |
| `b23db435` Canadian Stock Market Investing | 47 | `{dividend, stock}` | 0.37% and 3.7% |

Every profile token is above the 0.2% ceiling, so no arriving group can anchor
on them — the percolation damper working: a growing storyline's consensus
vocabulary tightens until the anchor can no longer reach it. Growth after that
point is **merges and attaches made earlier**, not new anchoring.

`b23db435` shows how the window opens and shuts. **All 47 of its groups are
`fool.ca`** dividend columns; `dividend` was **df 17** when the arc formed —
comfortably under the ceiling — against **df 61 (0.372%)** now, above it.
ADR-0009's original finding ("the story's own name hit df 64 the day it
dominated") happening to a BEAT: the anchor recognised the column series while
its vocabulary was still rare and stopped once the series was established, by
which time the arc held 47 groups — 32 by direct attach, ~7 by bridge merge.

### The label-agreement merge is NOT the vector — do not add a coherence check there

The obvious next place for a verdict, and the archive says it would be wasted:

- **Hormuz**: the absorbed labels are legitimate *exact* agreements — "Hormuz
  Strait Crisis" ×8, "Strait of Hormuz Crisis" ×10. The merge did its job.
- **`b23db435`**: of 40 aliases, **one** carried the matching label; the other
  six model labels were all different names ("Canadian Dividend Passive
  Income", "TSX Market Strategy", …), so the merge could not have built it.

The seam already carries STRONGER evidence than a coherence verdict would add:
two *independent* model labels agreeing exactly, plus the grounded-proper-noun
guard, plus span overlap. Asking "are these one story?" there re-asks a
question two labels have already answered separately.

Contamination enters **earlier, at formation**: an oil-market piece pairs with
a Hormuz piece, the labeller reasonably names the pair "Strait of Hormuz
Tensions", and label agreement merges it in, dragging the market piece along —
each step defensible, the aggregate drifting an event into a topic. 35 of the
arc's 135 lead titles (26%) never mention hormuz, strait, Iran or Tehran; most
are oil-and-markets commentary, which ADR-0011 arguably permits ("follow-ups,
reactions, analysis"), but about ten are not defensible at all — a Canada.ca
diplomatic-appointments notice, a Reddit CMV post, "Daily Stock Market Report
(Mon 3rd August)". **The coherence gate would not refuse these either**: shown
an oil piece and a Hormuz piece, a model plausibly says yes.

### Absorption is a ONE-WAY DOOR, and it is the reason cleanup is time-sensitive

**49 declined piles have already been absorbed into 30 larger arcs**,
permanently beyond `dissolveFormation` — it requires exactly two groups, and
these are now members of arcs of 31 to 135. Every large arc has swallowed
several:

| arc | groups | piles absorbed |
| --- | --- | --- |
| Europe Solar Eclipse | 98 | 5 |
| Hormuz Strait Crisis | 135 | 4 |
| FedEx St Jude Championship | 86 | 4 |
| Tropical Storm Lala | 97 | 3 |
| Trump Turkey Flight Scare | 94 | 3 |
| USS Lincoln Conditions Inquiry | 43 | 3 |
| Y Intercept Hong Kong Filings | 31 | 3 |

So the original 382 split three ways: 66 still dissolvable at cleanup time,
**49 already escaped into real arcs**, the rest at 3+ groups alone. The nightly
chore keeps opening that door: a pile left alone does not stay dissolvable — it
migrates into a correct arc and contaminates it, a stronger argument for acting
promptly than "the timeline looks untidy".

A gotcha for whoever measures this next: **`attached_at` survives a merge**
("the loser's groups keep their original `attached_at`"), so it dates a group's
FIRST attachment to anything, not when it joined its current arc. It cannot be
used to date an arc's growth.

### Single-domain concentration finds the boilerplate residue for free

A genuine event draws several outlets; a publisher's column series draws one.
One aggregate, no model calls:

```sql
-- arcs of 6+ groups whose every member group leads with the same source domain
select s.id, s.label, count(*) groups, min(a.source_domain) domain
from storylines s
join storyline_groups sg on sg.storyline_id = s.id
join lateral (
  select source_domain from articles where group_id = sg.group_id
  order by published limit 1
) a on true
where s.merged_into is null and s.status <> 'provisional'
group by s.id, s.label
having count(*) >= 6 and count(distinct a.source_domain) = 1
order by count(*) desc;
```

| arc size | arcs | single-domain |
| --- | --- | --- |
| 2 | 936 | 23.2% |
| 3–5 | 1,884 | 11.1% |
| 6–19 | 448 | 7.1% |
| **20+** | 31 | **9.7% (3)** |

**35 arcs hold 381 groups at 6+ groups, and all 14 at 9+ are boilerplate or a
beat** — `fool.ca` dividends (47), marketbeat ×5 ("Price Target", "Consensus
Recommendation", "MarketBeat Daily Stock Picks", "Royal Bank"), `akipress`
"South Korea" (30), `hkexnews` ×3, `investing.com` and `benzinga` "Earnings
Call", `prnewswire` InventHelp ×2 — **including both families this document
logged as "known residue … recorded, not fixed"**, found for nothing.

A **detector, not a gate**, on two measured grounds:

- At 6–8 groups roughly a third are legitimate: `winnipegfreepress.com`
  carrying AP sports is one outlet on one real story ("Nationals No Hitter
  Bids", "Minnesota Lynx Playoff Berth", "Twins Orioles Series").
- With one provider configured (ADR-0012 leaves GNews off by default),
  single-domain partly measures PROVIDER coverage rather than publisher
  behaviour. A second provider will move these numbers for reasons unrelated to
  storyline quality, so do not build a threshold on them.

### An expectation this document got wrong

The known-residue note predicted: *"S4's labeler will make them conspicuous,
since neither can be named in a few words."* **It did not.** The labeller named
them fluently — "MarketBeat Daily Stock Picks", "InventHelp Product
Innovations", "Frontiers Research Publication Series", "Canadian Stock Market
Investing". A beat is *easy* to name; naming difficulty was the wrong proxy for
incoherence, which is why this residue grew into top-ten arcs unnoticed. What
does surface them is the domain aggregate above, and — at formation only — the
coherence verdict, which refused two `fool.ca` dividend pairs in the cleanup's
dry run.

## Candidate retrieval was truncating the decision (2026-08-22)

Everything above was measured by the in-memory replay, and the replay retrieves
candidates by *"every storyline sharing at least one token"* with **no limit**.
The service does not. `readCandidateStorylines` adds `limit 200`
(`WHOLE_PROFILE_CANDIDATE_LIMIT`, then called `CANDIDATE_LIMIT`), and it was
documented as *"a safety valve for a pathological token, not a tuning knob"*.

It was not a valve. Measured over **all 12,366 groups** in the dev archive's
trailing window (31,308 articles, 17,008 live storylines, read-only against
`zammy` and mutating only `pg_restore` clones since dropped):

| probing with | rows returned | cap at 200 binds |
| --- | --- | --- |
| the whole group profile | p50 **1,903**, mean 2,074, max 8,054 | **12,266 of 12,366** |
| the anchor-eligible subset | p50 78, p99 684, max 2,625 | 1,131 of 12,366 |

So on 99% of groups the cut was the normal operating point, discarding ~90% of
the candidate set by `last_coverage` recency — which is not what the decision
reads. **Every pinned value in this document was certified against a candidate
set production has never judged.**

### The fix: probe with the anchor-eligible subset

`qualifyingStorylines` rejects a candidate when `evidence.anchorDf >
bar.ceiling`, `anchorDf` is the df of the *rarest shared* token, and `barFor`
only ever divides the ceiling. So a qualifying candidate must share at least one
token whose window df is at or below `anchorCeiling` — probing on that subset is
a **necessary condition**, the same kind of retrieval bound `profile_tokens &&`
already is, and it is free because `readTrailingCorpus` has already returned the
df map (`anchorEligibleTokens`).

| over 800 sampled window groups | full profile | anchor-eligible |
| --- | --- | --- |
| tokens probed with (p50) | 19 | **7** |
| `readCandidateStorylines` mean | 34.9 ms | **2.2 ms** (15.8×) |
| qualifiers found | 34 | **1,181** |
| qualifiers lost | — | **0** |

Zero lost is what a proven necessary condition predicts, and it held over 800
groups. An **absent** token is anchor-eligible and the filter must say so
explicitly — `linkEvidence` scores a token missing from the df map as df 1,
"genuinely the rarest thing there is". 0 of 237,944 profile tokens were absent on
this corpus, so only a unit test holds that line.

The narrowed probe's cap is **4,000** (`NARROWED_CANDIDATE_LIMIT`): it binds on 0
of the 12,366 groups where 200 binds on 1,131 and discards ~10% of qualifiers.
The two move together and only together — see the gate below. It stays a limit
rather than
being deleted because narrowing does not bound the fan-out structurally — a token
can be rare in the 14-day window and still sit in many long-lived storyline
profiles, since storylines outlive the window that measures them (`openai`:
window df 27, in 73 live profiles).

### …and fixing it exposed a second, independent bug

**The nightly late-candidate sweep percolates against the true candidate set,
and is now off by default** (`STORYLINE_LATE_CANDIDATE_SWEEP`).

Four passes of the real `runLateCandidateChore` over 2,000 groups on a clone,
`labeler` omitted so no model call was made:

| | live storylines | largest | 100+ arcs | 20–99 | bridges |
| --- | --- | --- | --- | --- | --- |
| baseline (cap 200) | 17,008 → 16,983 | 124 → 124 | 1 | 15 | 1,913 → 1,927 |
| narrowed, pass 1 | → 16,124 | 124 | 2 | 34 | → 10,002 |
| narrowed, pass 2 | → 16,045 | **157** | 4 | 30 | → 10,237 |
| narrowed, pass 3 | → 16,026 | **201** | 4 | 29 | → 10,256 |
| narrowed, pass 4 | → 16,025 | 201 | 4 | 29 | → 10,282 |

It converges by pass 4, and it converges somewhere wrong. **The largest storyline
grew 124 → 201 from offering 16% of the window**, and the 201 is not a story: it
chains Gaza, the Israel-Iran war and Russia-Ukraine together through shared
diplomatic vocabulary — the transitive percolation K=2 exists to prevent. Two of
the other new arcs (157, 54 groups) are election *beats*, mixing the South
Carolina Senate special with Alabama and Michigan primaries.

Not everything it built is wrong, which is what makes this a threshold problem
rather than a retrieval one: the new 151-group FIFA/Infantino arc — the World Cup
privatisation plan, UEFA's revolt, Infantino seeking Trump's help — is coherent
end to end across all 151 groups, and the 200-row cap was suppressing it.

**Why the replay never caught it.** At the pinned bar the replay builds a largest
storyline of **50** groups. It models birth-time offers only — each group attaches
once and its provisional arc is absorbed — while the sweep re-offers the same
group every night, and `bridgePairs` records the full O(n²) cross-product of its
qualifiers on every offer. Bridges went 1,913 → 10,282 on 2,000 groups. The
sweep's re-offer path is not modelled by the harness that pinned K, so the cap
was silently doing the bounding that K was believed to be doing.

**What this leaves open.** Turning the sweep back on wants K re-measured against
a replay that re-offers groups, which does not exist yet. The retrieval fix
itself shipped unconditionally on the birth path, on the argument that the birth
path is the one the replay *does* model — and **that is no longer where it
stands** (below).

### The narrowing is gated too (2026-08-23)

`STORYLINE_NARROW_RETRIEVAL`, **default off**, and off is the pre-2026-08-22
behaviour exactly: whole profile, `limit 200`.

The birth-path argument above rested on a replay that says 50 at the pinned bar.
A later re-measurement found that harness was **not modelling `mergeStorylines`**
— the service re-points a merge loser's bridges onto the winner rather than
dropping them with the alias, which is the mechanism that makes merging
self-reinforcing, and the harness modelled neither that nor the drop. Modelled
with it, **birth-only** at the pinned bar leaves a largest arc of **2,591 groups
(9.96%)** where that harness reported 72. So the number that justified shipping
this unconditionally was measured against a harness that skipped the merge. (Those
two figures are recorded from that re-measurement; this change did not re-run
them — the harness for it is the same one the K re-measurement above needs.)

Nothing is damaged: all **1,913** standing bridge pairs hold exactly one
independent bridge and **none is at K=2**, so no merge is pending. But a bad merge
is unrecoverable — ADR-0011 refuses to build a split, and the only repair is
`backfill:storylines --restart`, which discards all label history.

**The flag switches a PAIR, and that is the load-bearing part.** #117 changed two
things: the probe tokens, *and* the cap from 200 to 4,000 — a value censused
against the *narrowed* probe. Gating only the narrowing would leave whole profile
+ 4,000, which is neither behaviour: it is the broad probe (p50 1,903 rows, max
8,054) with its only bound effectively removed, feeding `bridgePairs`' O(n²)
cross-product — more percolation-prone than the old behaviour and than the new
one. So both halves come out of one function, `candidateRetrieval`, one object
literal per mode, and `LinkerConfig` carries no other retrieval input.

**The replay reads the same flag**, so the grid above still describes what the
service does — the correspondence whose silent loss caused all of this. Verified
on the 2026-08-23 corpus (29,658 articles in 24,655 groups, read-only): the
pre-#117 replay, the gated replay with the flag **off**, and the gated replay with
it **on** produce an identical 30-row grid, storyline-for-storyline, and the
committed numbers above stand at the pinned bar (largest 50, 0.20%, on a corpus
that has grown since). What the replay still does not APPLY is the row cap — it
now **reports** it instead, as `cappedGroups`: **12,734 of 24,655** groups exceed
the off mode's 200 rows, and **0** exceed the on mode's 4,000 — 0 at the pinned
bar and its neighbours, 1-3 only at the 0.01 and 0.02 shares this document
already refuses. That is the truncation as a printed number rather than a
silence.

## The group whose own membership changed (2026-08-22)

`STORYLINE_REOFFER_JOINED_GROUPS`, off by default, and
`apps/api/src/storyline-rejoin-trigger.ts`.

### What was missing

`groupCreatedArticles` offered the linker **seeded** groups only, on the stated
grounds that *"an article that JOINED a group inherited that group's storylines,
so only the ones that SEEDED a group have a decision left to make."* That is
true about membership and false about qualification. A group is judged on the
**majority** of its members' story tokens (`groupProfile`), and
`readLinkableGroups` re-aggregates them on every read — so with two members the
majority rule needs support from one, and the profile becomes the union. An
arrival can therefore hand its group a vocabulary the linker has never judged,
and nothing on the write path was ever going to ask again. The nightly
late-candidate sweep was the only repair, and it is the one class a
storyline-change filter cannot see at all: the group moved, no storyline did.

The trigger re-offers that one group through `linkGroup` on the ingest tail. Same
profile, same corpus, same thresholds, same `ownGroups > 1` guard and therefore
the same ONE lifetime retroactive arc per group — it changes when the question is
asked, never whether.

**The predicate is "an article joined this group", never "the profile tokens
diffed."** A diff misses the case above from the other side: an arrival carrying a
subset of what the group already said leaves the majority profile byte-identical
while the group's membership, day slots and corpus contribution all move. The
test `is asked even when the join left the majority profile byte-identical`
pins it.

### Yield, measured (2026-08-22)

`pg_dump -Fc` / `pg_restore` clone of the dev archive — 31,308 articles, 26,006
groups, 17,008 live storylines, 27,083 memberships — freshly `ANALYZE`d, the real
exported `linkGroup`, **no labeler anywhere**, so no model call was made. The
trailing window (14 days from the newest group) holds **12,558 groups, of which
1,071 (8.53%) have more than one member**: those 1,071 are the whole trigger
population, ~76 a publication day, against the sweep's 12,338 offers a night.

The control matters. The archive was built by a backfill that never re-offered
anything, so a plain re-offer of *any* window group finds things whether or not a
join caused them. Both cohorts are the full 1,071, each on its own fresh clone:

| 1,071 offers | attached | retroactive arcs | promoted | merges | ms/offer |
| --- | --- | --- | --- | --- | --- |
| membership changed, retrieval as it ships | 6 | 42 | 5 | 4 | 47.2 |
| control: groups of one, same retrieval | 6 | 29 | 6 | 3 | 37.7 |
| membership changed, anchor-eligible retrieval | 111 | **430** | 231 | **170** | 18.4 |
| control: groups of one, anchor-eligible retrieval | 161 | 309 | 226 | 73 | 13.0 |

**On the retrieval as it ships, the trigger buys nothing measurable.** 42
retroactive arcs against the control's 29 is ~1.5σ on Poisson counts — a hint, not
a result. **On the anchor-eligible retrieval it is unambiguous**: 1.39× the
retroactive arcs (430 vs 309, ~4.4σ) and 2.33× the merges (170 vs 73). The
membership change is real evidence; the 200-row candidate cap was swallowing it.

That is the whole reason the knob ships **off**. The offer spends a group's one
lifetime retroactive arc, and that spend is monotone — once `existing.length > 1`
the group can never take another. Firing at ingest frequency rather than nightly
makes an irreversible choice earlier, and today it would make it against a
candidate set the cap has truncated on 399 of 400 window groups. Narrowing the
retrieval first is what makes this knob worth turning on.

Also visible in the control's own numbers: a group of one attaches more often
(161 vs 111) because it is still sitting in its own birth storyline and takes the
merge-with-alias path, while an enlarged group is more often already homed and
takes the retroactive one. Two different doors, and the trigger's population is
mostly behind the second.

### Graph shape, before and after

The largest-storyline metric alone is not evidence against percolation, so the
size distribution travels with it. Every run starts from the same clone: 17,008
live storylines, 13,074 of them singletons, 3,241 at 2–4 groups, 677 at 5–19, 15
at 20–99, 1 at 100+, largest 124, 1,913 bridges.

| after 1,071 offers | live | singletons | 2–4 | 5–19 | 20–99 | 100+ | largest | bridges |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| membership changed, as shipped | 16,998 | 13,063 | 3,240 | 679 | 15 | 1 | **124** | 1,919 |
| membership changed, narrowed | 16,727 | 12,666 | 3,318 | 720 | 22 | 1 | **124** | 5,649 |
| control, narrowed | 16,774 | 12,662 | 3,379 | 714 | 18 | 1 | **124** | 4,118 |

The largest storyline does not move in any run, and neither does the 100+ bucket.
What grows is the middle: 20–99 goes 15 → 22 on the narrowed trigger cohort
against 15 → 18 on the control, and groups sitting in a real (≥2 group) arc go
14,009 → 14,828. That is arcs thickening, which is what a suppressed backlog
draining looks like — not a swallow, which shows up as the top bucket moving.
The bridge count tripling (1,913 → 5,649) is the same fact from the evidence
side and it is the narrowing's, not the trigger's: the control does it too.

### Cost, where it lands

The tail (`void tail` in `grouping-service.ts`), not inline and not the queued
consumer. Inline would take the linker's share of `SYNC_FILL_DEADLINE_MS` from
~16% to 24–30%; the queued consumer runs at concurrency 1 and already holds that
single worker ~3 minutes for the label tails. On the tail, 76 groups a day at
47 ms is ~3.6 s of work spread over a day's batches — one or two offers per
upstream page, alongside labels that cost ~8 s each.

The cost that is real and is not latency: **tail work is invisible to
`meta.ingest` for the cache TTL.** The response caches on `state === "complete"`
(`timeline-service.ts`), so a retroactive attach landing after that is not
visible until the TTL expires — the measured trending precedent is 61 labels
landing in the ~3 minutes after a cloud of 3 was cached. For this trigger it is
the mild version: the group already renders in its own slot and what it gains is
a second arc on a storyline page. Recorded as a known cost, not a blocker.

## The nightly sweep's changed-set filter, and what measuring it turned up (2026-08-22)

`STORYLINE_LATE_CANDIDATE_CHANGED_ONLY`, off by default, and
`storylines.link_dirty_at` (migration 0017). The design, the marker's home and the
guarantee it gives up are in docs/ARCHITECTURE.md §9.1. This is what the
measurement pass found, including two things it was not looking for.

Clone of the dev archive throughout — `pg_dump -Fc` / `pg_restore`, freshly
`ANALYZE`d, the real exported `runLateCandidateChore`, **`labeler` omitted so no
model call was made at any point** — 31,308 articles, 26,006 groups, 17,008 live
storylines, 12,558 groups in the trailing window.

### The inverse retrieval cannot filter on rarity, and that is not a bug

The filter was specified to push `qualifyingStorylines`' own predicates into SQL:
one shared token with `df <= anchorCeiling(N)`, and `Σ ln(N/df) >= massFloor`.
Both are functions of `N` and `df`, and **both are functions of which fortnight
the reader is standing in.** The inverse retrieval stands in the changed arc's;
`linkGroup` will stand in each candidate group's. `pruneStoryDf` deletes buckets
past `windowDays + 1`, so an old group's window is mostly gone and its corpus is a
fraction of a recent arc's — while `anchorDfFloor` does not scale down with it.

One real missed pair, both sides computed:

| | corpus `N` | anchor ceiling | shared tokens' `df` | verdict |
| --- | --- | --- | --- | --- |
| forward, at the group's window | 1,074 | 10 (the floor binds) | 6 | mass 31.8, **qualifies** |
| inverse, at the arc's window | 13,489 | 27 | 32–171 | **no anchor-eligible token at all** |

Over 400 sampled window groups, that form reached **38.9%** of the (group, arc)
pairs the real forward decision qualified — 197 of 506. A filter that misses three
in five is worse than a slow sweep, because the tally still reads clean. And it
cannot be repaired by loosening: pruning can shrink a group's `df` arbitrarily, so
for any token there is some group whose window makes it rare, and there is no
window-independent anchor filter to loosen to.

What survives is the corollary of the mass floor, which is window-independent: the
largest weight one token can carry is `ln(N)`, so clearing the floor needs at
least `ceil(massFloor / ln(N))` shared tokens — 3 at every corpus size this
archive has held, and monotonically more as `N` shrinks. Deriving it from the
widest `N` makes the bound the loosest and therefore the safe one.

| inverse retrieval, 400 sampled groups / 483 arcs | recall | groups named per arc (mean / p50 / p90) | ms (mean / p90) |
| --- | --- | --- | --- |
| mass + anchor, as specified | **38.9%** | 2.1 / 1 / 6 | 2.9 / 5.1 |
| overlap + window + shared-token floor | **87.4%** | **105.6 / 95 / 200** | 101 / 220 |

Every one of the 64 remaining misses is the 200-row safety valve, not the
predicate — all of them sit against an arc that named exactly 200. So the cap is a
dial between lossiness and volume with no good setting, and the selectivity the
design was priced on was being bought with the lossiness above.

**So the narrowing is ~3.4×, not ~24×.** A realistic night — 250 arcs marked
dirty, weighted toward recent coverage — names **3,698 window groups, 29.4% of the
window**, for 5.6s of retrieval. Useful, but not the order of magnitude the filter
was proposed for.

### The percolation alarm does ring, and bounding the sweep is what hid it

Measured while pricing the above, because the filter had to be priced against
something. Four passes of the *unfiltered* sweep on one clone, with the
anchor-eligible retrieval narrowing applied behind a temporary local gate since
that is where the linker is going:

| pass | offered | attachedTo | merges | live | bridges | 20–99 | 100+ | **largest** | ms/offer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | 17,008 | 1,913 | 15 | 1 | **124** | — |
| 1 | 12,275 | 3,487 | 1,411 | 14,229 | 9,700 | 54 | 2 | **588** | 17.1 |
| 2 | 12,275 | 823 | 208 | 13,945 | 10,099 | 55 | 5 | **906** | 8.2 |
| 3 | 12,274 | 115 | 88 | 13,851 | 9,806 | 53 | 5 | **1,214** | 5.0 |
| 4 | 12,273 | 30 | 35 | 13,815 | 9,625 | 52 | 5 | **1,347** | 4.3 |

**1,347 groups is 10.7% of the window in one arc**, against 124 before and the
0.18% the pinned bar was measured at. It is still climbing on pass 4 while
attaches have nearly stopped — the last 133 groups came from 35 *merges*, so the
arc is absorbing other arcs rather than recruiting groups. For scale, ADR-0009's
transitive first cut — the failure this design's north star is set by — absorbed
1,179 of 1,190 groups.

**Two methodological findings, and the first one matters more than the number.**

1. **A bounded sweep hides it completely.** The same four passes with
   `maxGroups: 2000` (which, with no cursor, re-sweeps the same first 2,000 groups)
   converge cleanly and the largest storyline never leaves 124: 615/272 on pass one,
   then 163/49, 12/13, 1/0. The runaway needs the whole window to express itself,
   because the vector is width — a wider qualifier set feeds `bridgePairs`, which is
   the full cross-product over qualifiers, so pairs grow superlinearly in that
   width, more pairs reach K, merges union profiles, and wider profiles overlap
   more on the next pass. Two thousand groups is not a small version of the
   fortnight; it is a different experiment.
2. **Per-offer cost gets better as the graph gets worse.** 17.1 → 4.3 ms/offer
   across the passes, because the work drains. Reading that as "the sweep now fits
   the ceiling" is reading the wrong metric: it fits because there is less left to
   link, and there is less left to link because it has been absorbed.

`recordBridge` is idempotent on `(storyline_lo, storyline_hi, group_id)`, so
re-offering the same group does not re-record a bridge. The growth is not repeated
observation; it is new pairs from wider qualifier sets.

### Two things the queue needs that a window keyset gets for free

Both found by running it, and both are the same rule: **a marker may only be
cleared by a pass that actually asked its question.**

1. **Bound the queue to where it stood when the pass began.** The keyset reads
   forward through `(link_dirty_at, id)`, and every attach and merge an offer
   performs stamps its arc with `now()` — which lands *ahead* of the cursor and is
   picked up later in the same pass. It terminates (§6's monotone measures still
   hold) but it turns one night into "run until the graph stops moving": without
   the bound, a filtered pass over the dev archive was still finding **~2,400
   dirty arcs after twenty minutes**, its own re-marks outpacing the drain. The
   bound also restores the ordering discipline the unfiltered pass has for nothing
   — one pass, one fixed set of questions — and leaves the cascade to the next run.
2. **Do not clear a batch `maxGroups` cut short.** Markers are per-arc, offers are
   the union over the batch, so there is no telling which arc an un-offered group
   came from. Clearing retires questions the pass never asked and the tally reads
   clean either way; leaving the batch marked costs an idempotent repeat.

One smaller thing worth recording because it cost an infinite loop: the marker
column is `timestamptz(3)`. Postgres `now()` is microsecond-precision and a
JavaScript `Date` is millisecond, so at full precision the marker is strictly
greater than the `Date` the driver returns for it — `(link_dirty_at, id) > ($read,
$id)` then matches every row and the keyset never advances, while
`link_dirty_at <= $read` matches none and nothing ever clears. Rounding in the
column makes the round trip exact whatever a writer used. Every writer also uses
the DATABASE's clock, and the pass reads its bound from the same clock, so there
is only ever one.

### Does the filter damp the runaway? No — it accelerates it

The obvious hope is that a filter which offers only what changed is a way to run
the sweep *safely* rather than merely faster. Measured head to head, it is the
opposite. Two clones, both starting from the same restore, both with the narrowed
retrieval; pass 1 is unfiltered in both arms so they diverge only after it, and
the two pass-1 rows agreeing to within 2 attaches is the calibration that lets
the rest be compared.

| pass | offered | attachedTo | merges | seconds | **largest** |
| --- | --- | --- | --- | --- | --- |
| 0 | — | — | — | — | 124 |
| 1 — unfiltered | 12,275 | 3,487 | 1,411 | 210 | 588 |
| 2 — unfiltered | 12,275 | 823 | 208 | 101 | 906 |
| 3 — unfiltered | 12,274 | 115 | 88 | 61 | 1,214 |
| 4 — unfiltered | 12,273 | 30 | 35 | 53 | **1,347** |
| 1 — same, other clone | 12,270 | 3,489 | 1,409 | 205 | 588 |
| 2 — **filtered** | 10,219 | 799 | 249 | 165 | 1,069 |
| 3 — **filtered** | 7,501 | 122 | 88 | 81 | 1,566 |
| 4 — **filtered** | 3,045 | 42 | 67 | 23 | **1,782** |

The filter does what it says on offers — 12,275 → 10,219 → 7,501 → 3,045 — and
**arrives at a 32% LARGER runaway arc than the unfiltered pass it replaces**, at
every pass along the way (1,069 vs 906, 1,566 vs 1,214, 1,782 vs 1,347). It is
also not reliably faster: pass 2 filtered took 165s against the unfiltered 101s,
because ~2,300 changed arcs at ~100ms of inverse retrieval each is most of a pass
on its own.

The mechanism is not subtle once stated. The arcs that change on every pass ARE
the arcs the feedback loop runs through — a merge is what marks an arc, and the
runaway grows by merging. So the filter selects for the runaway: it drops the
harmless offers and keeps the productive ones, and in a percolation regime
"productive" is the problem. **A changed-set filter is a way to run the sweep
cheaper, never a way to run it safely.**

### What this leaves the filter for

Not speed, and not safety, on this evidence. What it leaves behind that is
unambiguously useful is the marker: a durable, crash-safe record of which arcs'
linking inputs actually moved, which is the scoping instrument a threshold
re-measurement needs, and `--changed-only` / `--full`, which let an operator run a
targeted late-candidate pass instead of the whole fortnight. The filter itself
should not be switched on before the bar the sweep judges at has been re-measured;
until then it would reach the same wrong answers sooner.

## K, re-measured against a replay that re-offers (2026-08-22, corrected 2026-08-23)

The measurement `STORYLINE_LATE_CANDIDATE_SWEEP`, `STORYLINE_REOFFER_JOINED_GROUPS`
and `STORYLINE_LATE_CANDIDATE_CHANGED_ONLY` were all gated on. It is recorded here
rather than in a new document because it revises the threshold grid above and the K
table beside it, and a finding that revises a table belongs next to it.

**The answer is not about re-offers, and it is worse than the question assumed.**
Building the missing half of the harness turned up a divergence in the half that
already existed: the replay does not model what `mergeStorylines` does to bridge
evidence. With that modelled, **the pinned bar percolates on the BIRTH path alone**,
and the sweep is a 1.75x amplifier on top of a graph that is already broken. K is not
the binding constraint, and raising it is not the best available lever.

**Which retrieval this measures, because it is no longer the default.** Every number
in this section is taken with `STORYLINE_NARROW_RETRIEVAL=true` — the anchor-eligible
probe with a 4,000-row cap. PR #128 gated that narrowing and shipped it **off**, so a
reader who assumes today's default reads this whole section backwards. The mode is
printed in the sweep's own header for the same reason. Corpus throughout: `--days=45`,
31,308 articles in 26,006 groups, anchor share 0.002, mass 20, cascade modelled.

### Corrected 2026-08-23: the instrument double-counted a re-offered group

**The first version of this section over-read its own instrument by about a quarter,
through exactly the class of bug the section exists to expose.** `mergePair`
concatenated the loser's membership lists onto the winner's; `mergeStorylines` inserts
them `on conflict (storyline_id, group_id) do nothing`. A group that was a member of
BOTH sides of a merge was therefore counted twice — and since `snapshot` reads an
arc's size off `groupProfiles.length`, that inflated `largestStoryline` and
`largestShare` directly, and let the duplicated profile vote twice in
`storylineProfile`'s majority rule, widening the survivor and so widening the next
pass's retrieval. The tell was available and nobody looked for it: a `largestShare`
above 100%.

Multi-homing arises only from the re-offer path's one retroactive attachment, which
this harness introduced, so the error is confined to exactly the numbers this harness
added:

- **Every birth-only number is unaffected, and reproduces exactly.** `replayLinker`
  offers each group once; on that offer the group's own storyline holds exactly one
  group, so the `ownGroups > 1` branch is unreachable and no group ever acquires a
  second home. Verified rather than argued: the whole birth-only K table below comes
  out column for column identical pre-fix and post-fix, on the same corpus.
- **Every re-offer number was too high, and not by a constant factor.** Bounding what
  may bridge suppresses merges, so the bounded rows had less to double-count and were
  inflated LESS than the baseline. The pre-fix figure is carried beside the corrected
  one throughout, because the size of the error is itself part of the evidence.

What survives, what changes:

- **Survives.** The sweep must stay off. The birth path percolates at the pinned bar
  on its own. K is not the binding constraint. Options 2 and 4 are the levers that
  work and option 3 is not worth building. The recommended order is unchanged.
- **Strengthened.** The birth path is a LARGER share of the problem than the first
  version said — 2,591 of the corrected 4,540 (57%) against 2,591 of 5,927 (44%) — and
  the sweep's amplification falls from 2.3x to 1.75x. The load-bearing claim of this
  section got *more* support from its own correction.
- **Withdrawn: "bounding to the top 5 is worse than doing nothing" was an artifact.**
  Top-5 read 6,745 against a baseline of 5,927; corrected it is 4,145 against 4,540 —
  marginally better, not harmful. It is still useless, which was the actual point.
- **Withdrawn: post-hoc no longer understates interleaved.** It converges at 4,668
  where interleaved is still climbing at 4,540, so the two now bracket rather than
  order. The methodological reason to prefer the faithful shape is unchanged and if
  anything sharper: a converged number reads like an answer either way.
- **Re-read: option 1's arcs are worse than the first version said.** At K=6 the
  second-largest arc is a 202-group commodities pile profiled by the single token
  `stock`. "Large but mostly meaningful" does not survive. Whether the fix moved that
  arc or the first reading simply stopped at five is not established and does not
  matter — the arcs were re-read because the numbers changed, and this is what re-reading
  found.
- **Never as clean as it read: top-2 does not beat a higher K on the sweep-on alarm,
  and did not in the first version either** (corrected: 299 against K=6's 205 and
  K=8's 98; pre-fix: 538 against 282 and 189). The recommendation rests on the BIRTH
  path, where top-2 does win, and the first version should have said so.

**The judged-column percentages are not comparable to the first version's.** They are
relative measures against the live archive's hand-judged sets, and the archive moved
between the two runs — 1,913 standing bridge pairs on 2026-08-22, 1,865 on 2026-08-23,
so a pass merged in between. Today's sets are **706 declined, 1,061 named**,
and every percentage below is against those. Compare rows within this run only; that
is what the columns were built for.

### The instrument

`storyline-replay.ts`, extended rather than forked — `offerGroup` is one function
called for a group's birth and for every re-offer, exactly as `linkGroup` has no
notion of which offer it is serving and splits only on whether the group's own
storyline still holds nothing but the group. Two modes:

- **interleaved** — each simulated day's new groups are offered, then ONE sweep pass
  runs over the trailing DF window. This is what production runs, and it is the only
  shape that gets the re-offer COUNT right: a group sits in the window for 14 nights,
  so it is re-offered ~14 times, against an archive growing underneath it.
- **posthoc** — build the archive birth-only, then run N passes over the final
  window. Cheaper, and the shape §2.6 measured. It is **not** production: it
  re-offers every group in the window the same number of times regardless of when it
  was published, and never lets a new day's coverage arrive between two passes. A
  converged post-hoc state need not equal the state production reaches, and here it
  does not.

Both model `linkGroup`'s re-offer path faithfully, and the two guards there are what
keep it from being trivially explosive: **one retroactive arc per group, ever**
(`existing.length === 1`), and **bridge evidence only from arcs the group is not a
member of**, so a multi-homed group cannot manufacture K "independent" bridges by
re-qualifying for its own home night after night. `storyline-replay.test.ts` pins
both, pins the merge semantics below, and — since 2026-08-23 — pins the one state
where a multi-homed group's membership can be counted twice: a group whose two homes
later merge. That case had no coverage, which is why the correction above was needed
at all.

**What it does not model**, and none of these is a detail:

- **the coherence gate.** No threshold measurement may spend model quota, so every
  formation forms — the pre-gate behaviour, and the looser of the two. (`.env` has
  `STORYLINE_COHERENCE_GATE=false` today anyway.)
- **the label-agreement merge.** A second merge vector entirely, absent here. The
  live archive has it, so the replay's merge counts are a floor rather than a ceiling.
- **a group's membership changing.** Production re-aggregates `memberTokens` on every
  read; here a group's tokens are fixed at their final state.
- **retention.** `story_token_days` is pruned in production, which moves a verdict
  with no storyline in the causal chain.
- **the candidate row cap.** The replay reports it (`cappedGroups`) and does not apply
  it, deliberately — PR #128's reasoning, and unchanged here. Narrowed it is 0 over
  this whole window, which is the only reason no limit here and 4,000 there is a
  difference without a consequence.
- **production's hybrid state.** This builds from scratch. The live archive was built
  under the 200-row cap and its arcs carry cap-shaped profiles. `--capped-build=200`
  is how far that can be reached from here — see the controls below.

### Calibration, and one thing it exposed about `--days`

Birth-only mode reproduces the committed grid **byte for byte** before and after the
refactor, and at `--days=31` (the CLI default) the pinned bar gives a largest arc of
**50** — the figure VERCEL-PHASE-0-FINDINGS §2.6 quotes. That is the calibration and
it holds. It also holds across the 2026-08-23 membership-dedup fix, which is the
strongest available evidence that the fix touches only the re-offer path.

Three caveats worth having on the record:

- The **anchor x mass grid above cannot reproduce**, because it was measured on a
  19,027-group corpus and this one is 26,006. Its shape holds; its numbers do not.
- **`--days` is not a cosmetic bound.** Groups whose trailing corpus is empty are
  never linked, but they still seed provisional storylines that later groups retrieve
  as candidates. So widening the window widens the candidate pool: the pinned bar
  gives largest 50 at `--days=31` and **72** at `--days=45`. `--days=45` covers the
  whole archive and is the faithful one, since `readCandidateStorylines` applies no
  date bound. Every number below is `--days=45`, 0.002/20.
- The df corpus is only **15 days deep** (`story_corpus_days`: 2026-08-07 to 08-21)
  against 39 days of publication, so ~11,000 of the 26,006 groups are never judged at
  all. The replay's effective decision set is the last fortnight, and that bounds all
  of these numbers including the committed ones.

### The finding: the harness does not model the merge

`mergeStorylines` **re-points the loser's bridges onto the winner**. A third storyline
holding one bridge to each side therefore reaches K with no bridge inserted and
nothing to trigger the linker's check, which only ever fires on an INSERT — which is
why `cascadeMerge` exists, why `MergeResult.repointed` is returned at all, and why
`readBridgedPairs` found 31 stranded pairs in this archive.

**The replay has never done either.** On a merge it dropped the merged pair's evidence
and left every other pair keyed under the alias, where the next `resolve` could not
find it. So the harness that pinned K systematically under-counted merging — and it
did so on the birth path, not only on the re-offer path nobody had built yet.

Modelled (`ReplayFidelity.cascadeMerges`), birth-only, at the pinned bar. **This table
is the one part of the section the 2026-08-23 correction leaves untouched, and it was
re-run to prove that rather than assumed:**

| K | live storylines | promoted | LARGEST | share% | merges | 100+ arcs |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 13,410 | 2,794 | 87 | 0.33 | 6,524 | 0 |
| **2** | **15,430** | **3,039** | **2,591** | **9.96** | **3,408** | **3** |
| 3 | 16,396 | 3,352 | 1,704 | 6.55 | 2,169 | 4 |
| 4 | 17,010 | 3,616 | 352 | 1.35 | 1,434 | 3 |
| 5 | 17,327 | 3,706 | 205 | 0.79 | 1,050 | 3 |
| 6 | 17,630 | 3,859 | 85 | 0.33 | 700 | 0 |
| 8 | 17,954 | 3,999 | 84 | 0.32 | 342 | 0 |
| 12 | 18,207 | 4,101 | 40 | 0.15 | 68 | 0 |

The same replay with the merge unmodelled gives **72** at K=2. So the birth path's
largest arc is 36x what the harness reported, and **every threshold in
`packages/config` was pinned against a merge the service does not perform.** The
200-row cap is the only reason production has never shown this: under it a group's
qualifier set was small, so pairs rarely repeated and the re-pointing avalanche had
nothing to work with. Read together with the cap section above, the cap was doing the
bounding K was believed to be doing — and it was doing it on the *birth* path too,
which PR #117 corrected unconditionally and PR #128 has since gated.

Note K=1: **87, better than K=2's 2,591.** With no evidence to accumulate there is no
avalanche — every bridge merges immediately, while the arcs are still small enough
that the majority rule tightens the survivor's profile. That is ADR-0011's claimed
percolation damper, and it only works when merges are not batched.

### The trajectories, with the sweep on

Interleaved, one sweep pass a night over the trailing window, cascade modelled,
retrieval narrowed. The last night is 2026-08-21; nights before 2026-08-07 have no
corpus and decide nothing. `pre-fix` is what this section's first version reported,
which is the same corpus and the same bar — re-run under the pre-fix harness at K=2 it
reproduces exactly (5,927 / 22.79% / 14,244 live / 4,623 merges, and the night-by-night
curve below), which is what makes the column a comparison rather than a memory.

| K | birth-only LARGEST | with re-offers | share% | live storylines | merges | still moving at the end? | pre-fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **2** | 2,591 | **4,540** | **17.46** | 14,277 | 4,608 | **yes, +277 on the last night** | 5,927 |
| 3 | 1,704 | 3,105 | 11.94 | 15,395 | 3,145 | yes, +372 | 3,922 |
| 4 | 352 | 1,605 | 6.17 | 16,169 | 2,185 | yes, +50 | 2,368 |
| 6 | 85 | 205 | 0.79 | 17,001 | 1,172 | settled, flat 3 nights | 282 |
| 8 | 84 | 98 | 0.38 | 17,542 | 580 | +28 on the last night | 189 |
| 12 | 40 | 70 | 0.27 | 17,986 | 105 | settled, flat 5 nights | 95 |

**It still climbs.** That was the question the correction put in doubt — each night's
sweep adds retroactive attachments the next merge double-counted, so some of the climb
could have been duplication accumulating rather than growth. It was not. The K=2
trajectory, night by night: 51 → 114 → 160 → 296 → 1,566 → 1,835 → 3,147 → 3,694 →
3,746 → 3,751 → 3,888 → 3,989 → 4,044 → 4,263 → **4,540**. Same shape, same failure to
converge inside the archive, +277 on the last night against the pre-fix +338.

One detail worth keeping, because it locates the bug exactly: **the first sweep night
is IDENTICAL pre-fix and post-fix — 51 both times** — and the two curves diverge from
the second night on. There is no multi-homed group to double-count until a night's
retroactive attachments have already landed, which is precisely the reachability
argument, observed rather than reasoned. Pre-fix, for comparison: 51 → 126 → 180 →
342 → 1,761 → 2,162 → 3,807 → 4,823 → 4,932 → 4,992 → 5,207 → 5,509 → 5,543 → 5,589
→ 5,927.

§2.6's 1,347 over four passes was the same curve, sampled early and from a cap-built
archive.

Two controls worth recording, both on this instrument:

- **From-scratch, cascade NOT modelled**, the sweep looks harmless: post-hoc holds at
  **72** across eight passes (unchanged by the fix) and interleaved reaches **64**
  (pre-fix 77). That is the number the committed harness would have produced, and it
  is the wrong answer.
- **Cap-built archive, swept corrected** (`--capped-build=200`) reproduces §2.6's
  experiment: 31 → 3,361 → 4,291 → 4,615 → 4,665 → **4,668** → 4,668, converged by
  pass 5 (pre-fix 31 → 3,728 → 5,012 → 5,451 → 5,573 → 5,583). So the drain is real,
  but it is not a *separate* problem from the birth path — both end in the same place,
  because the corrected retrieval is what puts them there.

  **And the ordering between the two shapes flipped.** Pre-fix, post-hoc converged at
  5,583 BELOW interleaved's still-climbing 5,927, which read as "the cheap shape
  understates the problem". Corrected, post-hoc converges at 4,668 ABOVE interleaved's
  still-climbing 4,540. The two now bracket each other and neither bounds the other,
  which is a better reason to insist on the faithful shape than the one the first
  version gave.

### The four options, priced against the same instrument

All at K=2 unless stated, interleaved, cascade modelled, retrieval narrowed. `piles` is
declined (unnameable) piles formed — lower is better. `named`/`kept` are the
model-named arcs left intact and their groups held together — higher is better, **and
both are inflated by percolation**, because a 4,540-group arc trivially contains every
named arc "intact" (`scoreJudged`: `intact = together === considered.length`). They are
only readable against the arc distribution beside them. Judged sets: 706 declined,
1,061 named, as the archive stood on 2026-08-23.

| option | LARGEST | share% | merges | 50-99 | 100+ | piles | named | kept | pre-fix LARGEST |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (today's rules) | 4,540 | 17.46 | 4,608 | 3 | 2 | 74.2% | 32.2% | 63.3% | 5,927 |
| **1.** K=6 | 205 | 0.79 | 1,172 | 9 | 4 | 70.0% | 27.7% | 57.5% | 282 |
| **1.** K=8 | 98 | 0.38 | 580 | 9 | 0 | 70.1% | 27.1% | 55.7% | 189 |
| **2.** top-2 qualifiers may bridge | 299 | 1.15 | 2,106 | 9 | 3 | 67.8% | 29.2% | 58.3% | 538 |
| **2.** top-3 | 2,760 | 10.61 | 3,633 | 3 | 5 | 72.9% | 31.2% | 61.2% | 4,050 |
| **2.** top-5 | 4,145 | 15.94 | 4,343 | 6 | 3 | 72.5% | 33.2% | 63.8% | 6,745 |
| **3.** K distinct days | 3,901 | 15.00 | 3,898 | 6 | 2 | 71.5% | 32.3% | 62.8% | 5,526 |
| **3.** K distinct domains | 3,994 | 15.36 | 4,107 | 5 | 1 | 74.6% | 32.3% | 61.9% | 5,293 |
| **4.** bridge at birth only | 2,176 | 8.37 | 3,352 | 5 | 2 | 72.2% | 31.6% | 59.2% | 2,702 |
| **2+4.** top-2, birth only | **38** | **0.15** | 595 | **0** | **0** | 67.6% | 27.1% | 53.8% | 46 |
| 2+4+3 (days) | 25 | 0.10 | 407 | 0 | 0 | 68.4% | 27.1% | 53.9% | 41 |

The corresponding birth-only figures, which the fix does not touch, are the other half
of every row below: baseline 2,591, top-2 **22**, top-3 94, top-5 407, K=6 85, K=8 84.

What each one is actually worth:

1. **A higher K works on the number, and reads worse than the first version said.** K
   must reach **6** — a 3x rise — to bring the alarm near 100, and it pays for that by
   refusing merges everywhere: 4,608 → 1,172, with `named` falling 32.2% → 27.7%.
   ADR-0011 refuses to build a split, so the merge is the only repair err-narrow
   formation has, and this raises the bar on all of it. And the arcs it leaves are not
   clean: at K=6 the second-largest is a **202-group pile profiled by the single token
   `stock`** — crude oil, gold and equity-index coverage chained together — which is
   the boilerplate class K has never touched, now visible because the giant pile is no
   longer hiding it.
2. **Bounding the qualifiers a group may bridge is still the strongest single lever,
   and it is still not monotone.** At the top **2** it is decisive — birth-only largest
   2,591 → 22, interleaved 4,540 → 299 — because `bridgePairs` is a full cross-product
   and two qualifiers is exactly one pair, so the quadratic term is gone rather than
   merely smaller. At 3 it leaves 2,760 and at 5 it leaves 4,145: better than nothing,
   which is a correction to the first version's reading, but both leave an arc holding
   a tenth to a sixth of the window. **There is no gentle version of this knob**, which
   is itself the finding. What is withdrawn is only the claim that 5 was *worse* than
   doing nothing — that was the double-count, not the rule.
3. **Strengthening "independent" is not worth building.** Distinct days buys 4,540 →
   3,901 and distinct domains 3,994. The premise is sound — a day of syndicated
   coverage does supply several groups trivially — but it is not where the volume is.
   Cheap to reject, and now rejected on evidence twice over.
4. **Bridging only at birth does more than it promises, and it is still not enough.**
   It removes essentially all of the sweep's amplification — 4,540 → 2,176, which is
   now *below* the birth-only 2,591 — while keeping 6,131 retroactive attachments. So
   it is a correct, cheap fix for the *sweep*, and the corrected numbers make it a
   better one than the first version claimed. It cannot fix the graph, because the
   birth path is at 2,591 without the sweep's help at all.

**The combination is the only thing that reaches the calibrated range.** Top-2 plus
birth-only bridging gives a largest arc of **38 groups and no arc above 50 at all** —
where the birth-only replay at this bar expects 50.

### The arcs, hand-read

A largest-arc number cannot say whether an arc is one story, and this measurement
turns on that twice.

**Baseline (K=2, sweep on).** Incoherent, and the profile says so before the headlines
do:

- **4,540 groups, 39 days, profile EMPTY.** No token is carried by half its members,
  which is what an arc with nothing in common looks like when the majority rule is
  asked to describe it. Its head is the Strait of Hormuz / Iran-Oman negotiation; its
  body is a sixth of the archive. An empty profile also makes it *unretrievable*, so
  it stops growing by attachment and can only grow by merge — a pile that has eaten
  its own vocabulary. (Pre-fix this read 5,927 groups; the same arc, the same head,
  the same empty profile.)
- **235 groups, profile EMPTY** — MLB game recaps. A beat, and ADR-0011 forbids beats.
- **78 groups, profile `eclipse, solar`** — the August 12 eclipse. Coherent as an
  event, and a reminder that the head of this distribution is not uniformly bad.
- **71 groups, `doug, ford, ontario, premier`** — an entity, which ADR-0011 also
  forbids: the hotel-expense scandal, opposition research and wildfire smoke in one
  arc because one politician is in all of them.

**K=6 (option 1).** Large, and mixed — this is where the correction changed the
reading:

- **205 groups, `graham, primary`** — the South Carolina Senate special and Darline
  Graham's campaign. **Coherent**, over 26 days. The 201-group Gaza/Iran/Ukraine chain
  §2.6 read is not here.
- **202 groups, profile `stock`** — **incoherent**, and new to this reading: crude oil
  on the Hormuz talks, gold, and equity-index coverage chained through one token. A
  single-token profile is the shape of a pile, not an arc.
- **160 groups, `missile, russia, ukraine`** — defensible as one running war, but a
  three-token profile is a warning: it is the vocabulary a theme shares, not the
  vocabulary an event has.
- **136 groups, profile `beat, night`** — MLB recaps again. **Incoherent**, and the
  clearest evidence that K does not touch the boilerplate class at all: the profile is
  literally the two words a sports recap headline always contains.
- **99 groups, `bank, israeli, palestinian, settler, west`** — West Bank settlement
  expansion. Correctly profiled; a running theme rather than one event.
- **86 groups, `hormuz, iran, strait`** — **coherent**, and worth pausing on: the story
  that heads the baseline's 4,540-group empty-profile pile is, at K=6, an 86-group arc
  with a profile that names it.

**Top-2 + birth-only bridging (options 2+4).** Nothing is a percolation pile. The
failures are the boilerplate families this document already records as known residue,
and the successes are event-shaped:

- **38 groups, `nasdaq, sec, filing, stock, share…`** — institutional-holdings
  filings. **Incoherent, and pre-existing**: the same syndication residue recorded
  above under "Known residue", not a new failure.
- **24 groups, `crowley, francesca, hong, wisconsin, primary`** — **mostly coherent**,
  the Wisconsin governor's primary, with the election-beat contamination this document
  already knows about (a Michigan Senate primary and a Tennessee primary-results page
  are in it).
- **24 groups, `abraham, carrier, lincoln, overboard, sailor, uss`** — **coherent**,
  one story end to end, over three days.
- **23 groups, `championship, fedex, jude, pga, playoff, st, tour`** — the FedEx Cup
  playoff run. Coherent as a tournament series, and see the cost paragraph below.
- **22 groups, `company, gave, nyse, price, rating, target`** and **21 groups,
  `marketbeat, screener, share, stock, tool`** — **incoherent**, both pure template
  residue, both known families.
- **21 groups, `by-election, clacton, farage, nigel`** — **coherent**, one event.
- **21 groups, `case, federal, guilty, luigi, mangione, plea`** — **incoherent**.
  Mangione's federal plea mixed with the Sam Nordquist murder case. A criminal-courts
  beat, and a genuine linking failure rather than boilerplate.

**And the cost of option 2, read rather than counted.** `kept` falls 62.0% (birth-only
baseline) → 53.8%, and reading the arcs says what that is: the tournament coverage
comes out as a 23-group arc rather than the 151-group FIFA/Infantino arc the sweep
built on the live archive and this document judged coherent end to end, and the running
political stories are split across several correctly and narrowly profiled arcs. That
is **err-narrow**, which ADR-0011 prefers — but ADR-0011 also says the merge is the
only repair err-narrow formation has, and top-2 removes most of it (4,608 merges →
595). Option 2 buys the alarm by giving up the cure.

### What this recommends

**Leave all three knobs off.** Nothing here supports enabling
`STORYLINE_LATE_CANDIDATE_SWEEP`, `STORYLINE_REOFFER_JOINED_GROUPS` or
`STORYLINE_LATE_CANDIDATE_CHANGED_ONLY`, and the sweep's own gate is no longer the
interesting question.

**The blocker on those knobs was stated wrongly, and this is the correction.** It read
"blocked on re-measuring K against a replay that re-offers". That has now been done,
and K is not the binding constraint: the same instrument says the *birth* path — fixed
unconditionally by PR #117, gated by PR #128, and the mode this section measures —
builds a 2,591-group arc at the pinned bar. The sweep makes a broken graph worse; it
is not what breaks it, and the corrected numbers make that division sharper rather
than softer (57% of the final arc is birth-path, against 44% as first reported).

**Recommended, in order:**

1. **Confirm the birth-path finding against the live archive before acting on it.** It
   is the load-bearing claim and it is a *prediction*. The archive is still nothing
   like the replay's projection — 1,874 bridge observations over 1,865 pairs, of which
   1,858 hold exactly one bridging group — which is what a cap-built archive looks
   like, and consistent with the model rather than a refutation of it. With the
   narrowing now gated OFF by default, the corrected birth path is not even running. A
   backfill replay of the archive through `linkGroup` on a clone would settle it, and
   it needs no model call.

   **One thing changed under this since PR #128 and is NOT diagnosed here.** #128
   recorded, hours earlier the same day, that all 1,913 standing pairs held exactly one
   bridge and **none was at K**. Re-counted for this section: **7 pairs are now at or
   above K=2** — five at 2, two at 3 — and both sides of all seven are live and
   unmerged (`Canada US Trade Negotiations`, two `Hayden Panettiere` arcs, `2026 FedEx
   St Jude Championship` and `Fedex St`, `Trump Canada Tariff Dispute`, `European Solar
   Eclipse`, `Tsx Stocks`/`Canadian Dividend`, and one provisional). Several of those
   read like merges that *should* happen, so this is not presented as damage. But "no
   merge is pending" was load-bearing for #128's argument and it is no longer true, and
   a standing pair at K means the check did not fire — the linker only tests on an
   INSERT, and `readBridgedPairs` has found stranded pairs before. Worth its own look
   before step 2; out of scope for a re-measurement.

   **Looked at, in the section below** ("The seven pending repairs"). They are stranded
   rather than pending: none of the seven is re-derivable against today's archive at
   all, because the bridging group has since been retroactively attached to one or both
   sides of its own pair and a member's qualification for its own arc is excluded from
   bridge evidence by design. So the check did not fail to fire — the evidence is a
   fossil of a state no arrival can reproduce. What that also settles is the question
   step 2 needed answering: a top-2 bound is not what would suppress them.
2. **Then option 2 as the primary lever, at the top 2 qualifiers**, not a higher K —
   and the argument is the BIRTH path, which is where the problem is. There it beats
   K=6 on the alarm decisively (largest **22** against **85**) and on `named`
   marginally (26.8% against 25.5%), while losing `kept` by 0.3 points (57.5% against
   57.8%) — so it does not strictly dominate, and the first version overstated that.
   On the sweep-on numbers a higher K is the better lever and always was (299 against
   K=6's 205), which is not an argument for K=6, because the sweep is off. Option 2
   attacks the quadratic term instead of raising the bar every merge must clear, and
   its value is *not* tunable: 3 and 5 leave 2,760 and 4,145.

   **Built, and still off** — `STORYLINE_MAX_BRIDGING_QUALIFIERS`, default 0
   (unbounded). Every figure in this row reproduces on the shipped code, and the
   section below has the arc-size distributions, the hand-reading, and two corrections
   to the cost stated here.
3. **Option 4 alongside it if the sweep is ever switched on**, because it is nearly
   free and removes the sweep's entire contribution — corrected, slightly more than
   all of it.
4. **Not option 3.** Measured, ineffective, recorded.

**And do not read speed as safety.** Per-offer cost improves as the graph degrades
(§2.6), and so do `named` and `kept` here: the baseline's 32.2%/63.3% are the best
numbers in the option table and they belong to the 4,540-group pile. Three of the four
metrics a reasonable person would reach for get *better* as this fails.

### Three things this contradicts

- **`storyline-link.ts` says `storylineProfile` "must agree with" storage's
  `refreshProfileTokens`. It does not.** Storage counts a group as carrying a token if
  **any** of its articles does; the replay's `groupProfile` requires a **majority** of
  its articles. Measured over the 722 live single-group storylines whose group holds
  two or more articles: stored profiles average **21.9** tokens, the union rule gives
  **21.9** and the majority rule **20.2**, and 104 of the 722 differ. So production's
  storyline profiles are systematically **wider** than the replay's — which widens
  overlap, qualifiers and pairs, in the same direction as everything above. Small on
  this corpus, load-bearing in principle, and the comment claiming agreement should
  not be trusted. Not fixed here: fixing it would change the birth-only calibration
  and belongs with its own measurement.
- **§2.6's "the replay says the largest arc should be 50" is true only of the harness
  as it stood.** The replay says 50 because it does not model the merge. Once it does,
  the same bar and the same corpus say 2,591, and the gap between 50 and the sweep's
  1,347 was never mostly about re-offers.
- **And this section contradicted itself for a day.** Its own first version reported
  every re-offer figure about a quarter too high, because the harness counted a
  doubly-homed group's membership twice where `mergeStorylines` counts it once. The
  conclusions held; four readings did not. A harness is only as good as its tests, and
  the test that would have caught this — a multi-homed group whose two homes later
  merge — did not exist until the bug was found by reasoning about a share that could
  exceed 100%.

## Bounding what one group may bridge (2026-08-23)

The option-2 lever the section above recommends, built: **at most N of a group's
qualifiers may bridge, best mass first**, behind
`STORYLINE_MAX_BRIDGING_QUALIFIERS`, **0 (unbounded) by default** — today's
behaviour exactly.

**Where it lands.** `bridgePairs` takes the bound as an argument, and
`bridgingQualifiers` beside it is the prefix both the write and the linker's
report come off. Not `qualifyingStorylines`: that function returns every
qualifier for two reasons the attach depends on — the group joins its BEST
qualifier, and the re-offer path takes the best arc it is not already in — so
narrowing it there would cost linking, not only evidence. Bounded at the pairing,
the group lands in exactly the arc it would have landed in; all it loses is the
right to testify about pairs it ranks low for. `storyline-linker.ts` and
`storyline-replay.ts` call the same function with the same argument, which is the
one thing PR #128 exists to stop happening again.

**One ordering decision, and it is observable.** On the re-offer path a group's
own homes are removed from its evidence before the bound applies, not after. The
other order is worse and not by a little: a doubly-homed group whose two homes
outrank everything would spend both slots on itself and testify about nothing,
which is not a decision anyone made. `storyline-linker.test.ts` pins it.

**No tiebreak was invented.** The bound is a PREFIX of `qualifyingStorylines`'
order — mass descending, then the older storyline, then the id — so it inherits
that tiebreak by construction. A test builds two candidates tied on mass and
separated only by coverage age, and checks the surviving pair is the one that
order names rather than the one the ids would.

### It reproduces the option table exactly, which is the calibration

Every figure below is `--days=45`, 31,308 articles in 26,006 groups, anchor share
0.002, mass 20, K=2, cascade modelled, **retrieval NARROWED**
(`STORYLINE_NARROW_RETRIEVAL=true`, which is **not** the default). Unbounded rows
reproduce the committed table to the digit — largest 2,591 birth-only and 4,540
interleaved, 4,608 merges, 74.2%/32.2%/63.3% judged — so the refactor is a no-op
where it should be, and the bounded rows are the same instrument.

**Interleaved, one sweep pass a night, final night 2026-08-21** — arc-size
distribution, not only the maximum:

| bound | live-sl | LARGEST | share% | merges | retro | 2-4 | 5-9 | 10-19 | 20-49 | 50-99 | 100+ | piles | named | kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unbounded | 14,277 | **4,540** | 17.46 | 4,608 | 6,713 | 3,186 | 613 | 121 | 28 | 3 | 2 | 74.2% | 32.2% | 63.3% |
| top-2 | 16,245 | **299** | 1.15 | 2,106 | 7,191 | 4,091 | 714 | 136 | 33 | **9** | **3** | 67.8% | 29.2% | 58.3% |
| top-3 | 14,914 | 2,760 | 10.61 | 3,633 | 7,405 | 3,476 | 656 | 113 | 32 | 3 | 5 | 72.9% | 31.2% | 61.2% |
| top-5 | 14,401 | 4,145 | 15.94 | 4,343 | 7,197 | 3,249 | 602 | 110 | 27 | 6 | 3 | 72.5% | 33.2% | 63.8% |

**Birth-only, the same bar — and this is the path that is live**, since the sweep
is gated off:

| bound | live-sl | promoted | LARGEST | share% | merges | 2-4 | 5-9 | 10-19 | 20-49 | 50-99 | 100+ | piles | named | kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unbounded | 15,430 | 3,039 | **2,591** | 9.96 | 3,408 | 2,572 | 355 | 85 | 21 | 3 | 3 | 74.1% | 31.1% | 62.0% |
| top-2 | 17,862 | 3,894 | **22** | 0.08 | 475 | 3,463 | 369 | 59 | **3** | **0** | **0** | 69.8% | 26.8% | 57.5% |
| top-3 | 17,315 | 3,649 | 94 | 0.36 | 1,131 | 3,106 | 445 | 85 | 11 | 2 | 0 | — | — | — |
| top-5 | 16,558 | 3,336 | 407 | 1.57 | 2,065 | 2,786 | 424 | 94 | 28 | 1 | 3 | — | — | — |

**The distribution says something the maximum does not, and it cuts both ways.**
Birth-only at the top 2 there is **no arc above 49 groups at all** and only three
between 20 and 49 — the cleanest distribution any option in this document has
produced. Sweep-on at the top 2 the maximum falls 15× but the COUNT of large arcs
goes UP: nine arcs at 50–99 against the baseline's three, and three at 100+
against two. That is the same effect K=6 showed — a 4,540-group pile trivially
contains every other large arc, so removing it reveals what it was swallowing —
and it is a reason to distrust a largest-arc metric on its own, not a reason to
prefer the pile.

**Post-hoc, eight passes, top-2: 22 → 67 → 128 and then flat from pass 2**
(0.49%, five arcs at 50–99, one at 100+). So both shapes are bounded under top-2,
and the two no longer bracket a runaway.

**And the unbounded post-hoc control is 5,320, not 4,668 — a number this document
did not have.** Measured here: from-scratch, unbounded, eight passes, it goes
2,591 → 4,614 → 5,275 → 5,317 → **5,320 (20.46%)** and is flat from pass 4. The
4,668 above is the `--capped-build=200` control, and the sentence comparing "the
two shapes" was comparing a CAP-BUILT post-hoc against a FROM-SCRATCH
interleaved — two variables at once. Compared properly, from-scratch post-hoc
(5,320) sits above from-scratch interleaved (4,540, still climbing), so the
direction of that finding survives and the margin is wider than reported.

**The cap-built control, top-2** (`--capped-build=200`, eight passes): 24 → 67 →
103 → 123 → **161 and flat from pass 4** (0.62%), against 4,668 unbounded. That is
the §2.7 hybrid experiment, and it is the one number in this exercise that
addresses production's actual starting state rather than a from-scratch archive.
Worth pairing with a warning: this run's judged columns are the BEST anywhere in
this document — **81.4% piles, 38.0% named, 64.3% kept** — while its arc
distribution is the second-tightest. So `named` and `kept` do not simply improve
as a graph degrades; on this row they improve as it is repaired, which means
neither direction can be read from them alone.

### The seven pending repairs: the bound is not what threatens them

The section above flagged **7 standing pairs at or above K** on the dev archive
and asked whether a top-2 bound would suppress them. Re-counted here:
**1,874 bridge observations over 1,865 pairs, 7 at or above K=2** — the same
seven, reproduced.

Measured, and the answer is not the one the question expected. For every one of
the seven, each bridging group's qualifier ranking was recomputed against the
archive and the trailing corpus as they stand, with the pair's two storylines
looked for in it:

| pair | K | derivable today | at top-2 |
| --- | --- | --- | --- |
| Canada US Trade Negotiations × (prov) | 3 | 0 of 3 | 0 |
| Hayden Panettiere × Hayden Panettiere | 3 | 1 of 3 | **1 — and at ranks 1 and 2** |
| Trump Canada Tariff Dispute × (prov) | 2 | 0 of 2 | 0 |
| European Solar Eclipse × (prov) | 2 | 0 of 2 | 0 |
| Tsx Stocks × Canadian Dividend | 2 | 0 of 2 | 0 |
| 2026 FedEx St Jude Championship × Fedex St | 2 | 0 of 2 | 0 |
| (prov) × (prov) | 2 | 0 of 2 | 0 |

**Not one of the seven is re-derivable today, bound or no bound**, and the
dominant reason is printed by the probe: the bridging group has since been
retroactively attached to one or both sides of its own pair, and a member's
qualification for its own arc is excluded from bridge evidence by design. Six of
the seven have at least one side reported as *"not retrieved (is a home)"*. Where
both sides DO still qualify — one group of the Hayden Panettiere pair — they are
that group's **top two qualifiers**, so top-2 permits it.

So the concern is real and the bound is not its cause. These seven are **stranded
evidence**: the merge is pending on the next INSERT into either pair, the linker
only checks on an insert, and no arrival can now produce one. That is the
`readBridgedPairs` class this document already records 31 of, arrived at from the
other direction. It wants its own look, and a bound would not change it.

**And a much larger sample says the cost to evidence is real.** Over all 1,874
observations, narrowed:

| | re-derivable today | kept at top-2 | top-3 | top-5 | top-10 |
| --- | --- | --- | --- | --- | --- |
| homes kept in the candidate list | 437 (23%) | 27.2% | 43.9% | 70.3% | 91.5% |
| today's homes removed (a re-offer now) | 40 (2%) | 7.5% | 27.5% | 62.5% | 82.5% |

Top-2 keeps about a quarter of the bridge evidence that is still derivable. The
mechanism is visible in the qualifier counts: **26.3% of bridging groups exceed 2
qualifiers narrowed** (p90 6, p99 20, max 53), and the observations concentrate on
exactly those groups because a 20-qualifier group writes 190 pairs. Most pairs are
therefore NOT a group's top two, which is the quadratic term seen on real data
rather than in a replay.

### The arcs, hand-read — and the recorded cost was attributed to the wrong arc

Birth-only, cascade modelled, the live path.

**Unbounded (the baseline).** The alarm is a pile and the profile says so:

- **2,591 groups, 39 days, profile EMPTY** — head is Canadian/Asian market and
  oil-price coverage, body a tenth of the archive. **Incoherent.** An empty
  profile also makes it unretrievable, so it grows only by merge.
- **191 groups, profile EMPTY** — MLB recaps. A beat; ADR-0011 forbids beats.
- **152 groups, `cup, fifa, gianni, infantino, president, world`** — the FIFA
  privatisation crisis over 11 days. **Coherent end to end**, and correctly named.
- **53 groups, profile EMPTY** — football transfer rumours. **Incoherent.**
- **54 groups, `eclipse, solar, total`** and **50 groups,
  `hawaii, hurricane, storm, tropical`** — the first coherent as an event, the
  second a weather BEAT spanning several unrelated storms.

**Top-2.** No pile, every profile populated, and the failures are the boilerplate
families this document already records:

- **22 groups, `company, gave, nyse, price, rating, research, share, target`** —
  analyst price-target syndication. **Incoherent, pre-existing** residue.
- **20 groups, `championship, cup, fedex, jude, pga, playoff, st, tour`** — the
  FedEx Cup playoff run. **Coherent** as a tournament series.
- **20 groups, `childhood, ... trump, vaccination, vaccine`** — the childhood
  vaccine executive order. **Coherent**, one story.
- **19 groups, `... marketbeat, screener, ... stock, tool`** — template residue,
  known family. **Incoherent.**
- **18 groups, `abraham, family, lincoln, sailor, uss`** — the carrier
  deployment. **Coherent.**
- **18 groups, `crowley, david, democratic, francesca, gubernatorial, hong, primary, wisconsin`**
  — the Wisconsin primary, with the election-beat contamination this document
  already knows about (a Michigan primary headline is in it). **Mostly coherent.**
- **17 groups, `binface, by-election, clacton, count, farage, nigel`** —
  **coherent**, one event.

**The arc it gets wrong, and it is worse than this document recorded.** The
FIFA/Infantino crisis. Unbounded, birth-only, it is ONE 152-group arc profiled
`cup, fifa, gianni, infantino, president, world`. Under top-2 its largest fragment
is **12 groups** (`... fifa, football, gianni, infantino, javier, la, liga, ... teba`)
and the story comes apart into **about forty arcs of 2 to 6 groups** — "possible
successors", "UEFA votes to boycott", "the Motsepe/CAF election", "the stake sale
abandoned", "the affair allegations", "the AFC/CONCACAF joint letter" — each
internally coherent and narrowly named, and collectively forty timeline entries
where a reader wants one. That is err-narrow, which ADR-0011 prefers, and it is
the single clearest cost measured here.

**The correction:** the four-options section priced this as "a 23-group arc rather
than the 151-group FIFA/Infantino arc". Measured separately, the 23-group figure
is the **FedEx/PGA** arc (20 groups birth-only here), which is coherent; the FIFA
cost is **152 → 12**, roughly twice as severe as recorded and against a different
arc. The two were conflated.

**A second correction, in the other direction.** "Canada tariffs split into ten
narrow arcs" reads as a cost of the bound, and mostly it is not: unbounded
birth-only the Canada/tariff coverage is ALREADY 34 / 18 / 17 / 9 / 8 / 8 / 7
groups rather than one arc. Top-2 takes its largest from 34 to 17. Real, and a
difference of degree rather than the fragmentation of a single coherent arc.

### Its own knob, not a property of the narrowed mode

`candidateRetrieval` welds the probe to the row cap because the split state —
broad probe, 4,000-row cap — is worse than either mode, so it has to be
unreachable. **That argument does not transfer, and the measurement says why.**

Consider all four combinations. Narrowed-and-bounded is the recommended state.
Narrowed-and-unbounded is the baseline every number in this document was taken
at. Broad-and-bounded is merely *stricter* than today rather than dangerous — and
nearly inert: **only 0.5% of the live archive's bridging groups exceed 2
qualifiers under the broad probe** (max 4), against 26.3% narrowed. So no
combination is worse than both, which is the whole of the retrieval's argument for
coupling.

**That 0.5% comes from the live archive and could not have come from the replay**,
which is worth stating because the absence of a broad-mode row in the tables above
otherwise looks like an omission. The replay REPORTS the row cap and does not apply
it (`cappedGroups`), and the two probes are a proven necessary condition of each
other, so a broad-mode replay reproduces the narrowed one exactly — birth-only 2,591
either way, verified. The whole broad/narrow difference for this bound lives in the
200-row cut the service applies and the harness does not, so measuring it required
the archive rather than the simulator. That is the one question in this line of work
where the replay is the wrong instrument.

What coupling would cost is measurement. Folding the bound into
`STORYLINE_NARROW_RETRIEVAL` makes narrowed-and-unbounded unreachable — and that
is the configuration the option table above was measured in and must be re-runnable
in. A state nothing can reach is a state nothing can re-measure, which is §2.5's
mistake one level up. Two knobs, and the flag's own note says to turn them on
together.

`storyline-sweep-cli.ts` follows `NARROW`'s precedent: the grids and an
unqualified `--reoffer` run model the CONFIGURED bound and print it, so a run
describes the deployed decision; `--variant=cap:N` overrides it explicitly for
pricing a bound the configuration does not have, and `cap:0` asks for unbounded
against a configured bound.

### What this changes, and what it does not

**Nothing is enabled.** The default is unbounded, `STORYLINE_MERGE_BRIDGES` stays
at 2, and the four default-off knobs are untouched. What exists now is the lever,
measured on the instrument that measured the problem.

**What would justify turning it on**, and it is a pair with
`STORYLINE_NARROW_RETRIEVAL` rather than a substitute for it: narrowing is what
widens the qualifier set, and this is what bounds the pairs that come of it.
Turned on together, the birth path's largest arc goes from 2,591 to 22 and the
distribution has nothing above 49. Turned on alone, against the broad probe, it
is close to a no-op and buys nothing.

**What to weigh against it**, stated plainly because three separate measurements
here say the cost is real: 3,408 birth-path merges become 475, `kept` falls 62.0%
→ 57.5%, about three-quarters of the archive's still-derivable bridge evidence
would not be written, and the FIFA crisis comes out as forty arcs instead of one.
ADR-0011 prefers err-narrow and also says the merge is the only repair err-narrow
formation has. This buys the alarm by giving up most of the cure, and that trade
is a decision rather than a conclusion.
