---
status: accepted
---

# A reader does not choose a category

`category` stops being a filter a reader can set. The chip leaves the command
bar, the API stops accepting the parameter, and `/api/v1/reference` stops
serving the taxonomy.

Nothing is deleted. `topics.category` keeps its column, the 29 topics already
scoped by one keep their rows, and `fingerprintOf` keeps serializing the field.
This removes a **choice**, not a schema.

## Why the choice cannot survive two planes

[ADR-0019](0019-a-fetch-carries-its-own-reason-and-its-own-coverage.md) makes a
fetch's *reason* the thing that matters and stops privileging a provider, which
means the deepening plane and the discovery plane both answer real queries.
Google News is intended to serve search and breadth as well as deepening — and
it cannot express a category at all.

That would be tolerable if it merely refused. It does not. Measured live
2026-08-27:

- `topic/BUSINESS?q=housing` returns a set **byte-identical** to plain
  `search?q=housing` — 102 of 102 identical guids. The category feeds exist and
  cannot carry a keyword, so asking for both **silently discards the category**.
- `search?q=…&topic=…` ignores the parameter outright.
- A bogus topic answers **HTTP 200 with zero items and no error**.

A filter that appears to have been applied and was not is worse than one that
was never offered. So the adapter refuses a category locally
(`unservableReason`, following `gnews-client`'s precedent) — but a refusal only
relocates the problem: a category-scoped topic is then a topic one of the two
planes can never honestly answer, and every one of them either sits half-fed or
gets fed off-topic articles.

The remaining question was whether the filter is worth that. Production,
2026-08-27:

```
topics                                          341
  country-scoped                                114
  category-scoped                                29   (technology 14, sports 5, then singletons)
article memberships in category-scoped topics   393
```

**Country carries four times the demand and is served** — as an edition bias
(`gl` + `ceid`) rather than a hard filter, which is weaker than the promise
Currents' `country` makes but is a real, measured lever: the same query across
CA / US / GB / IN editions shared only 30–50% of titles. Category is 29 topics
and is the one filter that would silently lie. The trade is cheap.

## The fingerprint does not change, and that is the load-bearing decision

`canonicalize` folds the filters into
`fingerprintOf({keywords, language, country, category})`. It is tempting to drop
`category` from that serialization now that nothing produces a non-null one.

**It would orphan the 29 topics.** Their accumulated coverage and 393 article
memberships would sit under a fingerprint no code path ever computes again —
invisible to every read, unreachable by every planner, and still holding rows in
a database with limited headroom. There is no reader-visible gain to buy with
that, because the reader's *choice* is what this ADR removes and the choice is
already gone once the chip and the parameter are.

So `category` stays in the identity, permanently, producing `null` for
everything minted from here on. `CanonicalQuery.category` stays for the same
reason: `processSegmentJob` rebuilds a query from a stored topic row, so a
segment queued against one of those 29 still fetches the thing the topic says it
is. Widening it to an unfiltered search would ingest off-topic articles under a
category-scoped fingerprint — the exact failure the adapter's refusal exists to
prevent, arriving through the back door.

The 29 topics are therefore **untouched**: not migrated, not deleted, not
re-identified. They stop accumulating when nobody searches them, and retention
(§7.5) reaches them on its own schedule like any other idle topic.

## A bookmarked `?category=` must return results, not an error

This is the failure mode the obvious implementation walks into. `canonicalize`
validated the category against the reference set and a miss became
`{ok: false}`, which the search route answers as **400 invalid query**. Simply
ceasing to populate `reference.categories` would therefore make every
`?category=technology` link a reader ever saved or shared start erroring — a
harder failure than the filter being removed.

The required behaviour is that such a URL **degrades to the same search without
the category**. Both sides do it, independently:

- **The API.** `TimelineQuery` no longer names `category` and is not
  `.strict()`, so Zod strips the unrecognised parameter. The request is answered
  as the plain search — same topic, same fingerprint, same accumulating
  coverage — and nothing is stored under a filter the reader can no longer see
  or clear.
- **The web.** `PARAM_KEYS` no longer names it, so `parseRoute` does not read it
  and `routeSearch` does not write it back. The first navigation drops it from
  the URL.

**One qualification on the web half, because "same fingerprint" is an
API-surface claim and the browser adds a step after it.** `defaultedFilters`
suppresses the browser's country default whenever the URL states any filter, and
`category` counted as one until this decision. So a link carrying *only* a
category — `?q=housing&category=technology`, no `lang`, no `country` — used to
suppress that default and now takes it, landing on `?q=housing&lang=en&country=CA`.

Measured against the right baseline this is still exact: that link and a plain
`?q=housing` now resolve to the identical topic, which is what "degrades to the
same search" has to mean. Measured against what the link did *before*, the reader
gains a country filter they never set. Narrow — every URL the app itself writes
carries `lang`, so only a hand-edited or pre-`lang` link reaches it — and
defensible, since a stale link should behave like the plain search in every
respect including defaulting. But it is a real change and the gate that produces
it is now invisible, so it is pinned in `browserDefaults.test.ts`.

**Both, not either.** Had only the web stripped it, a direct API consumer would
have broken silently while the app looked fine — the app is not the only caller,
and a shared link is exactly the thing that arrives from outside it. Neither
side relies on the other having cleaned up, and both halves are pinned by tests.

## The taxonomy keeps its plumbing and loses its offer

`/api/v1/reference` stops serving `categories`, and `fetchReference` stops
asking for them — two upstream calls on a cold cache rather than three.

`availableCategories()` stays on the `NewsClient` interface, and the Currents
adapter still parses the taxonomy out of a recorded 400 body. Removing that is a
much larger change than removing the chip, it is explicitly out of this phase,
and §10.1's breadth sample still sends categories upstream — what changed is
that no *reader* picks one.

What the offer costs, kept, is the next person: a list of pickable-looking
values on the wire is an invitation to build the control back, and the control
is what this ADR removes. So the plumbing stays and the offer goes.

`cachedReference` still counts a hit on two keys where an instance deployed
before this decision left three, so a deploy does not turn every warm cache into
a refetch. The orphan `ref:categories` expires on its own 24h TTL.

## The accepted costs

**A tab open across the deploy loses its chip options.** An already-loaded
bundle parses `/api/v1/reference` with a schema that still requires
`categories`, so its next reference fetch fails to parse and `reference.data`
goes undefined. Nothing errors — the location chip simply renders with no
options and the browser default does not apply — and it self-heals on reload.
Transient, one deploy wide, and the price of taking the offer off the wire.

**No `PAGE_SHAPE_VERSION` bump, deliberately.** `TopicSummary` has never carried
a category, so the timeline page shape is unchanged; the version keys the page
cache, and bumping it would invalidate every cached page for a change that does
not affect one. The reference payload is not page-cached — it lives under its
own per-field `ref:*` keys, where removing a key from the read set cannot serve
a stale composite to a new client.

**The 29 topics are now unreachable by a reader**, and that is the point rather
than a regret: a reader who lands on one of their old URLs gets the same search
without the filter, which is a topic that both planes can honestly answer.

## What this does not do

Drop the `topics.category` column. Delete the 29 topics. Change how Currents
maps category on the wire. Touch the breadth sample's category list. Each is a
schema or an ingest decision; this one is about what a reader is offered.
