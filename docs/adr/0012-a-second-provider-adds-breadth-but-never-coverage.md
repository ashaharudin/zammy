---
status: accepted
---

# A second provider adds breadth, but never coverage

GNews joins Currents behind one client interface. Every search and breadth
sample fans out to both and the results merge. The two providers are
deliberately **not** equals: Currents alone decides when a window is finished,
and GNews contributes articles without ever contributing an end-of-results
signal.

That asymmetry is the whole decision. Everything else — the package split, the
per-adapter error mapping, the narrowed limits — follows from wanting a second
source of articles without weakening what `topic_coverage` means.

## Why symmetry breaks the archive

`topic_coverage` records the spans we have actually fetched. It is what
separates "nothing was published then" from "we never asked" (ADR-0001), and it
is the reason a topic's history can be trusted past the 30-day upstream
lookback. The planner writes a coverage row when a fill reports
`isLastPage` (ARCHITECTURE 6.3).

So consider the obvious design — combine both providers' end-of-results signals
— on the Free tiers we actually run:

Currents has 1000 calls a day. GNews has 100. A moderately dense topic will
exhaust the GNews budget an order of magnitude sooner. Now a window is being
filled, GNews runs dry at page three, Currents walks to the end and reports the
window finished. A combined signal records coverage over the whole span.

Nothing is wrong at that moment. The damage is later: coverage says the span is
done, so no reader and no backfill will ever ask about it again. GNews never
looked at two thirds of it. There is no error, no metric, no retry — the gap is
permanent and invisible, and it is invisible *specifically because* the system
believes it did the work. That is the failure mode this codebase treats as the
worst available (ARCHITECTURE 11), and the one ADR-0001 exists to prevent.

The alternative failure — GNews sitting out entirely — costs some articles we
could have had. That is recoverable: the budget resets at midnight, the next
reader tries again, and the article is still there if the story is still in
either provider's window.

Between a recoverable loss of breadth and an unrecoverable loss of coverage,
this takes the recoverable one.

## What that means concretely

**Currents is coverage-bearing.** `isLastPage` is its answer alone. Its failures
propagate untouched, exactly as before GNews existed, because a cold topic has
nothing to fall back on and that failure is the caller's to render.

**GNews is best-effort breadth.** Its articles merge in when they arrive. When
it errors, runs out of budget, or refuses a query it cannot express, the call
still succeeds with whatever Currents returned. It can never end a walk and
never manufacture coverage.

**A degraded supplement is loud, not silent.** Every sit-out lands in the
response's `adjustments`, in a warn log naming the provider and the reason, and
in `/readyz.upstream.providers`. Swallowing the error is a deliberate choice
about *control flow*, not about visibility — a misconfigured key would otherwise
look like a provider that simply never finds anything.

**Sightings are not deduplicated across providers.** Two providers reporting one
URL is two genuine observations of one article — the same relationship one
provider re-emitting a story creates — and the storage fold already collapses
both on `dedupKey` (ADR-0002). Collapsing them in the client would discard a
sighting the archive is entitled to, and would make per-provider yield
unmeasurable.

## The accepted cost

GNews coverage is opportunistic. A GNews-only article published inside a span
Currents has already covered may never be fetched, because nothing will ask
about that span again.

This is a real hole and it is stated rather than hidden. The fix is per-provider
coverage — `topic_coverage` gaining a provider column, so each provider's spans
are tracked and repaired independently. That is a schema change and a planner
change, and it buys nothing until a supplement is contributing enough to be
worth backfilling. Deferred, not forgotten.

## Two consequences that will surprise someone

**Enabling a provider can make the others spend more.** Every provider is asked
the same `pageNumber` and `pageSize`, so the composite intersects their limits.
GNews Free pages at 10 where Currents pages at 20, so switching GNews on halves
the shared page size and doubles the calls Currents needs for the same window.

The alternative was letting each provider clamp its own page size, which reads
fine and is wrong: at a requested page size of 20, page 2 is items 21–40 for
Currents and items 11–20 for a provider that clamped to 10. That provider
re-reads what it already sent and never reaches its own tail — under-coverage
again, and again invisible. The narrowed limit is visible in the quota numbers,
which is the whole difference.

**A provider that cannot express a query refuses it locally.** GNews `/search`
has no category filter and no domain filter. Answering a category-scoped topic
anyway would silently drop the filter and fill that topic with articles that do
not belong to it — the topic's own definition violated by its contents. So the
adapter refuses before spending a call, and the composite treats the refusal as
a sit-out.

## What did not change

Nothing in ARCHITECTURE §6–§8. The Query Service still plans in `SearchParams`,
still receives `Sighting[]`, still never learns which upstream answered. §5.6
predicted a new provider would cost "a new client satisfying the same interface
plus a `provider` column on `articles`", and that is what it cost — plus the
composite, which is the part §5.6 did not anticipate needing, and which exists
entirely to hold the line above.

With `GNEWS_ENABLED=false`, the default, the factory returns the Currents client
bare: no fan-out, no wrapper, no behavioural change of any kind.
