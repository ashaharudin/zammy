---
status: accepted
---

# A storyline's profile needs two members to agree

ADR-0011 makes a storyline's profile *"tokens at least half its member groups carry"*, and
calls the tightening that follows the **percolation damper**: the more groups join, the more a
token must be shared to stay in the profile, so a growing arc gets harder to join rather than
easier.

The damper has a hole at exactly one member count. `Math.ceil(n / 2)` is **1** when `n` is
**2**, so a two-group storyline's profile was the UNION of its members' vocabularies, not their
consensus. The second group to arrive donated *everything it said* to the arc's identity — and
since `profile_tokens` is what candidate retrieval overlaps against, the third group was then
found, and judged, by words no two members had ever agreed on.

So: **a token enters a storyline's profile only with support from at least two member groups,
wherever the storyline has two to give.** The floor is clamped to the member count, so a
storyline-of-one keeps its own vocabulary; from three members up the majority already demands
two and nothing moves. The rule changes exactly one member count.

## What it is for

Prod storyline `49002d0e` was labelled **"Antigonish Ambulance Theft"** and held ten articles,
eight of them about the EPA repealing greenhouse-gas limits on power plants. The ambulance
group and the EPA group share **no token at all**. One CBC piece — the Nova Scotia grid
operator's search for energy technology, mentioning natural gas power plants in Pictou County —
overlapped the ambulance report on `{nova, scotia, county, ultimately}` and the EPA coverage on
`{natural, gas, power, plant}`. It joined first, the union handed its whole vocabulary to the
arc, and the EPA coverage then linked to an arc about a stolen ambulance.

Three tokens of that first overlap are provincial geography and the fourth is an adverb
(*"…ultimately stopped by a spike belt"*, *"…what will ultimately be chosen"*). That is the
same failure ADR-0011 already knows about from the Global News dateline — boilerplate entering
the vocabulary and pre-loading the mass floor — but the amplifier is this hole, not the
tokenizer. Under this rule the arc's profile is those four Nova Scotia tokens, the EPA group
shares none of them, and no threshold can admit it.

## What it costs, measured

`pnpm measure:storylines-v2` over 62 days of the dev archive (35,178 articles, 28,723 groups)
at the deployed `share=0.002 / mass=20 / K=2`, the old rule via `--variant=min-support:1`:

| rule         | chained arcs | named-intact  | groups kept | attached | merges | p50/p99 |
|--------------|--------------|---------------|-------------|----------|--------|---------|
| support >= 1 | 350  (7.4%)  | 1473  (30.1%) | 54.0%       | 12,056   | 606    | 3 / 16  |
| support >= 2 | 45   (0.7%)  | 901   (18.4%) | 48.3%       | 10,256   | 339    | 2 / 13  |

A **chained** arc holds two member groups sharing no token — it cannot have been built by those
two linking, so something percolated. That count falls by 87%.

The cost is not hidden: **572 judged-real arcs stop reassembling exactly**, and the softer
reading — groups that stay together — falls 54.0% to 48.3%. It is bought anyway, because the
same precision through the mass floor costs more: `mass=25` leaves 101 chained arcs with only
793 named arcs intact and 43.3% of groups kept, which this beats on all three at once. As a
precision lever the support floor dominates the threshold.

The `PILES-FORMED` column could not weigh in. It reads `label_source = 'bigram'`, and the
2026-08-29 relabel campaign converted almost all of that set — 2 declined against 4,892 named —
so the sweep grew a label-free alarm (`chained`) for this decision and for the ones after it.

## Considered and refused

- **A config knob.** Every other bar here is one, and this deliberately is not. A flag is a
  decision that can be silently lost: `STORYLINE_COHERENCE_GATE` was set in `.env`, never
  provisioned on the Vercel cutover, and ran at its schema default for sixteen days against an
  explicit decision to the contrary. The sweep already prices the alternative without a flag,
  which is what a knob would have been for.
- **Raising `STORYLINE_MASS_THRESHOLD_V2` instead.** Measured above, and worse on every axis.
- **Applying the same floor to `groupProfile`.** The article-level majority degenerates at two
  the same way, and the same EPA group's two-article union is how `change` reached its profile.
  It is a different rule over a different population and wants its own measurement; this ADR
  does not touch it.
- **Splitting the arcs it would have prevented.** ADR-0011 refuses a split, and that is
  unchanged: this rule stops a chain forming, it does not unmake one. `49002d0e` itself is not
  repaired by shipping it, and `dissolve:storyline-piles` does not reach it either — that tool
  is scoped to two-group arcs labelled `bigram`, and this one has three groups and a model
  label. A three-or-more-group pile has no repair today, which is a gap this ADR names rather
  than closes.

## Consequences

- `refreshProfileTokens` (SQL, authoritative) and `storylineProfile` (memory, what the sweep
  replays) both carry the floor, and must move together — a floor on one side only is how a
  threshold gets pinned against a decision nothing runs.
- **The rule change moves no membership, so nothing re-derives on its own.**
  `pnpm backfill:storyline-profiles` exists for that and must be run wherever the code lands,
  or the archive keeps union-shaped profiles and the retrieval keeps finding groups through
  them. On the dev archive: 14,665 live storylines scanned, 997 narrowed, 0 widened, ~40s.

  A census by member count says the rest, and it is the strongest claim this ADR makes:

  | member groups | storylines | narrowed | widened | empty after |
  |---------------|-----------:|---------:|--------:|------------:|
  | 1             |      9,392 |        0 |       0 |           0 |
  | 2             |      1,005 |  **997** |       0 |           0 |
  | 3             |      2,630 |        0 |       0 |           0 |
  | 4+            |      1,638 |        0 |       0 |           0 |

  **The rule moves exactly one member count and nothing else.** Every arc from three members
  up is byte-identical, the storyline-of-one clamp holds across all 9,392 of them, and the 8
  two-group arcs that do not narrow are the ones whose members already agreed on every word.
- An arc's profile now **widens only on corroboration** — two members must say a word before
  the arc does — so the nightly late-candidate sweep reaches an old group one arrival later
  than it used to.
- The cloud's query narrows with the profile: `cloudQuery` grounds a label against
  `profile_tokens`, so a two-group arc searches the words both members say. That can strip a
  **naming** word — if only one of the two members' headlines says "Hurricane", the query for
  "Hurricane Fausto Hawaii Landfall" becomes `fausto hawaii` rather than `fausto hurricane`. The
  words that survive are the ones the coverage agrees on, which is the trade this rule makes
  everywhere else too.
- **It can strip EVERY label word, and then the deepening gate refuses the arc.** Measured on
  the dev archive: of 892 labelled two-group arcs, **149 (16.7%)** have no label word left in
  their profile, against 0 before. "Nvidia GPU Financing" is grounded on nothing and keeps
  `{convince, keep, lending}`. Two consequences, and the first is the one with teeth:

  - `deepeningQuery` returns `null` for an ungrounded label, so those arcs are **never deepened
    again** unless a third group joins and re-widens the profile. That is archive-wide and
    permanent per arc, where the cloud-query effect is cosmetic.
  - `cloudQuery` falls to its last-resort branch and shows two alphabetically-first folded
    tokens as the placeholder.

  Defensible on the gate's own logic, which is why it ships: the gate exists because the
  deepening plane's product is MEMBERSHIP, and an arc whose two members do not agree on the
  word its name is built from is exactly the arc whose deepened results nobody has checked
  belong to it. Refusing more of those is the rule working, not misfiring. But it is a 17%
  swing that was unmeasured until review, and if the deepening yield drops, grounding against
  the union while retrieving against the consensus is the lever to reach for — a split with
  its own measurement, not a line to add here.
  At three members and up the gate is unmoved: 389 of 4,002 ungrounded before, and the same
  389 after.
- **An empty profile is now reachable, where `cloudQuery` documented it as impossible.** A
  two-group arc whose members share nothing has no consensus, so it has no profile. Linking
  cannot build one — a group joins by overlapping the profile it is judged against — and 0 of
  the dev archive's 1,005 two-group arcs are empty. The label-agreement merge can, because it
  fuses arcs on their names and asks nothing about their vocabulary. Such an arc falls to
  `cloudQuery`'s last fallback and searches its raw label, which ADR-0014 measured as the input
  that returns nothing. Excluding empty-profile arcs from the trending read would close it;
  that is a decision with its own measurement, and this ADR only names it.
