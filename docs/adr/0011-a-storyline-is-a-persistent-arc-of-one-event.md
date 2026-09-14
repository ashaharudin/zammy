---
status: accepted (ADR-0013 had made the landing-page cloud one exception to "a label's words never execute as a search"; ADR-0016 retracted that exception, so the rule stated here now holds everywhere without exception)
---

# A storyline is a persistent arc of one event, paged as storyline-days

A **storyline** is redefined: a persistent, unbounded-in-time collection of
groups covering one specific event or evolving situation. Identity is a UUID,
never a label. Membership is group-level and many-to-many: a group may belong
to several storylines, and an article's storylines are its group's. The
timeline's paginated unit becomes the **storyline-day** — each day a storyline
has coverage it takes one fresh slot — which is what makes "unbounded" free at
read time: no slot spans days, and keyset pagination survives unchanged in
shape.

This supersedes ADR-0009 entirely (the day-bounded storyline, its hub-and-spoke
day clustering, the `storyline_id`/`storyline_published` columns) and the
mechanics of ADR-0010 (read-time phrase choice, topic seeding, the superset
guarantee). ADR-0010's layout survives: the gutter left of the spine remains
the label's home. The group layer — syndication, bridge merging, the figures
veto, the day bound on group drift — is untouched.

## What a storyline is, and is not

A storyline is anchored to a *happening*, not an entity. "Trump Iran War" is a
storyline; "Donald Trump" is not, however much coverage he draws. The system
errs **narrow**: two storylines that should be one can merge later; one
storyline that swallowed a day cannot be unwound, and ADR-0009's measurement
history says exactly that happens — the transitive first cut absorbed 1,179 of
a day's 1,190 groups. That failure remains the specification's north star.

Not every article belongs to a storyline. A storyline is only *real* once it
holds multiple groups; singleton coverage is the normal case, not an error.

## Lifecycle

- **Born provisional.** Every new group seeds a provisional storyline of one —
  the seed-own-identity discipline the old trigger enforced, generalized.
  Provisional storylines are invisible as storylines: no label, no display
  treatment; their slot is the plain article slot, so the timeline has one
  uniform unit.
- **Promoted** when a second group attaches: the storyline becomes real and is
  labeled. Retroactive attachment is allowed and asynchronous — a Wednesday
  storyline may pull in Monday's group, and past days re-rendering with richer
  grouping is the feature working.
- **Merged, never split.** Merges are automatic and bridge-counted: a group
  qualifying (anchor + mass) for two storylines attaches to the better and
  records a bridge; K independent bridges merge them (K starts at 2, pinned by
  measurement). Single-bridge merging is refused — one ambiguous roundup
  chaining three storylines is percolation by another door. The losing UUID
  becomes an alias resolving to the winner, so nothing held elsewhere dangles.
  Split is not built: err-narrow formation makes it rare, and it is the one
  operation with no cheap correct implementation.
- **Dormant, not dead.** Nothing ends a storyline. After ~90 days without
  coverage it leaves the normal candidate set but stays matchable at a
  high-confidence threshold only — the trial fourteen months after the crash
  can still reattach without ten thousand dead storylines serving as
  false-positive surface at everyday thresholds.

## Linking

The decision stays anchor + mass (ADR-0009's structure), with the corpus
redefined:

- A storyline speaks through **profile tokens** — tokens carried by at least
  half its member groups — and, since ADR-0026, no fewer than two of them
  wherever the storyline has two — stored on the storyline row. ADR-0009's
  majority-support rule promoted one level; also the percolation damper, since
  a growing storyline's consensus vocabulary tightens rather than loosens.
- **Candidate retrieval** is a GIN overlap between the arriving group's
  `story_tokens` and `storylines.profile_tokens` — one index scan over a small
  table. The whole-day-in-memory read dies with the day bound.
- **Rarity is measured against a trailing corpus** — document frequency over a
  rolling ~14-day window of article tokens — replacing day-relative df.
  ADR-0009's finding that an absolute cap fails (a story's own name hit df 64
  the day it dominated) carries forward: the ceiling stays a share of the
  corpus, now over a window wide enough that one loud day cannot blind the
  anchor to itself. Fourteen days is a starting knob, not a commitment.
- **No threshold ships unmeasured.** `measure:storylines` is extended to replay
  group→storyline decisions over the live corpus and grows a
  largest-storyline-share metric, so a swallow event is visible in the sweep
  before it is visible in production.

Embeddings remain refused (ADR-0005 stands); the decision functions stay pure
and swappable, and the linking seam is explicitly where an LLM verdict could
slot in later if token evidence proves insufficient. It does not ship now:
linking runs per group (~1,200/day), and cheap-and-measurable beats
better-and-opaque at that volume while auto-merge exists to heal its misses.

**Token evidence has now been measured insufficient (2026-08-18).** The record
is docs/STORYLINE-LINKING.md, "What the anchor rule cannot see". The labelling
campaign left a set hand-judged in both directions — 382 storylines a model was
shown and could not name, against 1,189 it named — and against it *no*
rearrangement of the token evidence separates the two: thirty-one settings
across five independent families (overlap size, rarity, lexical class,
provenance, temporal concentration), each destroying more model-named arcs than
it prevents unnameable piles, confirmed by a nine-setting replay over the whole
archive at under one pile per arc in every direction. The anchor's premise is
"there is a name here" and its implementation is "this token is rare"; the
archive says those are different propositions, because `ogbah` and `biweekly`
are equally rare in a fortnight.

Three things follow:

- The failure is **not** the one auto-merge heals. The label-agreement merge
  cures over-narrow formation; this is over-broad formation, and with no split
  built it has no cure at all today.
- The verdict is **already being computed and discarded**. A promotion makes
  one model call, and the Labels prompt opens by asserting the coverage is one
  story — so a model shown two unrelated articles invents a name,
  `validateLabel` refuses it, and the storyline stands under a bigram label.
  The 382 declines are that verdict arriving as a formatting failure.
- **Measured 2026-08-18 on the configured model, and it holds — at two groups
  only.** Over the hand-judged sets the verdict refuses 75 of 88 declined
  (85.2%) and 27 of 86 named; reading all 27 shows ~22 are coincidence piles
  the *namer* papered over, so the true cost is 1–5 of 86 — the first candidate
  here that is not a bidirectional trade. It also means the `named` set is
  contaminated and the reported failure is **larger than 382**. But over the 21
  named arcs at ≥20 groups the same verdict refuses **9, seven of them genuine
  events** — a mature arc's breadth reads as incoherence. So the verdict may be
  consulted **only where the storyline is not yet real**: a promotion whose
  winner was a provisional-of-one, never `merge` (which already carries K
  bridges plus label agreement) and never `drift`. `storyline-coherence.ts` is
  the pure, tested half; `pnpm measure:storyline-coherence` reproduces the
  matrix.

**Wired 2026-08-18**, in the shape the measurement forced: the gate **defers**
a formation rather than reverting one. On the fresh path the arriving group's
birth storyline is absorbed by merge-with-alias, so undoing a promotion is
exactly the split refused above; the merge waits for the verdict instead
(`LinkOutcome.pendingFormation` → `resolveFormation`), and refusals are
recorded durably in `storyline_formation_refusals` — keyed on GROUPS, since a
provisional storyline-of-one is an identity a group is merely wearing —
otherwise the nightly late-candidate sweep would re-offer the pair and pay for
a refusal every night.

It costs no extra model call: the promotion label was already one, and a model
that can name the story has thereby said it is one. Only an explicit refusal
acts; an unavailable, slow, out-of-quota or contract-breaking model performs
the withheld merge and falls back to bigrams — the pre-gate outcome exactly.
`STORYLINE_COHERENCE_GATE` can stop it without a deploy, and it is inert with
no `GEMINI_API_KEY`. The backfill does not gate — it has no tail to resolve a
deferred formation, so a gated replay would withhold every formation in the
archive and form nothing — and it rebuilds what the token evidence says.

**Amended 2026-09-11 (refusal replay).** "Does not gate" was implemented as "does not read the
refusals table either", because the linker consulted that table inside the
gate's own condition. A `backfill:storylines --restart` on 2026-08-21 therefore
re-minted 63% of every formation a verdict had ever refused, including all 66
subjects of the retroactive cleanup two days earlier. Buying a verdict and
replaying one already bought are separate permissions — `coherenceGate` and
`honourRefusals` — and only the first costs a model call. Durable refusals are
worth nothing to a process that does not read them
(docs/STORYLINE-BACKFILL.md, "What a rebuild remembers").

## Labels

A storyline carries a persistent, **non-unique** display label of two or three
words — a proper noun plus what happened: "Fort Hood Crash", "Trump Iran War".
Generated by Gemini (flash tier; `GEMINI_API_KEY` via `packages/config`) at
promotion, on merge, and on drift (membership doubled since the label was
made). Input: up to ~10 representative headlines and descriptions,
recent-weighted. Contract: 2–3 words, must contain a proper noun, names the
event or situation not just the entity, no punctuation. On failure or
unavailability: the bigram extractor, else the storyline renders label-less.

The label is presentation, not identity. It regenerates as the storyline
drifts — "Fort Hood Crash" may become "Fort Hood Investigation" — and two
storylines may share a label; an on-screen collision gets a quiet date-span
disambiguator ("Fort Hood Crash · Mar 2026").

**Amended 2026-08-17 (label-agreement merge).** A label is still not identity —
nothing keys off one, clicking rides the UUID — but agreement between two
labels is now **evidence**, and the merge acts on it. The reason is measured:
the token-bridge merge cannot reach a big running story, because the story's
own name outgrows the anchor ceiling as coverage climbs. The dev archive held
the Strait of Hormuz coverage as 25 arcs whose entire shared vocabulary was
`{hormuz, strait, iran}` — mass 10.7 against a floor of 20, every token at
2.1–4.1% of a 17,028-article fortnight against a ceiling of 0.2% — so no group
could bridge them and the cure never fired. Reshaping the ceiling does not fix
it either (docs/STORYLINE-LINKING.md): every setting loose enough to collapse
that component also builds a 315-group `com, investing` storyline and 58
storylines with no profile at all.

The labeler had already solved it: six of those arcs were independently handed
the identical name "Strait of Hormuz Crisis" — the semantic judgement no df
statistic can make. Two storylines merge when their **model** labels agree, the
label contains a **grounded proper noun**, and their **spans overlap or nearly
touch**. The date span stays the disambiguator, keeping two "Fort Hood
Crash"es apart; the grounding guard keeps a *category* from passing as a name —
the same archive labelled three unrelated earnings arcs "Q2 2026 Financial
Results", with overlapping spans, and no word of it survives
`properNounEvidence`. The bigram fallback is excluded outright: it named
sixteen unrelated arcs "Strait Hormuz", which is agreement about vocabulary,
not events. Merging is transitive within one label and nowhere else — bounded
where ADR-0009's transitive token linking was unbounded. See
`storyline-label-merge.ts`.

**ADR-0010's superset guarantee is deliberately dead.** It was load-bearing
only while the phrase *was* the query. Clicking a label opens the storyline by
UUID — the label's words never execute as a search — so nothing requires them
to appear in any member article, and the ~20% yield ceiling goes with it: every
promoted storyline has a label.

*Amended by [ADR-0013](0013-the-cloud-names-recently-updated-storylines.md):
the landing-page cloud does run a label as a search, accepting exactly the cost
this paragraph describes. The timeline gutter and the surfaced pills still open
the storyline by UUID, which makes the cloud an exception rather than a
reversal.*

This is the repo's first external model dependency. It is confined to the one
place heuristics demonstrably cannot meet the bar — the adjacent-bigram
extractor cannot reliably produce "names the event at a glance" — it runs at
storyline volume (births and drifts), not article volume, and every call has a
deterministic fallback.

**Amended 2026-08-28 (the tier changed on 2026-08-27; the decision did not).**
"Flash tier" above is now historical: labelling runs on `gemma-4-26b-a4b-it`, config's
default. What the paragraph actually asked for was the cheapest tier that can
read ten headlines and name the event, and Gemma 4 26B meets it while
publishing **double the free-tier rate — 30 requests a minute against
flash-lite's 15, and 14,400 a day (confirmed 2026-08-28) against the 500-a-day
ceiling the coherence-gate paragraph above reasons from**. It is served from
the same endpoint, so the client did not change; two things about the model
did. It spells the thinking knob differently — `minimal`, where a Gemini 3.x
flash model wants `low` — and the two families 400 on each other's values, so
`GEMINI_MODEL` and `GEMINI_THINKING_LEVEL` are now a pair rather than two
settings. That is load-bearing, not cosmetic: measured 2026-08-28 over ten live
label prompts, the model produces **9 usable labels in 10 at a 1.4 s median**
with `minimal` set, and **3 in 10 at ~43 s** with the field omitted, most of
those spending an entire token budget reasoning and answering nothing. Naming a
story is recall, not reasoning — the finding this ADR already recorded for the
flash tier, reached the other way round. Everything else here stands:
presentation not identity, the three triggers, the bigram fallback, and the
label-agreement merge's model-labels-only rule.

## The timeline

- The paginated unit is the **storyline-day**: keyset over
  `(day_slot_published, storyline_id)`, one row per storyline per day with
  coverage, positioned by that day's earliest article. A long-running story
  resurfaces every day it earns coverage instead of sinking to its first
  article's date — the exact failure MIN-published positioning would have under
  unbounded storylines.
- Within a slot: hero is that day's earliest article; the day's remaining
  articles sit in the related pane, chronological, with same-story/
  more-coverage sectioning derived from group membership as before.
- A group in two storylines appears in both storylines' slots that day, hero of
  both if it comes to that. Duplication is accepted: it is honest, err-narrow
  formation makes it rare, and "primary storyline" has no principled
  definition.

## Search and navigation

Search and storylines are separate axes. A search is never limited to a
storyline; it **surfaces** matching ones (search keywords ⊆ profile tokens).
Clicking a storyline opens the **storyline view**: the timeline filtered to
that UUID, the label as a dismissible chip, the search box empty; typing exits
the view, consistent with "typing strips the seed". ADR-0010's label-as-query
click is refused in this context — non-unique labels mean the words no longer
identify the story, so navigation must ride the UUID.

How surfaced storylines present — top strip, storyline-as-rail-slot,
command-bar typeahead — is deliberately left to a throwaway prototype round,
with universal gutter labels as the baseline layer in every variant.

## Schema

Three new tables:

- `storylines` — UUID pk, label, profile tokens, status
  (provisional/active/dormant), merged-into alias pointer.
- `storyline_groups` — the join; group-level many-to-many.
- `storyline_days` — one row per storyline-day: the keyset index, maintained at
  write time exactly as `storyline_published` was.

Dropped after cutover: `articles.storyline_id`, `articles.storyline_published`,
their trigger and indexes. Kept: `story_tokens` (still the linker's input) and
the entire group layer.

This puts the first real join in the hot read path, superseding the letter of
"the timeline read is one index scan with no join". The spirit of ADR-0002 is
preserved: position is precomputed at write time in `storyline_days`, step one
of the read stays a pure index scan, and reads never re-sort.

## Rollout

Full-history backfill, offline, before cutover: a resumable CLI replays the
linker **chronologically** over the whole article corpus (the linker is
order-dependent; replay order is the canonical order, as regroup's is today),
builds storylines/joins/day-slots from scratch, then labels each promoted
storyline. Existing `storyline_id` data is ignored — it dies with the old
model. The new read path ships behind a flag until the backfill is verified;
`PAGE_SHAPE_VERSION` bumps with the wire change, and any tokenizer change rides
the usual `TOKENIZER_VERSION` + regroup discipline.

## Considered and refused

**Keeping the day-cluster as an internal layer**, with storylines as chains of
day-bundles. Lower-risk and it preserved the one clustering layer with real
measurement history — but it keeps two coverage concepts alive forever, and
every reader of the code pays for a distinction the product no longer draws.
Replaced wholesale; the measured lessons (majority profiles, share-relative
rarity, hub discipline) carry into the new linker.

**Heuristic-only labels.** The bar is "proper noun, names the event at a
glance" — measured experience with the adjacent-bigram extractor (9 phrases
from 46 eligible slots, bound by an adjacency rule that served a guarantee now
dead) says token heuristics do not reach it.

**LLM-judged linking.** Better at "is 'Survivor found' a continuation of 'Fort
Hood Crash'?" than token overlap will ever be — and per-group volume,
un-replayable verdicts, and an unmeasurable threshold. The seam stays open.

**Forever-flat candidate matching.** Every dead storyline competing at normal
thresholds forever degrades precision monotonically. Dormancy with
high-confidence revival keeps the "unbounded" promise without the decay.

**Single-bridge merging.** The 1,179-group swallow was transitive linking;
merging two storylines because one group qualified for both is the same
percolation delivered more slowly.

**Split support.** Requires re-deciding every member's true home — the one
operation with no cheap correct answer. Err-narrow formation is the prevention;
prevention over cure.

## Left open

- **All thresholds are unmeasured as of this writing** — anchor share and floor
  against the trailing corpus, mass, K, the dormancy window, the drift-relabel
  trigger. The extended `measure:storylines` sweep pins them before anything
  ships; the numbers here are starting knobs.
- **The surfacing UX** awaits the prototype round.
- **The label prompt will iterate** on live output; the contract (2–3 words,
  proper noun, event not just entity, no punctuation) is the fixed part.
- **Non-English storylines** inherit the group layer's English-stopword
  degradation, compounded by an English-tuned label prompt. Recorded, not
  fixed.
- **Trailing-corpus df infrastructure** stands alone — settled by ADR-0013,
  which dropped `term_baseline` outright, so there is nothing left to converge
  with.

## Amended 2026-08-14: the label contract widens to two to five words

**The word count above is superseded. The contract is now 2–5 words**; every
other clause — must contain a proper noun, names the event or situation and not
just the entity, no punctuation — stands unchanged, as does grounding as the
mechanical stand-in for the proper-noun clause.

Two or three words was the tighter reading of "readable at a glance", and it
buys tightness at the cost of the clause the contract actually cares about:
"Fort Hood Crash" fits, but "Fort Hood Helicopter Crash Investigation" is the
same story once it has moved on, and at three words the model's only way to
keep the proper noun is to drop what happened — precisely the failure the
event-not-entity clause exists to prevent. The ceiling was doing the opposite
of its job on the arcs long enough to matter.

Five is where a label stops reading as a running-story tag and starts reading
as a headline, so the ceiling moves rather than opens. The floor of two is
untouched: one word is an entity, never an event.

`validateLabel` and the prompt in `storyline-label.ts` carry the new range; the
prompt half remains free to iterate, and the contract half is now 2–5.

## Amended 2026-08-20: surfacing reads the label as well as the profile

**"Search keywords ⊆ profile tokens" is superseded. The rule is now: search
keywords ⊆ profile tokens ∪ label words**, per keyword rather than per side —
"fausto pacific" surfaces the storyline whose profile says `fausto` and whose
label says "Pacific". Everything else about surfacing stands: containment and
not overlap, beside the results and never narrowing them, aliases and
provisional and unlabelled storylines excluded.

The profile alone was the wrong reading of "what a storyline is about", for two
reasons that only showed up once labels were real:

- **The majority rule is a filter on vocabulary, not on aboutness.** Profile
  tokens are the words at least half the member groups carry (at least two of
  them since ADR-0026), which is exactly
  right for the linker — it is the percolation damper — and wrong for search: a
  word only a minority of the coverage uses is dropped even when it is the word
  the model chose to name the event by. "Fort Hood Crash" answered to neither
  `hood` nor `crash` while both sat in the label on screen.
- **The cloud was a one-way door.** ADR-0013 made the label the cloud's word, so
  a reader is shown labels before they type anything. A label typed back into
  the box, verbatim, found nothing — the one search a reader has been actively
  invited to make.

The label is still **presentation, never identity** (labels are non-unique, and
navigation still rides the UUID). What changes is that it is now also a MATCH
surface: a name is what a reader has to go on, so it must be a name search can
reach.

**The label's words are stored, folded by `normalizeLabel`, in `label_words`.**
One definition of "the label's words", used by everything that needs them: the
label-agreement merge that has always used it, ADR-0014's `cloudQuery`, and now
surfacing. `normalizeLabel` is `trimWordPunctuation`, then `foldDiacritics`, then `singular` — the
same three steps in the same order the corpus ran into `story_tokens` — so
`label_words` and `profile_tokens` hold the SAME SPELLING of the same word, and
a keyword folded once answers both with a GIN `@>`. There is no inverse fold and
nothing to keep in sync.

The alternative was an expression index over
`regexp_split_to_array(lower(label), '[^[:alnum:]]+')`, which is free of a write
and a backfill and was how this first shipped for review. It is the wrong trade.
It puts a SECOND definition of the label's words in another language, and the two
drift silently: it splits on the apostrophe instead of folding the possessive, so
`dillard's` — which is what a reader typing a label back actually sends, since
`canonicalize` never trims punctuation — reaches `dillard'` under `singular`
alone and is in no profile and no label. That is the `dillard'` lesson
`trimWordPunctuation` was written for, arriving from the search side. The SQL
class `[:alnum:]` is also collation-dependent where the fold is not.

The cost is what an expression index avoided, and it is small: `label_words` is
written beside the label by its one writer (`setStorylineLabel`), and existing
rows are filled in by `backfill:label-words` — pure local computation, no
upstream call and no model. Until that runs, a row's words are `'{}'` and
surfacing degrades to the profile-only behaviour it had before, which is what
makes migration 0016 safe to run ahead of the API.

Note that the second reason above — the cloud as a one-way door — is answered
twice over once ADR-0014 lands, and by a different mechanism: ADR-0014 stops the
cloud sending a verbatim label at all. It stays recorded here because it is why
this was found, and because the first reason is the one that outlives it: a
reader typing a name they read in the gutter is not the cloud's click, and no
amount of grounding the cloud reaches them.
