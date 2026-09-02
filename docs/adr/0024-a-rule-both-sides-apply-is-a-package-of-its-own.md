---
status: accepted
---

# A rule both sides apply is a package of its own, not a wire type

CONTEXT.md states the **representative** — the article whose headline a timeline slot
shows — as one rule with four clauses. Until now each clause lived somewhere different: a
SQL join in `@zammy/storage`, `leadBeats` and `chooseRepresentative` in `apps/api`, and
`earliestIndex` in `apps/web`. No module named the rule, two prose restatements of one
invariant sat a package apart, and nothing pinned that they agreed — nothing *could*, because
they were in different packages with different fixtures.

The fourth clause was in the browser for a reason that has since expired. It reads "a card the
rail cut out of a LATER part is headed by the earliest article that part holds", and
CONTEXT.md gave the reason as *the wire carrying no group structure below the slot to choose
within*. `Article.groupId` is now on the wire — the rail folds the cut on it rather than on
title text — so the browser can identify a heading group and could apply source authority
inside it exactly as the service does. The reason expired; the clause outlived it.

So: **the rule lives in `@zammy/representative`, a dependency-free package both the API and
the browser import**, with the last clause as a parameter (`within: "lead" | "part"`) rather
than a second algorithm in another package.

## Why not `@zammy/shared`

ADR-0004's stated test is "does the browser need it — if no, it belongs in the package that
owns the concern". The browser needs this, so that test does not exclude it, and `shared`
would be the easy import. It is still the wrong home, and the reason is the *other* half of
ADR-0004's sentence: `shared` holds **the wire contract** and nothing else.

The rule is not a wire shape. Its substance is `TIER_1_SOURCES`, a list of outlets we have
decided to trust — an editorial stance, revisable by argument, sent to nobody. Putting it in
`shared` would make "the shapes the API sends" also mean "the judgements the API applies",
and ADR-0004 exists because that boundary erodes one convenience at a time.

So the test ADR-0004 implies, made explicit here: a type belongs in `shared` when the browser
needs it **and** it is the wire contract. Needing it on both sides is an argument for a shared
*package*, not for `shared` specifically.

This does not weaken ADR-0004's safety mechanism, which is about keeping the API key's home in
`@zammy/config` unreachable from the bundle. `@zammy/representative` has no dependencies at
all — no zod, no wire contract — because the rule is arithmetic over four fields.

## Considered options

**Duplicate the tier list into `apps/web`.** Rejected: two copies of a list whose entire value
is that one review governs it. The next outlet added to one copy is the bug.

**Have the server choose each group's head and send it.** This genuinely works — `railSlots`
folds by `groupId` and files a whole group at its earliest copy, so a group is *atomic* with
respect to the reader's parts of the day, and group membership is the same on both sides of
the wire. It was rejected on what it buys, not on whether it works:

- It **re-splits the rule**. The browser would still own "which group leads *this* part", so
  the single test would still span two packages — the thing consolidating was for.
- A per-group head **cannot express what ships today**. "The earliest article the part holds"
  is not a per-group quantity, so the wire would have to carry an answer to a product question
  nobody has decided — plus a `PAGE_SHAPE_VERSION` bump and a cold cache for a field inert
  until someone decides it.

## Consequences

- **Clause 1 stays a SQL join**, because it is one. What the module owns there is the
  contract, documented at both ends rather than restated.
- **`sightingCount` is unreachable from the rule.** The module's input type carries `id`,
  `groupId`, `sourceDomain` and `published` and nothing else, so CONTEXT.md's "never by how
  often upstream re-emitted it" is a compile error rather than a comment.
- **Agreement between the two readings is testable for the first time.** One table of member
  sets asserts what a slot shows *and* what a later part of the reader's day shows, from the
  same fixture through the same function. Rows where the two columns differ are the product
  delta, visible rather than inferred across two packages.
- **The fourth clause is now one line, and it is deliberately not flipped.** Measured over
  23,361 slots: 153 of 3,104 later-part cards would change headline (4.9%), stable across five
  timezones. Of the 148 visible changes, 43 go untiered → tier-1 but **21 go tier-1 →
  untiered**, because "largest group" is decided before "tier 1" — so a syndicated pile
  outranks a lone wire piece, and a templated-filings mill can take a headline from `rte.ie`.
  Changing it is a product decision with evidence attached, not a refactor's to make.
- A future rule that both sides must apply and that is not a wire shape has somewhere to go,
  and this ADR is the argument for putting it there rather than in `shared`.
