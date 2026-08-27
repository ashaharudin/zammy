---
status: accepted
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
  tokens instead. One rule and not two, so the topic a click mints is the topic
  the cloud's own placeholder proposes for the same arc — same fingerprint,
  same accumulating topic (§6.2).
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
- **A cold or gappy topic** queues the newest gap and nothing else — §9.4's
  "backfill is never automatic on first search" applied to a click. An arc with
  30 days of missing history is worth one 7-day slice of freshness, not five
  calls nobody asked for. Deeper history is still what typing the words is for.

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
