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
