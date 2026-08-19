---
status: superseded by ADR-0013 (the cloud draws storyline labels, not terms; the stopword and desk-furniture findings still gate the tokenizer)
---

# The cloud stops at two-word phrases

Terms stay unigrams and bigrams (§10.2). Trigrams were measured against the
recorded corpora and refused: on this evidence a three-word term cannot outrank
a two-word one on merit, only by evading the baseline, and the two it produces
are a restatement of a phrase already in the cloud and a wire dateline. What
the ask was really after — more specific, more clickable topics — is answered
instead by stopwording a class of words the breadth gate cannot defend against,
and by fixing a rendering defect that was already deleting the cloud's biggest
word.

## What the corpus says

Both recorded fixtures, collapsed by URL: 141 articles across 49 domains. The
gate cascade by n-gram order — distinct, then `df_articles >= 2`, then
`df_domains >= 2`, then the §10.3 phrase gates — measured against the stopword
vocabulary as it was before the list this change adds, since that is what the
question was asked against. ADR-0006's verb lexicon moves none of these counts.

| n | distinct | df ≥ 2 | domains ≥ 2 | + proper noun |
| --- | --- | --- | --- | --- |
| 1 | 2037 | 443 | 289 | **37** |
| 2 | 1574 | 110 | 20 | **11** |
| 3 | 893 | 49 | 5 | **2** |
| 4 | 480 | 22 | 1 | **0** |

The two survivors: `president donald trump` — df 3 over 3 domains, matching
`donald trump` and `president donald` to the digit, both already in the cloud —
and `los angeles ap`, from the `LOS ANGELES (AP) —` dateline of two unrelated
wire stories. Under the vocabulary that now ships the same corpus gives
`858 / 48 / 4 / 1` at n = 3 (`ap` became a stopword, so the dateline trigram
cannot exist); the verdict is the same either way.

Across 56 subsampled runs (7 corpus sizes × 8 mulberry32 seeds) two distinct
trigrams appeared, neither carrying a word or article its own run's cloud
lacked. Widening to 280 runs (40 seeds) turns up a third in 5 of them — `shape
tmk energy`, which does carry a new word, but is a sampling artifact: at full
corpus `tmk` is seen lowercase and fails the propriety gate. It is also the
`gas flows` nonsense class §10.3 was rewritten to exclude — which is what the
third-order term space has to offer.

## The arithmetic is closed, not merely unlucky

`extractTerms` emits per-article sets, so every article emitting `a b c` also
emitted `a b` and `b c`. Article and domain sets are **nested by construction**
— 0 violations across all 893 trigrams — and the nesting survives
`min(count, perDomainCap)` and `sqrt`, so a trigram's score numerator is
bounded by both its bigrams'. It equals the sub-bigram minimum for 891 of 893;
844 sit at df 1 and can never clear a gate.

With an empty baseline a trigram can only tie. **The one mechanism that would
let it win is the denominator**, which is the argument against it: a rarer
phrase has a smaller trailing mean, so once the baseline is warm the wordier
restatement is systematically the *larger* word — `donald trump` at df 3 a day
scores `sqrt(3)·3/6 = 0.866` while a first-week `president donald trump` on the
same articles scores `sqrt(3)·3/3 = 1.732`. The cloud would spend its biggest
word on a phrase naming nothing new.

## Considered options

**Trigrams as an add-on** (change `extractTerms` only). The cloud goes 33 → 35
terms, both additions duplicating present terms at identical score. Needing no
other change is the trap: `isBigram` is derived as `term.includes(" ")`, so a
trigram ships as `is_bigram = true` through a NOT NULL column and the public
`TrendingTerm` contract. Nothing fails loudly; `daily_terms` quietly loses the
ability to tell orders apart.

**Trigrams with the subsumption rule extended** one level, per §10.3's own
principle. The honest version, and worse: 33 → **31** terms — it removes
`donald trump`, `president donald`, `los angeles` and `angeles ap` to add
`president donald trump` and `los angeles ap`, promoting the AP dateline and
deleting the legitimate city name.

**A relaxed breadth gate for phrases.** Admits 45 bigrams and 27 trigrams,
~90% single-outlet CVE boilerplate from `vulners.com` and `vuldb.com` —
literally the Jenkins flood §10.3 built the gate to stop.

**Entity adjacency** — join adjacent proper nouns into one term of any length.
Targets names rather than word count, but adds nothing: every proper-noun run
clearing both gates is already a cloud term, and `president` fails the case
test, so it is *narrower* than trigrams, not better aimed.

## The two costs that would remain even if the yield were good

**A phrase cannot survive the click.** `canonicalize` lowercases, dedupes and
**sorts** the keywords, so `president donald trump` leaves as
`keywords=donald+president+trump` — word order, the only thing a phrase has
over its parts, is discarded before the request is built, and upstream has no
phrase search to receive it (PROBE-FINDINGS §3). Matching is conjunctive —
`bitcoin` 20 results, `volcano` 20, `bitcoin volcano` **1** — so a trigram's
result set is bounded by every bigram inside it: over all 49 repeated trigram
candidates, 44 tie with their best contained bigram, 5 return strictly fewer,
none more. And the fingerprint is taken over the sorted keywords, so the click
opens a *different topic* with empty coverage, re-spending quota to reach
articles the bigram's topic already holds.

**Long words do not shrink, they vanish** — see the d3-cloud amendment below.

## Taken instead: wire services and desk furniture are stopwords

`ap`, `rep`, `ceo`, `daily`, `weekly` and their classes are *structural*, not
generic news vocabulary. `LOS ANGELES (AP) —` opens a wire story whatever it is
about, so `ap` clears `df_domains >= 2` the moment two outlets carry AP copy —
which is not two newsrooms independently choosing a word, the only thing that
gate is evidence for. The propriety gate cannot help: `AP`, `Rep.` and `CEO`
are always capitalized and never seen lowercase — exactly the shape of a name.

Measured: 33 → 28 terms at 141 articles, removing exactly `angeles ap`, `ceo`,
`daily`, `rep` and `weekly`; 51 → 47 at 183, where `daily` had already fallen
to the propriety gate. **Nothing else leaves and nothing new arrives**, and no
article pair changes side of the ADR-0005 grouping bar at either size.

`deal`, `file`, `files`, `review` and `share` were considered and refused: each
has a junk instance and a real one (`iran deal`, `epstein files`), and the junk
is already caught by the masthead word beside it. `rci` came off the list — its
only appearance is a Malaysian Royal Commission of Inquiry, the story's
subject, not a byline.

The list changes the **shared** tokenizer, so `TOKENIZER_VERSION` goes to 3 and
stale `title_tokens` are a countable backlog for `pnpm regroup` (ADR-0005).

## Measured and declined: un-stopwording `new`

`new` breaks an n-gram run rather than being skipped, so `new york`, `new
zealand` and `new delhi` are unreachable at any n. It entered the list before
the propriety gate existed, so removing it looked free. It is not: the gate
admits a phrase when **`.some()`** of its words is a proper noun, so `new`
never has to qualify — `new gaza` and `new trump` clear every gate the way
`new york` does, and the subsumption rule then drops `gaza` and `trump` in
their favour. The cloud would not gain junk beside the real term; it would
**lose the real term**, and the replacement leaves as two ANDed keywords
against an upstream that narrows hard on the second one.

On the grouping side no compensating gate exists: `properNounEvidence` lives
only inside `scoreTerms`, so returning a frequent token to `headlineTokens`'
vocabulary can only raise Jaccard and can push `shared` across the two-token
floor. Constructed: "New Rules For Drivers" / "New Rules For Landlords" go from
`shared 1, 0.333` to `shared 2, 0.500` — exactly the default threshold.

The measured gain is zero — removing `new` changes no term at 141 or 183
articles, every `New <Name>` phrase occurring once, far below the breadth gate.
An unmeasured gain against a mechanism that fails toward deleting good output
(§14.7's lesson again), so it stays stopworded. Making it safe would need a
phrase-position rule — a change to the propriety gate itself. **That
measurement has since been taken and the rule refused; see the amendment at the
end of this page.**

## Measured and declined: folding dotted initialisms

`u.s. open` and `j.d. vance` are unreachable because `splitTokens` splits on
the periods and `keepable` drops the fragments as too short. Folding `U.S.` to
`US` before splitting was implemented and measured: the fixtures contain five
dotted forms (`U.S.`×7, `e.g.`×2, `S.C.`×1, `a.m.`×1, `p.m.`×1), folding
delivers **none** of its targets — `U.S.` folds to `us`, already a stopword for
the pronoun — and adds one term, `sc`, out of the `COLUMBIA, S.C. (AP)`
dateline this ADR is otherwise removing. The collision-free variant (keep an
internal period, `U.S.` → token `u.s`) needs its own stopwords for `e.g`, `a.m`
and `p.m` and renders terms like `u.s open` — no longer a cheap fix, and
nothing in the corpora argues for it. Left undone deliberately, with the
measurement recorded so it is not re-derived.

## Consequences

- **A three-word entity cannot appear, and that is a real limit.** `new york
  times`, `world cup final`, `los angeles lakers` show up as their strongest
  contained bigram or not at all. None clears the breadth gate in the recorded
  corpora, so the limit is named rather than measured.
- **The evidence is corpus-bounded.** One fixture spans 13 minutes, the other
  18 hours; production is ~24 hourly snapshots plus stored searches (§10.1).
  Subsampling a fixed corpus measures re-discovery of its own terms, so nothing
  here extrapolates to a full day — except the structural part: the df nesting,
  the baseline inversion, the sorted-keyword click and the render bound hold at
  any corpus size.
- **Above the 40–50 cap, additions displace.** 28 terms at 141 articles, 47 at
  183 (pre-stopword: 33 and 51), so a day's corpus crossing the cap is
  ordinary. Displacement is decided by an alphabetical tiebreak among score
  ties — exactly where trigrams live, all tied with the bigrams they restate.
- **`is_bigram` is still a write-only field.** Nothing in `apps/web` reads it
  and §10.4's response contract never listed it. Keeping bigrams as the ceiling
  keeps it honest; dropping it is a separate cleanup.
- **Revisiting this needs one new measurement, not a rerun**: score a live
  day's corpus at n = 3 and count net-new terms clearing `df_domains >= 2`
  that are not restatements. The answer here was 0 of 56 runs.

## Amended in the same change: d3-cloud drops what it cannot fit

d3-cloud does not shrink, wrap or warn about a word too wide for the board:
`place()` rejects any box crossing the edge, and a word that never places is
simply absent from the array handed to `.on("end")`. Font size is assigned by
rank, so the top-scoring term meets the bound first — while staying in the
accessible `<ol>`, so the visual and assistive views disagree with nothing
signalling why.

Verified against d3-cloud 1.2.9 on an empty 700px board: at font 56,
`artificial intelligence` (23 chars) and `president donald trump` (22) are both
dropped, while `democratic primary` (18, the longest term the fixtures produce)
places at any size. No term the recorded corpora emit triggers this today —
`artificial intelligence` fails the propriety gate, so `ai` is what ships — but
nothing announces when the bound is crossed, so the guard is worth having.

`fontSizes` now clamps by length as well as score, inverting d3-cloud's own
measurement (boxes sized from `⌊size + 1⌋` px, padded by 1, rounded up to a
32px bucket, so the bound is `length × advance × (font + 1) + 1 + 32 <= width`).
The clamp sits below the measured drop boundaries (20 chars → 54.9px, 22 →
49.9, 26 → 42.9, 30 → 36.9) with margin for the resolved monospace face. A word
too long for `FONT_MAX` renders smaller instead of disappearing; every term the
cloud shows today is unaffected. The cost — font size slightly less faithful to
score for long terms — trades the weaker channel (§10.5: font size is
decorative; the article count is the accessible signal) to keep the word on
screen.

## Amended 2026-08-11: the phrase-position rule is closed, not open

Would a phrase-position rule make un-stopwording `new` safe? Measured against
all three recorded fixtures, collapsed by URL as `term-scoring.test.ts` does:
141 articles / 49 domains, and 183 / 73 with `search-climate-duplicates`. **No
code changed. The rule is refused, and not on yield: it is refuted
structurally.**

`new york` and `new trump` are the same shape — a non-proper leading word, a
proper trailing one — differing only in document frequency, so no rule reading
positions can separate them: point it at the leading word and both are refused,
point it at the trailing word and both are admitted. A bound on the mechanism,
not a shortfall in the corpus. Both readings were implemented and scored
anyway, because the class each one costs is worth knowing.

### Reading 1: the leading word must be a proper noun

| corpus | terms | lost | gained |
| --- | --- | --- | --- |
| 141 | 28 → 27 | `president donald`, `world cup` | `cup` |
| 183 | 47 → 46 | `president donald`, `world cup` | `cup` |

The rule **cannot gain a phrase**: `isProperNoun(words[0])` admits a strict
subset of `.some(isProperNoun)`, so the only arrival is a unigram resurrected
by the bigram that used to subsume it — the trigram trade run backwards.

Across 56 subsampled runs the cloud changes in 30, net **−24 terms**. Four
bigrams removed: `president donald` ×24, `world cup` ×17, `abdul el-sayed` ×5,
`tmk energy` ×1 — 46 removals of real terms (three names, one a person's full
name) to 1 of junk. Two pinned expectations fail: `world cup` in
`term-scoring.test.ts`, and `displaced kelowna` in ADR-0006's participle case —
the more telling, because ADR-0006 wrote the `index > 0` guard *because* a
modifier in front of a name modifies, and this rule deletes that whole class
immediately after the verb lexicon was built to protect it.

Nor is the class a fixture artifact. Six constructed trailing anchors, each
using its modifier lowercase once in prose (the condition that fails the case
test in any real corpus), are all six deleted — `hurricane milton`, `storm
milton`, `president donald`, `mount fuji`, `lake michigan`, `cyclone freddy` —
and what survives is what §10.3 and ADR-0006 exist to exclude: `milton nears`,
`nears landfall`, `donald speaks`, `freddy batters`. The rule deletes the name
and keeps the clause.

The narrower variant — `.some()` as shipped plus a small modifier list (`new`,
`world`, `president`, `hurricane`, `storm`, `tropical`) barred from leading —
measures **identically** on fixtures and counterfactual. It cannot do better:
barring `new` from leading is precisely what refuses `new york`.

### Reading 2: the trailing word must be a proper noun

At 183 it loses `australian river`, `democratic primary`, `senate primary` and
`united states` for bare `australian`, `democratic`, `united`; at 141 it loses
`democratic primary` and `senate primary` for `democratic`. And it leaves the
hazard where it was: on the synthetic corpus below it admits `new trump`, which
deletes `trump` — the failure `new` was declined over.

### The counterfactual, on synthetic corpora

Each `New <Name>` phrase occurs once in the fixtures, so two corpora were
constructed: three articles across three domains in which every `York` sits
inside `New York`, and six across four in which `Trump` appears alone in four
and `New Trump` in two.

| variant | new-york corpus | new-trump corpus |
| --- | --- | --- |
| shipped gate, `new` stopworded | `york` 3 | `trump` 6 |
| shipped gate, `new` freed | `new york` 3 | `new trump` 2 — **`trump` deleted** |
| leading rule, `new` freed | `york` 3 | `trump` 6 |
| trailing rule, `new` freed | `new york` 3 | `new trump` 2 — **`trump` deleted** |
| narrow rule, `new` freed | `york` 3 | `trump` 6 |
| shipped gate + contained subsumption, `new` freed | `new york` 3 | `trump` 6 *and* `new trump` 2 |

Row 2 is this page's original argument, now measured: a df-2 phrase deletes a
df-6 name. Every variant that keeps `trump` fails to deliver `new york`, and
the one row that does both is not a position rule.

### What would actually work, and what it costs

The separating fact is coverage — what the subsumption rule's own comment
claims to be about and does not check. `new york` covers 3 of `york`'s 3
articles; `new trump` covers 2 of `trump`'s 6. Requiring full coverage before a
phrase deletes a word is a small change and not free. At 183 it adds six
unigrams the shipped rule deletes, every one a partial covering:

| unigram | df | covering phrase(s) | df |
| --- | --- | --- | --- |
| `trump` | 9 | `donald trump` | 4 |
| `democratic` | 5 | `democratic primary` | 3 |
| `michigan` | 4 | `michigan senate` | 2 |
| `senate` | 4 | `michigan senate`, `senate primary` | 2, 2 |
| `abdul` | 3 | `abdul el-sayed` | 2 |
| `australian` | 3 | `australian river` | 2 |

That is a change to what the cloud *is* — 47 → 53 terms — defensible on its own
evidence (a term covering 9 articles is deleted today in favour of one covering
4) and pinned against by `term-scoring.test.ts`, which asserts `trump` is
absent. It wants its own ADR, and freeing `new` is not the argument for it:
with contained subsumption in place, freeing `new` still changes no term at
183, and on the synthetic corpus adds `new trump` beside `trump` — junk gained
with no measured gain behind it.

### The grouping bar, measured regardless

5 of the 183 titles contain `new`. Same-story pairs under the ADR-0005 bar
(Jaccard ≥ 0.5 with the 2-shared-token floor, over **all** pairs) hold at
**15 → 15** with `new` freed, no pair crossing in either direction. The
constructed Drivers/Landlords hazard reproduces unchanged at exactly the
default threshold — still real, still invisible in this corpus. Nothing changes
the stopword list, so `TOKENIZER_VERSION` stays at 3 and there is no regroup
backlog.

### Verdict

`new` stays a stopword, the propriety gate keeps `.some()`, and `new york`,
`new zealand` and `new delhi` stay unreachable — a named limit. The position
rule was the cheap candidate and is refuted from both directions at once,
deleting names it should keep while refusing the names it was proposed for. The
live thread for anyone returning here is the subsumption rule's missing
coverage check, measured above, which stands or falls on its own account and
not on `new`.
