---
status: accepted
---

# Headline tokens, not embeddings, decide article grouping

Two articles are the same story when their headlines share at least two
content-bearing tokens, their Jaccard similarity clears
`GROUPING_SIMILARITY_THRESHOLD` (0.5), and they do not quote contradictory
figures — judged inside one `APP_TIMEZONE` day, against **any member** of a
candidate group. The tokenizer is the wordcloud's (`contentTokens`), so
grouping and the cloud agree about what a word is.

ARCHITECTURE §14.3 settled everything else before this was built — a group is
a day's coverage, materialized at write time, positioned by earliest published,
headline chosen from a two-tier source-authority list, `sighting_count` never
the signal — and left open whether to build it at all and how similarity would
be decided. It called grouping "the strongest case in this product for vectors
at all"; this is the answer.

## Considered options

**Embeddings, with pgvector on RDS.** Genuinely the strongest case: a soft
failure mode (a wrong grouping demotes an article behind a toggle, never
deletes it) and a real ceiling on lexical matching. Rejected on the costs §14.7
priced when term-variant merging died: the first ML dependency, model weights
in an image whose runtime filesystem is read-only (§4.1), an English-first
affordance in a language-selectable product, and a threshold nobody has
measured.

**Headline-token Jaccard.** Catches what the feature is for: the same wire
story republished at different URLs with near-identical headlines. It does not
catch loosely-related coverage of one event — "Wildfires force thousands to
flee northern Alberta" and "Alberta wildfire evacuations grow as flames near
Fort McMurray" share one token — a limit worth naming, not a bug to tune away.

**The shared-token floor is not optional.** Two headlines reducing to the
single token `trump` score a perfect 1.0, so the threshold alone would collapse
every headline naming one person. Neither orthography nor similarity is safe on
its own (§14.7).

## Amended 2026-08-11, after measuring against live data

The first cut compared a newcomer against a group's **seed** only, to bound
drift. Live traffic showed the cost: the Mirror's "Dozens of police chiefs urge
PM to prevent PC Harper killers' prison release" scored 0.375 against its
group's arbitrary first arrival and stayed a separate slot, while duplicating a
BBC article inside that group almost word for word.

Seven policies replayed over 2,713 live tokenized articles:

| policy | grouped | single-outlet merges* | biggest group |
| --- | --- | --- | --- |
| seed-only, 0.50 (as shipped) | 336 | 49 | 9 |
| seed-only, 0.40 | 395 | 49 | 10 |
| seed-only, 0.35 | 441 | 55 | 14 |
| **any-member, 0.50** | **348** | **49** | 10 |
| any-member, 0.40 | 410 | 49 | 15 |
| any-member + stemming, 0.50 | 361 | 50 | 10 |
| overlap coefficient, 0.60 | 463 | 54 | 14 |

\* multi-member groups whose members all share one outlet — syndication is
cross-outlet by definition, so the count is a false-merge proxy.

**Any-member at 0.50 was chosen**: it recovers the missed syndication with no
new single-outlet merges. Every looser option fuses distinct developments — at
any-member 0.40 the police-chiefs letter and the separate Burnham U-turn become
one 15-article slot — so lowering the threshold buys recall by merging
different stories that share vocabulary, exactly what the floor and the bar
exist to prevent. The cost, stated: **the calendar day is now the whole of the
drift bound.** Chaining inside a day is possible and accepted; a day is a hard
ceiling, and the alternative was losing the feature's point.

**The figure rule came out of the same measurement.** Ten marketbeat.com
insider filings ("Buys 36,800 Shares", "Buys 43,500 Shares") merged under every
policy, because the tokenizer drops digits. Grouping now refuses when both
headlines quote figures and none agree. Across the corpus this changed exactly
one group — that one — leaving the genuine wire clusters (Big Sur ×6, Gaza ×9)
untouched.

**Plural stemming was measured next and taken.** Over 8,240 live articles it
added 44 grouped (1,368 → 1,412), single-outlet merges unchanged at 114, every
sampled new group genuine syndication. Extending to `-ing`/`-ed` added 22 more
with no such gain and did not even unify `urge`/`urging` (that needs Porter's
consonant-vowel restoration — a different order of complexity for an unmeasured
gain). Not taken. The stemmer drops a trailing `s` and nothing more (plus
`-ies`→`y`, `-ss` left alone); stripping `es` after s/x/z/ch/sh turns
`releases` into `releas`, which costs more than `boxe` does — consistency beats
linguistic correctness, since both sides map alike.

**Grouping stems; the cloud does not.** A term is a surface form, not a concept
(CONTEXT.md, §10.3) — "China" and "Chinese" are two terms. Grouping asks
whether two headlines describe one story, where `chiefs` and `chief` are the
same word. `contentTokens` keeps returning surface forms.

## Resolved: the one-shot gap, by adopting groups of one

Stemming did not fix the third card in the report that prompted it. The Daily
Mail's "Every police chief is urging PM to stop release of PC Harper's killers"
was ingested **before** any of the cluster existed, so its one evaluation had
nothing to join; when the BBC article arrived, the Daily Mail piece was a valid
candidate (0.538, above the bar) but the Independent scored 0.750, and a
newcomer joins its single best match. The two never met.

The fix: **best-match decides which group a newcomer joins, not who is left
out** — every other match that is still a group of one joins the same group.
The ranking was already computed; only its first element was used. Measured
over 8,240 live articles: **+31 grouped (1,412 → 1,443), single-outlet merges
unchanged at 114**, the Daily Mail piece lands in a slot of seven, every
changed group genuine syndication.

Only groups of **one** are adopted — the whole safety argument. Merging two
established groups is transitive chaining, which the day window exists to
bound; adopting a singleton keeps every member within one hop of the article
that pulled it in, the star topology any-member matching already produces.
`recordGrouping` enforces the singleton rule in SQL, so a candidate that gained
members between read and write is refused rather than stranding its members.

Cost, stated: a slot a reader has seen can fold into another, and an adopting
group moves down the timeline. Neither is new in kind (ADR-0002 accepted the
same for `published`), but adoption makes both more frequent.

## Amended again: stored tokens are a derivation, and they go stale

Plural folding worked on new articles and did nothing for stored ones —
including the exact card that prompted it. `title_tokens` had been materialized
before the tokenizer changed, so the BBC row still stored `chiefs`:

| pair | stored tokens | re-derived today | bar |
| --- | --- | --- | --- |
| dailymail vs bbc | 0.429 | 0.538 | 0.50 |

The comparison straddles the bar and nothing noticed — ADR-0002's "a rule we
keep widening" hazard in a different column. Three things follow, all built:

1. **`articles.tokens_version`** stamps the tokenizer that produced a row's
   tokens, with a partial index over the stale ones; healthy is an empty index,
   unhealthy is countable.
2. **`TOKENIZER_VERSION`** in `grouping.ts`, bumped whenever `headlineTokens`
   changes what it emits — the constant sits directly above the function
   because forgetting the bump is the one way this goes quiet again.
3. **`pnpm regroup [--days=N] [--tokens-only]`** re-derives tokens, then
   re-runs grouping for articles still a group of one — reusing `groupArticle`,
   so the maintenance path cannot drift from ingest.

It is an operator command rather than a chore, for the reason §14.3 refused
retroactive regrouping: pass 2 moves rows under live cursors. That cost is now
deliberate, bounded by `--days`, avoidable with `--tokens-only`, and pass 2
only moves groups of one — it can add members, never take a group apart.

## Consequences

- **The threshold is unmeasured**, set against constructed examples rather than
  labelled pairs — exactly what §14.7's post-mortem warned about, so it is
  named in the config, the code, and here. Watch `zammy_articles_grouped_total`
  against `zammy_articles_created_total`: near zero means grouping does
  nothing, a sharp rise means it merges the merely similar. Err per ADR-0002: a
  false merge is worse than a visible duplicate.
- **`GROUPING_ENABLED=false` turns it off** without a migration, keeping
  §14.3's "whether to build this at all" answerable in production. Existing
  `group_id` values survive and page as groups of one.
- **`chooseGroup` is the seam.** It takes tokens and candidate seeds and
  returns a group; nothing above it knows how. A vector implementation replaces
  that function and the candidate query only, and any revival starts where
  §14.7 says it must — by measuring whether the classes separate.
- **Grouping is forward-looking.** Pre-migration articles have no tokens, are
  never candidates and never join a group; regrouping the archive would move
  rows under live cursors for no reader's benefit.
- **Non-English timelines get the fallback, not the feature.** English
  stopwords and an Anglophone authority list (§14.3) make grouping there less
  accurate and headline-blind; it degrades to earliest-published — the
  behaviour those timelines had before this existed.
