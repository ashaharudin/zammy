---
status: superseded by ADR-0013 (the cloud draws storyline labels, not terms; the stopword and desk-furniture findings still gate the tokenizer)
---

# The cloud stops at two-word phrases

Terms stay unigrams and bigrams (§10.2). Trigrams were measured against the
recorded corpora and refused: on this evidence a three-word term cannot outrank
a two-word one on merit, only by evading the baseline, and the two it produces
are a restatement of a phrase already in the cloud and a wire dateline.

What the ask was really after — a cloud of more specific, more clickable topics
— is answered instead by naming a class of words the breadth gate cannot
defend against, and by fixing a rendering defect that was already deleting the
cloud's biggest word.

## What the corpus says

Both recorded fixtures, collapsed by URL: 141 articles across 49 domains. The
gate cascade, by n-gram order — distinct, then `df_articles >= 2`, then
`df_domains >= 2`, then the §10.3 phrase gates (a proper noun anchors it, no
word of it is a verb). **Measured against the stopword vocabulary as it was
before the list this same change adds**, since that is what the question was
asked against. ADR-0006's verb lexicon landed while this was being measured and
moves none of these counts: nothing in the third-order term space these corpora
produce is a predicate.

| n | distinct | df ≥ 2 | domains ≥ 2 | + proper noun |
| --- | --- | --- | --- | --- |
| 1 | 2037 | 443 | 289 | **37** |
| 2 | 1574 | 110 | 20 | **11** |
| 3 | 893 | 49 | 5 | **2** |
| 4 | 480 | 22 | 1 | **0** |

The two survivors are `president donald trump` — df 3 over 3 domains, which is
`donald trump` and `president donald` to the digit, both already in the cloud —
and `los angeles ap`, from the `LOS ANGELES (AP) —` dateline of two unrelated
wire stories.

Under the vocabulary that now ships the same corpus gives `858 / 48 / 4 / 1` at
n = 3: the dateline trigram cannot exist any more, because `ap` became a
stopword lower down this page, and the sole survivor is the restatement. The
verdict is the same either way, and the pre-change numbers are kept above
because they are the ones that decided it.

Across 56 subsampled runs (7 corpus sizes × 8 mulberry32 seeds) two distinct
trigrams appeared, neither carrying a word or an article its own run's cloud
lacked. Widening to 280 runs (40 seeds) turns up a third in 5 of them — `shape
tmk energy`, which does carry a new word. It is a sampling artifact rather than
a counterexample: at full corpus `tmk` is seen lowercase and fails the propriety
gate, and in a subsample that evidence can vanish. But it is also the `gas
flows` / `shape tmk` nonsense class §10.3 was rewritten to exclude, which is
what the third-order term space has to offer.

## The arithmetic is closed, not merely unlucky

`extractTerms` emits per-article sets, so every article emitting `a b c` also
emitted `a b` and `b c`. Article sets and domain sets are therefore **nested by
construction** — 0 violations across all 893 trigrams — and the nesting survives
`min(count, perDomainCap)` and `sqrt`. A trigram's entire score numerator is
bounded by both its bigrams'. It equals the sub-bigram minimum for 891 of 893;
844 of 893 sit at df 1 and can never clear a gate at all.

So with an empty baseline a trigram can only tie. **The one mechanism that
would let it win is the denominator**, and that is the argument against it, not
for it: a rarer phrase has a smaller trailing mean, so once the baseline is warm
the wordier restatement is systematically the *larger* word. With `donald trump`
running at df 3 a day it scores `sqrt(3)·3/6 = 0.866`, while a first-week
`president donald trump` on the same three articles scores `sqrt(3)·3/3 =
1.732`. The cloud would spend its biggest word on a phrase that names nothing
new.

## Considered options

**Trigrams as an add-on** (change `extractTerms`, change nothing else). The
cloud goes 33 → 35 terms and both additions duplicate terms already present, at
identical score. Note this needs *no* other code change, which is the trap:
`isBigram` is derived as `term.includes(" ")`, so a trigram would ship as
`is_bigram = true` through a NOT NULL column and the public `TrendingTerm`
contract, and the subsumption rule would keep working by accident. Nothing
fails loudly; `daily_terms` just quietly loses the ability to tell orders apart.

**Trigrams with the subsumption rule extended** — §10.3's own principle, "the
phrase is the more specific name for the topic", applied one level further. This
is the honest version of the feature and it is worse: 33 → **31** terms, because
it removes `donald trump`, `president donald`, `los angeles` and `angeles ap` to
add `president donald trump` and `los angeles ap`. It promotes the AP dateline
to be the sole survivor of its group and deletes the legitimate city name.

**A relaxed breadth gate for phrases**, so more trigrams qualify. Admits 45
bigrams and 27 trigrams, ~90% of them single-outlet CVE boilerplate from
`vulners.com` and `vuldb.com` — literally the Jenkins flood §10.3 built the gate
to stop.

**Entity adjacency** — join adjacent proper nouns into one term of any length,
instead of a blanket n-gram order. Attractive because it targets names rather
than word count, but measured it adds nothing: every proper-noun run clearing
both gates is already a cloud term, and `president` is not a proper noun under
the case test, so it is *narrower* than trigrams rather than better aimed.

## The two costs that would remain even if the yield were good

**A phrase cannot survive the click.** `canonicalize` lowercases, dedupes and
**sorts** the keywords, so `president donald trump` leaves as
`keywords=donald+president+trump` — byte-identical to any other ordering. Word
order, the only thing a phrase has over its parts, is discarded before the
request is built, and upstream has no phrase search to discard it into
(PROBE-FINDINGS §3: quoted and bare queries return different sets, and neither
is a phrase match). Matching is conjunctive — `bitcoin` 20 results, `volcano`
20, `bitcoin volcano` **1** — so a trigram's result set is bounded by every
bigram inside it. Over all 49 repeated trigram candidates: 44 tie with their
best contained bigram, 5 return strictly fewer, none return more. And the
fingerprint is taken over the sorted keyword array, so the click opens a
*different topic* with empty coverage and re-spends upstream quota to reach
articles the bigram's topic already holds.

**Long words do not shrink, they vanish.** See below; it is the reason the
second change in this ADR exists.

## Taken instead: wire services and desk furniture are stopwords

`ap`, `rep`, `ceo`, `daily`, `weekly` and their classes are not generic news
vocabulary in the §10.3 sense — they are *structural*. `LOS ANGELES (AP) —`
opens a wire story whatever it is about, so `ap` clears the `df_domains >= 2`
gate the moment two outlets carry AP copy, which is not two newsrooms
independently choosing a word — the only thing that gate is evidence for. The
propriety gate cannot help either: `AP`, `Rep.` and `CEO` are capitalized every
time and never seen lowercase, which is exactly the shape of a name.

Measured: the cloud goes 33 → 28 terms at 141 articles, removing exactly
`angeles ap`, `ceo`, `daily`, `rep` and `weekly`, and 51 → 47 at 183, where the
same four leave and `daily` has already fallen to the propriety gate on its own.
**Nothing else leaves and nothing new arrives**, and no article pair changes side
of the ADR-0005 grouping bar at either size.

`deal`, `file`, `files`, `review` and `share` were considered for the same list
and refused: each has a junk instance and a real one (`iran deal`, `epstein
files`), and the junk instance is already caught by the masthead word beside it.
`rci` was on the list and came off — its only appearance in the corpora is a
Malaysian Royal Commission of Inquiry, the subject of the story rather than the
byline. Radio Canada International never appears at all.

The list changes the **shared** tokenizer, so `TOKENIZER_VERSION` goes to 3 and
stored `title_tokens` behind it are a countable backlog for `pnpm regroup`
(ADR-0005). That is the whole of the migration.

## Measured and declined: un-stopwording `new`

`new` breaks an n-gram run rather than being skipped over, so `new york`, `new
zealand` and `new delhi` are unreachable at any n, with `york` and `zealand`
standing in. It sits in the list as generic news vocabulary from before the
propriety gate existed, so removing it looked free.

It is not, and the argument for it was a non-sequitur. "The gate suppresses
`new` on its own now" is true and beside the point: the gate admits a phrase
when **`.some()`** of its words is a proper noun, so `new` never has to qualify —
one name beside it is enough. `new gaza` and `new trump` clear every gate the
same way `new york` does, and the subsumption rule then drops `gaza` and `trump`
in favour of them. The cloud would not gain junk beside the real term; it would
**lose the real term**, and the replacement leaves as two ANDed keywords against
an upstream that narrows hard on the second one.

On the grouping side the compensating gate does not exist at all: `keepable` is
what `headlineTokens` filters through, and `properNounEvidence` lives only
inside `scoreTerms`. Returning a frequent token to that vocabulary can only
raise Jaccard for any pair that shares it, and can push `shared` across the
two-token floor `grouping.ts` documents as load-bearing. Constructed:
"New Rules For Drivers" / "New Rules For Landlords" go from `shared 1, 0.333` to
`shared 2, 0.500` — exactly the default threshold.

The measured gain, meanwhile, is zero: removing `new` changes no term at 141 or
183 articles, because every `New <Name>` phrase in the corpora occurs once, far
below the breadth gate. So this is §14.7's lesson in a new costume — an
unmeasured gain against a mechanism that fails toward deleting good output — and
it stays stopworded. Making it safe would need a phrase-position rule (a leading
common word cannot anchor a bigram), which is a change to the propriety gate
itself and wants its own measurement. **That measurement has since been taken
and the rule refused — see the amendment at the end of this page.**

## Measured and declined: folding dotted initialisms

`u.s. open` and `j.d. vance` are unreachable because `splitTokens` splits on the
periods and `keepable` drops what is left as too short. The obvious fix — fold
`U.S.` to `US` before splitting — was implemented and measured, and it does not
work. The three fixtures contain five distinct dotted forms (`U.S.`×7, `e.g.`×2,
`S.C.`×1, `a.m.`×1, `p.m.`×1). Folding delivers **none** of its targets, because
the common one collides: `U.S.` folds to `us`, which is already a stopword for
the pronoun. What it does add is one term — `sc`, out of the `COLUMBIA, S.C.
(AP)` dateline this ADR is otherwise busy removing.

The variant that avoids the collision — keeping an internal period the way the
tokenizer already keeps internal hyphens, so `U.S.` becomes the distinct token
`u.s` — needs its own stopwords for `e.g`, `a.m` and `p.m`, and renders terms
like `u.s open`. That is no longer a cheap fix, and nothing in the recorded
corpora argues for it. Left undone deliberately, with the measurement here so
the next person does not re-derive it.

## Consequences

- **A three-word entity cannot appear, and that is a real limit.** `new york
  times`, `world cup final`, `los angeles lakers` will show up as their
  strongest contained bigram or not at all. None of them clears the breadth gate
  in the recorded corpora — `new york times` occurs once and the other two never
  — so the limit is named rather than measured.
- **The evidence is corpus-bounded, and the corpora are snapshots.** One fixture
  spans 13 minutes, the other 18 hours, and §10.1 describes production as ~24
  hourly snapshots plus stored user searches. Subsampling a fixed corpus
  measures how fast its own terms are re-discovered, not how a cloud grows when
  genuinely new articles arrive, so nothing here extrapolates to a full day.
  What does carry is the part that is structural: the df nesting, the baseline
  inversion, the sorted-keyword click and the render bound hold at any corpus
  size.
- **The cloud is not always starved, and above the cap additions displace.** At
  141 articles it emits 28 terms against a 40–50 cap, and 47 at 183 — inside the
  cap, but the pre-stopword figures were 33 and 51, so a day's corpus crossing
  it is an ordinary event rather than a distant one. Once it does, a new
  extraction mode does not add terms, it displaces them, and displacement is
  decided by an alphabetical tiebreak among score ties — which is exactly where
  trigrams live, all of them tied with the bigrams they restate.
- **`is_bigram` is still a write-only field.** Nothing in `apps/web` reads it,
  and ARCHITECTURE §10.4's own response contract never listed it. Keeping
  bigrams as the ceiling means it stays honest; dropping it is a separate
  cleanup this ADR does not take.
- **Revisiting this needs one new measurement, not a rerun.** The question is
  whether a day's real corpus produces three-word phrases that clear
  `df_domains >= 2` and are *not* restatements. Score a live day's
  `daily_terms` corpus at n = 3 and count net-new terms; the answer here was 0
  of 56 runs.

## Amended in the same change: d3-cloud drops what it cannot fit

Investigating how a 22-character term would render turned up a hazard at the
shipped `n <= 2`. d3-cloud does not shrink, wrap or warn about a word too wide
for the board: `place()` rejects any candidate box crossing the edge, and a word
that never places is simply absent from the array handed to `.on("end")`.
Because font size is assigned by rank, the top-scoring term meets the bound
first. It stays in the accessible `<ol>` regardless, so the visual and assistive
views disagree with nothing signalling why.

Verified against d3-cloud 1.2.9 on an empty 700px board: at font 56,
`artificial intelligence` (23 chars) and `president donald trump` (22) are both
dropped, while `democratic primary` (18, the longest term the fixtures produce)
places at any size.

**No term the recorded corpora emit is long enough to trigger this today**, so
the clamp is a guard rather than a repair. `artificial intelligence` clears both
df gates but is stopped by the propriety gate — both words appear lowercase in
the prose — so `ai` is what ships. The bound is worth having anyway because
nothing announces when it is crossed: any term past 20 characters is
unplaceable above ~55px, the cloud simply omits it, and the `<ol>` goes on
listing it.

`fontSizes` now clamps by length as well as by score, inverting d3-cloud's own
measurement — it sizes boxes from `⌊size + 1⌋` px, pads by 1 and rounds up to a
32px bucket, so the bound is `length × advance × (font + 1) + 1 + 32 <= width`.
The clamp sits *below* the measured drop boundaries (20 chars → 54.9px, 22 →
49.9, 26 → 42.9, 30 → 36.9) with margin for whichever monospace face the browser
resolves. A word too long for `FONT_MAX` now renders smaller instead of
disappearing, and every term the cloud shows today is unaffected.

The cost is that font size becomes slightly less faithful to score for long
terms. §10.5 already says font size is decorative and the article count is the
accessible signal, so this trades the weaker channel to keep the word on screen.

## Amended 2026-08-11: the phrase-position rule is closed, not open

The question left open above — would a phrase-position rule make un-stopwording
`new` safe? — was measured against all three recorded fixtures, collapsed by URL
as `term-scoring.test.ts` does: 141 articles / 49 domains for the two the page
already uses, 183 / 73 with `search-climate-duplicates`. **No code changed. The
rule is refused, and not on yield: it is refuted structurally.**

`new york` and `new trump` are the same shape — a non-proper leading word
followed by a proper trailing one. They differ in neither position nor
propriety, only in document frequency, so no rule reading positions can separate
them. Whichever way such a rule points it must treat the pair alike: point it at
the leading word and both are refused, point it at the trailing word and both
are admitted. This is the same kind of closure as "the arithmetic is closed"
above — a bound on the mechanism, not a shortfall in the corpus.

Both readings were implemented and scored anyway, because the class each one
costs is worth knowing.

### Reading 1: the leading word must be a proper noun

| corpus | terms | lost | gained |
| --- | --- | --- | --- |
| 141 | 28 → 27 | `president donald`, `world cup` | `cup` |
| 183 | 47 → 46 | `president donald`, `world cup` | `cup` |

The rule **cannot gain a phrase**: `isProperNoun(words[0])` admits a strict
subset of `.some(isProperNoun)`, so the only way a term can arrive is a unigram
resurrected by the bigram that used to subsume it. `cup` standing in for `world
cup` is the entire upside, and it is the trigram trade run backwards — a less
specific name for the same topic.

Across 56 subsampled runs (7 sizes × 8 mulberry32 seeds, the method used higher
up this page) the cloud changes in 30 of them, net **−24 terms** summed over all
runs. Four distinct bigrams are removed: `president donald` ×24, `world cup`
×17, `abdul el-sayed` ×5, `tmk energy` ×1. Three are names — one of them a
person's full name — against one instance of the `shape tmk` nonsense class. 46
removals of real terms to 1 of junk.

Two pinned expectations fail under it. `world cup` is asserted present by the
wire-and-desk block of `term-scoring.test.ts`, and `displaced kelowna` by
ADR-0006's participle case. The second is the more telling: ADR-0006 wrote the
`index > 0` guard *because* a modifier in front of a name is a modifier ("armed
forces", "planned parenthood"), and this rule deletes that whole class from the
propriety side immediately after the verb lexicon was built to protect it.

The class is not an artifact of two fixtures. Six constructed trailing anchors,
each using its modifier lowercase once in prose the way running text does — the
condition that makes the leading word fail the case test in any real corpus —
are all six deleted: `hurricane milton`, `storm milton`, `president donald`,
`mount fuji`, `lake michigan`, `cyclone freddy`. What survives in their place is
what §10.3 and ADR-0006 exist to exclude: `milton nears`, `nears landfall`,
`donald speaks`, `freddy batters`. The rule deletes the name and keeps the
clause.

The narrower variant the question suggested — `.some()` as shipped, plus a small
modifier list (`new`, `world`, `president`, `hurricane`, `storm`, `tropical`)
barred from leading — measures **identically** on the fixtures (28 → 27, 47 →
46, the same two terms lost, `cup` gained) and identically on the
counterfactual. It cannot do better: barring `new` from leading is precisely
what refuses `new york`.

### Reading 2: the trailing word must be a proper noun

At 183 it loses `australian river`, `democratic primary`, `senate primary` and
`united states`, gaining bare `australian`, `democratic`, `united`; at 141 it
loses `democratic primary` and `senate primary` for `democratic`. And it leaves
the hazard exactly where it was — on the synthetic corpus below it admits `new
trump`, which then deletes `trump`, which is the failure `new` was declined over.

### The counterfactual, on synthetic corpora

Each `New <Name>` phrase occurs once in the fixtures, far below the breadth
gate, so two corpora were constructed: three articles across three domains in
which every `York` sits inside `New York`, and six across four in which `Trump`
appears alone in four articles and `New Trump` in two.

| variant | new-york corpus | new-trump corpus |
| --- | --- | --- |
| shipped gate, `new` stopworded | `york` 3 | `trump` 6 |
| shipped gate, `new` freed | `new york` 3 | `new trump` 2 — **`trump` deleted** |
| leading rule, `new` freed | `york` 3 | `trump` 6 |
| trailing rule, `new` freed | `new york` 3 | `new trump` 2 — **`trump` deleted** |
| narrow rule, `new` freed | `york` 3 | `trump` 6 |
| shipped gate + contained subsumption, `new` freed | `new york` 3 | `trump` 6 *and* `new trump` 2 |

Row 2 is this page's original argument, previously reasoned and now measured: a
df-2 phrase deletes a df-6 name. Every variant that keeps `trump` fails to
deliver `new york`, and the one row that does both is not a position rule.

### What would actually work, and what it costs

The separating fact is coverage, which is what the subsumption rule's own
comment claims to be about — "every `Ben Carroll` headline also produced `ben`"
— and does not check. `new york` covers 3 of `york`'s 3 articles; `new trump`
covers 2 of `trump`'s 6.

Requiring full coverage before a phrase deletes a word is a small change and it
is not free. At 183 it adds six unigrams the shipped rule deletes today, every
one of them a partial covering:

| unigram | df | covering phrase(s) | df |
| --- | --- | --- | --- |
| `trump` | 9 | `donald trump` | 4 |
| `democratic` | 5 | `democratic primary` | 3 |
| `michigan` | 4 | `michigan senate` | 2 |
| `senate` | 4 | `michigan senate`, `senate primary` | 2, 2 |
| `abdul` | 3 | `abdul el-sayed` | 2 |
| `australian` | 3 | `australian river` | 2 |

That is a change to what the cloud *is* — 47 → 53 terms — defensible on its own
evidence, since a term covering 9 articles is currently deleted in favour of one
covering 4, and pinned against by `term-scoring.test.ts`, which asserts `trump`
is absent. It wants its own ADR, and freeing `new` is not the argument for it:
with contained subsumption in place, freeing `new` still changes **no term at
183**, and its effect on the synthetic corpus is to add `new trump` beside
`trump` rather than instead of it — junk gained, which is the cost this page
originally said it would rather have than a deletion, but a cost with no
measured gain behind it.

### The grouping bar, measured regardless

5 of the 183 titles contain `new`. Same-story pairs under the ADR-0005 bar
(Jaccard ≥ 0.5 with the 2-shared-token floor, over **all** pairs — a superset of
the same-day, same-language bound) hold at **15 → 15** with `new` freed, and no
pair crosses in either direction. The constructed hazard reproduces unchanged:
"New Rules For Drivers" / "New Rules For Landlords" go from `shared 1, 0.333` to
`shared 2, 0.500`, exactly the default threshold. The cost is therefore still
real and still invisible in this corpus.

Since nothing here changes the stopword list, `TOKENIZER_VERSION` stays at 3 and
there is no `pnpm regroup` backlog to clear.

### Verdict

`new` stays a stopword, the propriety gate keeps `.some()`, and `new york`, `new
zealand` and `new delhi` stay unreachable — a named limit, as above. The open
question is now closed: the position rule was the cheap candidate and it is
refuted from both directions at once, deleting names it should keep while
refusing the names it was proposed for. The live thread for anyone returning to
this is the subsumption rule's missing coverage check, measured above, which
stands or falls on its own account and not on `new`.
