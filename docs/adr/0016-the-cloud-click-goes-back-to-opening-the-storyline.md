---
status: accepted
---

# The cloud click goes back to opening the storyline

A cloud word now opens its storyline by UUID, the same as every other label in
the app — the surfaced pills, the timeline gutter. This retracts the one part
of [ADR-0013](0013-the-cloud-names-recently-updated-storylines.md) that
survived [ADR-0014](0014-the-cloud-ranks-by-volume-and-searches-what-the-coverage-says.md):
**"the search-not-UUID click stands."** It no longer does.

## Why the exception is gone

ADR-0013 carved the cloud out as the one place a label is executed as a
search, and named the cost plainly: "the search may return a timeline that is
not the arc." ADR-0014 then had to spend a whole mechanism —
`cloudQuery`, grounding a label's words against the storyline's own
`profile_tokens`, capped at two — just to keep that search from landing on an
empty timeline most of the time. Even grounded, it stayed a keyword match over
headline text standing in for a UUID that was sitting right there on the same
row.

That was a real cost for a real reason at the time: the cloud was also the
cold-start answer (§9.3), and a click that opens a storyline mints no topic
and feeds the demand-driven loop (§9) nothing. But readers hit the failure
mode ADR-0013 predicted often enough, in practice, that a click landing on the
wrong thing — or nothing — cost more than the loop's cold-start rows were
worth. A cloud word is the UUID of a specific, already-labeled arc; searching
its own name back at it was always the roundabout path.

## What changes

- **`TrendingCloud`** takes `onOpenStoryline(storylineId)` instead of
  `onSearch(q)`. Both the drawn cloud and its accessible `<ol>` twin call it
  with `word.storyline.id` — the two views still agree on what a click does,
  the thing ADR-0013's own two-affordance refusal cared about.
- **`Hero`** threads `onOpenStoryline` through from `App`, alongside the
  `onSearch` the free-text search box still uses — the box still runs a
  keyword search; only the cloud's own words no longer do.
- **`App`** wires it to the same `openStorylineView(route, storylineId)` the
  timeline gutter and `StorylinePills` already use.
- **`storyline.query` and `cloudQuery` are unchanged and still wired** — not
  to the click, but to `searchPlaceholder`'s ghost text, which still needs a
  string worth typing rather than a label that returns nothing if typed
  verbatim. Grounding a label into a real search is still a real problem; it
  is just no longer the click's problem.

## Consequences

- **The demand-driven loop learns less from a first-time reader.** A cold-start
  click now opens a storyline directly rather than minting a topic and calling
  upstream. Accepted: the loop still runs off every search the box itself
  produces, and a reader landing on the arc they clicked is worth more than
  one extra upstream call recorded.
- **CONTEXT.md's storyline-label paragraph is wrong again in the other
  direction.** It says a label's words are "never executed as a search" except
  in the cloud. That exception is retracted; the rule is no longer narrowed.
- **The cloud and the rest of the app agree on what a label does.** The
  asymmetry ADR-0013 introduced deliberately — cloud searches, everywhere else
  opens — is gone. A label opens its storyline everywhere, full stop.
