---
status: accepted
---

# A view holds several storylines

The storyline view ([ADR-0011](0011-a-storyline-is-a-persistent-arc-of-one-event.md))
was a view of exactly one arc: click a label, see that storyline's days, dismiss the
chip to leave. This ADR widens it. **A reader with a storyline open who clicks another
adds it to the view rather than swapping it in**, the pills the search surfaced stay in
the command bar for as long as the view is open, and the rail pages every held arc's
days on the one keyset so they interleave in time.

## The change

1. **`?storyline=` accepts a list.** One UUID, or several joined by commas, capped at
   `MAX_VIEW_STORYLINES` (12). `readStorylineView` resolves each — aliases to their
   survivors, unknown ids dropped — folds repeats, and reads
   `readStorylineTimelinePage` with `storylineIds`, whose only widening is the
   predicate `sd.storyline_id in (...)`. Nothing about the keyset moves:
   `(day_slot_published, storyline_id)` already gives two arcs' days a total order,
   and a cursor that stops between them resumes between them.
2. **The response names every arc in the view**, in request order, in the same
   `storylines` list a search uses for what it surfaced. The browser reads each
   chip's label from it by id, and — when the served list differs from the one asked
   for — rewrites its URL to say what the server actually served.
3. **The URL is `/storyline/<first>/<slug>?also=<uuid>,<uuid>`.** The path names one
   storyline because the pretty path is the crawlable, server-rendered page and can be
   about one thing; the rest ride in `also`. `Route` and `TopicQuery` hold the same
   split. A click from inside the view appends to `also`; taking the path's storyline
   out promotes the next; taking the last one out leaves the view exactly as
   dismissing the single chip always did.
4. **The pills stay, as a pool of offers.** The command bar keeps drawing the
   storylines the search the view was opened from surfaces — asked of
   `GET /api/v1/storylines?q=` with a limit of a row's worth plus one per held arc —
   minus the arcs the view already holds, biggest first, eight at most
   (`storylineOffers`). Taking a pill moves its arc to the prompt as a chip and out
   of the row, and the next match fills in; dismissing a chip returns its arc to the
   row and the pill with the fewest articles makes room. A view with no origin (a
   shared link, the hero's cloud) draws no row until something is typed.
5. **A day may carry several sentences.** Two arcs in one view can both have a day
   sentence for the same date (ADR-0023); `groupByDay` keeps one per arc and the rail
   attributes each by label when there is more than one.

## Why add rather than swap

The pills are an offer the search made, and the offer does not expire because the
reader accepted part of it. Under the old view, accepting one pill hid the others,
and comparing two storylines the same search surfaced meant opening one, going back,
opening the other, and holding the first in memory. The two arcs a reader wants side
by side are usually arcs one search surfaced together — the same event under two
labels the merge never joined, a story and its follow-up — which is exactly the case
the pills row is showing them.

"Swap" also had nowhere to put a second click that was not a regression: a pill click
in the view either replaced the subject (losing the first) or did nothing. "Add" gives
the click a meaning, and a pressed pill gives the reader the way back out.

## Why the server merges

The alternative was N single-arc queries in the browser, merged and sorted
client-side. Refused because it has no cursor: page two of arc A and page two of arc
B are not page two of the view, and a reader paging down would see slots arrive out
of order or twice. The keyset already answers the question for one arc; widening one
predicate answers it for N, with the same totality guarantee and the same cursor
shape, at the cost of nothing new.

## What is deliberately not done

- **No held arc in the row.** The chip is the one place a held arc is named; a
  pill for it too would say the same thing twice, and the row's job is to offer
  what is NOT yet open.
- **No ranking of the arcs.** The URL keeps the order the reader chose; the rail
  orders by time. There is no primary storyline, for the same reason
  `memberships` has none.
- **The server-rendered page stays single.** `/storyline/<uuid>/<slug>` renders the
  path's storyline whatever `also` says; a crawler is sent to one page per arc and a
  reader's JavaScript widens it. The canonical link is that page's.
- **No cap below 12 in the UI.** A reader assembles a view by clicking, and a search
  surfaces at most eight; the cap exists so a hand-built URL cannot page the archive.

## Consequences

- `TimelineQuery.storyline` is no longer a single UUID on the wire; readers of it use
  `viewStorylineIds`. `isStorylineView` accepts the list.
- `readStorylineView` takes `storylineIds`; `readStorylineTimelinePage` takes
  `storylineIds`. `describeStorylines` is exported from storage for the view's own
  subjects, replacing one whole-life count per arc.
- `DayGroup.summary` became `summaries`, a list with the arc on each.
- A filter change made inside the view now keeps the view's origin (`from`); it used
  to drop it, so the reader's way back was lost by narrowing the search they would
  return to.

## Amended 2026-09-17: typing inside the view finds storylines

Under ADR-0011, typing into the view's search box left it — "typing exits the
view". With several arcs held and the pills row kept, that exit became the one
click in the bar that threw the reader's work away, and the box sat above a row
of storylines with nothing to say about them.

**Typing now searches FOR storylines.** The words go to
`GET /api/v1/storylines?q=` — the same keyword match `GET /api/v1/timeline`
makes beside a search's results (`findSurfacedStorylines`, folded with
`labelWords`), on its own: no topic is minted, nothing is fetched, no page comes
back. The matches take the pills row — minus what the view already holds, as
the origin's do; a match clicked is added like any pill. The words ride in the URL as `?find=` so the row
a reader shares is the row the recipient sees. An emptied box hands the row back
to the origin search's pills. "No storylines say X" is said under the box once
the answer is in, since an empty row after Enter would otherwise read as
nothing having happened.

**Leaving the view** is now by dismissing its chips (the last one out returns
to the origin search, as before) or by the `zammy>` prompt. The words typed
inside the view do not travel out: they were a question about storylines, not
the search the reader will return to.

**The row is a pool, not a list.** Whichever question it answers — the origin's
words or the typed ones — it shows the matches the view does not hold, biggest
first, a row's worth, and asks the server for one more than that per held arc so
the match that takes a picked pill's place is already in hand. The pool keeps
every answer it has seen for the standing question (`growPool`): when a chip is
dismissed the ask shrinks by one, and without the pool the ninth match would
vanish by rank rather than the smallest by size, which is what the row's own
order says should go. An earlier version read the origin's pills off the search's
own cache entry through a second observer; that entry holds exactly eight and
could never say what came ninth, so it went.
