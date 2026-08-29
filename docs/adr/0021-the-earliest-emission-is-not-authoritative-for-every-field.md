---
status: accepted
---

# The earliest emission is not authoritative for every field

[ADR-0002](0002-articles-are-deduplicated-stories-sightings-are-emissions.md)
made the earliest emission authoritative:

> **An article is positioned in the timeline by its earliest sighting**

ARCHITECTURE §7.4 is where that became a rule about every column at once —
"Display fields come from the earliest sighting, so a later re-emission does not
rewrite the headline" — with only the two identity keys exempt.

That was right while every provider sent an outlet's own URL, its own clock and
its own copy. Google News sends none of the three. So the rule gains two
exceptions, each carried on the **sighting** and set by the adapter that knows:

- **`isAggregatorCopy`** — this sighting is an aggregator's rendering of somebody
  else's article. It hands over no display field at all, keeping only the
  timestamp fold and `provider`.
- **`publishedIsDateOnly`** — this timestamp's clock is the provider's own
  convention rather than the article's publication time. Such a sighting is
  stored and counted, and moves nothing.

**Both of ADR-0002's sentences are amended, and an earlier draft of this ADR
wrongly claimed the positioning one was untouched.** Its bullet reads "An article
is positioned in the timeline by its earliest sighting, with an
'updated ⟨relative time⟩' badge when later sightings exist", and the timestamp
exception reaches both halves: an article is now positioned by its earliest
sighting **that carries a publication time**, and a date-only sighting does not
move the badge either, because `latest_seen` is frozen with `published`. This
change's own test asserts exactly that — a date-only sighting on a stored
`12:09:10Z` article leaves it at `12:09:10Z` with a `sighting_count` of 2.

The AGGREGATOR exception genuinely does leave positioning alone: it still folds
the timestamp, because a copy really did see the article and really did see it
when it says. What it amends is only §7.4's generalisation — the earliest
emission wins every field it is *entitled to*, and entitlement is now per-field,
because "earliest" and "first-hand" came apart.

## The evidence, and why it is not a tuning question

Measured on the **dev archive on 2026-08-29** over 41 live fetches
([plan §G6](../DISCOVERY-DEEPENING-PLAN.md) carries the method). Of 169
pre-existing articles a Google News sighting folded onto, **116 lost fields**.
All three rows below fire on one predicate, so they are about the same 116
articles — the title row reads 113 because three of them already carried the
title the arriving sighting brought, so the write was a no-op:

```
url replaced with a news.google.com/rss/articles/CBMi… redirect   116   69%
title replaced with the Google-chromed " - Outlet" form           113   67%
published moved earlier by the fold                               116   69%
  …of which onto a 07:00Z day boundary rather than a real time    106   63%
```

The other 53 of the 169 lost nothing: the archive's own timestamp was already
earlier than the arriving one, so the handover never fired. **`116` is derivable
from §G6's split-by-run-and-stamp table (103 + 1 + 3 + 9) and `106` from its
bare-date rows; `113` is not in the plan at all** — it is this change's own count
over both runs, from the same query on the same day, stated here because §G6
publishes a title figure for one run only (101 of Span A's 126).

A worked case, `articles.id = 678` on the dev archive:

```
was  https://www.abc.net.au/news/2026-08-10/ukraine-kills-13-…/107021852
     2026-08-10 12:09:10+00   "Ukraine kills 13 in drone attack on … Nizhnekamsk"
now  https://news.google.com/rss/articles/CBMiswFBVV95cUxNMHE4NnJDTDBoWGlq…?oc=5
     2026-08-10 07:00:00+00   "… Nizhnekamsk - ABC News & Headlines – Australian
                               Broadcasting Corporation"
```

Every one of those three writes is ADR-0002 working as specified. That is what
makes this an amendment rather than a bug report.

## Why the aggregator exception is unconditional, and why it is the whole handover

**Every Google News sighting carries a redirect. All 3,087 measured, without
exception** — the adapter's own header says why, and `DropReason.no_identity`
already names it: "Google News, whose `<link>` is an opaque redirect".

So the trade is never favourable. Handing that URL over exchanges a link that
resolves to the newsroom for one that hops through an aggregator, and it does so
*whether or not the emission really was earlier*. The measurement makes the point
sharply: in the leading-edge run, where timestamps are trustworthy, **9 of the 12
URL losses were cases where the earlier-emission claim was TRUE.** Being right
about which emission came first does not make an aggregator's rendering the
better record, so gating this on the timestamp would have left **three quarters
of the leading-edge damage unfixed** — it repairs the 3 bare-date losses of 12
and walks past the other 9 — while looking like a complete job. Pooled over both
runs a timestamp gate reaches 106 of 116, which is exactly why pooling would have
been the flattering way to report it: the regime production actually runs in is
the leading edge, and there the timestamp gate is nearly useless.

**And it is not only the URL, which a first draft of this ADR got wrong.** The
same adapter writes `description`, `author` and `imageUrl` as `null` and both
category arrays as `[]` **as unconditional literals** — not as a fallback, so no
input can populate them; only `description` has a DEPARTURE note arguing it, and
the empty category arrays are argued nowhere — and its `title` carries a
` - Outlet` suffix the newsroom did not write. So a handover does not merely swap one field for a worse
one: it empties five populated ones. Reproduced against Postgres, a Currents
article with a summary, a byline, a hero image and two category arrays, folded
onto by a leading-edge Google sighting that really was earlier:

```
description  "Crews worked through the night."   ->  null
author       "Jane Reporter"                     ->  null
image_url    "https://…/hero.jpg"                ->  null
categories   {world}                             ->  {}
title        the newsroom's headline             ->  "… - Outlet Name"
```

That is a reader's card losing its summary and its picture, on the regime this
plane actually runs in. A `url`-only guard leaves every line of it in place,
which is why the exception is the whole display handover.

**What such a sighting is still trusted for** is that it saw the article, and
when. So `published`/`latest_seen` still fold, and `provider` still hands over:
which upstream reported the earliest emission is a fact about the emission rather
than a rendering of the article, and `articles.provider` is documented as exactly
that. A newly minted article keeps everything, redirect included: there is no
other record of it, and the alternative is refusing to store it.

## Why the timestamp exception blocks the whole handover, not just `published`

Google News stops reporting a publication time for items past about eight days
and sends midnight US Pacific instead — 1.7% of items at eight days or fresher,
**89.4% beyond that**, over 3,087 sightings. The stamp still parses and still
sorts; it is simply wrong by up to a day.

`published = LEAST(...)` therefore drags a 12:09 article back to 07:00, and
because the arriving sighting is *then* the earliest emission, ADR-0002 hands it
the title, the URL and the provider as well. One degraded field recruits all the
others. Blocking only `published` would leave the handover firing on a
comparison whose inputs are known to be fabricated, so the exception is the whole
handover or nothing.

**`latest_seen` is frozen on the same claim, and that needs its own sentence
because the argument above does not reach it.** `GREATEST` cannot drag an article
earlier and cannot trigger the handover, so nothing said so far explains refusing
it. The reason is separate and smaller: `latest_seen` is what the reader-visible
"updated ⟨relative time⟩" stamp is computed from (ARCHITECTURE §10), and a
fabricated 07:00Z boundary should not be able to claim a story was updated. A
date-only sighting has no opinion about when anything happened, in either
direction.

What such a sighting still does: it is inserted, it carries its own timestamp on
its own row, and it increments `sighting_count`. **It is a real observation of a
real article and it is recorded as one.** What it may not do is redefine an
article somebody else timed properly.

## The second failure this closes, which is not about display at all

`readTrendingStorylines` ranks on `published` twice over — window membership, and
`max(published)` for the recency decay — and it excludes deepening-plane articles
precisely so a plane fed by our own ranking cannot feed it back (ADR-0019).
Measured in §G6, **the cloud moved anyway**: no deepening article was counted, and
the board still changed, because an absorbed sighting rewrote the timestamps of
articles that *were* counted.

`plane` gates which rows are counted. It cannot gate what a counted row says.
That gap is what `publishedIsDateOnly` closes on the timestamp side; the group
re-parenting half of it is not closed here and is recorded in §G6 as still open.

## The accepted costs

**A flag nothing can force an adapter to set.** `finalizeSighting` takes
`unknown`, so an object literal gets no compile-time push, and both fields are
optional so that every adapter predating them — and every stored row — keeps
exactly its old behaviour. The mitigation is an observation in two
places, and the reading of it is **inverted**: a `date_only` share falling to
zero on an old span means the detector stopped matching, not that the provider
improved. `zammy_sightings_stamped_total{provider,stamp}` is the counter, and it
is **a Compose-only instrument** — ARCHITECTURE 12 deletes `/metrics` under the
Vercel target, since per-process counters mean nothing across ephemeral
instances and nothing scrapes them. So the observation that survives production
is the structured log field `processDeepenJob` writes beside it, on every fetch
rather than only on a high share, because a line that fires only when the number
is large cannot show the number's absence. **There is no alerting in this repo
today**, on this or anything else; what exists is a number a person can read. This is deliberately
the same shape as ADR-0019's admission about `plane` — "a column that can be set
wrong" — and it has the same answer: the value is set in the few places that
*know*, and watched where it is used.

**A heuristic at the boundary, with the error pointed the safe way.** A real
article can publish at exactly midnight Pacific to the second, and 20 of the
1,153 items measured inside the eight-day window carry that stamp — whether those
20 are genuine midnight publications or early onset of the same degradation was
not established, and the bound is quoted as the conservative one it is. A false positive costs one
handover and leaves the existing article's own fields in place, which is the
outcome the archive wants anyway. A false negative is the expensive direction and
is what the metric watches for.

**The archive is not repaired, and cannot repair itself.** This change is
forward-only. §G6 measured **116 already-damaged articles on the dev
archive** — of the 169 a Google sighting folded onto, 53 lost nothing because
the archive's timestamp was already the earlier one — and production is
unmeasured — its arc payloads visibly carry Google-redirect
URLs today. The damage is permanent by this ADR's own mechanism: an article whose
`published` was dragged back to 07:00 now holds an artificially early timestamp,
so no honest later sighting can ever be "earlier", and its chromed title and
redirect URL are frozen with it — while the fabricated stamp goes on feeding the
cloud's window membership and decay. **They are not repaired and will not be**,
following ADR-0018's precedent for its own 411 duplicates: a repair means
rewriting display fields out of `sightings.raw`, which is a chore with its own
correctness argument to make and nothing here makes it.

**What this recovers, stated so the damage table above is not misread as the
prize.** Of the 116 URL losses, this stops all 116 — the 106 bare-date ones and
the 10 §G6 calls "correct", which this ADR argues were never correct for `url`.
Of the 113 title replacements it stops all 113. What it does NOT stop is a
handover from a first-hand provider with an honest earlier stamp, which is
ADR-0002 working and is meant to keep working. And **the measurement §G6 asked
for is still outstanding**: "re-run this instrument afterwards, with the
acceptance test being the one G5 stated and did not get: the cloud comes back
byte-identical across a run." That is a live-fetch experiment against a mutated
dev archive, and it is owed before G7 rather than before this lands.

**`alt_key`'s day bucket is NOT settled here, and G6 asked for it in the same
change.** Its gating item reads "decide in the same change what a bare date means
for `alt_key`'s day bucket — the two are one question about whether a date is an
emission time". They are, and this ADR answers only the display half. The fold
still mints the key from the bare stamp's UTC day, so a story Currents timestamped
between 00:00Z and 07:00Z still lands in a different day bucket from its Google
twin and still mints a second row — §G6 measured that at seven hours of the clock,
with byte-identical `pbs.org` headlines as the worked case. It is deferred rather
than forgotten, for ADR-0018's reason: changing the fold re-keys the archive and
owes a migration, which is a different change with a different risk profile.

**An article minted from a bare date keeps it, permanently.** `LEAST` keeps the
earlier value, so a real timestamp arriving afterwards cannot repair the row.
Nothing here is dishonest — the date was all the provider gave — but such an
article's position *within* its day is arbitrary, and at 100 items sharing one
instant, so is its ordering. This is a known residue, asserted in a test so it
cannot be mistaken for an oversight, and it is one of the reasons §G6 refuses a
crawl frontier over older spans.

**Not `provider = 'google-news'` in the storage layer, and the layering argument
for that is weaker than it first looks.** Two lines and no new contract would
have done it. And `@zammy/storage` demonstrably *does* already know provider
names — `TOPIC_COVERAGE_PROVIDER = "currents"` in `coverage.ts`, the `'currents'`
defaults in migrations 0013/0021/0022, and the ranker's own
`provider = any('{currents,gnews}')` that ADR-0019 replaced — so "must not learn
their names" is an aspiration, not a fact about the package.

The honest case for the flags is narrower and has two halves. For
`publishedIsDateOnly` it is real: the claim varies **per item within one call**,
so no provider-level predicate can express it. For `isAggregatorCopy` it is not
— that flag is literally `isAggregatorCopy: true` in one adapter, which is the
provider name relocated. It is carried on the sighting anyway for extensibility
(a second aggregator gets the behaviour by declaring it, not by editing SQL in a
package below it) and to keep the fold's SQL free of a name it would have to
grow a list of. That is a preference, argued, not a necessity.
