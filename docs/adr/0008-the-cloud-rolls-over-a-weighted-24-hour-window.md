---
status: accepted
---

# The cloud rolls over a weighted 24-hour window

The landing-page wordcloud aggregates the articles published in the last
`TREND_WINDOW_HOURS` (default 24), recomputed from `now` on every sample, with each
article's contribution decayed by `0.5 ^ (age_hours / TERM_HALF_LIFE_HOURS)` (default
half-life 8h). This replaces the original design, in which the cloud aggregated a fixed
`APP_TIMEZONE` calendar day, refused articles that arrived for a day already closed, and
froze that day's aggregate permanently.

Two things go with the calendar day and are worth naming as losses rather than
simplifications: the API's `?day=` parameter, and the ability to serve a past cloud at
all. What arrives in their place is a term's **age**, which the day model had no way to
represent — inside a frozen day, a story from 00:05 and one from 23:55 were the same
story as far as the cloud was concerned.

## Why the day boundary was the wrong unit

The calendar day was never load-bearing for the feature; it was load-bearing for the
*baseline*, which needed stable, comparable periods to average over. Everything else it
touched, it hurt:

- **A day-shaped aggregate is emptiest exactly when it is most read.** At 9am the cloud
  described three hours of news. `APP_TIMEZONE` was introduced to stop this being worse
  still under UTC — where a Vancouver afternoon is already tomorrow and the landing page
  went near-empty after ~5pm local — but that fixed the timezone, not the shape. A window
  that ends at `now` is always the same size.
- **The freeze existed to protect the baseline, and cost the corpus.** Late articles are
  routine here: `/latest-news` is a snapshot of the moment, so a slow feed or a deferred
  backfill lands after the fact constantly. The day model had to store them, show them in
  timelines, and refuse them to the cloud.
- **The discontinuity was real and invisible.** At local midnight the corpus went to zero
  and the cloud rebuilt itself from whatever the first hour brought in. Nothing in the UI
  said so.

## Considered options

**Keep the day, shorten the freeze** — let a closed day accept late articles for some
grace period. This keeps the addressable-day contract and softens the worst of the
refusal, but leaves the two real problems untouched: the cloud is still empty every
morning and still has no notion of age. It also makes "frozen" mean "frozen eventually",
which is a worse thing to reason about than either state.

**Roll the window without weighting** — the smallest change that answers the morning-empty
problem. Rejected because a sliding unweighted window has a cliff: a story ranks
identically at 23 hours old and disappears at 24. Under a day model that cliff was hidden
by everything else resetting at the same instant; under a rolling one it is the only
discontinuity left, and it fires at a different moment for every term.

**Exponential decay over linear.** A linear ramp separates a 1-hour-old story from a
5-hour-old one by 17%, which no reader would recognise, while treating the 20-to-24-hour
tail as significant. Exponential puts the resolution where the interesting distinction is
and leaves the tail present but clearly outranked (`≈0.125` at 24 hours with an 8-hour
half-life). The two knobs interact and both want tuning against real traffic: a half-life
much shorter than the window makes the window's older half decorative; much longer, and
the weighting stops doing anything.

**Weighting the displayed count too** — rejected. `uniqueArticles` stays the true, uncapped,
unweighted count of distinct articles. A reader who sees "14 articles" can go and find
fourteen; a decayed 6.3 rounded to 6 answers no question anyone asked, and the accessible
`<ol>` is where the count matters most, since font size is decorative there by design.

## What replaces the day for the baseline

An **hourly snapshot history** (`term_snapshots`): each recompute writes its raw per-term
window counts under the hour it ran, upserting so a busy hour keeps one observation. The
baseline is the mean over the `BASELINE_WINDOW_DAYS` of snapshots ending one window-length
ago — excluded because a snapshot taken less than `TREND_WINDOW_HOURS` ago shares most of
its corpus with the live window, and a term that suppresses itself is the same self-defeat
the old design avoided by excluding today.

Two consequences of sampling being visit-driven (§9), decided deliberately:

- **Absence inside a recorded snapshot is a zero; a missing snapshot is not an
  observation.** So the divisor is the number of snapshots actually recorded in the range,
  not the number of hours in it. This differs from the frozen-day rule, which divided by a
  fixed seven days regardless of how many had data — defensible when a day had many chances
  to be sampled, wrong at hourly resolution, where overnight gaps are the norm and a fixed
  divisor would deflate every baseline in proportion to how quiet the deployment is.
- **A one-day story is roughly twenty-four consecutive snapshots**, not one, because the
  window drags it along. So it arrives at tomorrow already carrying a real baseline. That
  is the suppressor working: yesterday's big story should not still be today's.

## Consequences

- **No addressable past cloud.** `GET /api/v1/trending` drops `?day=`. `term_snapshots`
  holds raw counts for the baseline, not scored clouds, so it deliberately cannot
  reconstruct what the cloud showed at 3pm on Tuesday. Nothing in v1 asked for that; if it
  is ever wanted, it is a new table of scored snapshots, not a query against this one.
- **Two readers minutes apart can see different clouds.** The 15-minute Redis TTL is now
  the only thing holding a cloud still; the day key used to guarantee it for a whole day.
- **The layout seed must key on `language` alone.** Seeding on anything derived from the
  window would reshuffle the entire board on every poll, since `windowEnd` changes with
  every response.
- **`term_snapshots` is the first derived table that grows without bound**, so the nightly
  chore (§7.5) prunes past `BASELINE_WINDOW_DAYS + 1`. Deleting derived rows is not the
  irreversible act [ADR-0001](0001-postgres-is-the-archive-beyond-the-upstream-lookback.md)
  guards against, and no ADR-0001 exemption is needed.
- **`APP_TIMEZONE` stays, with one consumer instead of two.** Article grouping still bounds
  a group by the local calendar day
  ([ADR-0005](0005-headline-tokens-not-embeddings-decide-article-grouping.md)). The setting
  is no longer about what the landing page shows, which is worth remembering before anyone
  "cleans it up".
- **`baseline` is no longer `baseline_7d`.** Its units are unchanged — mean distinct
  articles per 24-hour window — so the `k = 3` smoothing constant and the `sqrt(df_domains)`
  breadth term carry over untouched, and so do every measurement and refusal in
  [ADR-0007](0007-the-cloud-stops-at-two-word-phrases.md), which turned on df nesting and
  baseline size, not on how the period was cut.
