---
status: accepted (behind SEARCH_FALLBACK_ENABLED, off by default; see "Before turning it on")
---

# A refused search asks Google News for its leading edge

A reader's keyword search is planned against Currents and nothing else, and until
now it was only ever *answered* by Currents. When Currents' daily budget ran down
to the interactive reserve, a search got its first page synchronously and every
deferred page was refused in the background. The reader was served what the
archive already held, and nothing else was coming.

That is exactly what production recorded on 2026-09-24 (ADR-0029 trace
`4e3a28c2…`). The environment was `googleNews: live`, and the search made one
Currents call (interactive, 496 ms, ok). It queued five segment jobs, and the
Currents quota governor refused all five with `failure: quota`. A second provider
was configured, healthy and unspent, and nothing asked it.

This ADR adds one thing: **a SEARCH that Currents refuses on quota is asked again
of Google News, for the part of it no older than six days.**

## Why it had never happened: an unfinished plan, not a bug

[ADR-0019](0019-a-fetch-carries-its-own-reason-and-its-own-coverage.md) (#171)
says Google News "is intended to serve search and breadth as well as deepening".
The plan's header repeats it, but none of G0–G8 in
[DISCOVERY-DEEPENING-PLAN](../DISCOVERY-DEEPENING-PLAN.md) ever planned it:
- G5 wired the deepening plane only.
- #196 made coverage reads and writes per-provider, then pinned
  `PLANNED_COVERAGE_PROVIDER = "currents"` on purpose. It called a second planned
  provider "a quota decision that wants measuring before it is made".
- G7 is the deepening *scheduler*, not search.

So "search uses Google News" was intended, and nothing ever scheduled it.

This ADR takes the smaller half deliberately: a **fallback**, not a second
discovery provider.

## What it is

Two triggers, both in `coverage-fill.ts`, both on a **quota** refusal and nothing
else, and both on the **search** plane only:

1. **The read's own synchronous fill is refused.** The refused gap, every gap the
   loop will now never reach, and every gap it had already deferred get a
   fallback. A degraded read enqueues none of its deferred Currents jobs, so
   without this nothing would ask for them today.
2. **A deferred segment job is refused below the interactive reserve.** This is
   the trace's case. The refused slice and every older slice of that job get a
   fallback, and the Currents error is rethrown unchanged, so the Currents job's
   own redelivery is untouched.

The fallback job (`kind: "fallback"`, `search-fallback.ts`) is a topic-subject
fetch:
- It counts under the topic's pending registry, so the reader's poll waits for it.
- It is asked with the topic's own keywords, language and country (an edition on
  this provider, not a filter), at background priority.
- It is folded in as a `search`-plane sighting and grouped and linked like any
  search's articles.

**What it is not:**
- It never writes a Currents coverage row. The next section explains why that is
  the property the design rests on.
- It changes nothing about which gaps a read plans.
- It is not the composite. The composite shares one paging plan across providers
  and lets the primary's failure propagate, and here the primary's failure is the
  trigger.

## Why a refused span stays a Currents gap

Coverage is per provider (ADR-0019). `topic_coverage` rows are keyed
`(topic, provider, span)`, and each row says only that *this* provider walked
*this* span. The planner that decides what to ask Currents reads only the
`currents` rows (`PLANNED_COVERAGE_PROVIDER`), and a span with no Currents row is
a gap, whatever any other provider holds for it.

The fallback writes only `google-news` rows. Suppose Currents refused a span this
morning and Google News then answered for it:
- the span has a `google-news` row and still no `currents` row;
- the next search of those words, today, is served whatever the archive holds and
  plans Currents again for that span (and, if refused again, the fallback skips
  it, because Google News already covered it);
- on the first day with Currents budget, that search's fill asks Currents for the
  span, gets its answer, and only then records the `currents` row.

So the fallback fills the reader's timeline today without claiming anything about
Currents. The alternative is the failure this codebase ranks worst. Had the
fallback written a Currents row, or had the planner counted Google News rows as
Currents', the span would read as covered and Currents would never be asked for
it. Every article only Currents carries for that span (real URLs, descriptions,
outlets Google News does not index) would be missing for good, with no error, no
metric and no retry, because coverage would say the work was done (ADR-0001).
Keeping the refused span a Currents gap costs, at most, the Currents calls it
would have cost anyway, spent on a later day.

## Its own coverage, and why there is no frontier

The fallback subtracts **Google News' own** `topic_coverage` rows, so a span it has
already walked is not bought again by the next refused poll. It records a row only
when a call comes back under the 100-item cap.

A capped answer is **halved**. It is never recorded as a frontier the way
`onTruncated` does for Currents. That frontier marks [oldest seen, end) as covered
on the strength of upstream answering newest-first. Currents does (PROBE-FINDINGS
§1). Google News does not: the recorded live capture
`fixtures/google-news-search-capped.xml` has 2,564 of its 4,950 item pairs out of
date order, which is no order at all. A frontier over that would claim as fetched
days whose newest items were never returned: the silent over-coverage ADR-0001
treats as the worst failure available.

Halving stops at **three days** (`SEARCH_FALLBACK_MIN_SPAN_MS`), not at the
Currents fill's one hour. Google News cannot be asked for less than a day: the
bounds are bare dates, each padded a day outward, so a span of L days reaches the
wire as roughly L+2 to L+3. Review measured a busy six-day fallback against the
real query builder:

| Floor | Calls | Distinct wire queries |
| --- | --- | --- |
| 1 hour | 511 | 18 |
| 1 day | 15 | 13 |
| 3 days | 3 | 3 |

Three days is a **trade, not the provider's limit**. A one-day floor would ask a
little deeper and pay repeated calls for it. At three days the whole tree is one
halving and every call is a different question.

A capped span at the floor is then accepted, which is the Currents fill's own
floor rule. Its row means "asked, capped, and not split further", not "walked".
It lives in Google News' rows only, whose sole reader is this plane.

## Why six days

The pubDate cliff (plan §G6): past about eight days, Google News sends a bare date
at midnight US Pacific instead of a time.
- 1.7% of items inside eight days are degraded, against 89.4% beyond it.
- The adapter pads `after:` a day outward, so a far edge D days back puts D+1 on
  the wire. Day 8 already reads 3.9% degraded.
- So 7 is the ceiling and 6 is the number with margin, which is G6's gating item 3.

The fold was already safe past the cliff: ADR-0021 refuses a bare date the display
fields and ADR-0022 widens its lookup. The clip protects the rows the fallback
*mints*, so they order within their day and fall in the right part of the reader's
day.

The cost is history. A reader asking about last month gets only the last six days
from this provider.

The planner snaps both edges onto the 15-minute window grid, so a quarter-hour of
refused polls is one message and the next quarter-hour's is another. The consumer
re-clips against the clock at delivery.

## Why the planner holds each address

A segment's re-planning stops once its coverage is recorded. This plan's re-planning
does not, because the Currents gap stays open until a day with budget. So every
poll of a degraded read plans the fallback again. A republish inside the queue's
900-second dedup window is swallowed but still re-adds its pending entry. A pending
entry for a message nothing will deliver holds the reader at `in_progress` for the
full `STALE_PENDING_MS`: the lesson PR #235 paid for, in a new place.

The planner therefore:
- skips a span Google News has already covered;
- publishes each address at most once per dedup window (`SET NX` for 900 s,
  pinned equal to `INGEST_RETENTION_SECONDS`).

Both guards fail open.

## Budgets

Every fallback call takes two counters before it spends:
- **`SEARCH_FALLBACK_DAILY_CALL_LIMIT`** (default 50), this plane's share of
  Google News' day. It is taken first, so a refusal here charges nothing else.
- **The topic's §9.4 daily cap, on Google News' own counter.** It is not charged
  to the Currents one: a background refusal below the interactive reserve says
  nothing about the interactive budget above it. A fallback that spent the topic's
  Currents allowance could turn the reader's next, answerable read into `capped`.

A Google News quota refusal is dropped rather than retried. A spent day does not
recover inside the redelivery budget, and each redelivery would take both counters
again for a call that cannot be made.

Google News' 200 calls a day is a number we invented (no key, no published
ceiling, no headers). The governor holds 50 back for interactive use from both
background planes alike, so 150 is what deepening and this plane share. The share
keeps at least 100 for the deepening plane, so a burst of refused searches cannot
starve every storyline open of its deepening fetch.

## The accepted costs

These are why the flag ships off:

- **Its articles feed the cloud.** They are `search`-plane, which is ADR-0019's
  rule for a reader's demand: unsteered, so counted. One Google News answer spans
  20–82 domains, so any arc it touches clears the ranker's two-domain floor
  (`MIN_SOURCE_DOMAINS`) at once. A refused search is therefore a much stronger
  lever on the landing cloud than a Currents search of the same words.
- **They form storylines, which means labels.** A search has no arc for G5's
  `attachTo` to name, so the linker decides. That is correct for a search, but up
  to 100 items per call arrive against Currents' 20, and every promotion is a label
  request on the Gemma RPM ceiling. The per-topic cap and the plane's share bound
  it; they do not remove it.
- **Every article it mints links through Google.** The URL is a
  `news.google.com/rss/articles/CBMi…` redirect, the description is null, and
  3.9% of titles still carry outlet chrome into `story_tokens` (plan §G5). ADR-0021
  keeps it from rewriting articles Currents already holds; it does not make its
  own rows better.
- **The terms.** The feed's own `<copyright>` names it for "a personal feed reader
  for personal, non-commercial use" and says "any other use… expressly
  prohibited". The deepening plane already accepted that risk on a click. This
  widens it to any refused search.

## Before turning it on

Turning it on is a measurement, not a switch. It needs the pre-registered shape G6
used:
- how many fallback calls a refused day spends;
- how many articles they mint that Currents never had;
- how many storylines they form and labels they request;
- whether the board moves on a window where the fallback fired.

`logUpstreamFetch` and `logIngestOutcome` already write the plane, provider and
created counts on every call.

## Also in this change: the other half of the budget

The same trace's refusals came from the background budget, and one of that
budget's spenders is ADR-0017's storyline refresh. It is a Currents top-up bought
on every open, beside the deepening fetch that refreshes the same arc from Google
News. `STORYLINE_REFRESH_DEFERS_TO_DEEPENING` (ADR-0017, amended) stops the
Currents half when the deepening plane has the arc in hand, meaning it planned
the arc on this click and its last fetch walked the arc to a clean end. That is the cheaper
fix, and it forfeits no guarantee this ADR has to argue for, so it ships beside
this rather than inside it.
