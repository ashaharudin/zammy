---
status: accepted (two consequences below are amended by ADR-0021: `url` no longer always moves when an earlier sighting wins the display fields — an aggregator's copy never hands one over — and the day-bucket risk bounded here at "33 articles of 31,308" was measured on ONE provider whose emissions are minutes apart, which does not survive a provider that emits a bare date in another timezone; see plan §G6)
---

# A fallback identity catches the duplicates the URL cannot

An article gains a second key, `alt_key` — sha256 of `(source_domain, folded
title, UTC day)` — under a partial unique index. Ingest resolves **URL key → alt
key → insert**. A normal article populates both, so the URL-keyed majority
behaves exactly as it did; only a URL that has never been seen consults the
fallback.

This amends ADR-0002, which made the canonical URL the whole of an article's
identity and disabled a `(title, source)` secondary key in as many words:

> A `(title, source)` secondary key stays disabled: probe data showed 42 unique
> URLs against 41 unique title+source pairs, so it would merge exactly one pair —
> no evidence, and a false merge is worse than a visible duplicate.

That was the right call on 42 articles. It is the wrong call on 37,000, and the
one pair it declined turns out to be a genuine duplicate.

## What changed is the evidence

Measured read-only against production 2026-08-27, 37,077 articles:

```
distinct URL keys           37,077     (unique by construction)
distinct alt keys           36,666
rows alt_key would absorb      411     (1.1%)
```

Every sampled group, at every size, was one story under several URLs:
`space.com` ran one eclipse liveblog under six slug variants, `standard.co.uk`
one story under five slugs with the SEO keywords reordered, `ansa.it` one story
under four section paths, `rte.ie` and `haaretz.com` section and paywall variants
of one article id.

**And the pair ADR-0002 declined is in the fixture we still test against.** It is
one Times of India blog post, "First-World Flames", emitted 15 seconds apart
under `/blogs/toi-edit-page/first-world-flames` and
`/blogs/gen-zedits/first-world-flames-2` — same domain, same headline, same
opening sentence, filed under two blog sections. Exactly the `ansa.it` class the
production sample is full of. ADR-0002's caution was correct and its conclusion
has expired: the evidence it asked for arrived.

## Fallback, never replacement

The ordering is the decision, not an implementation detail. **Titles drift and
URLs do not.** Making `(domain, title, day)` the primary key would split an
article whose headline was edited between two emissions — a regression URL
identity does not have, traded for a duplicate class it does. Consulted second,
the fallback can only ever be reached by a URL never seen before, which is
precisely the case URL identity was already failing.

This is also what a possible Google News provider needs, whose opaque `CBM…`
link cannot serve as identity — but nothing here presupposes that design, and
the 411 rows pay for it on the corpus we already have.

## The fold peels an outlet suffix only when it NAMES the outlet

The fold is: lowercase, Latin diacritics onto their base letter, a trailing
` - Outlet` / ` | Outlet` segment removed, every run of non-alphanumerics
collapsed to one space.

The suffix strip is needed because Currents ships a title as the outlet wrote its
own `<title>` tag, attribution and all. The obvious rule — peel whatever follows
the last delimiter — is measurably wrong. Replayed over the dev archive (32,279
articles), a positional strip merges **68 unrelated Frontiers research papers
into one article**, because every one of them is titled `Frontiers | <the actual
title>` and a greedy split keeps the head. Across that archive it merges 348 rows
this rule refuses.

So the segment must name the article's own `source_domain`. `headline-tokens.ts`
faces the same problem and settles for a shape rule ("short, verbless, no
interior function word") because, as its comment says, consulting `source_domain`
"would be the precise rule" but would have to be threaded through five call
sites. Here the domain is already an argument, so the precise rule costs nothing
— and it matters more here, because a shape rule would peel "Manitoba floods -
live updates" and "Manitoba floods - what we know" onto one key.

As first shipped the test was an EXACT one: the segment's compare form had to be
the domain stem, loose about case, spaces, punctuation, a leading "the" and the
public suffix, and about nothing else — so "The Guardian" matched
`theguardian.com` and little else did. G5 replaced that with four rules, each a
different way a display name can name a domain without spelling it, measured on
a held-out split of a corpus harvested for the purpose. See the consequence
below, and `stripOutletSuffix` for the experiment in full. Nothing about the
DIRECTION changed: the segment still has to be about the outlet, and a similarity
score is still refused.

## What this refuses to key, and why refusing is the safe direction

A `null` key means "identified by URL alone", which is what every article was
before this. So each refusal below is a return to the old behaviour, never a
guess:

- **A title the SOURCE already truncated**, ending `...` or `…`. `hkexnews.hk`
  filed three distinct regulatory disclosures on one day under titles it had
  itself cut to `[00232.HK] Disclosure of...`. Measured on the dev archive, the
  guard costs 9 genuine collapses out of 32,279 rows and buys back the whole
  over-collapse class.
- **No source domain**, which is what scopes the key to one newsroom. Without it
  two outlets running one wire headline would collapse, destroying the
  distinct-source signal ADR-0002 protects and the cloud depends on.
- **A title that folds to nothing.** Unmeasured — nobody has seen one — and it
  costs one comparison.

## Consequences

- **The recorded duplication fixture now collapses 100 sightings into 41
  articles, not 42.** Both numbers are asserted: 42 distinct `dedup_key`s still
  proves canonicalization neither over- nor under-collapses, and 41 `articles`
  proves the fallback caught the one thing the URL could not. A future change
  that moves 42 is a canonicalization regression; one that moves 41 is an
  alt-key regression.

- **The key is timezone-sensitive, and the day bucket is load-bearing.** Two
  emissions of one story that straddle a UTC midnight land in different buckets
  and do not fold. That is the price of stopping a domain's recurring column
  headline from collapsing a month of instalments into one article, and it is
  bounded: 33 articles of 31,308 on the dev archive carry sightings that straddle
  a UTC midnight at all. Changing `APP_TIMEZONE` would silently re-key every
  article minted afterwards while leaving history keyed the old way.

- **`dedup_key` can stop hashing `url`, and that is intended.** Both keys are
  minted once, by the sighting that created the row, and never rewritten —
  rewriting either would change an article's identity under a live unique index,
  and a row that stopped answering to the key it was found by would be found
  again as a new article by the very next sighting of it. So when an earlier
  sighting under a different URL wins the display fields (ADR-0002), `url` moves
  and `dedup_key` does not. The key is the identity the row was minted with;
  `url` is what a reader clicks.

- **The 411 existing duplicates are NOT merged, and will not be.** The backfill
  keys only rows whose key is unique across the archive and leaves the colliding
  ones NULL. Merging them means DELETING article rows, and `group_id` is a bigint
  article id carrying **no foreign key**, in both `articles.group_id` (migration
  0003) and `storyline_groups.group_id` (migration 0007) — deliberately, so a
  dangling seed degrades a group to loose members rather than blocking a delete.
  A merge would therefore dangle group seeds and orphan storyline attachments
  with nothing raising: the silent-data-loss class ARCHITECTURE 11 names as the
  worst available. A historical merge is a separate chore that must re-seat those
  seeds first.

- **Existing duplicates keep accreting, slowly.** Neither of a colliding pair
  carries the key it would match, so a third URL of that story mints a third row.
  The population is capped at what exists today and decays under retention.

- **Ingest can now raise a unique violation, and is fenced against it.**
  `ON CONFLICT` takes one arbiter and `dedup_key` has it, so two concurrent
  transactions inserting different URLs of one story race on the alt-key index
  instead. The insert runs inside a savepoint and a lost race is re-resolved
  rather than raised. Measured on the local dev Postgres over the 100-sighting
  duplication fixture, five runs: 287ms fenced against 248ms with every alt key
  nulled — ~0.95ms per fenced insert, and an upper bound. A real batch is one
  upstream page of 20, so the ceiling is ~19ms against ARCHITECTURE 6.3's
  1,200ms sync-fill budget, and an article with no key pays nothing.

- **The suffix strip fired only when the outlet's display name WAS its domain
  stem, and G5 replaced that rule.** The original comparison was loose about
  case, spaces, punctuation, a leading "the" and the public suffix — and about
  nothing else. So it stripped ` - The Guardian` from `theguardian.com` and
  ` | Globalnews.ca` from `globalnews.ca`, and left everything else on. Which
  outlets cleared that bar was not guessable from the masthead, so every name
  below was read off the wire:

  ```
  STRIPPED       bbc.co.uk        - BBC                       Google ABBREVIATES it
  STRIPPED       cbc.ca           - CBC                                 ''
  STRIPPED       wsj.com          - WSJ                                 ''
  STRIPPED       aljazeera.com    - Al Jazeera                          ''
  NOT STRIPPED   nytimes.com      - The New York Times        display name expands the stem
  NOT STRIPPED   ft.com           - Financial Times           initialism domain
  NOT STRIPPED   ecfr.eu          - European Council on Foreign Relations
  ```

  **Corrected 2026-08-28, and the correction mattered more than the numbers.**
  The names in the first version of this table were reasoned from the outlet
  rather than read off the wire, and four were wrong in the same direction:
  Google *abbreviates* mastheads, sending "BBC" rather than "BBC News" and "WSJ"
  rather than "The Wall Street Journal", so those outlets fold where invented
  names said they could not. A table of names no provider emits tests nothing,
  and this one had propagated into `deriveAltKey`'s own docstring and into a test
  that demonstrated the non-folding case with a string that in fact folds — an
  assertion passing on a premise no upstream produces.

  **G5 measured the damage on a corpus of its own and fixed it.** 70 real
  storyline labels off the dev archive — the deepening plane's actual work list —
  run against Google News RSS: 6,008 items over 1,837 outlets, committed as
  `fixtures/google-news-source-names.tsv`. Every item ends with the outlet Google
  named, and under the exact rule **26.2% of items failed to fold**.

  Four rules replaced the exact match — the domain stem being one END of the
  display name (the workhorse), an initialism of its content words, leading
  initials plus trailing words, and the reverse affix — chosen on a HELD-OUT half
  of the queries so nothing was fitted to what it was scored on. Held-out
  residual: **6.9%**. `stripOutletSuffix` carries the table and the two rules
  that were built and rejected on the same split.

  **The display-name MAP this ADR predicted was built, measured and declined.**
  Harvested from the same build half — 301 domains, 319 names — it scored 12.1%
  residual on held-out data against the rules' 6.9%, because the failure
  population is a long tail: the top 100 failing outlets are only 61% of failing
  items, over 529 distinct pairs in 70 queries. The decisive argument is the last
  bullet below rather than the five points, though. A map is a fold that changes
  every time an outlet is added, and changing the fold re-keys the archive; a
  rule that generalises is a fold that can stay fixed.

  Cost, measured the way this ADR measured the positional strip — replay the
  whole fold over the dev archive's 32,279 articles: the four rules cost **one
  additional merge**, and it is a real duplicate (`cbc.ca` filed one headline
  both with and without ` | CBC Radio`). The positional strip costs 347.

  What is left is 6.9% of items and no rule reaches it: a masthead written in
  another script (`chosun.com` "조선일보", `sana.sy` "سانا") and names with no
  lexical relation at all (`umn.edu` "CIDRAP", `channelnewsasia.com` "CNA"). A
  map is the only thing that could hold the first group, and only for outlets
  already seen.

- **Changing the fold is a migration, not an edit — and G5 paid it.** Keys are
  stored and never recomputed, so any change splits the archive into rows keyed
  the old way and rows keyed the new one. Measured for G5's widening: 524 of the
  dev archive's 32,279 articles (1.62%) compute a different key, 1 stops being
  keyable, 0 become keyable. Migration `0023` re-keys, under this ADR's own
  unique-only rule, and lands at 31,539 keyed against the 31,542 keyed before it. This is why the fold is duplicated in
  `@zammy/news-client` rather than shared with `foldDiacritics` in
  `apps/api/src/headline-tokens.ts`: that fold serves the VOCABULARY and is
  expected to change with `TOKENIZER_VERSION`, and sharing it would let a
  tokenizer improvement silently re-key every article minted after it. ADR-0004
  independently bars parking a shared copy in `@zammy/shared`.
