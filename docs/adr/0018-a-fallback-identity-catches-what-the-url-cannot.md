---
status: accepted
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

## The fold peels an outlet suffix only when it spells the outlet

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

So the segment must spell the article's own `source_domain`, compared loosely —
case, spaces, punctuation and a leading "the" dropped, the public suffix optional
— so "The Guardian" matches `theguardian.com`. `headline-tokens.ts` faces the
same problem and settles for a shape rule ("short, verbless, no interior function
word") because, as its comment says, consulting `source_domain` "would be the
precise rule" but would have to be threaded through five call sites. Here the
domain is already an argument, so the precise rule costs nothing — and it matters
more here, because a shape rule would peel "Manitoba floods - live updates" and
"Manitoba floods - what we know" onto one key.

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

- **The suffix strip only fires when the outlet's display name IS its domain
  stem, and that will surprise the phase that needs it most.** The comparison is
  loose about case, spaces, punctuation, a leading "the" and the public suffix —
  and about nothing else. So it strips ` - The Guardian` from `theguardian.com`
  and ` | Globalnews.ca` from `globalnews.ca`, and does not strip:

  ```
  NOT STRIPPED   nytimes.com      - The New York Times        display name expands the stem
  NOT STRIPPED   indiatimes.com   - Times of India            display name reorders the stem
  NOT STRIPPED   bbc.co.uk        - BBC News                  display name adds a word
  NOT STRIPPED   cbc.ca           | CBC News                            ''
  NOT STRIPPED   wsj.com          - The Wall Street Journal   domain is an initialism
  NOT STRIPPED   ft.com           - Financial Times                     ''
  ```

  Measured over a 12-outlet probe: 5 strip, 7 do not.

  **Inert today**, because one provider means one spelling of the suffix: an
  outlet that always appends ` - BBC News` produces a stable key either way, and
  the production result above already reflects this behaviour. It stops being
  inert the moment two providers describe the same article, because **Google
  News writes the outlet's DISPLAY name** while Currents ships the outlet's own
  `<title>` tag. For every outlet in the second class above, a Google item and
  its Currents twin would fold to different keys and mint two rows — precisely
  the failure this key exists to prevent, and the mechanism the
  discovery/deepening design's §2a rests on.

  Left unfixed on purpose. The fix is a display-name-to-domain map, which is a
  real piece of design: it needs a corpus of Google News titles to be built
  against and measured on, and there is none yet. It belongs to the phase that
  ingests the first Google News article, not to this one.

- **Changing the fold is a migration, not an edit.** Keys are stored and never
  recomputed, so any change splits the archive into rows keyed the old way and
  rows keyed the new one. This is why the fold is duplicated in
  `@zammy/news-client` rather than shared with `foldDiacritics` in
  `apps/api/src/headline-tokens.ts`: that fold serves the VOCABULARY and is
  expected to change with `TOKENIZER_VERSION`, and sharing it would let a
  tokenizer improvement silently re-key every article minted after it. ADR-0004
  independently bars parking a shared copy in `@zammy/shared`.
