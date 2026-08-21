---
status: accepted (the cloud stopped drawing terms in ADR-0013; the lexicon still gates the bigram label)
---

# A curated verb lexicon keeps predicates out of the cloud

A cloud term is rejected when any of its words is a verb form, decided against
a hand-curated lexicon of ~600 English news verbs
(`apps/api/src/verb-lexicon.ts`) rather than by morphology or corpus
statistics. Two guards restrain it: a word carrying proper-noun evidence is
never read as a verb, and a past participle counts only after the first word —
in front it modifies ("armed forces"), after a name it predicates. (The first
guard now carries a per-caller threshold — see "Amended 2026-08-21" below.)

This closes the second junk class the propriety gate opened. Requiring a proper
noun in every term (§10.3) removed phrases of two common words but let one name
drag the rest of its headline in with it. On the live cloud of 2026-08-12,
twelve of forty-two terms were fragments of that shape, six a name beside a
verb: `graham advances`, `graham moved`, `trump slipped`, `giving rob`,
`schaffer reflects`, `leaving turkey`. A topic is a nominal; a name plus a verb
is a headline with its middle removed, and it leads nowhere when clicked.

The separation cannot be morphological — "funding" and "games" wear the same
`-ing` and `-s` as "giving" and "advances", so a suffix rule takes `medicaid
funding` and `patriot games` with the junk. What differs is the lemma, so the
lexicon is split by which inflection has nominalized: verbs whose `-s` and
`-ing` both stay verbal fire on any inflection; verbs whose `-ing` became a
noun (warn/warning, spend/spending) fire on `-s` and `-ed` only; verbs whose
`-s` is also a plural noun (fund/funds, game/games, vote/votes) fire only in
the past tense, since no English plural ends in `-ed`.

## Considered options

Four rules were designed independently and measured against the same 80-article
live corpus with a hand-labelled gold set — six name+verb phrases to remove,
twenty real topics to preserve. **All four scored 6/6 with zero collateral**,
so the gold set carried no discriminating information and the choice was made
on unseen corpora: the repo's two other recorded fixtures plus news days
written by the judges.

**Distributional (nominal-position) evidence** — every word must be seen
somewhere in the corpus in a slot only a noun can fill. The best fit with this
codebase (it is `properNounEvidence` pointed at a second question), but it
demands *positive* evidence for every word and fails toward killing: it
systematically deletes plural common-noun heads — sanctions, talks, votes,
files, drones, orders, earnings — the grammatical signature of hard news,
reweighting the cloud toward soft singular abstractions. On a thin corpus it
deletes most of what it should keep.

**Capitalized adjacency** — a real multi-word name appears as a contiguous
capitalized run in prose ("Secret Service"); a name+verb pair never does. The
most elegant idea and the highest kill power, rejected for the same structural
flaw with worse numbers: it destroyed real topics across every unseen corpus,
including `fed minutes`, `iran sanctions`, `epstein files` and `nvidia
earnings`.

**Inflection accuses, corpus acquits** — suspect on `-ed`/`-ing`/`-s`, acquit
on corpus noun-slot evidence. The most general rule, rejected as too little
delivered: structurally blind to irregular pasts ("Trump won", "Graham fell",
"Iran met"), and its acquittal cannot distinguish "flood control funding" from
"the mayor advances a plan".

The lexicon wins on the property the others lack: **its kill decision needs no
corpus evidence at all**, so it behaves identically on five articles and five
hundred, and its errors are curation mistakes — auditable, fixable in one file
— rather than statistics of the day. It had the highest precision on the unseen
corpora and removes nothing from the repo's other two fixtures. Precedent:
`NEWS_EXTENSION` in `stopwords.ts` already hand-curates news vocabulary because
no day-one statistic can do the job.

## What this costs

**Curation ages and is English-only.** An unlisted verb passes as junk,
silently, until noticed — the same maintenance the stopword list carries,
justified the same way: headline *predicates* are a small, closed, slow-moving
vocabulary; the names beside them turn over daily.

**Some real topics are lost to judgement calls.** "advance" is a full verb, so
"medical advances" loses it; the same exposure exists on "leaves", "remains"
and "saves". Expected rather than observed.

**Neither guard is justified by this corpus.** Removing the proper-noun guard,
or letting past forms fire in first position, leaves the measurement at 6/6 and
zero collateral. Both are insurance bought on off-corpus reasoning ("planned
parenthood", "Sitting Bull"); the eval will not defend them.

**It is silently disarmed by a corpus with no lowercase prose.** An all-caps or
uniformly Title-Cased feed reads as all names, switching the lexicon off.
Inherited from the case-evidence gate — such a corpus already yields a garbage
cloud — but the failure mode to fix first if headline-only sources are added.

**It does nothing for the adjective/title + name class** — `president trump`,
`late sen`, `potential iranian`, `graham darline` are nominals and survive.
Still open.

## Amended 2026-08-21: the proper-noun guard now has a threshold, and it differs by caller

"A word carrying proper-noun evidence is never read as a verb" was unconditional
above. It is now unconditional only for **grounding**; the **verb gate** asks for
that evidence from two distinct members.

The guard was never free, and one shape made it free enough to break: a press
release that quotes its own Title Case headline inside its own body. The sentence
split glues that Title Case run onto the prose sentence after it, so a single
article supplies both the mid-segment capital and the lowercase word that makes
the segment count as prose — and on a storyline of two or three members, one
article was the whole corpus. `Gigabyte Brings` and `Lufthansa Discover` were
labelled that way with `brings` and `discover` already in the lexicon: the guard
outranked it on evidence one article had manufactured about itself.

The two gates are asymmetric because their errors are:

- **Grounding** stays at one member. A wrong refusal there costs a real label
  outright, and the note above ("neither guard is justified by this corpus")
  argues for keeping the cheap side cheap.
- **The verb gate** asks for two. A wrong `true` there admits a clause the
  lexicon had already caught — the exact junk class this ADR exists to refuse.

An article echoing itself is one source. Measured over 3,471 live multi-group
storylines: 13 labels move, nine of them clauses refused, against one real name
lost (`Flying Eagles` → `Eagles Cruise`). A bar of three was tried and rejected —
it costs `Justin Rose` and moves nothing else.

The lexicon's bare-form classification was widened in the same change, on a
separate hole: headline style puts a plural subject in front of the *bare* verb
("Brewers place RHP … on 15-day IL"), which the `-s`/`-ing`/`-ed` routes cannot
reach. See docs/STORYLINE-LABELS.md for that half.

**A lemma belongs to exactly one classification list**, and that is now checked
mechanically rather than by re-reading the file: `ok` was copied into a second
list in this very change, behaviourally inert and therefore invisible to every
test that asserts only observable gating.
