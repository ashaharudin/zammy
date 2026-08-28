---
status: superseded by ADR-0019 (the provider ranking; every failure it prevents is still prevented, by the fetch's own reason and its own coverage rows rather than by privileging one provider)
---

# A second provider adds breadth, but never coverage

GNews joins Currents behind one client interface. Every search and breadth
sample fans out to both and the results merge. The two providers are
deliberately **not** equals: Currents alone decides when a window is finished,
and GNews contributes articles without ever contributing an end-of-results
signal. That asymmetry is the whole decision; the package split, the
per-adapter error mapping and the narrowed limits all follow from wanting a
second source of articles without weakening what `topic_coverage` means.

## Why symmetry breaks the archive

`topic_coverage` records the spans actually fetched — what separates "nothing
was published then" from "we never asked" (ADR-0001) — and the planner writes a
coverage row when a fill reports `isLastPage` (ARCHITECTURE 6.3).

Consider the obvious design — combine both providers' end-of-results signals —
on the Free tiers we run: Currents has 1000 calls a day, GNews 100. A
moderately dense topic exhausts the GNews budget an order of magnitude sooner.
A window is being filled, GNews runs dry at page three, Currents walks to the
end, and a combined signal records coverage over the whole span. The damage is
later: coverage says the span is done, so no reader and no backfill will ever
ask about it again, yet GNews never looked at two thirds of it. No error, no
metric, no retry — the gap is permanent and invisible *specifically because*
the system believes it did the work. That is the failure mode this codebase
treats as the worst available (ARCHITECTURE 11), and the one ADR-0001 exists to
prevent.

The alternative failure — GNews sitting out entirely — costs some articles, and
is recoverable: the budget resets at midnight, the next reader tries again.
Between a recoverable loss of breadth and an unrecoverable loss of coverage,
this takes the recoverable one.

## What that means concretely

**Currents is coverage-bearing.** `isLastPage` is its answer alone. Its
failures propagate untouched, exactly as before GNews existed — a cold topic
has nothing to fall back on and that failure is the caller's to render.

**GNews is best-effort breadth.** Its articles merge in when they arrive. When
it errors, runs out of budget, or refuses a query it cannot express, the call
still succeeds with whatever Currents returned. It can never end a walk and
never manufacture coverage.

**A degraded supplement is loud, not silent.** Every sit-out lands in the
response's `adjustments`, in a warn log naming the provider and reason, and in
`/readyz.upstream.providers`. Swallowing the error is a choice about *control
flow*, not visibility — a misconfigured key would otherwise look like a
provider that simply never finds anything.

**Sightings are not deduplicated across providers.** Two providers reporting
one URL is two genuine observations of one article, and the storage fold
already collapses both on `dedupKey` (ADR-0002). Collapsing in the client would
discard a sighting the archive is entitled to and make per-provider yield
unmeasurable.

## The accepted cost

GNews coverage is opportunistic: a GNews-only article published inside a span
Currents has already covered may never be fetched, because nothing will ask
about that span again. The fix is per-provider coverage — `topic_coverage`
gaining a provider column so each provider's spans are tracked and repaired
independently. That is a schema and planner change, and it buys nothing until a
supplement contributes enough to be worth backfilling. Deferred, not forgotten.

## Two consequences that will surprise someone

**Enabling a provider can make the others spend more.** Every provider is asked
the same `pageNumber` and `pageSize`, so the composite intersects their limits.
GNews Free pages at 10 where Currents pages at 20, so switching GNews on halves
the shared page size and doubles Currents' calls for the same window. The
alternative — each provider clamping its own page size — reads fine and is
wrong: at a requested size of 20, page 2 is items 21–40 for Currents and items
11–20 for a provider that clamped to 10, which re-reads what it already sent
and never reaches its own tail — under-coverage again, and again invisible. The
narrowed limit is visible in the quota numbers, which is the whole difference.

**A provider that cannot express a query refuses it locally.** GNews `/search`
has no category or domain filter. Answering a category-scoped topic anyway
would silently drop the filter and fill the topic with articles that do not
belong to it. The adapter refuses before spending a call, and the composite
treats the refusal as a sit-out.

## What did not change

Nothing in ARCHITECTURE §6–§8. The Query Service still plans in `SearchParams`,
still receives `Sighting[]`, still never learns which upstream answered. §5.6
predicted a new provider would cost "a new client satisfying the same interface
plus a `provider` column on `articles`", and that is what it cost — plus the
composite, which §5.6 did not anticipate and which exists entirely to hold the
line above.

With `GNEWS_ENABLED=false`, the default, the factory returns the Currents
client bare: no fan-out, no wrapper, no behavioural change of any kind.
