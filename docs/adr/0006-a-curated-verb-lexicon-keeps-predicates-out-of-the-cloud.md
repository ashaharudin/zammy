---
status: accepted (the cloud stopped drawing terms in ADR-0013; the lexicon still gates the bigram label)
---

# A curated verb lexicon keeps predicates out of the cloud

A cloud term is rejected when any of its words is a verb form, decided against a
hand-curated lexicon of ~600 English news verbs (`apps/api/src/verb-lexicon.ts`)
rather than by morphology or by corpus statistics. Two guards restrain it: a word
carrying proper-noun evidence is never read as a verb, and a past participle counts
only after the first word, because in front it modifies ("armed forces") while after
a name it predicates.

This closes the second junk class the propriety gate opened. Requiring every term to
carry a proper noun (§10.3) removed phrases of two common words — "slipped away",
"gas flows" — but let one name drag the rest of its headline in with it. Measured on
the live cloud of 2026-08-12, twelve of forty-two terms were fragments of that
shape, six of them a name beside a verb: `graham advances`, `graham moved`,
`trump slipped`, `giving rob`, `schaffer reflects`, `leaving turkey`. A topic is a
nominal; a name plus a verb is a headline with its middle removed, and it leads
nowhere when clicked.

The separation cannot be morphological, which is the whole reason this needed
deciding. "funding" and "games" wear the same `-ing` and `-s` as "giving" and
"advances", so a suffix rule takes `medicaid funding` and `patriot games` with the
junk. What differs is the lemma, so the lexicon is split by which inflection has
nominalized: verbs whose `-s` and `-ing` both stay verbal fire on any inflection;
verbs whose `-ing` became a noun (warn/warning, spend/spending) fire on `-s` and
`-ed` only; verbs whose `-s` is also a plural noun (fund/funds, game/games,
vote/votes) fire only in the past tense, since no English plural ends in `-ed`.

## Considered options

Four rules were designed independently and each measured against the same 80-article
live corpus with a hand-labelled gold set — six name+verb phrases to remove, twenty
real topics to preserve. **All four scored 6/6 with zero collateral**, so the gold set
carried no discriminating information and the choice was made on unseen corpora
instead: the repo's two other recorded fixtures, plus news days written by the judges.

**Distributional (nominal-position) evidence.** Every word must be seen somewhere in
the corpus in a slot only a noun can fill — after a determiner, before a relative
pronoun, heading a noun-noun compound. The best fit with this codebase by a distance:
it is `properNounEvidence` pointed at a second question, same signature, same scan,
same conservative-by-construction stance. Rejected because it demands *positive*
evidence for every word and therefore fails toward killing. It systematically deletes
plural common-noun heads — sanctions, talks, votes, files, drones, orders, earnings —
which is the grammatical signature of hard news, so it does not merely lower recall,
it reweights the cloud toward soft singular abstractions. On a small or thin corpus
it deletes most of what it should keep.

**Capitalized adjacency.** Extend the case-evidence test from one token to two: a real
multi-word name appears as a contiguous capitalized run in prose ("Secret Service"),
a name+verb pair never does. The most elegant idea in the set and the highest kill
power. Rejected for the same structural flaw with worse numbers — it destroyed real
topics across every unseen corpus tested, including `fed minutes`, `iran sanctions`,
`epstein files` and `nvidia earnings`.

**Inflection accuses, corpus acquits.** Suspect a word on `-ed`/`-ing`/`-s`, then let
corpus noun-slot evidence acquit it. Judged the most general rule of the four, because
the accusation needs no corpus at all. Rejected as too little delivered: it is
structurally blind to irregular pasts ("Trump won", "Graham fell", "Iran met"), where
there is no suffix to find, and its acquittal step cannot distinguish "flood control
funding" from "the mayor advances a plan" — the same shape.

The lexicon wins on the property the others lack: **its kill decision needs no corpus
evidence at all**, so it behaves identically on five articles and on five hundred, and
its errors are curation mistakes — auditable and fixable in one file — rather than
statistics of the day. Measured across the unseen corpora it had the highest precision
of the four, and run against the repo's other two recorded fixtures it removes nothing
at all. It also has the closest precedent in the codebase: `NEWS_EXTENSION` in
`stopwords.ts` already hand-curates news vocabulary for exactly this reason, that no
statistic available on day one can do the job.

## What this costs

**Curation ages and is English-only.** Any verb not on the list passes through as junk,
silently and permanently until someone notices. This is the same maintenance the
stopword list already carries, and the same argument justifies it: the vocabulary of
headline *predicates* is small, closed in practice and slow to change, while the names
beside them turn over daily. The lexicon is the stable half of the phrase.

**Some real topics will be lost to judgement calls.** "advance" is treated as a full
verb, so a corpus about "medical advances" loses it; the same exposure exists on
"leaves" (foliage), "remains" (human remains) and "saves" (baseball). These are
expected rather than observed.

**Neither guard is justified by this corpus.** Removing the proper-noun guard, or
letting past forms fire in first position, leaves the measurement unchanged at 6/6 and
zero collateral. Both are insurance bought on off-corpus reasoning ("planned
parenthood", "Sitting Bull"), and a reviewer who dislikes unmeasured code should know
the eval will not defend them.

**It is silently disarmed by a corpus with no lowercase prose.** The proper-noun guard
reads an all-caps or uniformly Title-Cased feed as all names, which switches the
lexicon off entirely. This is inherited from the case-evidence gate rather than
introduced here — that corpus already produces a cloud of garbage with or without this
rule — but it is the failure mode to fix first if headline-only sources are ever added.

**It does nothing for the adjective/title + name class**, which is the other half of
what the live cloud showed: `president trump`, `late sen`, `potential iranian`,
`graham darline` are all nominals and all survive. That class is still open.
