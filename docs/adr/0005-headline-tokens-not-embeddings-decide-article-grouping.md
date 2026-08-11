---
status: accepted
---

# Headline tokens, not embeddings, decide article grouping

Two articles are the same story when their headlines share at least two
content-bearing tokens and their Jaccard similarity clears
`GROUPING_SIMILARITY_THRESHOLD` (0.5), judged inside one `APP_TIMEZONE` day and
against a group's seed only. The tokenizer is the wordcloud's
(`contentTokens`), so grouping and the cloud agree about what a word is.

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
