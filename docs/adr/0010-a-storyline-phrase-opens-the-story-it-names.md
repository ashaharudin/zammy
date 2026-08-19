---
status: superseded by ADR-0011 (mechanics; the gutter placement survives as the label's home)
---

# A storyline phrase opens the story it names

A slot with wider coverage (ADR-0009) carries a two-word **storyline phrase**,
rendered in the gutter on the far side of the rail and clickable as a search.
The topic it opens is seeded with that storyline's articles before anything is
fetched, so the result set is a **superset** of the slot the reader clicked —
by construction, not by hope.

## Why a phrase at all

A storyline is the one place in this product where we know several articles are
one story; everywhere else the product asks the reader what they are interested
in. A day's coverage of one story is exactly what a reader wants to follow
sideways: who else reported this, and what did they say.

Left of the spine, deliberately. The right-hand column is the reader's present;
the phrase is a way out of it. Layout says that without a label, and it keeps
the card's own controls ("more", "N related") uncrowded.

## Why the click could not be trusted, before

ADR-0007 established that a phrase cannot survive the click: `canonicalize`
sorts the keywords, upstream has no phrase search, matching is conjunctive, and
the opened topic has its own fingerprint and empty coverage. That argument
applies to any clickable phrase — including this one — unless something
guarantees the articles the phrase was named after are in the topic it opens.
§14.2's "partial topic reuse" says the general version is unavailable (upstream
relevance cannot be reproduced locally, §7.6). The specific version is enough:

> These particular articles, in this particular storyline, contain every
> keyword of this particular topic.

That is checkable locally, because `story_tokens` already holds each article's
title+description vocabulary (ADR-0009).

## The mechanism

**Choosing the phrase** (`storyline-phrase.ts`, at read time, per slot):

- Candidates are adjacent token pairs from the **headline's title** — a phrase
  lifted from the words beside the card reads as a label, not a machine's
  summary.
- A candidate survives only if **both words appear in every article the slot
  shows** — the headline and all of `moreCoverage` — under the same singular
  fold `story_tokens` was written with. This is the whole guarantee.
- `related` is excluded from that test: those are syndication copies, and
  letting them vote would qualify a phrase on near-identical wording and miss
  the angle pieces the search has to reach.
- ADR-0006's verb lexicon still applies. A phrase that states rather than names
  ("letter urges") leads nowhere when clicked, and that argument is about
  clicking.
- §10.3's proper-noun gate does **not** apply. It exists because cloud terms
  compete for a slot; this phrase is anchored by the storyline the reader is
  looking at, and "police chiefs" or "medicaid funding" name a story perfectly
  well. Requiring a name would leave most storylines unlabelled for nothing.
- Ranking: how many of the slot's articles say the phrase *adjacently*, then
  position in the headline, then the phrase itself — deterministic, so a
  replayed read reaches the same label (§7.4).

**Seeding the topic** (`attachStorylineToTopic`, `?storyline=<id>`):

One `insert … select` enrolling that storyline's articles in the new topic,
gated on `story_tokens @> keywords` and the topic's language. The gate is the
security property: without it `?q=bananas&storyline=…` is an open door onto any
topic's membership. With it, the worst a crafted link can do is enroll articles
that genuinely contain every searched word, in the searched language.

Coverage is untouched, so the ordinary fill still runs and the topic grows past
the seed. `storyline` is deliberately **absent from the fingerprint** — it says
where the reader came from, not what they searched for, so the same phrase from
a chip and from the search box is one topic.

## What this costs

- **A seeded read cannot use the page cache when it enrolls anything.** A page
  cached a moment ago cannot contain articles this request is adding, and
  serving it would break the chip's only promise. Seeding that inserts nothing
  — the ordinary case from the second visit on — leaves the cache path
  untouched, which is why `attachStorylineToTopic` returns a count.
- **Other cached pages of that topic stay incomplete until their TTL.** Not
  new: every ingest does this (§7.1), and the §6.4 tiers are the answer.
- **The topic's membership now has two origins.** `topic_articles` meant
  "upstream returned this article for this search"; it now also means "the
  reader arrived from a storyline whose article carries every keyword" — a
  strictly narrower claim, which is why it may share the table. §7.6's refusal
  of a local *search path* is untouched: nothing here resolves a keyword into a
  result set.
- **The rail gets a gutter, and narrow screens pay for it.** The spine moves
  right by `--rail-gutter`; a wide window loses nothing, a phone loses ~4rem of
  card. The phrase wraps to two lines rather than truncating (a clickable
  "poli…" names nothing), and the card's meta row was made to wrap in the same
  change.
- **Most slots with coverage get no phrase.** Measured over the recorded
  fixtures (`q=donald trump` and `q=turkey` at `limit=100`, deduplicated by
  storyline): **192 slots, 46 carrying `moreCoverage`, 9 producing a phrase.**
  The other 37 share no two adjacent headline words across their whole coverage
  — the guarantee doing its job. A looser rule (any shared pair, or coverage of
  *most* articles) would raise the yield and give up the superset property, and
  the property is the feature. Whether ~20% yield is the right trade is a
  question for live data.

## Considered and refused

**A front-end-only chip**, linking to `?q=<phrase>` with no seed. This is what
ADR-0007 refuses: a new fingerprint with empty coverage, quota re-spent, and
the chip frequently opening a topic that does not contain the story it was
named after — the one outcome worse than nothing.

**Seeding the whole storyline, ungated.** Simpler and wrong: a storyline links
groups by rarity-weighted mass (ADR-0009), not by any particular word, so its
members need not carry the phrase. It also hands anyone with a URL bar the
ability to put chosen articles into a chosen topic.

**Deriving the phrase from `related` as well as `moreCoverage`.** Raises the
yield and breaks the guarantee, as above.

**Requiring a proper noun, per §10.3.** Refused on the argument; the
measurement neither rescues nor condemns it — on the same 46 slots it removes
exactly one phrase (`mail-in voting`) and adds none. A gate that costs real
labels and buys no precision is carried for provenance, not effect. The small
number also warns: proper-noun evidence needs a corpus using a word in running
text (§10.3), and a slot of two or three articles is a very small corpus, so
the gate would behave far less predictably here than over a day.

## Left open

- **The masthead problem returns.** `honolulu star-advertiser` appeared in the
  fixture run — desk furniture every article of a same-outlet storyline
  carries. ADR-0007 made `ap`, `rep` and their class stopwords for this shape;
  whether the phrase needs its own additions is a question for live data.
- **Word order is shown but not searched.** The chip renders "mail-in voting"
  and sends a sorted pair. Nothing is lost relative to the search box, but the
  phrase looks like it promises more than a conjunction does. The seed closes
  the gap for the clicked slot; for everything else, the conjunction is the
  truth.
- **Stopwords are elided inside a phrase**, so "Strait of Hormuz" surfaces as
  `strait hormuz`. Consistent with the cloud's bigrams (ADR-0007), slightly odd
  to read; recorded rather than fixed.
