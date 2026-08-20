---
status: partly superseded by ADR-0014 (the unit, the exclusions and the search-not-UUID click stand; the arc-wide breadth gate, the pure-recency ordering and running the label verbatim do not)
---

# The cloud names recently updated storylines

The landing-page wordcloud draws the **storylines whose coverage moved inside
the rolling `TREND_WINDOW_HOURS`**, most recently updated first, each word
being that storyline's label. Font size is the number of articles the storyline
gained inside the window; the warm→cool ramp is how recently it last moved.
This replaces the design in which the cloud drew *terms* — proper nouns and
two-word phrases extracted from headlines, scored against a trailing per-term
baseline and recomputed by the sampler. The window keeps rolling exactly as
[ADR-0008](0008-the-cloud-rolls-over-a-weighted-24-hour-window.md) made it
roll; what changes is *what is in* it — an event rather than a word.

## Why the unit was wrong, not the scoring

The term cloud worked: everything measured against it held — the
`df_domains >= 2` breadth gate, the stopword and desk-furniture lists, the
propriety gate, the verb lexicon
([ADR-0006](0006-a-curated-verb-lexicon-keeps-predicates-out-of-the-cloud.md)),
the two-word ceiling
([ADR-0007](0007-the-cloud-stops-at-two-word-phrases.md)). That list is the
argument for this change: six mechanisms and two ADRs stand between a headline
corpus and a word that names something, and what they produce is still only a
word — `kelowna`, `donald trump`, `world cup` — leaving the reader to supply
the event. Meanwhile
[ADR-0011](0011-a-storyline-is-a-persistent-arc-of-one-event.md) made a
storyline a persistent arc with a generated 2–5 word label — "Fort Hood Crash",
not "fort hood" — and every gate above already ran before that label was
written, in the model prompt's grounding rules or the bigram fallback. The
cloud had a choice between a phrase it had to defend and a name already
defended, and was still drawing the phrase.

The actual reasons, as consequences:

- **A term names a subject; a label names an event.** "Trump" was in the term
  cloud every day and told a reader nothing about today. A storyline cannot be
  bare "Donald Trump" — not an arc — so the unit itself refuses the class of
  word the baseline was invented to suppress.
- **A click can lead somewhere real.** A term was a search over headline text;
  a label names one specific arc with a UUID behind it (though the cloud
  deliberately still runs the label *as a search* — below).
- **Nothing needs computing.** The linker attaches groups at write time, the
  labeler names them, `storyline_days` is maintained per day of coverage. A
  cloud of storylines is a query over rows another path keeps honest; a cloud
  of terms was a per-window recompute over every article's title.

## What the change deletes

Three tables, one scorer, two knobs, and the sampler's second job:

- `trending_terms`, `term_snapshots`, `term_baseline` — dropped in migration
  0014, along with the one prune in §7.5 that actually deleted rows.
- `scoreTerms` and the recency-decay arithmetic. `term-scoring.ts` is renamed
  `headline-tokens.ts` and keeps exactly what has other readers:
  `contentTokens` (grouping), `properNounEvidence` and `isVerb` (the bigram
  label's gates). Their tests are re-pointed rather than deleted, because the
  classes they pin — identifier fragments, wire-service furniture, a name
  beside a verb — are properties of headline text, not of the cloud.
- `TERM_HALF_LIFE_HOURS` and `BASELINE_WINDOW_DAYS`. Recency is the cloud's
  *ordering* now, so there is no half-life to choose; and a storyline needs no
  suppressor, because "is this word perennial" is a question about words.
- `processSampleJob` still fetches, ingests and groups — grouping is what runs
  the linker — but computes nothing the cloud reads. The two halves of §10 are
  now independent: the sample feeds the corpus, the read answers the window.

The baseline's accumulated history is the one real loss, and it is not
recoverable: seven days of hourly observations took a week of traffic to earn.
Migration 0014's `down` restores the schema empty and says so.

## What it keeps

**The breadth gate, measured over the arc.** A storyline needs >= 2 distinct
source domains to appear. PROBE-FINDINGS 6b proved the mechanism necessary (the
naive scorer returned a cloud made entirely of one outlet's Jenkins CVE burst),
and a storyline does not make it unnecessary: eight advisories from one
newsroom are eight groups, and eight groups can link into a perfectly real arc
that is nonetheless not what several newsrooms are covering. Measured over the
whole arc rather than the window, unlike every other count here, because the
question — have several newsrooms covered this event — is a fact about the
story: a three-week storyline eleven outlets have carried is not disqualified
because today's one new article came from one of them.

**The exclusions the pills already made.** Aliases (a pointer has no coverage),
provisional storylines (a storyline-of-one is the ordinary timeline slot), and
unlabelled ones. The last was learned by looking: `findSurfacedStorylines`
shipped without it and the browser showed eight pills reading "unlabelled
storyline". A label-less storyline is valid to render but not to offer, and in
a cloud the label *is* the word.

**One word per label.** Labels are non-unique (ADR-0011); the dev archive holds
three storylines called "Trump Administration". A timeline can separate them
with a date qualifier; a cloud cannot — it would draw the same word twice at
two sizes and colours. The API keeps the freshest claimant per label.

## Two channels, one question each

Size answers "how much is happening", colour answers "how recently". The term
cloud put both into one score and gave size the result, so a reader could not
tell a busy old story from a quiet new one.

- **Size ∝ sqrt(articles inside the window)**, not the arc's total — a
  storyline running since March would otherwise be the biggest word on the
  board every day for a month. Clamped by length as before, and that clamp is
  now load-bearing rather than a guard: a 2–5 word label is routinely wide
  enough for d3-cloud to drop silently.
- **Colour = recency rank**, read straight off the response's order. The
  freshest arc burns red.
- **The arc's total size is in the text and in no channel at all** — the
  `title` and the accessible `<ol>` — because it is the one fact that tells a
  three-week story from a three-hour one, and neither channel is legible as a
  number.

## The click, which reverses a documented rule

**A cloud word runs its label as a search.** Everywhere else a label opens its
storyline by UUID — the surfaced pills, the timeline gutter — and CONTEXT.md
said flatly that a label's "words are never executed as a search", which
[ADR-0010](0010-a-storyline-phrase-opens-the-story-it-names.md) spent a whole
document earning. The rule is narrowed deliberately: **in the cloud, and only
in the cloud, a label is a query.**

The reason is the cloud's other job: it answers cold start (§9.3) — the landing
page is never blank, and clicking a word is how a first-time reader mints a
topic and feeds the demand-driven loop (§9). A click that opens a storyline
view spends no upstream call, creates no topic, and teaches the system nothing
about what people want — a read of what we already have, which is exactly what
the landing page is not for.

What this costs, stated plainly: the search may return a timeline that is not
the arc. `canonicalize` is not the linker, "Fort Hood Crash" as keywords is a
keyword match over headlines, and ADR-0010's superset guarantee does not hold —
it was bought by a containment rule ADR-0011 retired. A reader clicking a cloud
word gets *a search for that name*, which is what the cloud has always given
them. The two-affordance alternative (cloud opens, list searches) was refused:
the `<ol>` is the cloud's accessible equivalent, and giving it a power the
cloud lacks makes the two views disagree about what the feature does.

## Consequences

- **No stored cloud, so no cloud to be stale.** The window's contents *are* the
  answer; a storyline gaining an article at 14:03 outranks its neighbour at
  14:04 with nothing having run in between. The 15-minute Redis entry is the
  only thing holding a cloud still, as it already was after ADR-0008.
- **The read does real work now.** The aggregate runs on the request path where
  the term cloud read a materialized table. Migration 0014 adds
  `articles (language, published DESC)` for it; the cache absorbs the rest. If
  this ever needs a materialized table, it is a new one, not a resurrection.
- **A cold deployment shows nothing for longer.** The term cloud filled from a
  single sample — forty unrelated articles still yield terms. They yield forty
  *provisional storylines of one*, which the cloud refuses, so it fills only
  once the linker has seen enough coverage for second groups to attach. The
  empty-state copy says so; this cloud describes a system that has been
  running, not one that just booted.
- **The cloud is only as good as the labels.** A bad label is now a bad word on
  the landing page, where before it could only mis-name one timeline gutter.
  This raises the stakes on ADR-0011's labeler and its bigram fallback, and
  makes the nightly label pass a landing-page concern.
- **`isBigram` and `uniqueArticles` leave the wire contract**, replaced by
  `id`, `label`, `windowArticles`, `size`, `sourceCount` and `lastUpdated`.
  There is no compatibility shim: the front end and the API ship together.
- **CONTEXT.md's vocabulary changes.** **Term** is no longer a cloud unit — it
  survives as the tokenizer's word, which grouping and the bigram label read —
  and **storyline label** gains the cloud exception above.
