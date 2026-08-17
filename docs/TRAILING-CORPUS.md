# The trailing corpus — what "rare" means to the storyline linker

Measured record for storylines-v2 S2 (ADR-0011, "Rarity is measured against a
trailing corpus"). Numbers below come from the dev archive on 2026-08-14:
22,987 articles spanning 2026-07-14 → 2026-08-14, `APP_TIMEZONE=UTC`.
Reproduce with:

```bash
pnpm story:df --rebuild --days=35
```

## What it is

Document frequency of article `story_tokens` over a rolling window of
`STORYLINE_DF_WINDOW_DAYS` (default 14) app-calendar days, plus the article
count that turns a df into a share. Two tables, both derived from `articles`
and rebuildable from it:

- `story_token_days (day, language, token, df)` — articles carrying the token
  in that day-language bucket. Per ARTICLE, never per occurrence.
- `story_corpus_days (day, language, articles)` — the denominator.

`day` is a YYYY-MM-DD key in `APP_TIMEZONE`, computed by the API layer for the
same reason grouping's day bound is (§10.1). `language` is `''` when the
article declares none.

Read: `readStoryDf` / `readTrailingCorpus`. Maintained on ingest by
`groupCreatedArticles`, the same place `story_tokens` are written. Rebuilt by
`rebuildStoryDf`. Pruned nightly with the retention chore.

## It stands alone, it did not converge with `term_baseline`

ADR-0011 left this open. The answer was: separate tables, and the reasons were
that the two infrastructures disagreed about all three of vocabulary, unit, and
clock.

**The question closed itself.** `term_baseline` and `term_snapshots` were dropped
with the term cloud in [ADR-0013](adr/0013-the-cloud-names-recently-updated-storylines.md)
— the landing page draws storyline labels now, and a storyline needs no
perennial-vocabulary suppressor — so these two tables are the only rolling-df
infrastructure left. The comparison is kept because it is the record of *why*
they were not merged, and because anything that later wants a trailing mean over
cloud vocabulary will land on exactly these three disagreements again.

| | `term_baseline` / `term_snapshots` | trailing corpus |
| --- | --- | --- |
| vocabulary | cloud DISPLAY terms — unigrams and bigrams off headlines, un-stemmed, filtered to what a cloud may show (ADR-0006, ADR-0007) | `story_tokens` — title AND description, stemmed by the grouping tokenizer |
| unit | mean of per-24h-window counts | document count over the whole window |
| clock | visit-driven hourly samples; a missing hour is "nobody looked", not an observation (§10.3) | every ingested article, once, under its publication day |
| question | "how loud is this term normally" | "in how many of the last fortnight's articles does this stem appear" |

Sharing rows would force one vocabulary and one clock on two questions that
agree about neither. The wordcloud's sampling gaps are correct for a
suppressor mean and wrong for a denominator: an unvisited day would read as a
day with no news, and every share measured against it would be inflated.

## The measured result: a story's own name stays anchor-eligible

ADR-0009's finding was that an ABSOLUTE df cap fails — on 2026-08-13 the
Leavitt story's own name reached df 64 in a 1,453-article day, 4.4%, and a cap
of 25 stopped recognising the story exactly when it became the day's biggest.
ADR-0011's claim was that a wider corpus buys the anchor headroom without
giving up the share-relative rule. It does:

| token | share of ITS OWN day (ADR-0009) | share of the 14-day trailing corpus |
| --- | --- | --- |
| `leavitt` | 4.4% (64 / 1,453) | **0.93%** (151 / 16,320) |
| `trump` | ~20% of any day | 13.0% (2,089 / 16,107) |

Under a 5% anchor ceiling, day-df put the story's own name at 88% of the
ceiling on the day its coverage peaked — one busier day from being refused.
The trailing corpus puts it at 19% of the same ceiling on the same day. Beat
vocabulary is still refused: `trump` is 13% and every other head token
(`president` 9.5%, `state` 6.1%, `world` 5.4%) is above or near the ceiling.

## Stability across sliding windows

The df of a token must not swing as the window slides, or no threshold can be
pinned. Fourteen-day windows ending on each of the last fourteen days
(language `en`):

| window ending | corpus | leavitt | trump | ukraine | tariff |
| --- | --- | --- | --- | --- | --- |
| 2026-08-14 | 16,107 | 0.91% | 12.97% | 3.50% | 1.86% |
| 2026-08-13 | 16,320 | 0.93% | 13.11% | 3.48% | 1.90% |
| 2026-08-12 | 14,558 | 0.41% | 13.39% | 3.78% | 1.81% |
| 2026-08-11 | 14,048 | 0.09% | 13.36% | 3.90% | 1.93% |
| 2026-08-10 | 12,227 | 0.11% | 14.16% | 3.56% | 2.21% |
| 2026-08-08 | 11,409 | 0.18% | 14.86% | 2.39% | 2.31% |
| 2026-08-06 | 11,346 | 0.29% | 15.31% | 2.14% | 2.71% |
| 2026-08-04 | 9,044 | 0.59% | 16.03% | 2.29% | 3.52% |
| 2026-08-01 | 6,709 | 0.83% | 18.04% | 1.92% | 4.86% |

Beat vocabulary is flat within a few points across the whole span. `leavitt`
moves exactly as it should: near zero before the story breaks on 08-13, an
order of magnitude higher once the window contains it — which is the signal
the linker is meant to read.

The drift in `trump` and `tariff` toward the older windows tracks corpus size,
not vocabulary: the archive thins out going back (6,709 articles in the
earliest window against 16,107 in the latest) because ingestion is
demand-driven (§9). A share measured over a thin corpus is noisier; this is an
argument for the floor ADR-0011 keeps under the ceiling, not against the share
rule.

Note also that the corpus is uneven day to day — 45 articles on 2026-08-14
against 3,363 on 2026-08-11 — for the same reason. The window is what smooths
that; a day-relative rule cannot.

## Costs

**Ingest path** (the number S2 owed): one batch of 8 articles — the measured
~8 new articles per upstream call (§12) — costs

- `storyTokens` re-derivation: **22.9µs per article** (200 articles sampled
  from the archive). `groupArticle` computes the same list; re-deriving a pure
  function was judged cheaper than widening a decision function's return type.
- `recordStoryDf`: **5.48ms mean** per batch (3.01ms min, 12.34ms max over 25
  batches), one transaction with two aggregated upserts whatever the batch
  size.

Against `SYNC_FILL_DEADLINE_MS=1200` and `MAX_SYNC_UPSTREAM_CALLS=5`, the
worst-case sync fill pays ~27ms — about 2% of the deadline. This is the cost
ADR-0009 measured blowing when it was paid per ARTICLE rather than per batch;
the batching is why it isn't.

**Lookup** (what S3 will pay, once per arriving group): **1.3ms mean** for a
19-token profile over the 14-day window, two statements, 0.48ms of it inside
Postgres on an index-only scan of `story_token_days_lookup_idx`.

**Rebuild**: **1.85s** for the whole 31-day archive — 22,987 articles into
135,290 token rows across 32 day-language buckets. One SQL pass.

**A rebuilt table MUST be analyzed.** The same lookup measured 19.9ms
immediately after the bulk rebuild and 1.3ms after `ANALYZE`: without
statistics the planner has no reason to prefer the index. `rebuildStoryDf`
now runs the `ANALYZE` itself.

**Size**: 84,116 rows for 14 days of one language, 32,414 distinct tokens.
Growth is linear in window × languages, and the nightly prune bounds it.

## Open for S3

Every threshold is still unmeasured — anchor share, the df floor under it,
mass, K, the dormancy window. What this session pins is the *corpus* those
thresholds are measured against, and the two facts the sweep can start from:
a story's own name peaks around 1% of the trailing corpus, beat vocabulary
sits above 5%.
