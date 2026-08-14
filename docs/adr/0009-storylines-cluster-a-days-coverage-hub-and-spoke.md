---
status: superseded by ADR-0011
---

# Storylines cluster a day's coverage hub-and-spoke, and bridged groups merge

A timeline slot is now a **storyline**: one day's coverage of one story, in one
language. Two mechanisms produce it, and they fix two different failures that
looked like one complaint ("multiple slots for the Karoline Leavitt story"):

1. **Bridge-evidence merging** repairs the group layer. When an arrival's
   matches span other groups above the full grouping bar — threshold,
   shared-token floor and figures veto included — those groups are one story
   and merge, whole. This supersedes ADR-0005's singleton-only rule.
2. **A storyline layer** clusters a day's groups around hubs. A group attaches
   to the day's best-matching hub when the two share a day-rare **anchor**
   token and enough rarity-weighted **mass**, computed over title AND
   description tokens. One hop only: spokes never extend a storyline's reach.

The timeline pages over `(storyline_published, storyline_id)`; the slot's lead
group (its most syndicated) supplies the headline via source authority, its
other copies ship as `related` ("same story"), and every other group's members
ship as `moreCoverage` ("more coverage" — the bare word already names fetched
time spans, CONTEXT.md). Defaults: `STORYLINE_ANCHOR_SHARE=0.05`,
`STORYLINE_MASS_THRESHOLD=8`, both measured before pinning (below).

## The case, on live data

On 2026-08-13 the corpus held 59 Leavitt-titled articles in 26 groups. The
core wire story sat in TWO multi-member groups — "to leave" and "to step
down" poles, formed order-dependently, and unfixable once both had members
(ADR-0005 moves singletons only). Around them: a retrospective, the successor
speculation, two fact-checks, the husband, the net worth — each correctly its
own group, none linked to anything. And §14.3's honest gap sat in the data
verbatim: the Guardian's "Will Trump's next press secretary be a better liar
than the first five?" names the story **only in its description**.

Description matching — the original hypothesis — was NOT what the split
needed (2 articles corpus-wide mention Leavitt in description but not title);
the split needed merging. Descriptions are what the *storyline* layer needed.
The two mechanisms fell out of measuring the one complaint.

## Measured failures that shaped the design

The first cut of each idea died on the live corpus. The failures are the
specification:

| design | measured failure | fix |
| --- | --- | --- |
| transitive clustering (union any qualifying pair) | one storyline swallowed 1,179 of a day's 1,190 groups — roundup articles bridge every story they mention | hub-and-spoke: membership is one hop from the hub, so a roundup can JOIN a story but never fuse two |
| any-member evidence (max over member pairs, per ADR-0005's precedent) | AP "The Latest:" live-blog copies inside the core group enumerate the whole day; the story acquired BLACKPINK and Thyssenkrupp as "coverage" | a group speaks through its **majority-support profile** — tokens at least half its members carry |
| absolute anchor rarity (df ≤ 25) | the story's own name hit df 64 as coverage exploded — the anchor stopped recognising the story on exactly the day it dominated | rarity is a **share of the day** (≤ 5%), floored at df 10 so small corpora can link at all |

The sweep over 31 days / ~17.8k articles, hub-and-spoke, majority profiles,
share-relative anchors:

| anchor share | mass ≥ | slots → storylines | largest | p99 |
| --- | --- | --- | --- | --- |
| 0.05 | 6 | 14,655 → 3,905 | 32 | 21 |
| **0.05** | **8** | **14,655 → 5,043** | **31** | **17** |
| 0.05 | 10 | 14,655 → 6,730 | 33 | 12 |

At mass 8 the Leavitt storyline carried 31 groups of genuine departure
coverage with strays in the low single digits (a Melania whereabouts piece, a
Wisconsin-polls roundup); at 6 the strays multiplied; at 10 real angles began
shedding. A stray here is a link under a headline — the slot's identity is
untouched — so this layer errs LOW, the opposite direction from
`GROUPING_SIMILARITY_THRESHOLD`, and for the same reason ADR-0002 gives:
what matters is what a mistake hides, and a stray hides nothing.

## Superseding ADR-0005's "only groups of one are adopted"

ADR-0005 refused to merge established groups because "C resembles both" is
transitive chaining. Bridge evidence is a different claim: the SAME headline
cleared the full grouping bar against members of both groups — not
resemblance to each in turn, but one article the rule says belongs in each.
Acting on it, replayed over the 31-day corpus: **59 merges**, sampled ones all
genuine syndication (the Canadian-tariff wording family, the Rutschman trade,
the solar eclipse), **13 of 15 marketbeat-style filings still unmerged** (the
figures veto holds at this layer), and the Leavitt poles healed.

What it costs, stated plainly: merges compound within a day. Successive
arrivals each merge what they bridge, so a mega-coverage day rolls its story's
wording family into one group — the healed Leavitt group holds 35 articles,
including a few pieces (two fact-checks, a replacement explainer) that are the
same *story* but not the same *piece*. Nothing is hidden — under storylines
those pieces sat behind the same disclosure either way; the cost is coarser
SECTIONING inside it, "same story" where "more coverage" would be more honest.
Accepted because the compounding is bounded by the same day window as ever,
the backfill replays exactly what arrival order would have done live (no
divergence between the paths), and the alternative — a second, higher bar for
merging than joining — is a second unmeasured threshold.

The figures veto stays at the GROUP layer and deliberately does not gate
storyline attachment: "Husband Nicholas Riccio is 32 years older" quotes a
figure the core story never does, and refusing that attach would delete a
correct link to prevent a harmless one.

## Consequences

- **One evaluation live, canonical on rebuild.** A group gets its storyline
  verdict when it is seeded, against the hubs that exist then — the same
  one-shot discipline grouping lives by, accepted for the same reason. The
  regroup command's new passes (3: bridge merges, 4: per-day recluster,
  biggest-group-first) are the canonical ordering; live drift heals there.
  First backfill over the dev archive: 18,050 retokenized, 59 merged, 9,979
  reclustered.
- **`story_tokens` is a materialized derivation** and rides the same
  `tokens_version` clock as `title_tokens` — one staleness ledger, one
  backfill. `TOKENIZER_VERSION` is 4; rows below it are invisible to the
  storyline layer until re-derived.
- **The wire shape changed behind a versioned cache key.** Entries carry
  `storylineId` and `moreCoverage` now; cached pages are served without
  re-validation, so the versioned key (`page:v3:`) keeps a new client from choking on an old
  build's page for a TTL.
- **The day-corpus read is per BATCH.** Attachment needs the whole
  day-language corpus (anchor rarity is day-relative), and reading it per
  article measurably blew the §6.3 sync-fill deadline. One read per ingest
  call, attaches applied against locally-updated state.
- **`STORYLINE_ENABLED=false` turns the layer off** without a migration:
  attachment stops; stored `storyline_id` values keep paging as they are
  until a regroup rebuilds or dissolves them. Non-English timelines degrade
  exactly as grouping does — English stopwords, so less accurate — and the
  midnight cliff is inherited: a storyline never spans two local days, by
  design and by the user's explicit choice (a story recurs each day it has
  coverage).
- **`pnpm measure:storylines` is the instrument.** It replays both decisions
  read-only over the live corpus and prints the sweep above; any threshold
  change starts there, per the §14.3 post-mortem's rule that no number ships
  unmeasured.
