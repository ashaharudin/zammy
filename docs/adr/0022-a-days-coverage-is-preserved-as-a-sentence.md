---
status: accepted
---

# A day's coverage is preserved as a sentence

Everything this system stores is derived from `articles` and rebuildable from
it. Groups, storylines, day slots, the trailing corpus, labels — drop any of
them and a pass rebuilds it. Retention (ADR-0001) is written on that assumption:
it reports today and will delete one day, and what it deletes is recoverable
from upstream or not worth recovering.

An arc's *history* is not covered by that assumption. Once retention takes an
article, what happened that day is gone — the storyline survives as a UUID and a
three-word label, and the label describes the arc as a whole, not any day of it.

So: **one sentence per storyline-day, and one per populated six-hour UTC segment
of it, written once and kept for ever.**

- It is **not derived state.** Nothing rebuilds it, because the model call that
  produced it is spent and the articles it read will not be there.
- It is therefore **exempt from retention**, which is the point rather than a
  concession.
- It is **cheap**: five sentences a day per qualifying arc, against a table that
  grows by storyline-days rather than by articles.

## Why segments, and why six hours

The unit a reader of history wants is not "the arc" and not "the article" — it
is *what happened while I was asleep*. A day is the coarsest unit that is still
a story beat, and a day of a fast-moving arc holds several.

The quarters are **even and UTC**: night 00-06, morning 06-12, afternoon 12-18,
evening 18-24. Both halves of that are decisions:

- **Even**, rather than the uneven spans the words actually name (night runs
  from about 21:00 to about 05:00 in ordinary speech). An uneven night straddles
  midnight, which would put part of a "night" in the previous day and make the
  day sentence cover a span its own quarters do not.
- **UTC**, unconditionally — not `APP_TIMEZONE`. The segments are UTC, so the
  day they add up to has to be the UTC day. `APP_TIMEZONE` is UTC today, so
  `storyline_days.day_key` and this table's agree; if it ever stops being UTC
  they stop naming the same 24 hours, and the pass says so in a warning rather
  than the config refusing to boot. The summaries stay internally consistent
  either way.

**An empty quarter gets no row.** That is the whole skip rule, and it is why a
refusal has to be a row with a null summary — otherwise "nothing happened that
afternoon" and "the model would not answer" are the same absence.

## What qualifies, and why it is two bars

A storyline-day is preserved when the arc is not `provisional`, the day holds
**more than four articles**, and those articles come from **at least two
groups**.

The two counts are not the same test, and the difference is the common case in
this corpus: one wire story syndicated six times is six articles in **one**
group. It clears a volume bar and it is not a day's coverage — it is one
telling, repeated, and five sentences about it would be five ways of saying the
same headline. The group count is what separates coverage from syndication; the
article count is what says there is enough of it to be worth a sentence.

## What can be rewritten, and for how long

A day's article set is not settled when the day ends. The linker attaches late
groups, the bridge sweep re-parents, and the pass runs five hours after
midnight. So:

- A **first** write is allowed whenever the bar is first cleared, however old
  the day is. A story that builds slowly and only qualifies on its fourth day
  must not be excluded for ever.
- A **rewrite** needs both: the day is less than three days past its close, and
  the span gained more than four articles. The window says when a day is still
  open to revision; the delta says whether the change was worth a model call.
- Past the window, **frozen**. That is what makes it a preserve. (What bounds
  how far the nightly pass READS is a separate knob — `SUMMARY_WINDOW_DAYS`,
  which is wider, because a day still has to be SEEN after it stops being
  revisable: a slow story can cross the article bar on its fourth day.)
- A **refusal never destroys a sentence that stands.** A rewrite the model
  declines leaves the older sentence in place and bumps an attempt count.
- A **refusal is the model answering unusably, and nothing else.** A 429, a
  5xx, a timeout or a pacer that will not queue writes no row and costs no
  attempt: it says nothing about the span. The two must not be one, or an
  outage retires spans it never read.
- The **day sentence follows its quarters even past the window.** A quarter can
  legitimately change there (a first write, a successful retry), and a day
  summary that omits a quarter of its own day is worse than one written twice.
  The **attempt cap still outranks it**: a span whose three asks were all
  refused is retired, and stays retired, whatever moves underneath it. Three
  refusals is the model declining that span, and following the quarters is not
  worth an unbounded bill.

## The cliff, and the days that only get one sentence

Google News drops the pubDate **time** beyond about eight days and stamps 89.4%
of those rows at midnight US Pacific — 07:00 or 08:00 UTC, so nearly every one
of them lands in the "morning" quarter. Four sentences off that would be four
sentences about a bucket boundary.

So a day older than the cliff gets the **day sentence alone**, built from its
articles rather than from quarters that do not exist, and the row's `segmented`
column records it. That column is the difference between *that day had no
evening coverage* and *we could not tell when that day's coverage landed*.

## The costs, accepted

- **A second model lane on one key.** The ceiling belongs to the key, not to the
  model id, so `SUMMARY_MODEL` pointed at a different model is still the same
  30 rpm. Both clients therefore share one pacer inside a process. Across
  processes it is still two windows, caught by the 429 cooldown — the same
  limitation labels have always had, and `SUMMARY_API_KEY` exists, unset, so the
  lanes can be split later without a code change.
- **No fallback.** The labeler degrades to a bigram extractor; prose has no such
  thing, and a sentence assembled from tokens would be worse than silence. A
  span the model will not describe stays undescribed, three attempts and then
  never again.
- **A bounded night defers rather than drops — but only because the walk is
  oldest-day-first.** The ceiling is reached on a busy corpus, and the days
  nearest to falling out of the window are the ones that cannot wait, so they
  are the ones the ceiling is spent on.
- **The day sentence is built from the quarters', not from the articles.** It
  cannot contradict them and it costs ~150 tokens instead of ~3,000. What it
  gives up is the chance to notice something across the day that no quarter
  noticed on its own.
- **It is off on merge.** `SUMMARIES_ENABLED=false`, the posture ADR-0011's
  linker shipped with, because this is the second thing here that spends quota
  per call.

## What did not change

Retention still reports rather than deletes (ADR-0001). Labels are still the
arc's name and still drift (ADR-0011) — a summary copies the label it was
written under rather than reading the live one, so history is not re-captioned
by a relabel. And `storyline_days` is untouched: this table is keyed on its own
UTC day and holds no foreign key to anything, so a storyline that is merged or
deleted leaves its preserve behind.
