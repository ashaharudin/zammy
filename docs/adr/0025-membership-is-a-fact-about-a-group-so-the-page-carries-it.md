---
status: accepted
---

# Membership is a fact about a group, so the page carries it once

CONTEXT.md states it and `packages/storage/src/database.ts` repeats it: **a group may belong
to several storylines.** ADR-0011 accepts the duplication that follows — a group in two arcs
takes a slot in each, and `readStorylineTimelinePage` fans it out to both deliberately.

Nothing in the UI said so. `TimelineEntry` carries a single `storylineId` and a single
`storyline`, so one headline filed in two arcs reached the browser as two unrelated slots
under two different gutter labels, with no way to tell the rows were one piece and no way to
reach the other arc from the row in hand.

So: **a page carries `memberships` — a `groupId → storylineId[]` map and a directory of the
storylines it names.**

## Why the page and not the entry

Membership lives on the **group** (`storyline_groups`, migration 0007), never on the article
and never on the slot. Two consequences shape the shape:

- **Keyed by group, it survives the rail's cut.** The browser re-cuts a slot into the parts of
  the reader's day (`apps/web/src/format.ts`, `railSlots`), and a card cut out of a later part
  is headed by a *different group* than the slot's lead. A membership list hung on the entry
  would be the lead group's, answering for a headline no longer on the card. Every article
  already names its group on the wire (page shape 9), so a group-keyed map is looked up
  correctly by whatever card ends up asking.
- **A group filed in exactly one storyline is absent.** Its one arc is the arc of whatever
  slot it appears in, which the entry already carries. Most groups are in one, so the common
  page carries an empty map — and `groupStorylines` in `@zammy/shared` is the one place that
  reading lives, rather than at each call site.

## The binding constraint: nothing here ranks

`packages/storage/src/storylines.ts` says it outright — *"'primary storyline' is a concept
with no principled definition"*. So the wire may name the arcs a group is filed in; it may not
order them, and the arc a slot is being read under is **in** the list rather than separated
from it. A consumer that wants an order must make one and own it. S9's verdict took the same
constraint into the UI: the popover lists only the crossings, under a header counting exactly
them, because the gutter label beside the row already names the remaining arc and is already
clickable.

## Why `TimelinePage.storylines` could not carry the directory

That field has a specific documented meaning: the storylines this **search** surfaced, matched
keyword-by-keyword against a storyline's own vocabulary (ADR-0011, as amended). Widening it
into "storylines mentioned anywhere on this page" would put arcs no keyword matched into the
pills row, which is a different claim about a different thing. The directory is therefore a
second list, inside `memberships`, holding exactly the storylines the map names.

Both lists carry the same six facts about a storyline, so they share one schema
(`StorylineSummary`, formerly `SurfacedStoryline`). The **list** is what carries the reason
the storyline is on the page; one shape per reason would be two places for the span, the size
and the dormancy marker to drift.

## What "same story" gets, and why it is nothing

`related` is the lead group's other members — same `groupId` as the headline by construction —
so those rows are in precisely the headline's storylines, always. Reporting membership per row
would say something about "same story" that is true of the headline and news about neither.
`moreCoverage` is every *other* group in the slot, each with its own rows in
`storyline_groups`, and those genuinely do run in arcs the headline never touches: 5 of 12
coverage rows crossed in S9's fixtures against 0 of 11 same-story rows. The asymmetry is
pinned by a test so a later change cannot quietly start reporting it.

## Consequences

- **A second statement, not a wider join.** `readStorylineTimelinePage`'s header argues that
  its scoping is what keeps a slot's members equal to what may be promoted to its headline —
  "widening the join widens the headline, silently and everywhere". So membership is asked
  separately, of the groups the page already settled on, over the reverse index
  `storyline_groups (group_id)` that migration 0007 created for exactly this question. Two
  more statements per page, both indexed, neither on the keyset path.
- **`PAGE_SHAPE_VERSION` 9 → 10.** Cached pages are returned with no re-validation on read, so
  without the bump a client parsing the new schema meets a page cached by the old build for up
  to the historical tier's 24h TTL.
- **Provisional storylines are never named.** A storyline-of-one is invisible as a storyline
  (ADR-0011's Lifecycle) — the same reason a provisional slot reaches the browser with
  `storyline: null`. Naming one as a crossing would be the first place the UI called it a
  story. Aliases are excluded too, so a UUID that resolves elsewhere is never offered.
- **Unlabelled promoted storylines are not excluded**, unlike `findSurfacedStorylines`, which
  refuses to *offer* one. A label-less arc is a valid thing to render (ADR-0011's Labels), and
  it may be the arc a slot is being read under, where dropping it would take a row's own
  membership away. Whether an unnamed arc is worth offering as a destination is presentation's
  question, asked where the answer can look at the label.
- **The storyline view gets it too.** A reader inside one arc is precisely the reader for whom
  "this piece also runs over there" is a way out — and it is the one view where the gutter
  beside every row says the same thing. It is also where the directory earns its keep: the arc
  a row crosses into has no slot on that page at all.
- **This does not tell a reader that two rows on one screen are one piece.** S9's round had a
  version of the treatment that dimmed every row outside a selected arc, which made ADR-0011's
  accepted duplication explain itself. It was cut deliberately; recorded here so it is not
  rediscovered as a bug.
