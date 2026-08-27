# MiniLM embeddings vs link mass — a shadow measurement

2026-08-27, against a same-day `pg_dump` of the production database (33,711
articles, 15,719 live storylines, 28,084 groups, 32,942 attachments). Question:
would cosine similarity over `all-MiniLM-L6-v2` embeddings of title+description
link storylines better than the anchor+mass system does?

**Finding: no.** On the labeled sets, cosine separates real storylines from
coincidence piles exactly as badly as link mass does — AUC 0.671 vs 0.669 —
and it fails *worst* on the pile families that matter most (templates and
beats), because those are maximally topically similar and topical similarity
is all an embedding measures. The one place cosine adds signal is the very
bottom of its range, where it flags pairs that share tokens but no meaning.

Everything below is reproducible from the scratch scripts recorded at the end.

## Setup

- Model: `sentence-transformers/all-MiniLM-L6-v2`, embedding
  `title + ". " + description` (trailing `| Source` segments stripped, echoing
  `stripSourceAttribution`), L2-normalized. 33,711 articles in 25 s on an
  M-series laptop.
- Group embedding: mean of member-article embeddings, renormalized. Storyline
  centroid: mean of member-group embeddings.
- Link mass recomputed offline the way `linkEvidence` computes it: trailing
  14-day df ending on the later group's day, df rebuilt from the articles'
  own `story_tokens` and published dates (the production `story_token_days`
  table only carries days since cutover). ~16% of refused pairs score below
  mass 20 in this reconstruction despite having qualified in production —
  that is the noise floor of the offline df, worth remembering when reading
  the mass columns.

## Part 1 — the labeled pairs

Two sets, both of which **cleared the token bar** (anchor + mass ≥ 20) at
formation, so token evidence admits 100% of each by construction:

- **refused** (n=296): pairs in `storyline_formation_refusals` — the Gemini
  coherence gate said NOT ONE STORY after the tokens qualified. Known bad.
- **named** (n=902): live two-group storylines a model labeled. Known good,
  with the standing caveat that ~26% of model-named two-group storylines were
  previously found to be piles the namer papered over.

| set | cos p10 | p25 | p50 | p75 | p90 | mass p50 |
| --- | --- | --- | --- | --- | --- | --- |
| named | 0.25 | 0.35 | 0.52 | 0.69 | 0.81 | 25 |
| refused | 0.19 | 0.29 | 0.38 | 0.50 | 0.59 | 22 |

**AUC (named ranked above refused): cosine 0.671, mass 0.669.** The two
signals are equally weak, and they are weak in the same place.

A cosine floor at formation, swept:

| link only if cos ≥ | blocks refused | destroys named |
| --- | --- | --- |
| 0.30 | 28.0% | 18.5% |
| 0.40 | 53.7% | 32.9% |
| 0.50 | 75.0% | 47.1% |
| 0.60 | 90.2% | 61.3% |
| 0.70 | 96.6% | 75.8% |

This is the same ~2:1 wall docs/STORYLINE-LINKING.md measured for all 31
token-statistic candidate rules ("Thirty-one settings, five families, one
result"). MiniLM on the same thin text surface hits the same wall.

### Why: the worst piles are the *most* similar

Highest-cosine refused pairs — every one is a template or a beat:

| cos | mass | pair |
| --- | --- | --- |
| 1.00 | 127 | r/Stocks Daily Discussion Aug 06 ↔ Aug 13 |
| 0.92 | 34 | TSX Today: What to Watch, Aug 13 ↔ Aug 18 |
| 0.85 | 42 | Stock Market Today, Aug 6 ↔ Aug 27 |
| 0.82 | 32 | two TFSA advice columns |
| 0.77 | 39 | two Pokémon TCG deal posts |
| 0.75 | 20 | "Why is CK Hutchison stock sliding" ↔ "Why is JetBlue stock sliding" |

The coherence gate correctly refused all of these. An embedding cannot: a
publisher's daily column embeds almost identically to yesterday's edition
(cos 1.00), because it *is* about the same subject. "Same subject" is exactly
the failure ADR-0011 forbids ("'Donald Trump' is not a storyline"), and it is
also exactly what cosine similarity measures. The instrument is structurally
aligned with the failure mode, not against it.

### The one honest signal: the very bottom of the range

Lowest-cosine *named* pairs read as piles the namer papered over — a Man Utd
transfer paired with an oil-price post ("Man Utd Lewis Hall"), a stabbing in
Germany paired with a French-immersion teaching piece, a Red Sox season
recap paired with a medical-records history. This matches the known ~26%
contamination of the named set, which means the "destroys named" column above
is somewhat overstated at low thresholds — some of what a cos ≥ 0.2–0.3 floor
would destroy deserves destroying. A conservative floor as a *third* signal
(alongside the coherence gate, or covering the hours the Gemini quota is
spent — embeddings are free and local) is the only wedge this measurement
leaves open. Proving it net-positive needs adjudication of the ~170 named
pairs under cos 0.30, which no statistic here can do.

## Part 2 — replay: what would cosine have linked

Groups offered chronologically (by first-seen publication time) against the
centroids of storylines that already had an earlier group; production's
placement (current live membership) as reference. Approximations: final
post-merge storylines stand in for as-of state, and `attached_at` cannot
order decisions (production's span is the backfill window), so first-seen
time is the clock.

- 13,483 groups attached to a pre-existing storyline in production; cosine's
  top-1 candidate agrees with production's home for **47.1%** of them.
- Sweeping a link threshold: at cos ≥ 0.55 cosine would link 76.9% of
  production's attaches (agreeing on the home 55.3% of the time when it
  does) — and would also link **40.3%** of the 14,600 groups production
  left as births. At cos ≥ 0.65 the over-linking falls to 19.4% but it only
  reaches 55.1% of production's attaches.

There is no threshold at which cosine reproduces production's behaviour, and
Part 1 says its disagreements are not systematically the better call: at any
operating point it trades production's token piles for its own topical piles,
and the topical ones (beats, templates, "the stock market today") are the
kind the linker's history shows growing into top-ten arcs.

## Verdict

- Do not replace or gate the linker with MiniLM cosine over title+description.
  It is not better evidence; it is the same evidence in a rounder shape, and
  strictly worse against boilerplate and beats.
- The measured gap in the current system — "same happening vs same subject" —
  stays with the coherence gate (an LLM verdict), which this measurement
  independently corroborates: the refused set's high-cosine members are
  unambiguous piles no similarity statistic would catch.
- If embeddings return, the open wedges are: (a) a low floor (~0.2) as a
  cheap, quota-free sanity check at formation, pending adjudication; (b) a
  richer text surface than title+description (the ADR-0005 refusal was also
  about this), since nothing here measures what a full-body embedding would
  do; (c) candidate *retrieval* rather than decision — but the anchor-eligible
  probe already returns the full qualifier set at 2.2 ms, so there is no
  retrieval problem to solve.

## Reproduction

One-time, laptop-local, read-only against production:

```bash
# dump production (session pooler URL from deploy/vercel/.env.production)
# restore into the compose Postgres as zammy_prod — see seed-production.sh
# for the pattern; this run: 25.3 MB dump in 45 s, restore < 1 min.
```

Scripts (session scratchpad, not committed): `embed.py` (33,711 embeddings,
25 s), `analysis.py` (both parts, ~2 min), `examples.py`. Outputs
`embeddings.npy`, `pairs.parquet`, `replay.parquet`.
