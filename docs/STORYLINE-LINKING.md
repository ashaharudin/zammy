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
| `STORYLINE_ANCHOR_MAX_SHARE` | 0.002 | measured |
| `STORYLINE_MASS_THRESHOLD_V2` | 20 | measured |
| `STORYLINE_MERGE_BRIDGES` (K) | 2 | measured |
| `STORYLINE_ANCHOR_DF_FLOOR` | 10 | **unmeasured** — never binds in English |
| `STORYLINE_DORMANCY_DAYS` | 90 | **unmeasured** — archive too short |
| `STORYLINE_DORMANT_STRICTNESS` | 1.5 | **unmeasured** — same reason |

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
