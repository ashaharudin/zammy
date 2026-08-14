---
status: accepted
---

# A storyline is a persistent arc of one event, paged as storyline-days

A **storyline** is redefined: a persistent, unbounded-in-time collection of
groups covering one specific event or evolving situation. Identity is a UUID,
never a label. Membership is group-level and many-to-many: a group may belong
to several storylines, and an article's storylines are its group's. The
timeline's paginated unit becomes the **storyline-day** — each day a storyline
has coverage it takes one fresh slot on that day — which is what makes
"unbounded" free at read time: no slot ever spans days, and keyset pagination
survives unchanged in shape.

This supersedes ADR-0009 entirely (the day-bounded storyline, its hub-and-spoke
day clustering, and the `storyline_id`/`storyline_published` columns) and the
mechanics of ADR-0010 (read-time phrase choice, topic seeding, and the superset
guarantee). ADR-0010's layout survives: the gutter left of the spine remains
the label's home. The group layer — syndication, bridge merging, the figures
veto, the day bound on group drift — is untouched.

## What a storyline is, and is not

A storyline is anchored to a *happening*, not to an entity. "Trump Iran War"
is a storyline; "Donald Trump" is not, however much coverage he draws. The
system errs **narrow**: two storylines that should be one can merge later; one
storyline that swallowed a day cannot be unwound, and ADR-0009's measurement
history says exactly that happens — the transitive first cut absorbed 1,179 of
a day's 1,190 groups. That failure remains the specification's north star.

Not every article belongs to a storyline. A storyline is only *real* once it
holds multiple groups; singleton coverage is the normal case, not an error.

## Lifecycle

- **Born provisional.** Every new group seeds a provisional storyline of one —
  the same seed-own-identity discipline the old trigger enforced, generalized.
  Provisional storylines are invisible as storylines: no label, no display
  treatment; their slot is the plain article slot. This gives the timeline one
  uniform unit — a provisional storyline-of-one *is* the ordinary slot.
- **Promoted** when a second group attaches: the storyline becomes real and is
  labeled. Retroactive attachment is allowed and asynchronous — a Wednesday
  storyline may pull in Monday's group, and past days re-rendering with richer
  grouping is the feature working.
- **Merged, never split.** Merges are automatic and bridge-counted: a group
  that qualifies (anchor + mass) for two storylines attaches to the better and
  records a bridge; K independent bridges merge them (K starts at 2, pinned by
  measurement). Single-bridge merging is refused — one ambiguous roundup
  chaining three storylines together is percolation by another door. The
  losing UUID becomes an alias resolving to the winner, so nothing held
  elsewhere dangles. Split is not built: err-narrow formation makes it rare,
  and it is the one operation with no cheap correct implementation.
- **Dormant, not dead.** Nothing ends a storyline. After ~90 days without
  coverage it leaves the normal candidate set; it stays matchable at a
  high-confidence threshold only, so the trial fourteen months after the crash
  can still reattach without ten thousand dead storylines serving as
  false-positive surface at everyday thresholds.

## Linking

The decision stays anchor + mass (ADR-0009's structure), with the corpus
redefined:

- A storyline speaks through **profile tokens** — tokens carried by at least
  half its member groups, stored on the storyline row. This is the
  majority-support rule that silenced AP live-blog vocabulary, promoted one
  level; it is also the percolation damper, since a growing storyline's
  consensus vocabulary tightens rather than loosens.
- **Candidate retrieval** is a GIN overlap between the arriving group's
  `story_tokens` and `storylines.profile_tokens` — one index scan over a
  small table. No day corpus, no unbounded read; the whole-day-in-memory read
  dies with the day bound.
- **Rarity is measured against a trailing corpus** — document frequency over a
  rolling ~14-day window of article tokens, the same shape as the
  `term_baseline` infrastructure — replacing day-relative df. ADR-0009's
  finding that an absolute cap fails (a story's own name hit df 64 the day it
  dominated) carries forward: the ceiling stays a share of the corpus, the
  corpus is now a window wide enough that one loud day cannot blind the
  anchor to itself. Fourteen days is the starting knob, not a commitment.
- **No threshold ships unmeasured.** `measure:storylines` is extended to
  replay group→storyline decisions over the live corpus and grows a
  largest-storyline-share metric, so a swallow event is visible in the sweep
  before it is visible in production.

Embeddings remain refused (ADR-0005 stands); the decision functions stay pure
and swappable, and the linking seam is explicitly where an LLM verdict could
slot in later if token evidence proves insufficient. It does not ship now:
linking runs per group (~1,200/day), and cheap-and-measurable beats
better-and-opaque at that volume while auto-merge exists to heal its
misses.

## Labels

A storyline carries a persistent, **non-unique** display label of two or three
words — a proper noun plus what happened: "Fort Hood Crash", "Trump Iran War".
Generated by Gemini (flash tier; `GEMINI_API_KEY` via `packages/config`) at
promotion, on merge, and on drift (membership doubled since the label was
made). Input: up to ~10 representative headlines and descriptions, recent-
weighted. Contract: 2–3 words, must contain a proper noun, names the event or
situation not just the entity, no punctuation. On failure or unavailability:
the bigram extractor, else the storyline renders label-less.

The label is presentation, not identity. It regenerates as the storyline
drifts — "Fort Hood Crash" may become "Fort Hood Investigation" — and two
storylines may share a label; when a collision is actually on screen, a quiet
date-span disambiguator ("Fort Hood Crash · Mar 2026") separates them.

**ADR-0010's superset guarantee is deliberately dead.** It was load-bearing
only while the phrase *was* the query. Clicking a label now opens the
storyline itself by UUID — the label's words never execute as a search, so
nothing requires them to appear in any member article, and the ~20% yield
ceiling that guarantee imposed goes with it: every promoted storyline has a
label.

This is the repo's first external model dependency. It is confined to the one
place heuristics demonstrably cannot meet the bar — the adjacent-bigram
extractor cannot reliably produce "names the event at a glance" — it runs at
storyline volume (births and drifts), not article volume, and every call has
a deterministic fallback.

## The timeline

- The paginated unit is the **storyline-day**: keyset over
  `(day_slot_published, storyline_id)`, one row per storyline per day with
  coverage, positioned by that day's earliest article. A ten-day storyline
  appears ten times as the reader scrolls back; a long-running story
  resurfaces every day it earns coverage instead of sinking to its first
  article's date — the exact failure MIN-published positioning would have
  under unbounded storylines.
- Within a slot: hero is that day's earliest article; the day's remaining
  articles sit in the related pane, chronological. Same-story/more-coverage
  sectioning inside the pane derives from group membership as before.
- A group in two storylines appears in both storylines' slots that day,
  hero of both if it comes to that. Duplication is accepted: it is honest,
  err-narrow formation makes it rare, and "primary storyline" is a concept
  with no principled definition.

## Search and navigation

Search and storylines are separate axes. A search is never limited to a
storyline; it **surfaces** matching ones (search keywords ⊆ profile tokens).
Clicking a storyline opens the **storyline view**: the timeline filtered to
that UUID, the label as a dismissible chip, the search box empty; typing exits
the view, consistent with "typing strips the seed". The label-as-query click
of ADR-0010 is refused in its new context — non-unique labels mean the words
no longer identify the story, so navigation must ride the UUID.

How surfaced storylines present — top strip above results, storyline-as-rail-
slot at its latest activity, command-bar typeahead — is deliberately left to a
throwaway prototype round, with universal gutter labels as the baseline layer
in every variant.

## Schema

Three new tables:

- `storylines` — UUID pk, label, profile tokens, status
  (provisional/active/dormant), merged-into alias pointer.
- `storyline_groups` — the join; group-level many-to-many.
- `storyline_days` — one row per storyline-day: the keyset index, maintained
  at write time exactly as `storyline_published` was.

Dropped after cutover: `articles.storyline_id`, `articles.storyline_published`,
their trigger and indexes. Kept: `story_tokens` (still the linker's input) and
the entire group layer.

This puts the first real join in the hot read path, superseding the letter of
"the timeline read is one index scan with no join". The spirit of ADR-0002 is
what mattered and it is preserved: position is precomputed at write time in
`storyline_days`, step one of the read stays a pure index scan, and reads
never re-sort.

## Rollout

Full-history backfill, offline, before cutover: a resumable CLI replays the
linker **chronologically** over the whole article corpus (the linker is
order-dependent; replay order is the canonical order, as regroup's is today),
builds storylines/joins/day-slots from scratch, then labels each promoted
storyline. Existing `storyline_id` data is ignored — it dies with the old
model. The new read path ships behind a flag until the backfill is verified;
`PAGE_SHAPE_VERSION` bumps with the wire change, and any tokenizer change
rides the usual `TOKENIZER_VERSION` + regroup discipline.

## Considered and refused

**Keeping the day-cluster as an internal layer**, with storylines as chains of
day-bundles. Lower-risk and it preserved the one clustering layer with real
measurement history — but it keeps two coverage concepts alive forever, and
every reader of the code pays for the distinction the product no longer draws.
Replaced wholesale; the measured lessons (majority profiles, share-relative
rarity, hub discipline) carry into the new linker rather than the old code.

**Heuristic-only labels.** The bar is "proper noun, names the event at a
glance" — measured experience with the adjacent-bigram extractor (9 phrases
from 46 eligible slots, and those bound by an adjacency rule that existed for
a guarantee now dead) says token heuristics do not reach it.

**LLM-judged linking.** Better at "is 'Survivor found' a continuation of
'Fort Hood Crash'?" than token overlap will ever be — and per-group volume,
un-replayable verdicts, and an unmeasurable threshold. The seam stays open.

**Forever-flat candidate matching.** "Unbounded" cannot mean every dead
storyline competes at normal thresholds forever; accumulation degrades
precision monotonically. Dormancy with high-confidence revival keeps the
promise without the decay.

**Single-bridge merging.** The 1,179-group swallow was transitive linking;
merging two storylines because one group qualified for both is the same
percolation delivered more slowly.

**Split support.** Requires re-deciding every member's true home — the one
operation with no cheap correct answer. Err-narrow formation is the
prevention; prevention over cure.

## Left open

- **All thresholds are unmeasured as of this writing** — anchor share and
  floor against the trailing corpus, mass, K, the dormancy window, the
  drift-relabel trigger. The extended `measure:storylines` sweep pins them
  before anything ships; the numbers in this document are starting knobs.
- **The surfacing UX** awaits the prototype round.
- **The label prompt will iterate** on live output; the contract (2–3 words,
  proper noun, event not just entity, no punctuation) is the fixed part.
- **Non-English storylines** inherit the group layer's English-stopword
  degradation, now compounded by an English-tuned label prompt. Recorded, not
  fixed.
- **Trailing-corpus df infrastructure** may converge with `term_baseline` or
  stand alone; an implementation question, not a design one.
