---
status: accepted
---

# Articles are deduplicated stories; sightings are upstream emissions

Currents re-emits the same story under fresh UUIDs — measured over one query's full
retrievable depth, 100 responses carried 100 unique ids but only **42 unique URLs**, with
a single link-roundup page appearing **50 times**. We therefore store two things: a
`sightings` row per upstream emission, and an `articles` row per real story, keyed by the
canonical URL. The timeline pages over articles.

## Considered options

The obvious schema — one `articles` row per upstream response item, deduplicated at read
time — was rejected twice over. It makes over half a typical timeline one repeated post,
and post-filtering breaks paging: with one URL occupying 50 of 100 upstream slots, a page
of 25 can collapse to 3 rows, so page size becomes unpredictable and `hasMore` unreliable.

Naming was the other axis. Calling the emission table `articles` (with `article_clusters`
for the collapsed story) was the first draft, and it forced a written warning into the
README — *"anything that counts articles must count clusters"* — plus a comment in the
shared contract explaining that `id` is not per-story. When a codebase needs prose to stop
you reaching for the obvious word, the word is wrong. The plain noun now means what users
mean, so `count(articles)` is correct by default and the dangerous mistake is hard to
express by accident.

## Consequences

- **URL is the only dedup axis.** A `(title, source)` secondary key stays disabled:
  probe data showed 42 unique URLs against 41 unique title+source pairs, so it would merge
  exactly one pair — no evidence, and a false merge is worse than a visible duplicate.
- **Syndicated stories do not collapse.** One story across six outlets is six articles, on
  purpose. Multiple outlets covering something is signal, and the landing-page cloud
  measures a term's breadth by counting distinct sources — collapsing syndicates would
  destroy the signal that feature depends on.
- **A liveblog or daily-links page collapses to one article, hiding the events inside it.**
  Accepted loss: such a page genuinely *is* one URL, and upstream gives us no per-item link
  to split it by. This will be reported as a bug; it is not one.
- **An article is positioned in the timeline by its earliest sighting**, with a
  "updated <relative time>" badge when later sightings exist. A chronology should place a
  story when it appeared. The cost is real and deliberate: a continuously-updated story
  sinks down the timeline and never resurfaces. Ordering by latest sighting was rejected
  because it lets the noisiest sources permanently hold the top of the feed.
- Effective retrievable depth is ~40 unique articles per query rather than 100, which is
  what makes time-window subdivision necessary.
- **An article's primary key is a surrogate identity, not its URL hash**, with the hash
  carried alongside under a unique constraint. The hash looks like a perfectly good natural
  key, and using it is the obvious move — but canonicalization is a rule we keep changing
  (`utm_*`, `fbclid` and `gclid` are stripped today; the list grows the first time a source
  turns up with something new). Under a natural key, widening that list re-keys every
  affected row, and article ids are what the timeline cursor is built from, so a re-key
  invalidates live cursors. Under a surrogate, the same change is a merge and identity
  survives. The cursor is `(published, id)`.
