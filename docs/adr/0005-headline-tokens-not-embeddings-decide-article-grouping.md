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

Everything else about grouping was settled in ARCHITECTURE §14.3 before any of
it was built — the group is a day's coverage, it is materialized at write time,
it is positioned by earliest published, the headline comes from a two-tier
source-authority list, `sighting_count` is never the signal. What §14.3 left
open was whether to build it at all, and — implicitly — how similarity would
actually be decided. It called grouping "the strongest case in this product for
vectors at all". This is the answer to that.

## Considered options

**Embeddings, with pgvector on RDS.** §14.3 is right that this is the strongest
case for them: a soft failure mode (a wrong grouping demotes an article behind a
toggle rather than deleting it) and a real ceiling on what lexical matching can
see. It is rejected on the costs §14.7 already priced when term-variant merging
died: the first ML dependency in the codebase, model weights baked into an image
whose runtime filesystem is deliberately read-only (§4.1), an English-first
affordance in a product where language is user-selectable — and a threshold
nobody has measured. Nothing about those costs changed between §14.7 and here.

**Headline-token Jaccard.** Catches what this feature is actually for: the same
wire story republished at different URLs, where headlines are near-identical
because they came off the same feed. It does not catch loosely-related coverage
of one event — "Wildfires force thousands to flee northern Alberta" and "Alberta
wildfire evacuations grow as flames near Fort McMurray" share one token — and
that is a limit worth naming rather than a bug to tune away. §14.3 defines the
unit as a day's coverage of a story, which is looser than this implementation
delivers.

**The shared-token floor is not optional.** Two headlines reducing to the single
token `trump` score a perfect 1.0, so the threshold alone would collapse every
headline naming one person into one group. This is §14.7's finding in a
different costume: neither orthography nor similarity is safe on its own.

## Amended 2026-08-11, after measuring against live data

The first cut compared a newcomer against a group's **seed** only, to bound
drift. Live traffic showed what that costs. The Mirror's "Dozens of police
chiefs urge PM to prevent PC Harper killers' prison release" scored 0.375
against its group's arbitrary first arrival and stayed a separate slot, while
duplicating a BBC article *inside that same group* almost word for word.

Seven policies were replayed over 2,713 live tokenized articles:

| policy | grouped | single-outlet merges* | biggest group |
| --- | --- | --- | --- |
| seed-only, 0.50 (as shipped) | 336 | 49 | 9 |
| seed-only, 0.40 | 395 | 49 | 10 |
| seed-only, 0.35 | 441 | 55 | 14 |
| **any-member, 0.50** | **348** | **49** | 10 |
| any-member, 0.40 | 410 | 49 | 15 |
| any-member + stemming, 0.50 | 361 | 50 | 10 |
| overlap coefficient, 0.60 | 463 | 54 | 14 |

\* a multi-member group whose members all share one outlet — syndication is
cross-outlet by definition, so these are templates or rolling updates, and the
count is a false-merge proxy.

**Any-member at 0.50 was chosen.** It recovers the missed syndication without
new single-outlet merges. Every looser option fuses distinct developments: at
any-member 0.40 the police-chiefs letter and the separate Burnham U-turn become
one 15-article slot. Lowering the threshold is therefore NOT the lever it looks
like — it buys recall by merging different stories that share vocabulary, which
is exactly what the two-token floor and the 0.50 bar exist to prevent.

The cost is stated plainly: **the calendar day is now the whole of the drift
bound.** Chaining inside a day is possible in principle and accepted, because a
day is a hard ceiling and the alternative was losing the feature's whole point.

**The figure rule came out of the same measurement.** Ten marketbeat.com insider
filings ("Buys 36,800 Shares", "Buys 43,500 Shares") merged into one slot under
every policy including the shipped one, because the tokenizer drops digits and
the numbers were the only difference. Grouping now refuses when both headlines
quote figures and none agree. Across the corpus this changed exactly one group —
that one — leaving the genuine wire clusters (Big Sur ×6, Gaza ×9) untouched.

Stemming (`chiefs`→`chief`, `urging`→`urge`) is the next available step: +25
grouped for +1 single-outlet merge. Not taken yet — §14.7's warning about
orthographic tricks applies, though far more weakly to multi-token headline
overlap than to merging single terms, and it deserves its own measurement.

## Consequences

- **The threshold is unmeasured**, set against constructed examples rather than
  labelled pairs. §14.7's post-mortem was explicitly about shipping exactly
  that, so it is named in the config, in the code, and here. Watch
  `zammy_articles_grouped_total` against `zammy_articles_created_total`: near
  zero means grouping is doing nothing, a sharp rise means it is merging stories
  that are merely similar. ADR-0002's principle governs the direction to err —
  a false merge is worse than a visible duplicate.
- **`GROUPING_ENABLED=false` turns it off** without a migration. §14.3 left
  "whether to build this at all" open; shipping it with a way back is how that
  question stays answerable in production. Existing `group_id` values survive
  and page as groups of one.
- **`chooseGroup` is the seam.** It takes tokens and candidate seeds and returns
  a group; nothing above it knows how the decision is made. A vector
  implementation replaces that function and the candidate query, and touches
  nothing else. Any revival starts where §14.7 says it must — by measuring
  whether the classes separate.
- **Grouping is forward-looking.** Articles stored before the migration have no
  tokens, are never candidates and never join a group. Retroactively regrouping
  the archive would move rows under live cursors for no reader's benefit.
- **Non-English timelines get the fallback, not the feature.** The tokenizer
  drops English stopwords and the authority list is Anglophone (§14.3), so on a
  Spanish or Arabic timeline grouping is both less accurate and headline-blind.
  It degrades to earliest-published, which is the behaviour those timelines had
  before this existed.
