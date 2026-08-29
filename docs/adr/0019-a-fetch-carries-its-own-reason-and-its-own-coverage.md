---
status: accepted (amended by ADR-0021: this ADR's accepted costs name one hazard for `plane` — a column that can be set wrong — and plan §G6 found a second that needs no mislabelling at all. `plane` gates which rows a ranking COUNTS; it cannot gate what a counted row SAYS, so an absorbed sighting was rewriting the timestamps of articles the cloud does count. ADR-0021 closes the timestamp half; the group-re-parenting half is open and recorded in §G6)
---

# A fetch carries its own reason, and its own coverage

[ADR-0012](0012-a-second-provider-adds-breadth-but-never-coverage.md) ranked
*providers*: one was coverage-bearing and any other was best-effort breadth that
could never end a walk or claim a span. This replaces that with two independent
properties of a **fetch**:

- **Its subject and provider bear its coverage.** `(subject, provider, span)`,
  so no provider is privileged and none can claim what another fetched.
- **Its reason decides what it may feed.** A fetch is `search`, `breadth` or
  `deepening`, and only the first two may feed the ranking that chooses what to
  deepen.

ADR-0012's asymmetry is not softened here, it is *relocated*. Every failure it
prevented is still prevented; the mechanism moves from "which provider answered"
to "what was asked, and why".

## Why the provider ranking has to go

ADR-0012 was right for the situation it described: two providers answering the
same question, one of them cheap enough to trust with the archive's honesty. It
made "is this Currents?" stand for two different questions at once, because with
one coverage-bearing provider the answers always agreed:

1. May this fetch's completion be recorded as *we asked*?
2. May this article feed the cloud that decides what to fetch next?

Google News is intended to serve **search and breadth as well as deepening**. The
moment one provider answers both a reader's keywords and a cloud-driven fetch,
those two questions come apart and no provider-level test can be right about
both:

- Its **search** and **breadth** articles must count toward the cloud, or the
  cloud is ranking a fraction of the corpus and calling it the world.
- Its **deepening** articles must not, or the cloud's volume score becomes
  endogenous — an arc that reaches the board once is fetched, gains articles,
  ranks higher, is fetched more, with nothing damping it.

Both are true of the same provider on the same day. `provider` is therefore no
longer a proxy for anything, and the honest column is the one that says why the
call was made.

## What a fetch's reason is, and where it lives

`sightings` gains a `plane`: `search` | `breadth` | `deepening`, set by the
caller that planned the fetch and never inferred from the provider.

**`search`** — a reader typed keywords. **`breadth`** — the periodic sample
(ARCHITECTURE 10.1). **`deepening`** — the cloud, or a storyline refresh, pointed
at an arc we already hold.

The distinction that matters is not "interactive vs background", and it is not
"which provider". It is **whether our own ranking chose the target**. A reader's
search and a breadth sample are demand we did not manufacture. A deepening fetch
is our own output fed back in.

So the rule
[the design doc](../DESIGN-DISCOVERY-AND-DEEPENING.md) states — *the plane that
measures is the plane that is not steered* — becomes a predicate on the sighting:

```sql
-- what may feed the ranking
exists (select 1 from sightings s
         where s.article_id = a.id and s.plane <> 'deepening')
```

`ADR-0017`'s storyline refresh is a genuine boundary case and it resolves
cleanly: it is triggered by a *reader's click*, but the target is an arc **our
cloud named**, so it is `deepening`. The test is the target, not the trigger.

This supersedes the provider-list form the ranker shipped with, which read
`provider = any('{currents,gnews}')`. That list was correct while every provider
was unsteered — and it says so — but it cannot survive one provider doing both
jobs.

## What coverage becomes

`topic_coverage` gains `provider`, and `storyline_coverage` arrives beside it —
the change ADR-0012 named and deferred: "`topic_coverage` gaining a provider
column so each provider's spans are tracked and repaired independently."

With that in place ADR-0012's core argument **dissolves rather than being
overruled**. Its fear was a combined end-of-results signal recording coverage
over days one provider never looked at. Per-provider rows cannot express that
claim: each provider records only the spans it actually walked, so the gap
planner asks each provider about its own gaps and a provider that ran out of
budget simply still has a gap.

Two consequences follow, and the second is the one that will surprise someone.

**Coverage is per-provider, so "is this span covered" has no single answer, and
must stop being asked that way.** For *fetching*, each provider is asked about
its own gaps. For *reading*, the timeline shows what the archive holds and never
consults coverage to decide what to display. Any code wanting one boolean for a
span is asking a question that no longer has a truth value.

**Providers stop sharing a plan.** ADR-0012's fan-out sent identical
`pageNumber` and `pageSize` to every provider and intersected their limits, which
is where its "enabling a provider can make the others spend more" came from —
GNews Free paging at 10 halved Currents' 20 and doubled its calls. That
arrangement is not merely wasteful now, it is **unimplementable**: Google News
has no offset parameter at all. There is no page 2 to ask it for; 100 items per
query is the whole of it, and depth comes from subdividing the window.

So each provider is planned against its own limits and its own coverage rows —
Currents in 7-day slices paged 20 at a time, Google News in slices narrow enough
that 100 items reaches the end. They no longer have to move together, and the
shared-page-size trap goes with the shared plan.

## What survives from ADR-0012, unchanged

**Sightings are still not deduplicated across providers.** Two providers
reporting one story is two genuine observations, and the storage fold collapses
them on identity (ADR-0002, and now ADR-0018's fallback key). Collapsing in the
client would discard a sighting the archive is entitled to and make per-provider
yield unmeasurable — which is the number that decides whether a provider is
worth its budget.

**A provider that cannot express a query still refuses it locally**, and the
Google News category trap makes the rule sharper than ADR-0012 could state it.
GNews simply has no category filter, so there was nothing to get wrong. Google
News *has* category feeds, and asking for a category and a keyword together
**silently discards the category**: `topic/BUSINESS?q=housing` returns a set
byte-identical to plain `search?q=housing`, 102 of 102 identical ids, and a
bogus topic answers 200 with zero items and no error. A filter that appears to
have been applied and was not is worse than one that was never offered, so the
refusal is not a courtesy — it is the only way to keep the topic honest.

**A degraded provider is loud, not silent.** Every sit-out still lands in the
response's `adjustments`, in a warn log naming the provider and reason, and in
`/readyz`. Swallowing an error is a choice about control flow, never about
visibility.

## The accepted costs

**More calls.** Per-provider gaps mean two providers can each hold an open gap
over the same span, and both will be asked. ADR-0012 bought its call savings by
letting one provider's coverage stand for the other's, which is precisely the
dishonesty it was written to prevent — it simply paid for it in breadth instead.
This pays in calls, which is the recoverable currency.

**A column that can be set wrong.** `plane` is supplied by the caller, so a
planner that mislabels a deepening fetch as `search` reopens the feedback loop
with nothing raising. That is a real hazard and it is the price of the honest
model: no derivable value carries this information, because the same provider
and the same parameters can arrive for either reason. The mitigation is that
`plane` is set in the few places that *plan* fetches, not in the many that
perform them.

**`plane` is not `provider`, and both are needed.** They answer different
questions — who answered, and why we asked — and a schema carrying only one of
them cannot express this decision. Anyone tempted to derive one from the other
should read the second section again.

## What did not change

Nothing in ARCHITECTURE §6–§8. The Query Service still plans in `SearchParams`,
still receives `Sighting[]`, and still never learns which upstream answered — it
now states which plane it is planning for, which it knows because it is the thing
doing the planning.
