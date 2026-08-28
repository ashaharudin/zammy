# Discovery and deepening — implementation plan, by session

The design is in
[DESIGN-DISCOVERY-AND-DEEPENING.md](DESIGN-DISCOVERY-AND-DEEPENING.md):
Currents discovers and stays coverage-bearing, Google News deepens known arcs.
Each phase below is sized for one focused session and self-contained; do not
widen a phase mid-flight — later phases exist for a reason.

**Standing context for every phase**: the design doc in full, plus ADR-0012 (why
a second provider never bears coverage), ADR-0002 (articles are identified by
canonical URL — G1 amends this), and ADR-0017 (the storyline refresh G5
repoints). Repo rules binding every phase: hand-written SQL migrations
(ADR-0003), tokenizer changes bump `TOKENIZER_VERSION`, wire changes bump
`PAGE_SHAPE_VERSION`, no threshold ships unmeasured.

**The organising principle.** Everything that protects the existing system lands
*before* the first Google News article is ingested. G1–G4 are all either
independently valuable or provably no-ops today, so the risky phase (G5) starts
with every guard already in place and verified.

## Dependency graph

```
G0 title-suffix strip ──────────────── (independent, any time)

G1 alt_key identity ────┐
G2 ranker isolation ────┤
G3 coverage schema ─────┼── G5 attach + repoint refresh ── G6 measure ── G7 scheduler
G4 adapter (flagged off)┘                                      │
                                                          kill criteria
```

G1–G4 are mutually independent and can run in any order or in parallel. **G5 is
gated on all four.** G7 is gated on G6 returning a yield worth having.

---

## G0 — Strip the trailing outlet suffix from headline tokens

**Depends on**: nothing. Independent of the rest of this plan and worth doing
on its own.

**Why**: we have measured the damage. `" | Globalnews.ca"` leaked
`winnipeg`/`globalnew`/`ca` into `story_tokens` and pre-loaded **19.6 of the
20-point link-mass floor** by itself. Google News appends ` - Outlet` to **100
of 101** items, so under this plan it would stop being one outlet's problem and
become every article's.

**Scope**: strip a trailing ` - Outlet` / ` | Outlet` segment before
tokenization in `apps/api/src/headline-tokens.ts`. Note line 116 there argues
that matching the segment against the article's own `source_domain` is the
precise rule and was skipped for plumbing cost — decide whether this phase pays
that cost or uses the cheaper positional strip, and record which.

**Cost, stated plainly**: this changes `story_tokens`, so it is a
`TOKENIZER_VERSION` bump to v9 plus a repair run on dev and prod. That is a
known, rehearsed operation — v8 shipped 2026-08-27 through the
`repair (production)` CI job — but it is not free and it is why this is its own
phase rather than a line inside G1.

**Explicitly out**: `alt_key`'s fold (G1 computes its own, with no tokenizer
impact); anything about Google News.

**Done when**: v9 is applied on dev and prod, the three repair steps have run,
and link mass on a sample of Globalnews-heavy storylines is measurably lower
with no storyline lost that v8 held.

## G1 — `alt_key` fallback article identity

**Depends on**: nothing.

**Why it stands alone**: measured read-only against production 2026-08-27 —
37,077 articles collapse to 36,666 `(source_domain, folded title, UTC day)`
keys, so **411 rows (1.1%) are duplicates URL identity is already failing to
catch** (design doc §7: one `space.com` liveblog under six slugs, one
`standard.co.uk` story under five reordered slugs, `rte.ie` and `haaretz.com`
section and paywall variants). It earns its place on the corpus we have. It is
*also* the enabling change for Google News, whose `CBM…` link cannot serve as
identity — but it does not depend on that design going ahead.

**Scope**: migration `0020` adding `articles.alt_key bytea` and
`CREATE UNIQUE INDEX … WHERE alt_key IS NOT NULL`. A fold (lowercase, trailing
` - Outlet` / ` | Outlet` stripped, non-alphanumerics collapsed) and key
derivation beside `canonicalizeUrl`/`deriveDedupKey`. Ingest resolves **URL key
→ alt key → insert**.

**Three constraints that are decided, not open**:

- **Fallback, never replacement.** URL first. Titles drift and URLs do not, so
  making `(domain, title, day)` primary would split an article whose headline
  was edited between sightings. Do not "simplify" the ordering away.
- **Forward-only. Do not merge the 411 existing rows.** `group_id` is a bigint
  article id carrying **no foreign key**, in both `articles.group_id`
  (migration 0003) and `storyline_groups.group_id` (migration 0007) — both
  argue for this deliberately, so a dangling seed degrades a group to loose
  members rather than blocking a delete. Deleting article rows to merge them
  would therefore dangle group seeds and orphan storyline attachments with
  nothing raising an error. A historical merge is a separate, carefully designed
  chore.
- **No `alt_key` for a title ending `...` or `…`.** `hkexnews.hk` filed three
  distinct disclosures on one day under titles the *source* had already
  truncated. Measured: 4 of the 411 absorbed rows. Excluding them costs a
  handful of genuine collapses and is the right trade, because
  `canonicalizeUrl`'s own comment establishes over-collapsing as the worse
  error.

**Recommended backfill**: populate `alt_key` only for rows whose computed key is
unique across the archive, leaving the ~411 colliding rows NULL. The partial
index excludes NULLs so it builds cleanly, and new articles can fold onto
backfilled history — most of the value, none of the merge risk.

**Open, decide and record**: whether the key is computed in
`packages/news-client/src/normalize.ts` (symmetric with `dedupKey`, but adds a
field to the `Sighting` schema and both adapters) or derived in
`packages/storage/src/ingest.ts` from fields the sighting already carries
(simpler, no schema change). Also where the fold lives — `foldDiacritics` exists
in `apps/api/src/headline-tokens.ts`, but `apps/api` depends on `packages/*` and
not the reverse, and ADR-0004 bars parking it in `@zammy/shared`.

**Probably warrants an ADR** (next free number 0018): ADR-0002 established that
articles are identified by canonical URL, and this amends it.

**Done when**: migration applies and reverts cleanly against data containing
collisions; tests cover URL-key-wins, fold-via-alt-key, no-key-for-truncated,
suffix-insensitivity, and two genuinely different same-day stories from one
domain staying separate; `@zammy/storage`'s `collapses 100 sightings into 42
articles` regression is still green.

**Landed** as [ADR-0018](adr/0018-a-fallback-identity-catches-what-the-url-cannot.md),
migration `0020`. Both open questions decided:

- **The key is computed in `packages/news-client/src/normalize.ts`**, beside
  `canonicalizeUrl`/`deriveDedupKey`, with `altKey` on the `Sighting` schema and
  set by both adapters — one function, so the identity and the thing it
  identifies cannot disagree.
- **The fold is duplicated in `news-client`, not shared with `foldDiacritics`.**
  The two must be free to diverge: the tokenizer's fold serves the vocabulary and
  is expected to change with `TOKENIZER_VERSION`, and sharing it would let a
  tokenizer improvement silently re-key every article minted after it.

Two things the phase learned that the design did not know. The suffix strip peels
a trailing segment **only when it spells the article's own `source_domain`** —
the positional strip §7 measured with merges 68 unrelated Frontiers papers into
one article on the dev archive, since each is titled `Frontiers | <real title>`,
so §7's 411 is an upper bound on what this collapses rather than a description of
it. And the recorded duplication fixture now collapses to **41** articles, not
42: the one pair ADR-0002 declined for want of evidence is a genuine duplicate.

## G2 — Isolate the ranker to the discovery plane

**Depends on**: nothing. **Land it while it is still a no-op.**

**Why**: this is the load-bearing rule of the whole design — *the plane that
measures is the plane that is not steered*. Without it, cloud membership drives
fetching, fetching adds articles, and the cloud's volume score becomes
endogenous: rich-get-richer with no damping, measuring our own fetch history
instead of the world's coverage. Separately, `MIN_SOURCE_DOMAINS = 2` asks "are
several newsrooms covering this NOW" and Google News returns 20–82 domains per
query, so the gate would clear for free on any arc it touched.

**Scope**: in `packages/storage/src/trending-storylines.ts`, restrict both the
volume count and the `having count(distinct a.source_domain) >= 2` gate to
articles carrying a discovery-plane sighting:

```sql
and exists (select 1 from sightings s
             where s.article_id = a.id and s.provider = 'currents')
```

No migration — `sightings.provider` and `sightings_provider_idx` already exist
(migration 0013).

**Note it is a no-op today**, with Currents the only enabled provider. That is
the point: it can be landed and verified as producing a byte-identical cloud
now, rather than being written under pressure alongside the change that makes
it matter.

**Done when**: the cloud output is provably unchanged against the dev archive,
the query plan still uses the provider index, and a test fixture containing a
non-Currents sighting shows it excluded from both the count and the gate.

## G3 — Per-provider and per-storyline coverage

**Depends on**: nothing.

**Why**: ADR-0012 deferred exactly this and named it — "`topic_coverage` gaining
a provider column so each provider's spans are tracked and repaired
independently". The deepening plane needs a *second subject* as well, because
its unit of coverage is a storyline, not a topic fingerprint.

**Scope**: migration `0021`.

```sql
ALTER TABLE topic_coverage ADD COLUMN provider text NOT NULL DEFAULT 'currents';

CREATE TABLE storyline_coverage (
  storyline_id uuid REFERENCES storylines ON DELETE CASCADE,
  provider     text NOT NULL,
  span         tstzrange NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storyline_coverage_gist ON storyline_coverage USING gist (storyline_id, span);
```

`DEFAULT 'currents'` backfills every existing row correctly, for the same reason
migration 0013's did. Storage functions for reading and writing storyline
coverage, mirroring `coverage.ts`.

**Explicitly out**: any planner change. Nothing reads `storyline_coverage` until
G5.

**Done when**: migration applies and reverts; existing coverage reads are
unaffected; storyline coverage round-trips and its gap arithmetic is tested.

## G4 — The Google News adapter, flagged off

**Depends on**: nothing.

**Scope**: `@zammy/google-news-client` satisfying `NewsClient`, following the
`gnews-client` package layout. RSS parsing, `after:`/`before:` date windowing,
the 100-item cap surfaced as `isLastPage` (`rawCount < 100` complete, `== 100`
means the caller must subdivide — verified: five weekly slices of one arc gave
433 items where the unsliced query gave 92).

**Two deliberate departures from the existing adapters**, both of which need a
comment saying why:

- `sourceDomain` comes from `<source url="…">`, **not** from the canonical URL.
  Both existing adapters use `sourceDomain(url)`; following that convention here
  attributes every article to `news.google.com`, which is what turns G2's gate
  into manufactured breadth. This is the first row shape where
  `sourceDomain(url) ≠ source_domain`.
- `description` is null. The RSS field is an `<a href>` blob wrapping the
  redirect, not prose.

`quota()` returns null — Google News sends no rate-limit headers and publishes
no ceiling, so the governor has nothing to correct itself with. Needs a
conservative self-imposed budget and the existing breaker.

**Off by default**, following `GNEWS_ENABLED`'s precedent: adding a provider
changes what gets ingested and how budget is spent, so it is an explicit
decision rather than something that happens when a package is installed.

**Done when**: fixture-backed tests cover parsing, windowing, the cap signal,
the suffix in `<title>`, and the `<source url>` attribution; the adapter is
unreachable with the flag off; no caller above the client learns the provider
count.

## G5 — Attachment rules, and repoint the storyline refresh

**Depends on**: G1, G2, G3, G4 — all four. **This is the first phase that
ingests a Google News article, and it must not start before every guard above
is landed and verified.**

**Scope**: redirect ADR-0017's existing storyline refresh at the deepening
plane. That path already turns a storyline into keywords and enqueues a top-up;
today it launders the query through a synthetic topic and sends it to Currents.
Changes:

- **Send the full label, not the grounded pair.** `cloudQuery` exists because
  Currents ANDs terms against body text we never receive (PROBE-FINDINGS 3).
  Google News does not have that problem: the four-word label out-performed its
  grounded pair (100 items / 63 domains vs 92 / 55). `cloudQuery` keeps its job
  but changes role — **from query rewriter to confidence gate.** An ungrounded
  label is one we do not trust enough to spend a call on.
- **Coverage goes to `storyline_coverage`**, not to a synthetic topic.
- **Attachment is by provenance.** An article fetched for storyline X joins
  storyline X. Deepening-plane articles **never form new storylines** — without
  this, 100 articles per arc become groups, groups become provisional
  storylines, and every promotion demands a model label against a 500/day
  quota that already has a backlog. Label demand must stay flat at zero.

**§9 survives this phase.** "Every upstream call traces back to a real user
request" holds — a click is still the trigger. G7 is where that is traded.

**The open question this phase must answer**: how a deepening-plane article
appears in a day slot. `alt_key` shrinks the problem a long way — a Google item
for a story Currents already has folds into a *sighting* of the existing
article and inherits its group, so only genuinely-new stories need placement.
For those, either (a) let them into grouping normally, which needs G0 landed
first to keep the suffix out of `story_tokens`, or (b) attach them as loose
storyline-day members rendered below the groups. Pick the smallest thing that
works, and let G6's numbers drive any richer answer.

**Done when**: a click on a storyline deepens it from Google News; no new
storyline is created by the deepening plane; the cloud is unchanged by the
fetch (G2 holding under real conditions, verified — not assumed); and
`storyline_coverage` records only spans actually fetched.

## G6 — Measure per-provider yield. Decision gate.

**Depends on**: G5, plus enough real traffic to be worth reading.

`sightings.provider` and its index exist for exactly this question: **how many
distinct articles does the deepening plane actually add to a clicked arc, and
how many were already there?**

**Kill criteria — state them before looking.** If the deepening plane's articles
are overwhelmingly ones Currents already had, the design is a duplicate
generator that `alt_key` is quietly absorbing, and it should stop here. G1 and
G2 keep their value regardless; G3 and G4 become dead weight to be reverted.

Also measure: how often Google News throttles under real load (there is no
header to read, so this can only be observed), and whether a `MIN_SOURCE_DOMAINS`
gate computed on discovery-plane domains still selects the arcs a human would
call newsworthy.

**Done when**: the yield number exists, is written down here, and a go/no-go on
G7 is recorded with it.

## G7 — The scheduler, and the §9 trade

**Depends on**: G6 saying yes.

Turn the cloud into a crawl frontier: storylines fetched on a schedule rather
than on a click, arcs backfilled by slicing their spans.

**This is where §9's invariant is traded** — "every upstream call traces back to
a real user request" stops being true, because the cloud fetches because it
exists. ADR-0017 went out of its way to preserve that, so abandoning it needs
its own ADR and its own argument, not a footnote in this one.

Do not take this phase early. Its payoff depends entirely on G6, and its risk
(the feedback loop) depends entirely on G2 holding under load, which only G5's
real traffic can demonstrate.

---

## Already landed

- `cmp` added to `TRACKING_PARAMS` (`21bb594`, `c5fddd2`) — a CBC feed link and
  the same story from Currents no longer become two articles.
- `share_id` added to the same set on the same evidence standard (`09bac41`,
  #166) — this one was found by the production query in design doc §7, as a
  `commondreams.org` pair differing by nothing else.

Both are the same class of defect as G1 at one-line cost, and neither depended
on this plan. They are also the cheap half of what G1 finishes: a parameter
allowlist can only catch duplicates that differ in the query string, and the 411
rows G1 addresses differ in the path.

## What this plan does not commit to

Google News has no key, no documented quota, and no developer terms
contemplating this use. That is unchanged from the survey
([RESEARCH-FREE-NEWS-SOURCES.md](RESEARCH-FREE-NEWS-SOURCES.md) §5) and it is a
standing risk across G4–G7, not a phase that resolves. The Guardian Open
Platform remains the alternative deepening source if the terms question ever
becomes blocking — deeper archive, real URLs, real quota headers, one outlet,
and a non-commercial free tier.
