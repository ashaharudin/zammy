# G6 gating item 5 — group re-parenting: what it is, how far it reaches, and whether it is a defect

**Status: description only. No fix is proposed as work, and the recommendation is
that item 5 as written should be CLOSED and replaced.** G6 recorded "this phase
does not know what should" fix it; the answer this note reaches is that the thing
it names is not the defect, and the defect it exposes is one G6 already recorded
under a different heading.

Every number below is measured on the **dev archive**. Two states:

- **PRE** — `pg_dump` taken before G6's run, `/tmp/claude-501/g6/zammy-pre-g6.dump`,
  restored 2026-08-29 as database `zammy_preg6`. At migration **0020**, so it has
  no `sightings.plane` column — correct, since no deepening sighting existed.
- **POST** — dev `zammy` as it stands **2026-08-29**, migration 0023. Read-only:
  every figure here was taken by copying out of it, and nothing wrote to it.
  Verified undisturbed since the run — the only sightings after 2026-08-29 02:00Z
  are G6's own 3,087 `google-news` / `deepening` rows, `03:13:46Z`–`03:29:15Z`.

POST therefore includes **both** of G6's spans. G6's own `board-live-*.txt`
captures were taken between Span A and Span B, so boards below show more drift
than G6 reported. The 259 figure reproduces exactly.

---

## 1. The mechanism

`groupCreatedArticles` (`apps/api/src/grouping-service.ts:203`) runs
`groupArticle` over **every** created article, in one loop, and only afterwards
branches on `intent.attachTo` (`:339`). Merging happens inside `groupArticle`
(`:498`) and is finished before the deepening branch is reached.

`groupArticle` scans same-day candidates, ranks them, and if it picks one calls
`mergeBridgedGroups` (`:601`), which merges **every other group the arrival
matched** into the group it joined, up to `MERGE_LIMIT = 10`. That constant
bounds *write amplification per arrival*. It does not bound reach: one merge of a
38-member group re-parents 38 articles.

`mergeGroups` (`packages/storage/src/grouping.ts:207`) then does two things in one
transaction:

1. `update articles set group_id = winner where group_id = loser` — every loser
   member is re-parented.
2. `absorbMergedGroup` (`packages/storage/src/storylines.ts:1317`) re-points every
   `storyline_groups` row from loser to winner, `on conflict do nothing`, and
   deletes the loser's rows.

**An article's storyline membership is entirely a function of its group's**, so
step 2 is where the arc change happens, and its semantics are a **union**:

```
arcs(winner) after  =  arcs(winner) before  ∪  arcs(loser) before
```

Both sides gain. The loser's articles gain the winner's arcs *and* the winner's
own articles — which never changed `group_id` at all — gain the loser's arcs.
That asymmetry is why G6's 259 counts the wrong population; see §3.

The one place membership is subtracted is `absorbMergedGroup`'s dedup tail: a
storyline whose only group is now held by another live storyline becomes an
**alias** (`merged_into`), and the alias still resolves. Nothing is orphaned.

The merge partition only ever **coarsens** — groups never split live — and merging
an already-merged pair is a no-op. So this channel is **monotone and idempotent**:
it converges rather than ratchets. That distinguishes it sharply from the
timestamp channel ADR-0021 addresses, where `published = LEAST(...)` can keep
moving.

---

## 2. Is this deepening-specific? **No — and G6's framing should be corrected.**

Three independent lines say the same thing.

**Code.** `groupCreatedArticles` has three callers. Two are discovery plane —
`trending-service.ts:285` (the breadth sample) and `timeline-service.ts:1483` (the
reader-search fill) — and one is deepening (`timeline-service.ts:1227`). All three
enter the same loop. `attachTo` is consumed *downstream* of grouping and gates the
linker and the attach, never the merge.

**History.** `mergeBridgedGroups` landed **2026-08-13** in `d40cce6` (ADR-0009).
`attachTo` and the deepening plane landed **2026-08-28** in `0dec1fa` (#179), 335
commits later. The channel predates the plane by a fortnight of work.

**ADR-0009's own evidence is discovery data.** Its measurements — 59 merges over an
18,050-article backfill of this archive, 66 over a 31-day live corpus — were taken
when no deepening sighting existed anywhere. Bridge-merge re-parenting is a
designed, argued, measured property of grouping on the discovery plane.

So the honest statement is: **G6 found a pre-existing property of grouping, not a
leak in the deepening plane.** `sightings.plane` gates which rows are *counted*;
it was never going to gate which rows *exist in which group*, and nothing about
this needs a deepening article.

**What IS deepening-specific is the rate, and it is worth stating separately.**

```
                                        merges   articles      per 100
G6's two runs (deepening arrivals)          55      2,902         1.90
ADR-0009 backfill replay (discovery)        59     18,050         0.33
```

Roughly six times denser per arriving article. The mechanism is obvious and does
not require a defect: a deepening call returns up to **100 items about one story**,
which is the maximal condition for an arrival to match across two groups. A
latest-news page is diffuse and rarely bridges. The bases are not
like-for-like — one is a live arrival sequence, the other a backfill replay — so
treat the ratio as an order of magnitude, not a coefficient.

---

## 3. Blast radius, measured

**259 pre-existing articles changed `group_id`** — reproduced exactly against the
restored PRE archive. Resolving each article's arc set through `merged_into` in
both states:

```
pre-existing articles that changed group_id             259
  arc set IDENTICAL afterwards (pure bookkeeping)        28
  arc set changed                                       231
    gained arcs only                                    225
    "lost" an arc                                         6   ← all 6 are alias
                                                              dissolutions; the
                                                              lost id is now
                                                              merged_into an arc
                                                              the article is in
```

**G6's 259 is both an over- and an under-count of the thing that matters.**

- **Over** by 28: those articles moved group and stayed in exactly the same arcs.
- **Under** by 33: **33 further pre-existing articles changed arc set without
  changing `group_id` at all.** These are the *winner* group's own members — their
  group never moved, but their group absorbed the loser's arcs. A diff on
  `group_id` cannot see them.

```
CORRECTED: 264 pre-existing articles changed which storylines they belong to.
           Every one of them GAINED arcs. Not one lost coverage.
```

51 storylines (of 14,670 holding any article) had their pre-existing-article
membership change.

The 55 merges themselves:

```
merges                                55      over 41 fetches
  singleton adoptions (n=1)           32      ADR-0005 already allowed these
  multi-article bridge merges (n>1)   23      ADR-0009's addition
largest single merge                  38 articles
cross-arc (loser and winner arc sets differed)   43
within one arc set (no membership effect)        10
one side held by no arc                           2
```

Two thirds of the "merges" are the singleton adoption that ADR-0005 permitted
before ADR-0009 existed. The population item 5 is actually about is **23**.

*Incidental, unexplained, out of scope:* ADR-0009 argues compounding is bounded by
the local-day window. 48 of the 55 joined groups whose earliest members share a
local day; 5 spanned a boundary and 2 had a newly-minted winner. Only one of the 5
involved an article whose `published` G6 rewrote, so the timestamp channel does not
explain it. Worth its own look; it changes nothing here.

---

## 4. Is it harmful? The merges are right. The unions are mostly right too.

**At the group layer — read by hand.** All 13 merges that moved five or more
articles pair leads of the same story:

```
38  Sword-wielding attacker injures several at Swedish school → Teenager kills one … with a sword at a school
35  Google's Pixel Tag is an AirTag for Android              → 12 announcements from Google's Pixel 11 launch
26  Judge dismisses Trump administration lawsuit alleging …   → DOJ's antisemitism lawsuit against Harvard dismissed
18  'DPRK fires ballistic missile ahead of US drills'         → North Korea fired ballistic missile, ahead of US-SK drills
14  Eurovision to bar countries at war from hosting           → Burgas to host the Eurovision Song Contest 2027
12  Russia frees ailing ex-US Marine Robert Gilman            → Russia releases former US Marine reported in poor health
11  Ukrainian drone attack on a Russian city kills 13         → Ukraine drone strike kills 13 in Nizhnekamsk oil hub
 9  Tropical Storm Lala could reach hurricane strength        → Tropical Storm Lala forms, forecast to hit Hawaii
 9  Twelve Killed, 39 Injured in Ukrainian Drone Attack       → Ukraine drone strike kills 13 in Nizhnekamsk oil hub
 9  Former US Marine held in Russia … has been released       → Russia releases former US Marine reported in poor health
 7  North Korea fired a ballistic missile, South Korea says    → North Korea launches a suspected ballistic missile
 6  USS Abraham Lincoln's deployment raises concerns          → USS Abraham Lincoln sailors tried to jump overboard
 5  Trump took secret flight out of Türkiye due to Iran threat → Trump secretly switched planes to leave Turkey
```

Eleven are unambiguous syndication heals — exactly what ADR-0009 was built to do.
Two (the Pixel Tag into a launch roundup, the Eurovision rule change into the host
announcement) are ADR-0009's stated and accepted cost: "same story, not the same
piece."

**At the arc layer.** The 43 cross-arc unions are, overwhelmingly, unions of arcs
that were **already duplicates of one event**:

```
Gilman Russia Release        +  Robert Gilman Release  +  Toledo Gilman Release
Nizhnekamsk Drone Strike     +  Ukraine Nizhnekamsk Drone Strike
USS Abraham Lincoln Crisis   +  USS Lincoln Deployment Crisis
North Korea Missile Drills   +  North Korea Missile Launch
Harvard Antisemitism Lawsuit +  DOJ Harvard Financial Aid
Canada US Trade War          +  Canada US Trade Deal  +  Canada Trade Collapse
Eurovision hosting rule change + Eurovision Conflict Rule + Burgas Eurovision Host
```

That is **G6's own Nepal split**, everywhere, and the merge did not create it.

Genuine cross-event contamination is about **2 of 43**, both small: two McIlroy
St Jude Championship articles dragged into "Leagues Cup 2026 Guide", and one
"Zelensky Belgrade Visit" article into "Zaporizhzhia North Korean strike".

**So the honest verdict on harm is not "articles moved to the wrong arc". It is
that a CORRECT group merge multiplies a pre-existing arc split into several
inflated board rows.** The damage is proportional to how badly
`storyline-label-merge` has already failed on that event.

---

## 5. The cloud, with the two channels finally separated

G6 could not say how much of the board movement was this channel and how much was
timestamps. Separated here.

**Harness validated first.** A transcription of `readTrendingStorylines` was run
against the restored PRE archive and reproduces **all three of G6's `board-pre-*`
files byte-identically**. (Two incidentals recovered doing so: G6's date label is
the window's `to`, one day after its `from`; and the half-life used is **12 hours**,
not the schema default of 8. Both were recovered from the data, not from config.)

Three counterfactual boards, top 20, 24-hour windows:

- **A** — POST as it is (both channels).
- **B** — POST group state, but every pre-existing article's `published` reverted
  to PRE. *Group channel only.*
- **C** — PRE group state, but `published` advanced to POST. *Timestamp channel only.*

Each diffed against the PRE board:

```
window ending      scenario                    rows changed   arcs entering/leaving
2026-08-13   A  actual, both channels                  12              6
             B  GROUP channel alone                    12              6
             C  timestamp channel alone                 0              0
2026-08-14   A  actual, both channels                  16              8
             B  GROUP channel alone                    12              8
             C  timestamp channel alone                 6              2
2026-08-21   A  actual, both channels                   4              2
             B  GROUP channel alone                     4              2
             C  timestamp channel alone                 0              0
```

**The group channel accounts for every one of the 16 board membership changes
across the three windows. The timestamp channel alone changes the board on one
window of three, and never changes an arc's article or domain COUNTS — only its
score, plus one boundary swap.** Its signature is visible and exactly as G6
described it: `Leavitt White House Exit | 68 | 49 | 62.574 → 54.126`, same
coverage, decayed differently.

This reverses the intuition G6's ordering leaves. **ADR-0021 fixes the channel that
moved the board least.**

**The worked case.** Group 30218 ("Burgas to host the Eurovision Song Contest
2027", 27 members across two groups pre-run) absorbed three groups on bridge
evidence from deepening-minted arrivals:

```
26815  14 articles   held by  Eurovision hosting rule change
33416   4 articles   held by  Eurovision Conflict Rule
30224   1 article    held by  BOTH
```

It ended at 43 members — 11 minted by the fetch, 5 arriving with other merges — and
**all three arcs now hold it**. On the board for the window ending 2026-08-14 all
three appear at once:

```
Burgas Eurovision Host          37 | 33
Eurovision hosting rule change  34 | 32
Eurovision Conflict Rule        33 | 31
```

Three top-20 slots for one story, each counting substantially the same coverage,
with four other arcs pushed off the board to make room. `USS Lincoln Deployment Crisis`
(37|33 → 43|38) and `USS Abraham Lincoln Crisis` rise together in the same window
for the same reason.

**And this is a genuine feedback path, which should be said plainly.** The
inflation is not deepening articles being counted — `plane` correctly excludes
every one. It is *pre-existing discovery articles* being re-parented into an arc,
raising its windowed volume, raising its score, making it likelier to reach the
board and be fetched again. That is the endogenous loop ADR-0019 built `plane` to
prevent, arriving by a route `plane` cannot see, exactly as G6 said.

**What bounds it is the property in §1**: the merge partition only coarsens and a
repeated merge is a no-op, so the loop has a **fixed point**. It cannot ratchet.
The reachable drift is bounded by how many genuine group splits the archive holds,
not by call volume. Call volume changes how fast the fixed point is reached, not
where it is. That is a materially weaker hazard than G6's "scales with call volume"
implies, and it is the single most important correction in this note.

---

## 6. Options

**(a) Accept it in writing, and re-point item 5. — RECOMMENDED.**
The merges are correct, the unions are mostly unions of arcs that should already
have been one, no article lost coverage, and the drift converges. There is nothing
here to close at the grouping layer. Item 5 should be struck and replaced with two
statements: that group re-parenting is general to grouping and not a deepening
defect (§2), and that the board harm it exposes is the arc split G6 already
recorded. Cost of accepting: several board rows for one event, and inflated counts
on each. Both are already true without any merge — the split arcs were there
first; the merge makes them louder.

**(b) Feed the merge back into label-merge as evidence.** A group merge is direct,
already-measured proof that two arcs are one event — stronger than anything
`mergeCollidingLabels` gets today. `absorbMergedGroup` currently marks
`link_dirty_at` and stops; it could offer the unioned arcs to the merge pass. This
turns item 5 from a defect into a *signal*, and it attacks the Nepal split, which
G6 named as G7's worst economics problem. **This is the follow-up worth measuring**,
and it is a bigger prize than closing the channel would be. It needs its own
measurement and does not belong in this note.

**(c) Break the union in `absorbMergedGroup`.** Keep the winner's arcs, drop the
loser's. Rejected on its face: `mergeGroups`' own contract says the membership must
follow or a storyline is left pointing at a group with no articles, and its day
slots silently lose coverage — a bug that was already caught once, exactly that way.

**(d) Refuse merging on the deepening plane.** Cheap, and it is what item 5's
wording implies. **Recommend against.** §2 says the channel is general, so this
fixes nothing in principle; it forfeits genuine heals (the 38-article Swedish
school attack, the 35-article Pixel 11 launch); and it makes the deepening plane's
grouping differ from discovery's, which is a new inconsistency to maintain for no
measured gain.

**(e) Add a per-batch merge cap.** `MERGE_LIMIT` is per arrival, so a 100-item
deepening batch can in principle run 100 × 10. Observed: 55 merges over 41 fetches,
nowhere near any limit. A guard, not a fix, and it would ship unmeasured. Not now.

---

## 7. What this note did not do

- **It did not touch production.** No local access, and nothing here needs it.
- **It did not observe a discovery-plane merge live.** The generality argument in
  §2 rests on the code path, the commit history, and ADR-0009's own discovery-data
  measurements. Those are strong, but a live discovery fetch that bridges two
  groups has not been watched happening in this phase.
- **It did not rate every one of the 43 cross-arc unions by hand** — all 13 merges
  of five or more articles were read, plus every distinct arc-label pair. The
  "about 2 of 43 are cross-event" figure is a hand count over those pairs, not a
  labelled sample.
- **It did not re-run G6's instrument.** No new live fetches were made and no
  archive was mutated.

## Reproducing

`zammy_preg6` is left in place in the dev Postgres container: schema `public` is
the PRE archive, schema `post` is a read-only copy of POST, and views
`pre_arcs` / `post_arcs` resolve each article to its arcs through `merged_into` in
each state. Drop it with `drop database zammy_preg6;` when it stops being useful.
