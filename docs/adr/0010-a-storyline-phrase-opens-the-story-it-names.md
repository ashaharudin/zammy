---
status: accepted
---

# A storyline phrase opens the story it names

A slot with wider coverage (ADR-0009) carries a two-word **storyline phrase**,
rendered in the gutter on the far side of the rail and clickable as a search.
The topic it opens is seeded with that storyline's articles before anything is
fetched, so the result set is a **superset** of the slot the reader clicked —
by construction, not by hope.

Two mechanisms, and the second is what makes the first honest.

## Why a phrase at all

A storyline is the one place in this product where we know several articles are
one story. Everywhere else — the cloud, the search box — the product asks the
reader what they are interested in. Here it already knows, and the day's
coverage of one story is exactly the thing a reader wants to follow sideways:
*who else reported this, and what did they say*.

Left of the spine, deliberately. The right-hand column is the reader's present
— this headline, its copies, its coverage. The phrase is a way out of it. That
is a layout statement, and layout says it without a label; it also keeps the
card's own controls ("more", "N related") uncrowded.

## Why the click could not be trusted, before

ADR-0007 established that **a phrase cannot survive the click**: `canonicalize`
lowercases, dedupes and *sorts* the keywords, so word order is discarded before
the request is built, upstream has no phrase search to discard it into, and
matching is conjunctive. The topic that opens has its own fingerprint and empty
coverage, and it re-spends quota to reach articles another topic already holds.

That page took this as an argument against trigrams. It is equally an argument
against any clickable phrase — including this one — unless something guarantees
the articles the phrase was named after are in the topic it opens. §14.2's
"partial topic reuse" says the general version of this is not available:
upstream relevance cannot be reproduced locally (§7.6), so one topic's result
set cannot be derived from another's.

The general version is not what this needs. The specific version is:

> These particular articles, in this particular storyline, contain every
> keyword of this particular topic.

That is checkable locally without resolving anything, because `story_tokens`
already holds each article's title+description vocabulary (ADR-0009).

## The mechanism

**Choosing the phrase** (`storyline-phrase.ts`, at read time, per slot):

- Candidates are adjacent token pairs from the **headline's title** — the chip
  sits beside that card, and a phrase lifted from the words next to it reads as
  a label rather than as a machine's summary.
- A candidate survives only if **both words appear in every article the slot
  shows** — the headline and all of `moreCoverage` — compared under the same
  singular fold `story_tokens` was written with. This is the whole guarantee.
- `related` is excluded from that test. Those are syndication copies of the
  headline; letting them vote would qualify a phrase on near-identical wording
  and then miss the angle pieces the search has to reach.
- ADR-0006's verb lexicon still applies. A phrase that states rather than names
  — "letter urges" — leads nowhere when clicked, and that argument is *about*
  clicking.
- §10.3's proper-noun gate does **not** apply. It exists because cloud terms
  compete for a slot and a generic word wins one it has not earned; this phrase
  is already anchored by the storyline the reader is looking at, and "police
  chiefs" or "medicaid funding" name a story perfectly well. Requiring a name
  would leave most storylines unlabelled for nothing.
- Ranking: how many of the slot's articles say the phrase *adjacently*, then
  position in the headline, then the phrase itself — deterministic, so a
  replayed read reaches the same label (§7.4).

**Seeding the topic** (`attachStorylineToTopic`, `?storyline=<id>`):

One `insert … select` enrolling that storyline's articles in the new topic,
gated on `story_tokens @> keywords` and on the topic's language. The gate is
the security property, not a nicety: without it `?q=bananas&storyline=…` would
be an open door onto any topic's membership. With it, the worst a crafted link
can do is enroll articles that genuinely contain every word the user searched,
in the language they searched it in.

Coverage is untouched, so the ordinary fill still runs and the topic still
grows past the seed — "include, but is not limited to" is literal.

`storyline` is deliberately **absent from the fingerprint**. It says where the
reader came from, never what they searched for, so the same phrase reached from
a chip and from the search box is one topic rather than two.

## What this costs

- **A seeded read cannot use the page cache when it enrolls anything.** A page
  cached a moment ago cannot contain articles this request is about to add, and
  serving it would break the only promise the chip makes. Seeding that inserts
  nothing — the ordinary case from the second visit onward — leaves the cache
  path untouched, which is why `attachStorylineToTopic` returns a count.
- **Other cached pages of that topic go on being incomplete until their TTL.**
  Not new: every ingest adds articles that cached pages do not know about
  (§7.1), and the tiers in §6.4 are the existing answer.
- **The topic's membership now has two origins.** Before this, `topic_articles`
  meant "upstream returned this article for this search". It now also means
  "the reader arrived from a storyline whose article carries every keyword".
  The second is a strictly narrower claim than the first, which is why it is
  allowed to sit in the same table; §7.6's refusal of a local *search path*
  is untouched, because nothing here resolves a keyword into a result set.
- **The rail gets a gutter, and narrow screens pay for it.** The spine moves
  right by `--rail-gutter` and the page's max width grows to match, so a wide
  window loses nothing; a phone loses ~4rem of card. The phrase wraps to two
  lines there rather than truncating — a clickable "poli…" names nothing — and
  the article card's meta row was made to wrap in the same change, since it
  clipped its own "more" control at the narrower width.
- **Most slots with coverage get no phrase.** Measured over the recorded
  fixtures, `q=donald trump` and `q=turkey` at `limit=100`, deduplicated by
  storyline: **192 slots, 46 carrying `moreCoverage`, 9 producing a phrase.**
  The other 37 share no two adjacent headline words across their whole
  coverage — which is the guarantee doing its job, not a shortfall. A looser
  rule (any shared pair, not necessarily adjacent in the headline; or coverage
  of *most* rather than *all* articles) would raise the yield and give up the
  superset property, and the property is the feature. Whether a ~20% yield is
  the right trade is a question for live data; two fixtures cannot answer it.

## Considered and refused

**A front-end-only chip**, linking to `?q=<phrase>` with no seed. This is what
ADR-0007 describes and refuses: a new fingerprint with empty coverage, quota
re-spent, and a result set bounded by whatever upstream makes of two ANDed
words against body text we never see. The chip would frequently open a topic
that does not contain the story it was named after — the one outcome that makes
the affordance worse than nothing.

**Seeding the whole storyline, ungated.** Simpler, and wrong: a storyline links
its groups by rarity-weighted mass (ADR-0009), not by any particular word, so
its members need not carry the phrase at all. It also hands anyone with a URL
bar the ability to put chosen articles into a chosen topic.

**Deriving the phrase from `related` as well as `moreCoverage`.** Raises the
yield and breaks the guarantee, as above.

**Requiring a proper noun, per §10.3.** Refused on the argument, and the
measurement neither rescues nor condemns it: applied to the same 46 slots it
removes exactly one phrase (`mail-in voting`) and adds none, so on this corpus
it is very nearly free. It is still not worth taking. The gate exists because
cloud terms compete for a slot and a generic word can win one on frequency
alone; nothing here competes on anything — the phrase is anchored by the
storyline the reader is already looking at, and "mail-in voting" names that
story exactly. A gate that costs real labels and buys no precision is a gate
carried for its provenance rather than its effect. Note what the small number
also means: proper-noun evidence needs a corpus that uses a word in running
text (§10.3), and a slot of two or three articles is a *very* small corpus, so
this gate would behave much less predictably here than it does over a day.

## Left open

- **The masthead problem returns.** `honolulu star-advertiser` appeared in the
  fixture run — desk furniture that every article of a storyline carries
  because they are all the same outlet's. ADR-0007 made `ap`, `rep` and their
  class stopwords for exactly this shape; whether the phrase needs its own
  additions is a question for live data, not for two recorded fixtures.
- **Word order is shown but not searched.** The chip renders "mail-in voting"
  and sends `keywords=mail-in+voting`, which canonicalizes to a sorted pair.
  Nothing is lost relative to the search box, but the phrase looks like it
  promises more than a conjunction does. The seed is what closes the gap for
  the slot the reader clicked; for everything else the search returns, the
  conjunction is the truth.
- **Stopwords are elided inside a phrase**, so "Strait of Hormuz" surfaces as
  `strait hormuz`. Consistent with the cloud's bigrams (ADR-0007) and slightly
  odd to read; recorded rather than fixed.
