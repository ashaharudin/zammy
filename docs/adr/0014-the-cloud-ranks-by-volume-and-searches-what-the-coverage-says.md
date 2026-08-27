---
status: accepted
---

# The cloud ranks by volume and searches what the coverage says

The landing-page wordcloud keeps the unit [ADR-0013](0013-the-cloud-names-recently-updated-storylines.md)
gave it — a storyline, drawn as its label — and changes the two things that
decided what a reader sees and what a click does:

- **The breadth gate moves from the arc to the window.** A storyline needs >= 2
  distinct source domains *inside* `TREND_WINDOW_HOURS`, not over its whole
  lifetime.
- **The ordering is a score again**: window article count decayed by
  `0.5 ^ (age / TREND_HALF_LIFE_HOURS)`, which brings back the knob ADR-0013
  deleted. Colour stays the recency channel by ranking `lastUpdated` in the
  browser rather than reading array position.
- **A click searches the label's grounded words, not the label.** The API sends
  a `query` per word: the label's own words that the arc's coverage actually
  says, capped at two.

Both halves were reported as one bug — "the wordcloud shows irrelevant topics,
and clicking them shows no articles" — and they are two.

## The click returned nothing, and it was never going to

ADR-0013 made the cloud the one place a label is executed as a search, and that
reversal is right: a click has to mint a topic and spend an upstream call, or the
landing page teaches the demand-driven loop nothing (§9.3). What it did was run
the label **verbatim**, and that cannot work. `canonicalize` splits on
whitespace, upstream ANDs the terms, and it matches them against body text the
response never includes (PROBE-FINDINGS 3, where `bitcoin` returned 20, `volcano`
20, and `bitcoin volcano` 1).

Meanwhile ADR-0011 asks the labeler for the 2–5 words that name an *event*, so
it writes prose — "controversy", "detention", "pursuit". Prose is exactly what a
headline matcher will not conjoin with the proper nouns beside it. Every
label-shaped query in the dev archive, with the articles the topic accumulated:

```
{arday, controversy, jason, plagiarism}   0     {canada, tariffs, us}      307
{detention, family, hashemi, ice}         0     {air, force, one}          291
{lunar, pollution, space}                 0     {ballistic, korea, ...}    168
{haka, ma'a, nonu, solo}                  1     {hormuz, of, strait}       110
```

The left column is what the cloud produced; the right is what readers typed. And
the arc the first row names was in the store the whole time: three articles, from
`bbc.co.uk`, `dailymail.com` and `mises.org`. ADR-0013 predicted this failure's
*class* — "the search may return a timeline that is not the arc" — and understated
it. For a four-word label the search returns nothing at all.

**So the cloud searches the searchable part of the label.** `cloudQuery`
intersects the label's words, folded by `normalizeLabel`'s fold, with the
storyline's `profile_tokens`, keeps label order, and takes two — spelling each
one the way the LABEL spells it (see the amendment below):

```
"Jason Arday plagiarism controversy"  ->  jason arday
"Lindsay Clancy murder trial"         ->  lindsay clancy
"Florida Textbook Climate Revision"   ->  florida textbook
```

Nothing is invented and nothing is looked up — the profile is a column on the row
the cloud already read. Three choices inside it are worth stating:

- **Label order, not rarity.** Labels are written subject-first, so the leading
  words are the naming ones and the cap cuts prose off the end. Ranking the
  candidates by `story_token_df` instead would put the linker's trailing corpus
  on the cloud's request path to re-derive an ordering the label already carries.
- **Two terms.** Upstream is conjunctive and the probe measured how fast that
  bites. Two words from one story co-occur; a third is another chance for the
  body text to disagree, and the third word of a label is where the prose starts.
- **The fold is `labelWords`, not a second regex.** It exists because label words
  and corpus words must reach the same spelling for the same word, and it has
  already paid for that lesson once (`dillard'` against `dillard`). A label word
  the tokenizer would have thrown away is simply not in the profile and drops out
  without `cloudQuery` knowing why.

**The pill is the fallback, and it costs nothing.** `findSurfacedStorylines`
surfaces storylines whose `profile_tokens` contain every search keyword — and
every term `cloudQuery` emits is drawn from that same profile, so containment
holds by construction. (Amended: the terms are now the label's spelling of those
words rather than the folded spelling, so containment holds by a re-fold instead.
See the amendment.) The click that spends an upstream call also surfaces the
arc it came from, out of machinery that already shipped. This is how a reader
reaches those three Jason Arday articles even on a run where upstream returns
nothing. Under the old behaviour they got neither: `{jason, arday, plagiarism,
controversy} ⊆ {academic, arday, cambridge, jason, professor, university}` is
false, so there was no pill either.

What this does **not** do is make the search the arc. `canonicalize` is not the
linker and a keyword match over headlines is not a storyline; ADR-0013's
statement of that cost stands unchanged. What changes is that the reader lands on
a timeline instead of an empty one.

## The board led with its least-covered words

ADR-0013 gave the two visual channels one question each and made recency the
whole ordering, on the argument that an ordering answers "old versus breaking"
directly and needs no half-life. It reads well. It ranks badly, because it left
**nothing at all** deciding what is prominent — the baseline and the scorer were
deleted, and the only remaining gate was measured over the arc.

The live board, `en`, 31 qualifying storylines, 18 of them on exactly one
article:

| position | label | articles in window | outlets in window | colour |
|---|---|---|---|---|
| 1 | Hashemi Family ICE Detention | 1 | 1 | red |
| 5 | Jason Arday plagiarism controversy | 2 | 2 | red |
| 7 | US National Debt Surge | 11 | 10 | orange |
| 23 | Trump Canada | 10 | 10 | blue |
| 24 | Trade Deal | 17 | 11 | blue |

Every channel pointed the wrong way at once. Position and colour are the loudest
signals a cloud has, both keyed to recency, so the freshest arrivals took the top
of the board and the warm end of the ramp; and `sqrt(windowArticles)` ramped
across the board's extremes put all 18 single-article words at `FONT_MIN`
together, where size discriminated nothing. A reader looking at the board was
being shown the corpus's thinnest coverage first, and reasonably called it
irrelevant.

**The gate moves to the window.** ADR-0013 measured breadth over the arc
deliberately, and argued it: the question is whether several newsrooms have
covered this event, which is a fact about the story, so "a three-week storyline
that eleven outlets have carried is not disqualified because today's one new
article came from one of them". That reasoning is what this reverses. It answers
a question about the *story* on a page that is asking a question about *now* — and
in practice it admitted exactly the class of word above: one article, one outlet,
qualifying on breadth earned weeks ago. Asked over the window, the gate answers
what the landing page is posing: are several newsrooms covering this today.

The arc's breadth survives as `sourceCount`, a fact the response reports and no
longer gates on. The window gate subsumes it — a window's articles are a subset
of the arc's — so this is one gate moved, not two applied.

**Volume returns to the ordering, decayed.** `windowArticles * 0.5 ^ (age /
TREND_HALF_LIFE_HOURS)`, with the half-life back at ADR-0008's default of 8
hours, and ADR-0008's argument for exponential over linear carried unchanged: a
linear ramp separates a 1-hour-old story from a 5-hour-old one by 17% while
treating the 20-to-24-hour tail as significant. `TERM_HALF_LIFE_HOURS` was
deleted because recency had become the whole ordering; the moment volume rejoins
it, something has to say how fast volume ages, and inventing a second shape for
that would be inventing a disagreement.

A decay rather than "volume, then recency" because the tiebreak version has no
way to let go: an 8-article storyline from yesterday afternoon would hold the top
of a 24-hour board until it aged out. Both directions are pinned by tests.

**Colour is ranked, not read.** ADR-0013's palette read array position, which
*was* the recency rank. It no longer is, so `rankColors` sorts by `lastUpdated`
itself. Without that, size and colour would both answer "how much" and the cloud
would be back to the term cloud's single conflated score — the exact thing
ADR-0013's two channels were built to escape.

## Consequences

- **A thinner cloud, and honestly so.** The live board goes from 31 words to 13.
  ADR-0013 already warned that a cold deployment shows nothing for longer; this
  extends that to a *quiet* deployment, and the same empty-state copy covers it.
  The lever if 13 is too thin is `SAMPLE_PAGES` — more corpus — not a weaker
  gate.
- **A storyline is now breadth-gated once per language.** The gate applies after
  the language filter, so an arc with two English outlets and one German one is
  in the English cloud and not the German one. That follows from where the gate
  sits and is the right reading: each cloud answers its own readers' question.
- **`TREND_HALF_LIFE_HOURS` is a live knob wanting real traffic**, in ADR-0008's
  terms: much shorter than the window and the window's older half is decorative;
  much longer and the decay does nothing.
- **The wire gains `query` and `windowSources`.** No shim; the front end and the
  API ship together, as they did for ADR-0013. `windowSources` appears in the
  accessible detail line ("6 articles from 2 outlets in the last 24 hours")
  because it is the gate, and a reader should be able to see why a word is on the
  board.
- **The board draws one string and searches another.** A real cost, and the one
  thing here a reader could be surprised by: the word says "Jason Arday
  plagiarism controversy" and the search box then says "jason arday". The
  alternative is a click that lands on nothing, which is what shipped.
- **Two words can now run the same search.** `dedupeByLabel` keeps one word per
  LABEL, and two distinct labels can ground to the same two terms — the live
  board carries "US National Debt Surge" and "US National Debt Milestone", both
  querying `national debt`. Left alone deliberately: they are two different arcs
  and the cloud is honest to say so, the reader who clicks either gets a topic
  that covers both, and de-duplicating by query would delete a word naming a real
  storyline. Worth revisiting only if it turns out readers read two words as a
  promise of two destinations.
- **A label whose leading word is not its subject grounds awkwardly.**
  "Strengthening US El Niño" clicks through as `strengthening el`: both terms are
  in the coverage, so it is a search that works, but not the one a person would
  write. Label order is a heuristic about the labeler's prompt, not a guarantee.
  The fix, if this proves common, is the rarity ranking this ADR declined —
  `story_token_df` would rank `niño` above `strengthening` — at the cost of
  putting the trailing corpus on the cloud's request path.
- **An empty timeline still says so above its pill.** When the search returns
  nothing and the arc surfaces as a pill, the rail reads "No articles yet for
  'jason arday'" with the storyline offered directly above it. Accurate, and
  wrong in emphasis — the reader has somewhere to go and the copy does not say
  it. A `Rail` `emptyLabel` that names the surfaced storylines would close it;
  out of scope here, where the pill's existence was the thing that was missing.
- **`searchPlaceholder` offers `query` too.** It was suggesting readers type
  labels — that is, suggesting they type searches that return nothing.
- **A bad label now costs less than it did, but not nothing.** ADR-0013 raised
  the stakes on the labeler by putting labels on the landing page; grounding the
  click in the coverage lowers them again, because a label whose words the
  corpus never says falls back to the profile's own tokens rather than searching
  prose. That fallback keeps the pill and gives up on the subject: the profile is
  stored alphabetically, so the two tokens it takes are arbitrary, and the cloud
  will draw a good label over a search that does not name it. Accepted here
  because there is nothing left to name it WITH — the label has already failed to
  say a word its own coverage says — and rejected on the grounded path, where
  `cloud-query.test.ts` pins label order precisely so "climate" cannot beat
  "florida".

## Amended 2026-08-26: the query is spelled by the label, not by the fold

The fold is a comparison key, and this ADR spent it as a spelling. `singular`
drops a bare trailing `s` and nothing more — that is `grouping.ts`'s deliberate
choice, and its own comment accepts `boxe` on the grounds that both sides map to
it alike. True of a comparison. Not true of `cloudQuery`'s output, which is not a
key: it becomes `?q=`, the command bar's value, `searchPlaceholder`'s ghost text,
and the keywords handed to upstream `/search`. So a storyline named "Gaza Crisis
Talks" put **`gaza crisi`** on the landing page as a thing to read about, and then
asked Currents for it. Measured on the dev archive the same day: `nauticu` for
Nauticus PirateFest, `spaghetti model`, `charge`.

`labelWordForms` now returns each label word as `{surface, folded}` from one walk
of one label, and `normalizeLabel`/`labelWords` are written on top of it — the
"one definition of the fold" rule this ADR leans on is intact, the pair simply
carries both spellings out of it. `cloudQuery` **matches on `folded` and spells
with `surface`**. De-duplication stays on the fold, or a label saying "State
States" spends both of its two terms on one word.

**What this costs is the containment argument above.** "Every term `cloudQuery`
emits is drawn from that same profile, so containment holds by construction" was
this ADR's reason the pill is free, and a surface term is by definition not in
`profile_tokens`. Containment still holds — `timeline-service.ts` re-folds every
keyword before `findSurfacedStorylines` compares, and re-folding a surface always
recovers the fold it came from — but it holds because another module applies the
same fold first, not because of the shape of the data. That is now a stated
dependency in both files rather than a structural guarantee: drop that re-fold, or
add a caller of `findSurfacedStorylines` that passes raw keywords, and the pill
vanishes for exactly the click that minted the query.

**The profile-only fallback still shows the fold**, and cannot stop. When no label
word is grounded there is no surface to read off — `profile_tokens` is stored
folded — so that branch can still put `crisi` in front of a reader. It is the
branch for storylines that should not exist, and fixing it needs a surface corpus
on the cloud's request path (`story_tokens`), which is the cost this ADR declined
for the ordering question and would decline again for this one.

One consequence worth stating: `q` feeds the topic fingerprint, so a cloud click
whose query actually changes spelling re-fingerprints once and spends one upstream
call against a topic the store has under the old spelling.
