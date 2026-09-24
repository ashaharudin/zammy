---
status: accepted (amended 2026-09-23: the Currents top-up may defer to the deepening plane — see the last section)
---

# Opening a storyline queues its own refresh

Clicking a storyline label — the hero's cloud, the timeline gutter, a surfaced
pill — opens the storyline view by UUID as it already did, **and asks, in the
background, for one top-up of the topic the arc's own coverage names.** The
click does not wait for it and the view does not show it: whatever arrives
lands in the archive for the next read of that arc.

This is the consequence
[ADR-0016](0016-the-cloud-click-goes-back-to-opening-the-storyline.md) accepted
and named — "the demand-driven loop learns less from a first-time reader" —
paid off without giving back the thing ADR-0016 fixed. A label's words are
still never executed as the click's search (ADR-0011, ADR-0016); the reader
still lands on the arc they clicked. What changes is that the click is no longer
free of ingestion.

## Why a storyline going stale is a real cost

A storyline is unbounded in time (ADR-0011): an ongoing story holds its whole
arc, and a reader opening it is reading a story that is still happening. But
nothing about opening it fetched anything. The arc deepened only when somebody
happened to run a keyword search whose topic overlapped it — which is exactly
the reader ADR-0016 stopped producing. The most-clicked arcs in the app had no
mechanism of their own for staying current.

Every upstream call still traces back to a real user request (§9), which is the
invariant that matters; a click IS one. What this adds is a second *kind* of
demand alongside the search box, and it is the kind the landing page actually
generates.

## What the ask is made of, and what it is not

**The arc's own coverage decides all of it. The reader decides none of it.**

- **Keywords** — `storylineKeywords`, which is `cloudQuery` (ADR-0014) plus the
  one case the cloud never reaches. The label's own words that the arc's
  coverage actually says, capped at two; for a **label-less** arc, which the
  timeline gutter renders and therefore lets a reader click, the profile's own
  tokens instead. One rule and not two, so a click asks for the same WORDS the
  cloud's own placeholder proposes for that arc. Not necessarily the same
  fingerprint: a topic's identity also holds the language, country and category
  (§6.2), and this refresh always uses the arc's modal language with neither of
  the other two, while a reader executing the placeholder carries whatever chips
  are set. The words are the half that decides whether the ask can match the arc
  at all, which is why they are worth deriving once.
- **Language** — the commonest one the arc's member articles carry
  (`readStorylineLanguage`), falling back to `DEFAULT_LANGUAGE`. The reader's
  language chip was the obvious source and is the wrong one: the cloud is built
  for English alone (§10.1), so a reader whose chip says Malay clicking an
  English cloud word would mint a Malay topic that can never match the arc — a
  background call guaranteed to find nothing, which is the spend §9.4 exists to
  refuse.
- **No country, no category, no window, no keywords on the wire.** A storyline
  is not defined by a region or a desk, and a caller who could name the window
  could aim the queue at any span of the archive it liked. `POST
  /api/v1/storylines/:id/refresh` takes a UUID and nothing else.

## What it costs, and what bounds it

**At most one job per click**, and no upstream call on the request path:

- **A warm arc queues nothing.** `freshnessTtlMs` is 60 s on a window ending
  now, so a storyline two readers open in the same minute costs one enqueue and
  one Redis read.
- **A stale trailing edge** queues the §6.4 top-up, deduplicated by its leading
  edge alone.
- **A cold topic** queues the newest gap and nothing else, bounded to one call —
  §9.4's "backfill is never automatic on first search" applied to a click. An arc
  with 30 days of missing history is worth one 7-day slice of freshness, not five
  calls nobody asked for. Deeper history is still what typing the words is for.
- **An interior hole under a covered present** queues nothing. That is missing
  history rather than staleness, and by the previous bullet a click does not buy
  history.

**Which branch a click takes is decided by the GAP, in two questions, and the
route to that shape is worth the record because two review rounds were spent on
it and each intermediate answer was wrong in its own way.**

The questions the code now asks, in order: does the newest gap reach
`min(window.to, now)` — if not, coverage sits above it and this is an interior
hole, so nothing is queued — and does that gap start where coverage inside the
window stops, which makes it a trailing edge to be judged on age.

*Not* `trailingSliver`, which is what the read path uses. That additionally
requires the whole window to reduce to ONE sliced gap, which is right there —
it separates "stale edge, repair behind the reader" from "missing history, take
the synchronous fill" — and wrong here, because a topic minted by a click is
multi-gap from its first click onward by construction: the click fills the newest
7 days of a 30-day window and never reaches the rest. Under the shape test the
edge was never a sliver, the freshness gate was unreachable, and what a click did
depended on where the clock sat inside the quarter-hour — measured, an arc whose
edge was 45 SECONDS old got a 15-second segment job and an upstream call, while
the same arc a few minutes earlier got nothing. There is no synchronous fill on
this path for a shape test to choose between, so the only question an edge poses
here is how stale it is.

*And not `max(coverage.upper)` either*, which was the first attempt at replacing
the shape test and is the more instructive mistake. "The newest gap does not start
at `max(coverage.upper)`" is not the same claim as "the present is covered":
`readCoverage` is unfiltered by window, so a topic whose whole coverage has aged
BELOW the lookback horizon satisfies the first while contradicting the second. It
read `fresh` on every click, forever, with nothing else in the system to advance
it — the quiet-arc failure this ADR exists to fix, reintroduced at its centre.
The gap's own upper edge cannot make that mistake, because below the horizon
there is no coverage inside the window at all and the gap runs to the clamp.

A **segment's span is snapped onto the 15-minute window grid**, which is the
one non-obvious mechanism here. `subtractCoverage` clamps its newest gap to
`now` exactly and `sliceSpan` measures back from that edge, so the same coverage
planned a second later produces different span endpoints — and `ingestJobId`
derives a job's content address from exactly those endpoints. Unsnapped, every
click mints a distinct job and spends its own call, with the queue's dedup
defeated on precisely the surface most likely to be clicked twice. Freshness is
still judged on the real clock: planning the staleness test on a snapped clock
would hide every staleness younger than the last grid line.

Below that, nothing is new. Queued jobs fetch at `"background"` priority behind
the interactive reserve, the per-topic daily cap binds before every call, and
the per-IP rate limit already covers `/api/v1/*` (§9.4).

**Per arc those guards bind; across arcs nothing does, and the arithmetic is
small enough to write down.** Every storyline is its own topic with its own
20-call cap, and the background allowance is `CURRENTS_DAILY_CALL_LIMIT −
INTERACTIVE_RESERVE` — 750 on today's settings. So roughly **38 distinct
storyline UUIDs is the whole day's background budget**, and UUIDs are public on
every timeline page; at `RATE_LIMIT_PER_MINUTE` 60 those 38 POSTs fit inside one
minute from one IP, with no keywords and no body. What it costs is the deferred
backfill of every real search for the rest of the day — readers are unaffected,
because the interactive reserve is what they draw on.

**Dormancy is deliberately not consulted.** `queueStorylineRefresh` reads the
storyline row and never looks at `status`, so a dormant arc — quiet since March,
still clickable from the gutter and from surfaced pills (ADR-0011) — has cold
coverage and therefore spends on its first click where a live arc is gated
`fresh`. That inverts which arcs cost the most, and it is still right: a top-up
over the present is exactly how a dormant arc would be SEEN to revive, and
refusing to ask is refusing to find out. It is also self-limiting rather than
recurring, because the first click's own job advances that topic's coverage to
the present and every later click meets the same 60-second gate as any other arc.

Accepted rather than fixed, and the reason is that this is not a new class: one
keyword search plans five segments, so the same IP can drive the same drain
through `/timeline` with about a fifth as many requests. A click is a materially
CHEAPER trigger, which is the honest new fact here, and §9.4's answer to
user-driven spend — per-topic cap, per-IP ceiling, interactive reserve — is the
answer to it too. A global daily ceiling on click-driven refresh is the fix if
this ever bites; it is a new mechanism with its own tuning and no evidence yet
asking for it.

## Consequences

- **Topic rows now exist that nobody searched for.** One per clicked arc, with
  its hit count and `last_hit_at` bumped by the click — which is the honest
  record, and what keeps it ahead of retention's idle cutoff (§7.5). An arc that
  stops being clicked ages out like any other idle topic.
- **A click can be refused and the reader will never know.** A 404 on a stale
  UUID, a 429 from the per-IP ceiling, an offline tab: all of them mean the arc
  goes un-refreshed, which is precisely the status quo this replaced. The
  browser's fetch has no error path on purpose.
- **`zammy_storyline_refreshes_total{result}` is how you tell whether it
  works.** `queued / (queued + fresh)` answers "how often does an open actually
  spend a call"; all-`fresh` means the gate is holding on a warm archive, and
  all-`queued` on a live window would mean it is not. `no_keywords` counts arcs
  with neither a label nor a profile.
- **The wire contract is unchanged.** No storyline shape gained a field: the
  keywords are derived server-side from the row the click names, so
  `StorylineRef`, `SurfacedStoryline` and `TrendingStoryline` are all as they
  were.
- **Only a CLICK queues anything.** A shared link, a bookmark, a reload or
  browser back/forward into `?storyline=<uuid>` renders the view and asks for
  nothing, because the trigger is `App.openStoryline` and none of those reach it.
  Named as a limit rather than defended: the most common way to re-open an arc is
  arguably not a click, and refreshing on the VIEW would serve this ADR's own
  premise better. It is a different trigger model, though — every reload would
  ask, and what makes that safe is the same freshness gate — so it is a decision
  to take on its own evidence rather than fold in here.
- **An arc whose own language upstream will not accept as a filter is refreshed
  in the configured default**, not refused. `articles.language` and
  `/available/languages` are not the same vocabulary — the reference table holds
  `{"Malay": "msa"}` against ISO-639-1 everywhere else (PROBE-FINDINGS 6) — and a
  400 there would be silent by construction and permanent for that arc.

## Amended: the top-up defers to the deepening plane, when told to

2026-09-23, behind `STORYLINE_REFRESH_DEFERS_TO_DEEPENING` (off by default).

When this ADR was written, a click had one plan. G5 gave it a second: the
deepening fetch of the arc itself, from Google News, against `storyline_coverage`
(ADR-0019). From then on, every open with a deepening provider configured bought
**both**. There was this ADR's Currents top-up of the topic the arc's two grounded
words name, and the deepening fetch of the arc. Both refresh one arc, and only the
first draws on the Currents budget readers' searches need. The background half of
that budget is what a reader's deferred pages were refused on (trace `4e3a28c2…`,
2026-09-24, and ADR-0030).

With the flag on, the route plans the deepening fetch **first**. The Currents
top-up is then skipped when the deepening plane answered `queued` (a fetch for
this arc is on the queue) or `fresh` (its own coverage of the arc is inside the
staleness tier). The refresh reports `deferred`.

Five things are deliberate:

- **Only for an arc the deepening plane has actually served.** `queued` is a
  plan, not a result, and two ways it goes unkept are common:
  - a busy arc comes back capped on every call (100 items of a seven-day span
    records no coverage, so every click plans the same fetch and reads `queued`
    again);
  - Google News' day can be spent after the plan is made.

  Deferring on the plan alone would take the Currents refresh away from the arcs
  with the most news. So `processDeepenJob` sets a **served** mark when its fetch
  walks the arc to a clean end (24 h), and clears it when a later fetch caps or
  fails. The route defers only while the mark stands, checking it with the
  resolved id, which is the survivor the consumer writes it against.
  - A busy arc never holds a mark, so its Currents refresh always runs.
  - The first open of any arc runs it too.
  - A Redis error reads as "not served", which spends the Currents call: the
    behaviour before the flag.

  An earlier draft used the opposite design, a one-hour mark of failure. Review
  showed it protected only clicks inside the hour after a capped result.
- **`ungrounded` and `unavailable` never defer.** An arc whose label the deepening
  plane will not trust is exactly the arc this refresh's profile-word fallback
  exists for. With no provider configured, the route behaves as it always did.
- **The topic is still minted and its hit still counted.** The topic row is what
  claims the articles earlier refreshes fetched against retention's idle cutoff
  (§7.5, and the first consequence above). A deferral that skipped it would let an
  arc shed its Currents history one idle window later, and nothing would report the
  loss.
- **The refresh now reports under its own key**, `refresh: { status, queued }`,
  beside `deepening` and `summaries`. The top-level `queued` stays for existing
  readers. It could not carry `deferred`, which a traced open (ADR-0029) needs to
  tell from `fresh`.
- **What is given up** is this refresh's Currents articles for an arc Google News
  is refreshing. They have real URLs and descriptions, which Google News rows
  never do, and they write `topic_coverage` for the arc's two words. A reader who
  later searches those words finds the topic colder than it would have been, and
  fetches for themselves. That is the truth, and a cost in the same currency the
  flag saves.

`refresh: deferred` in the storyline-open log line is the saving, counted: its
share of opens is the Currents calls not spent.
