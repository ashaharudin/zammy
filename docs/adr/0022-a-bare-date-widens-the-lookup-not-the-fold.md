---
status: accepted
---

# A bare date widens the lookup, not the fold

`alt_key` keeps hashing `(source_domain, folded title, UTC day)`. What changes is
that a sighting whose provider sent a DATE rather than a time
(`publishedIsDateOnly`, [ADR-0021](0021-the-earliest-emission-is-not-authoritative-for-every-field.md))
is **resolved against three keys — its own day and the two adjacent ones — while
still being STORED under one.** `altKeyProbe` derives the probe set;
`findArticle` matches on it; `insertArticle` writes the same single key it always
did.

[ADR-0018](0018-a-fallback-identity-catches-what-the-url-cannot.md) says
"changing the fold is a migration, not an edit". **This is not a fold change and
owes no migration**, and that is the point of the shape rather than a convenient
side effect: every stored key still means exactly what it meant when its row was
minted, and a re-derivation — migration `0023`, a repair, a backfill —
reproduces it from the stored columns unchanged.

## What this was supposed to be, and why it is not

[Plan §G6](../DISCOVERY-DEEPENING-PLAN.md) found the defect and proposed the fix
in the same paragraph:

> Google says 07:00:00Z of Pacific date D; the real article is anywhere in
> D 07:00Z … D+1 07:00Z, so every twin Currents timestamped between 00:00Z and
> 07:00Z — seven hours of twenty-four — lands in a different UTC day and cannot
> fold whatever the fold does to the title.

If that premise held, the repair would be arithmetic: bucket on the Pacific day
and Google's asserted interval becomes exactly one bucket. **The premise does not
hold, and the fix it implies makes folding worse.**

Every Google News sighting carrying a bare date that has a Currents twin — same
`source_domain`, same folded title, within three days — was paired off and the
two day buckets compared. 150 such pairs exist on the dev archive:

```
day bucket, google minus its currents twin        -1     0    +1     same bucket
UTC day (what ships)                              12   127    11        84.7%
Pacific day (what §G6 proposed)                    0   118    32        78.7%
```

The error is **two-sided**, which no fixed offset can be. Google's date is a day
early for 12 pairs and a day late for 11, and moving the boundary to Pacific
trades the 12 away for 20 more of the second kind. All 24 hourly boundaries were
scored on the same 150 pairs, so nothing here rests on Pacific being the wrong
guess in particular:

```
00:00Z  84.7%   06:00Z  80.0%   12:00Z  38.7%   18:00Z  71.3%
01:00Z  84.0%   07:00Z  78.7%   13:00Z  44.0%   19:00Z  75.3%
02:00Z  85.3%   08:00Z  24.0%   14:00Z  45.3%   20:00Z  77.3%
03:00Z  86.0%   09:00Z  29.3%   15:00Z  50.7%   21:00Z  80.7%
04:00Z  85.3%   10:00Z  32.0%   16:00Z  55.3%   22:00Z  83.3%
05:00Z  82.7%   11:00Z  36.7%   17:00Z  63.3%   23:00Z  85.3%
```

**The best boundary in the world is 03:00Z at 86.0%, two pairs better than doing
nothing.** The archive is a real corpus of real timestamps and it says the
current fold is already at the optimum, to within the noise. The 15% residual is
two clocks disagreeing about what day a story belongs to — Google's date, and
the time whichever newsroom's CMS gave Currents — and a bucket boundary is the
wrong instrument for it.

A worked pair in each direction, both byte-identical headlines:

```
pbs.org        currents 2026-08-13T00:32:39Z    google 2026-08-12  (a day early)
france24.com   currents 2026-08-09T06:23:20Z    google 2026-08-09  (Pacific would
                                                 make this a day late)
```

`pbs.org` is §G6's own worked example and Pacific fixes it. `france24.com` folds
correctly today and Pacific breaks it. Both stories were filed within seven hours
of a UTC midnight; the difference is which side of Google's date they fell on,
and nothing about the sighting says which.

## What was measured, on which archive

Two archives, because neither can answer both halves.

**Archive P** — the `pg_dump` taken immediately before §G6's run
(`zammy-pre-g6.dump`, 2026-08-28), **32,279 articles**, the same corpus ADR-0018
and migration `0023` measured. Keys are recomputed in TypeScript from
`(source_domain, title, published)` with the `deriveAltKey` `main` ships, which
is exactly what `0023` does, so this is the pre-run archive keyed the way `main`
keys it today. Used for everything about the fold, because §G6's run mutated the
live archive — 2,902 articles minted and 169 rewritten — and a rewritten row's
`title` and `published` are Google's, so recomputing its key there would be
measuring the run rather than the archive.

**Archive L** — the live dev database, 35,181 articles at migration 0023. Used
for everything about Google News, because Archive P has no Google News rows at
all. Read through `sightings.raw`, which is never rewritten, so the per-emission
titles and timestamps are the ones the providers actually sent.

### What a boundary change would have cost, in ADR-0018's own terms

Recorded because it is the measurement the phase was chartered to produce, and
because a later reader deserves the number rather than the verdict. Archive P,
today's fold against a Pacific-day fold:

```
articles whose key CHANGES                    7,232   (22.4%)
articles that stop being keyable                  0
articles that become keyable                      0
collision groups                                301   (against 292 today)
rows absorbed by collisions                     324   (against 312)
pairs that newly collide                         20
pairs that stop colliding                         6
```

All 26 were read. Of the 20 gained, 18 are one story filed twice within hours
across a UTC midnight — `abcnews.com`, `middleeasteye.net`, `independent.co.uk`,
`dailymail.com` and `standard.co.uk` all filing a byte-identical headline twice —
and 2 are `ft.com` "Company Announcements", a desk feed that collides under both
folds and is nulled by ADR-0018's unique-only rule either way. Of the 6 lost, 5
are genuine: a `spectrumlocalnews.com` group of four splitting into 1 + 3, and
the "Rosebank consultation closes" pair on `independent.co.uk` and
`standard.co.uk`.

So on a Currents-only corpus the boundary shift looks like a modest win, +18
against −5. **It is refuted by the measurement it was proposed for**, not by
this one: the corpus that decides is the cross-provider one, and there it costs
six points. This is the whole reason the number this ADR turns on is the twin
count and not the collision count.

Two hourly boundaries are indistinguishable on Archive P — a Pacific-day fold and
a fixed 07:00Z fold produce **identical keys for all 32,279 rows** — because the
archive spans 2026-07-14 to 2026-08-27 and is entirely inside daylight saving. An
archive that cannot tell an IANA zone from a constant cannot be used to choose
between them, and it is recorded here so nobody reads the agreement as
corroboration.

### What the widened lookup buys

Archive L's 1,749 bare-date Google News sightings, resolved against an index
built from Archive P — the archive as it stood before the run, so a row this
experiment minted can never be counted as a fold:

```
resolve to a pre-run article under today's single key      127
resolve under a key set widened to D-1 / D / D+1           150   (+23)
of those, the widened set hit MORE THAN ONE utc day          0
```

**All 23 were read.** Every one is the same story: `pbs.org` and `techradar.com`
(both of §G6's worked examples), five outlets' coverage of one Air Force One
plane swap, four of one North Korean missile launch, four of one press-secretary
departure. The closest call is `taipeitimes.com` "World News Quick Take", which
is a daily column and therefore exactly the shape the day bucket exists to keep
apart — it is a correct fold, and checkable: Taipei is UTC+8, the matched
article's `2026-08-12T16:42:19Z` is 00:42 on the 13th in Taipei, and Google said
the 13th.

That takes the day-bucket loss to zero on this corpus. It is 23 duplicate rows
out of 1,749 bare-date sightings, and the population it comes from is small
today: the deepening plane ships a `now - 7d … now` window, where 1.7% of items
carry a bare date at all. **It is the phase after this one that would have made
it large** — a crawl frontier over older spans sits in the 89.4% zone — and G7 is
refused, so this fix is sized for the plane as it ships rather than for the plane
that was declined.

### What the widened lookup risks, counted rather than assumed

A day bucket is what stops a domain's recurring headline from collapsing a month
of instalments into one article. Relaxing it is the trade, so the archive's
exposure was counted. Archive P, 31,752 distinct `(source_domain, folded title)`
pairs:

```
pairs held by more than one article, all on ONE utc day     283
pairs spanning more than one utc day                         48
  of which some pair of days is ADJACENT                     22
```

All 22 were read. **Four are a recurring desk headline** — `ft.com` "Company
Announcements" (18 rows), `winnipegfreepress.com` "AP News in Brief at 12:04 a.m.
EDT" (14), `upi.com` "Directors Corner - Korea Regional Review" (7), and a
`cbc.ca` fire-hazard bulletin filed at 11:00:00 on three consecutive days. Those
four are what a bare-dated emission could fold onto wrongly. The other 18 are
duplicates the day bucket is currently splitting, which is the same population
the boundary measurement above found from the other side.

None of the 1,749 bare-date sightings matched any of the four. That is an
observation and not a guarantee — the exposure is one provider's emission of a
headline a newsroom repeats, and nothing bounds which headlines a provider will
emit.

**The cost when it does happen is an article, not a field.** A bare-dated
instalment that folds onto the wrong day's row is never minted, so the archive
loses a story rather than gaining a duplicate — the direction ADR-0002 names as
the worse one. That is worth stating plainly because the rest of this section
prices the risk at zero on the corpus measured, and the price is not zero if the
measurement is unrepresentative.

**One shape of it is refused outright, and it is the smaller shape.** Where the
own day matches nothing and BOTH neighbours match different articles, the
fallback is refused and the sighting mints its own row — there is no principled
choice between two neighbours a day away in either direction, and the shape is
itself evidence of a recurring headline. Measured: 0 of 1,749 sightings reached
it, and all 23 recovered folds matched on exactly one day, so the refusal is free.

**It is not a defence against the recurring-column class, and presenting it as
one would be wrong.** A daily column's damaging shape is ONE neighbour matching —
the archive has to hold instalments on both sides for the other shape to arise —
and one neighbour matching is precisely the shape every recovered fold has. So it
cannot be refused without giving the whole widening back. Counted over the four
desk columns above, on the days where a bare-dated instalment would find no
own-day article:

```
                                                    refused   folded
winnipegfreepress.com  "AP News in Brief…"                0       16
ft.com                 "Company Announcements"            2       12
upi.com                "Directors Corner…"                0        8
cbc.ca                 fire-hazard bulletin               0        2
                                                          2       38
```

So the exposure is **accepted and sized**, not closed. What bounds it is the
population — a bare date reaches only one provider's items, and that provider
must emit a headline a newsroom repeats — plus the fact that the whole class is
4 identities in 31,752 and none was matched in 1,749 sightings. If a real
instance ever appears, the lever to reach for is the one ADR-0018 already uses
for `hkexnews.hk`: refuse to key the shape at all, rather than widen or narrow
the probe.

Two things keep the consequence small when it does happen. The relaxation applies
to bare-dated sightings ONLY, which no adapter but Google News produces. And such
a sighting **moves nothing**: `publishedIsDateOnly` clears `movesTheClock` in
`ingestSightings`, which holds `published` and `latest_seen` where they are, and
with them the `earlier` test every display-field handover is gated on — so a
wrong fold costs one inflated `sighting_count` and one sighting filed against the
wrong article, not a rewritten `url`, `title` or `published`, and it moves
neither the group's keyset position nor a storyline day slot. What it does still
cost is the article that sighting would otherwise have minted, which is why the
shape where that is most likely is refused outright above rather than priced.

**This ADR must not ship ahead of ADR-0021**, and the dependency is behavioural
rather than a citation. Widening the lookup without it would let a bare-dated
sighting reach an article a day away AND, being "earlier" than almost any real
time that day, take that article's URL, headline and timestamp with it — the
defect §G6 measured at 106 handovers, arriving through a wider door. The two
fixes were split apart because only one of them touches the fold; they are safe
in one order.

## Consequences

- **No migration, and no re-key.** The stored fold is untouched, so `0023` stays
  the last word on `alt_key`'s values and the archive is not split into rows
  keyed two ways. This is the whole reason the answer is a lookup and not a
  bucket: ADR-0018's standing cost for a fold change is a re-key of every row,
  and 7,232 rows of Archive P was the price the boundary shift asked for.

- **The lookup takes no additional round trip and two additional index probes.**
  `alt_key = any(…)` is one `Bitmap Index Scan` on `articles_alt_key_idx`, the
  same partial index the single-key lookup used, inside the same statement. The
  `limit` moved from 1 to 4 so the ambiguity above can be SEEN — four is the most
  that can match (the URL key, the own-day key, two neighbours, each unique on
  its own index), and the rows are already gathered by the bitmap either way.
  Measured against the dev Postgres, 5,000 lookups: 24–25 ms
  with one key against 41–43 ms with three, matching the same pair at `limit 1`
  to within noise — about 3.5 µs per widened lookup, and only bare-dated
  sightings pay it. Against ARCHITECTURE 6.3's 1,200 ms sync-fill budget that is
  not a number worth carrying forward.

- **A precedence order that has never yet been exercised, ending in a refusal
  rather than a tie-break.** With three candidate keys `findArticle` can match
  several rows, so it takes the URL match first, then a match on the sighting's
  own day — both unique by index, so both name exactly one row — and if only
  neighbours matched, it folds when they name ONE article and refuses when they
  name two. There is deliberately no rule for choosing between two neighbours:
  both are one day away, so any choice would be arbitrary, and the shape itself
  is evidence of a recurring headline rather than of a duplicate. The `order by
  id` under all of it decides nothing; it is there because a `limit` over an
  unordered tie is a different article on different days, and that failure would
  be silent. Nothing measured reached any of it.

- **It is asymmetric, and only one arrival order is repaired.** The probe is
  carried by the ARRIVING sighting. A bare-dated emission that arrives after the
  archive already holds the story folds onto it; one that MINTS the article,
  under its own asserted day, is not found by the Currents emission that arrives
  the next day carrying only its own key. All 24 same-identity adjacent-day pairs
  in Archive L had the Currents row first, so §G6's run is fully covered by the
  half that is fixed — but that is a property of a retrospective run over a span
  the archive already covered, not a property of the design. Closing the other
  half means widening the lookup for a sighting on the strength of the STORED
  row's stamp, which puts "is this a bare date" into a SQL predicate over
  `articles.published` and a timezone into the query planner's path. It is not
  taken here and it is not measured; the population is unobserved rather than
  known small.

  **The same asymmetry means folding does not CHAIN, and the article count for
  three bare-dated emissions of one story depends on which arrived first.** A row
  minted under D-1 is invisible to a sighting on D+1, whose own neighbours are D
  and D+2. So D-1, D, D+1 in that order leaves two articles and D, D-1, D+1
  leaves one. Neither outcome is wrong — both are the pre-widening behaviour or
  better — but the two differ, and the difference is asserted in a test so it
  cannot be mistaken for an oversight. Removing it needs the stored key to move,
  which is the migration this ADR exists to avoid.

- **`publishedIsDateOnly` is now load-bearing twice, and in opposite
  directions.** ADR-0021 reads it as a REFUSAL — this stamp may not move the
  clock — and admitted that nothing can force an adapter to set it, mitigating
  with `zammy_sightings_stamped_total` and an alert inverted so that a
  `date_only` share falling to zero reads as "the detector broke". Here the same
  flag is a PERMISSION: it is what lets the fallback identity consult its
  neighbours. So a detector that stops matching now loses a fold as well as
  gaining a bad handover, and one that starts over-matching costs a refused
  handover as well as a wider probe. The mitigation does not change; what
  changes is how much rides on it.

- **The `alt_key` unique index still arbitrates the insert, unchanged.** A
  bare-dated sighting that finds nothing inserts under its own single key and is
  fenced against a concurrent writer of that key exactly as before. The widened
  set is never written and never indexed; it exists between the lookup's
  parameters and its result.

  The fence's re-resolution now calls a `findArticle` that CAN return undefined,
  and it provably never does so from there: a 23505 on `articles_alt_key_idx` can
  only be raised by the value that was inserted, which is `altKey`, which is
  always `altKeyProbe`'s first element — so the winning row matches the own-day
  arm and is returned before the refusal is reached. That proof rests on three
  invariants, none of which a test would notice breaking: `altKeyProbe[0] ===
  sighting.altKey`, `isAltKeyConflict` narrowing to that one index, and the two
  sort tiers. **The savepoint fence has no test on either side of this change**,
  because forcing the race needs a second connection held mid-transaction and the
  deterministic way to do that is to poll `pg_stat_activity` for a blocked
  backend — machinery whose own failure mode is a flake, which this repo has
  enough of. The first invariant is asserted directly; the third is asserted by
  the own-day precedence test. The second is not, and that is the gap.

- **What is refused, and why refusing was easy.** §G6 offered "return null for a
  bare date" as the ADR-0018-flavoured option — a null key means "identified by
  URL alone", which is a return to old behaviour rather than a guess. It does not
  survive contact with this provider: Google News's URL is an opaque redirect, so
  `normalizeSighting` DROPS a keyless item as `no_identity`. That would have
  discarded 1,749 of the 3,087 sightings §G6 produced, including the 127 that
  fold correctly today, in order to repair 23. It is the only one of the four
  options that is worse than doing nothing.
