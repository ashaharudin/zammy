---
status: partly superseded by ADR-0013, partly restored by ADR-0014 (the window still rolls and still ends at now; the snapshot history and the baseline are gone for good, and the terms with them, but the exponential recency decay this ADR chose came back under ADR-0014 as `TREND_HALF_LIFE_HOURS`, same shape and same 8h default, weighting storylines instead of terms)
---

# The cloud rolls over a weighted 24-hour window

The landing-page wordcloud aggregates the articles published in the last
`TREND_WINDOW_HOURS` (default 24), recomputed from `now` on every sample, each
article's contribution decayed by `0.5 ^ (age_hours / TERM_HALF_LIFE_HOURS)`
(default half-life 8h). This replaces the fixed `APP_TIMEZONE` calendar day,
which refused articles arriving for a closed day and froze each day's aggregate
permanently. Two things go with the day and are losses, not simplifications:
the API's `?day=` parameter, and the ability to serve a past cloud at all. What
arrives instead is a term's **age**, which the day model could not represent —
inside a frozen day, a story from 00:05 and one from 23:55 were the same story.

## Why the day boundary was the wrong unit

The day was load-bearing only for the *baseline*, which needed stable
comparable periods to average over. Everything else it touched, it hurt:

- **A day-shaped aggregate is emptiest exactly when it is most read** — at 9am
  it described three hours of news. `APP_TIMEZONE` fixed the worse UTC version,
  but that fixed the timezone, not the shape; a window ending at `now` is
  always the same size.
- **The freeze protected the baseline and cost the corpus.** Late articles are
  routine (slow feeds, deferred backfills), and the day model had to store
  them, show them in timelines, and refuse them to the cloud.
- **The midnight discontinuity was real and invisible**: the corpus went to
  zero and the cloud rebuilt from the first hour's arrivals, with nothing in
  the UI saying so.

## Considered options

**Keep the day, shorten the freeze** — accept late articles for a grace period.
Leaves the morning-empty cloud and the missing notion of age untouched, and
makes "frozen" mean "frozen eventually", worse to reason about than either
state.

**Roll the window without weighting.** Rejected because a sliding unweighted
window has a cliff: a story ranks identically at 23 hours old and disappears at
24. The day model hid that cliff by resetting everything at once; rolling makes
it the only discontinuity left, firing at a different moment for every term.

**Exponential decay over linear.** A linear ramp separates a 1-hour-old story
from a 5-hour-old one by 17%, which no reader would recognise, while treating
the 20-to-24-hour tail as significant. Exponential puts resolution where the
interesting distinction is and leaves the tail clearly outranked (≈0.125 at 24
hours with an 8-hour half-life). Both knobs want tuning against real traffic: a
half-life much shorter than the window makes the older half decorative; much
longer, and the weighting does nothing.

**Weighting the displayed count too** — rejected. `uniqueArticles` stays the
true, uncapped, unweighted count: a reader who sees "14 articles" can go and
find fourteen, a decayed 6.3 rounded to 6 answers no question anyone asked, and
the accessible `<ol>` is where the count matters most.

## What replaces the day for the baseline

An **hourly snapshot history** (`term_snapshots`): each recompute upserts its
raw per-term window counts under the hour it ran. The baseline is the mean over
the `BASELINE_WINDOW_DAYS` of snapshots ending one window-length ago — more
recent snapshots share most of their corpus with the live window, and a term
suppressing itself is the self-defeat the old design avoided by excluding
today. Two consequences of sampling being visit-driven (§9), decided
deliberately:

- **Absence inside a recorded snapshot is a zero; a missing snapshot is not an
  observation.** The divisor is the number of snapshots actually recorded, not
  the hours in range. The frozen-day rule divided by a fixed seven days —
  defensible at daily resolution, wrong at hourly, where overnight gaps are the
  norm and a fixed divisor would deflate every baseline in proportion to how
  quiet the deployment is.
- **A one-day story is roughly twenty-four consecutive snapshots**, because the
  window drags it along — so it reaches tomorrow already carrying a real
  baseline. That is the suppressor working: yesterday's big story should not
  still be today's.

## Consequences

- **No addressable past cloud.** `GET /api/v1/trending` drops `?day=`.
  `term_snapshots` holds raw counts, not scored clouds, so it deliberately
  cannot reconstruct what the cloud showed at 3pm on Tuesday; if ever wanted,
  that is a new table of scored snapshots.
- **Two readers minutes apart can see different clouds** — the 15-minute Redis
  TTL is now the only thing holding a cloud still.
- **The layout seed must key on `language` alone**: anything derived from the
  window would reshuffle the board on every poll, since `windowEnd` changes
  with every response.
- **`term_snapshots` is the first derived table that grows without bound**, so
  the nightly chore (§7.5) prunes past `BASELINE_WINDOW_DAYS + 1`. Deleting
  derived rows is not the irreversible act
  [ADR-0001](0001-postgres-is-the-archive-beyond-the-upstream-lookback.md)
  guards against.
- **`APP_TIMEZONE` stays, with one consumer instead of two** — grouping still
  bounds a group by the local calendar day
  ([ADR-0005](0005-headline-tokens-not-embeddings-decide-article-grouping.md)).
  Worth remembering before anyone "cleans it up".
- **`baseline` is no longer `baseline_7d`.** Its units are unchanged — mean
  distinct articles per 24-hour window — so the `k = 3` smoothing constant, the
  `sqrt(df_domains)` breadth term, and every measurement and refusal in
  [ADR-0007](0007-the-cloud-stops-at-two-word-phrases.md) carry over untouched:
  those turned on df nesting and baseline size, not on how the period was cut.

## Amended by ADR-0014: the decay came back

ADR-0013 deleted the decay along with the score it weighted, and made recency
the cloud's whole ordering. ADR-0014 put volume back into that ordering and
needed the decay again the moment it did — a raw article count with no age term
lets yesterday afternoon's eight-article story hold the top of a 24-hour board
until it ages out.

What returns is exactly this ADR's decision, not a new one: `0.5 ^ (age /
half-life)`, exponential, defaulting to 8 hours, for the reason argued at length
above — a linear ramp separates a 1-hour-old story from a 5-hour-old one by 17%
while treating the 20-to-24-hour tail as significant. The knob is renamed
`TREND_HALF_LIFE_HOURS` because what it decays is a storyline's coverage rather
than a term's contribution, and `TERM_HALF_LIFE_HOURS` would name a unit the
cloud no longer has (CONTEXT.md, **Term**).

What does NOT come back is the baseline. `BASELINE_WINDOW_DAYS` and the trailing
per-term mean stay deleted: "is this word perennial" is a question about words,
and a storyline is an event.
