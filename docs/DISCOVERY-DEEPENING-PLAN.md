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

**ADR-0012 is superseded by
[ADR-0019](adr/0019-a-fetch-carries-its-own-reason-and-its-own-coverage.md), and
this plan is written for that version.** ADR-0012 assumed one coverage-bearing
provider and a supplement that only added breadth; Google News provides search
and breadth as well as deepening, so it is not a supplement. ADR-0019 relocates
the asymmetry rather than softening it: coverage becomes `(subject, provider,
span)` — G3 — and what may feed the ranker becomes a property of the *fetch*
(`search` | `breadth` | `deepening`) rather than of the provider.

The consequence for **G2**, spelled out in ADR-0019's second section:
if one provider serves both a reader's search *and* a cloud-driven deepening
fetch, then **`provider` stops being a proxy for "steered"**. The same provider
would be unsteered answering a search or a breadth sample and steered answering
the cloud, and no provider-level predicate can be true of both. G2's
`DISCOVERY_PROVIDERS` is therefore correct today and has a shelf life: the plane
has to become a property of the *sighting* — why was this fetched — rather than
of the provider. That is a `sightings.plane` column and a predicate of
`plane <> 'deepening'`, and it belongs to the phase that first makes one provider
serve both roles — **G5**. G2's own comment already anticipates this by refusing
to build a registry early; the correction is a different shape from a registry,
not a bigger one. Note ADR-0019 resolves the boundary case G2 raised: the
storyline refresh is `deepening`, because the test is whether *our ranking chose
the target*, not what triggered the call.

**What no phase below schedules, recorded 2026-09-23.** The paragraph above
says Google News "provides search and breadth as well as deepening", and none of
G0–G8 plans the search half: G5 wires deepening, #196 left
`PLANNED_COVERAGE_PROVIDER = "currents"` as a decision "that wants measuring",
and G7 is the deepening scheduler. A production trace (ADR-0029, `4e3a28c2…`)
showed what that costs — a search whose deferred pages Currents refused on
quota, beside an idle Google News. [ADR-0030](adr/0030-a-refused-search-asks-google-news-for-its-leading-edge.md)
lands the smaller half, a quota FALLBACK for a search, clipped inside the
`pubDate` cliff and off by default; a second PLANNED discovery provider is still
unscheduled and still wants its own measurement.

**The organising principle.** Everything that protects the existing system lands
*before* the first Google News article is ingested. G1–G4 are all either
independently valuable or provably no-ops today, so the risky phase (G5) starts
with every guard already in place and verified.

## Dependency graph

```
G0 masthead peel (v9) ──────────────── (independent, landed)

G1 alt_key identity ────┐
G2 ranker isolation ────┤
G3 coverage schema ─────┼── G5 attach + repoint refresh ── G6 measure ── G7 scheduler
G4 adapter (flagged off)┤                                      │
G8 retire category ─────┘                                 kill criteria
```

G1–G4 and G8 are mutually independent and can run in any order or in parallel.
**G5 was gated on all five and all five had landed** — G1 (#170), G2 (#169),
G3 (#172), G4 (#173) and G8 (ADR-0020). **G5 has now landed too**, with
migrations `0022` and `0023`; see its section for the four decisions that
departed from what it assumed. **G6 has run: 89.2% yield, and a NO-GO
on G7 that overrides its own pre-registered rule.** The yield is worth having
and nothing is reverted; G6 found two defects in G5 that a click-driven plane
bounds and a scheduler would not. G7 is gated on those landing, not on the
yield.

**G0 has landed too** (#176) and was never on the gate for anything — it is
independent by construction. What it turned out to be worth to the deepening
plane is measured in G5's answer to its own open question, and it is a good deal
more than G0's own section measured on the Currents archive.

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

**Done when**: v9 is applied on dev and prod, the repair steps this bump
actually owes have run, and link mass on a sample of chrome-heavy storylines is
measurably lower with no storyline lost that v8 held. Not "the three repair
steps": which steps a bump owes is a finding of the phase, not a constant — see
the Landed note.

**Landed** as `TOKENIZER_VERSION` 9, `isNameCased` in
`apps/api/src/headline-tokens.ts`. **The premise above was already satisfied and
this phase is not what it says it is**, which is the first thing a later reader
needs:

- **The trailing ` - Outlet` / ` | Outlet` strip already existed**, as
  `stripSourceAttribution`, shipped with v6. `" | Globalnews.ca"` — the damage
  the Why paragraph is built on — has been peeled since then, along with
  `" - The Guardian"` and `" - Winnipeg | Globalnews.ca"`. The Scope paragraph
  therefore asks for something that is already there.
- **The real defect was narrower**: a masthead carrying a function word INSIDE
  it ("The Times of India", "Council on Foreign Relations", "the Globe and
  Mail") was refused by the shape rule and survived into the vocabulary — the
  SAME shape as `" - Winnipeg | Globalnews.ca"`, only spelled with an `of` in
  the middle. The module named that blind spot and named its fix, the segment's
  own capitalization, and said the fix could not be had because it would take
  "top of the table" with it. **Measured, it does not**: a name capitalizes its
  content words and prose does not.
- **The `source_domain` question the Scope paragraph poses is answered NO, and
  was not re-litigated.** The capitalization rule exists precisely to avoid the
  plumbing. G1 has since shipped a domain rule of its own in `deriveAltKey`;
  reconciling the two was considered and refused as wider than this phase.
- **The prize is small and the phase says so.** 63 titles of 32,279 peel
  differently — 55 chrome, 5 wrong, 3 argued — against 513 rows for v8. Four
  bad storyline attachments would stop forming; the Times of India pile that
  looks like the motivating case does NOT dissolve, because `delhi` reaches
  `story_tokens` through the description regardless.
- **Steps 1 and 2 are owed; step 3 is not.** `label_words` derives from a
  storyline's LABEL through `foldDiacritics` and `singular`, and v9 touches
  neither the fold nor any label text — only which words a TITLE donates. Both
  owed steps have run on dev; production is a separate hand dispatch.

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

**What the query surface can and cannot express**, probed live 2026-08-27. Every
row is measured, and the last one is the dangerous one:

| `SearchParams` | Google News | Verdict |
| --- | --- | --- |
| `keywords` | `q`, matches headlines and entities | supported |
| `startDate`/`endDate` | `after:` / `before:` | supported |
| `domain` | **`site:` operator** — `site:cbc.ca` gave 100 items over 2 domains against 75 for the control | **supported** — unlike GNews, which refuses it |
| `language` | `hl` + `ceid` | supported as an EDITION |
| `country` | `gl` + `ceid` | **allowed** as an EDITION — see below |
| `category` | topic feeds exist, but cannot carry a keyword | **must be refused** |

**`country` is allowed, and it is an edition rather than a filter.** Measured:
the same query across CA / US / GB / IN editions shared only 30–50% of titles,
with visibly localised domains (`airdriecityview.com` for CA, `bcis.co.uk` for
GB, `aninews.in` for IN) — so the lever is real. But it biases selection rather
than restricting it: `asia.nikkei.com` and `axios.com` appeared in all four. So
a country-scoped topic filled this way WILL hold some out-of-country outlets,
which is weaker than the promise Currents' `country` makes. That is a decided,
accepted cost — say so in the adapter rather than implying a filter. `language`
behaves the same way and is stronger: `hl=en-CA` against `hl=fr-CA` on one
keyword shared **1 of 100** guids.

**`category` must be refused, and the reason is sharper than "unsupported".**
Google News has category feeds (`/rss/headlines/section/topic/BUSINESS`, 70
items) but they cannot take a keyword, and asking for both **silently discards
the category**: `topic/BUSINESS?q=housing` returned a result set byte-identical
to plain `search?q=housing` — 102 of 102 identical guids. `search?q=…&topic=…`
ignores the parameter outright, exactly as Currents ignores a bogus one. A bogus
topic returns HTTP 200 with zero items and no error.

That is worse than the case ADR-0012 documented for GNews, which simply has no
category filter and so has nothing to get wrong. Follow
`gnews-client`'s `unservableReason` precedent exactly — read it first; its
comment states the principle, that answering without the filter "would ingest
off-topic articles into a category-filtered topic". **G8 removes category from
the user's reach entirely, which makes this refusal unreachable rather than
merely rare — implement it anyway**, because an unreachable guard that is
already written is what keeps the next person from re-adding the parameter.

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
  this, 100 articles per arc become groups and groups become provisional
  storylines.

  **The quota argument this bullet used to make is withdrawn, and the constraint
  survives it.** It read "every promotion demands a model label against a 500/day
  quota that already has a backlog", which is a figure for a labeler config no
  longer runs: the default is `gemma-4-26b-a4b-it` and `gemini.ts` records its
  published free-tier figure as **30 requests per minute**, so the binding limit
  is pace rather than a daily budget, and a burst of labels is a latency problem
  for the reader who clicked. Two reasons remain and neither moves when a quota
  does: **the endogenous loop** — ADR-0019 argues it on its own terms, and a
  deepening article that formed an arc would be feeding the ranking that chose it
  — and **arc inventory**, since dozens of provisional storylines per click
  pollute the table the cloud reads, the linker scans and the merge pass judges,
  whatever labelling costs.

- **Add `sightings.plane`** (`search` | `breadth` | `deepening`) and move the
  ranker's guard onto it, replacing G2's provider list. This is the phase that
  first makes one provider serve two roles, so it is the phase that owes the
  column — see [ADR-0019](adr/0019-a-fetch-carries-its-own-reason-and-its-own-coverage.md).
  The storyline refresh is `deepening` even though a reader's click triggers it:
  the test is whether our own ranking chose the target. Re-run G2's byte-identical
  proof against the new predicate — with every existing sighting backfilled to a
  non-deepening plane it must still hold, and if it does not, the backfill default
  is wrong.

**§9 survives this phase.** "Every upstream call traces back to a real user
request" holds — a click is still the trigger. G7 is where that is traded.

**A known limitation of `alt_key`, carried forward from G1 and load-bearing
here — now measured and mostly closed.** The fold's suffix strip fired only when
the outlet's display name IS its domain stem, and **Google News writes the
display name**, so for every outlet in the second class a Google item and its
Currents twin folded to different keys and minted two rows. That is the exact
failure `alt_key` exists to prevent, and it landed on this phase.

**Measured on a corpus harvested for it** — 70 real storyline labels off the dev
archive, run against Google News RSS on 2026-08-28: 6,008 items over 1,837
outlets, committed as `fixtures/google-news-source-names.tsv`. **26.2% of items
failed to fold.** Four generative rules replaced the exact match, chosen on a
held-out half of the queries: the domain stem being one END of the display name
(the workhorse), an initialism of its content words, leading initials plus
trailing words, and the reverse affix. Held-out residual **6.9%**, and what
remains is a masthead in another script or a name with no lexical relation to
its domain at all — neither reachable by any rule.

Cost, measured the way ADR-0018 measured the positional strip: replaying the
whole fold over the dev archive's 32,279 articles costs **one additional merge**,
and it is a real duplicate. Migration `0023` re-keys the 524 rows (1.62%) whose
key moved, because ADR-0018 is explicit that changing the fold is a migration.

**Budgeting for it here rather than discovering it in G6 was the right call.**
Note what the 26.2% is and is not: it is the share of items whose Currents twin
they COULD NOT have folded onto, not the share that would have duplicated —
duplication additionally needs Currents to hold that story, on that domain, on
that UTC day, and how often that happens is precisely what G6 measures. Left
unfixed it would have put an unknown fraction of that 26.2% into G6's yield
number as new articles, biasing the one figure the phase is a go/no-go on, in
the direction that says yes.

**The open question this phase must answer**: how a deepening-plane article
appears in a day slot. `alt_key` shrinks the problem a long way — a Google item
for a story Currents already has folds into a *sighting* of the existing
article and inherits its group (subject to the suffix limitation above), so
only genuinely-new stories need placement.
For those, either (a) let them into grouping normally, which needs G0 landed
first to keep the suffix out of `story_tokens`, or (b) attach them as loose
storyline-day members rendered below the groups. Pick the smallest thing that
works, and let G6's numbers drive any richer answer.

**Answered: (a), and G0 does not gate it.** A deepening article is grouped
normally — `story_tokens` written, an existing group joined where the headline
matches — and what it SEEDS is attached to the arc that fetched it, with nothing
offered to the linker. That is (a) plus the attachment rule, and it needs no new
rendering.

**The G0 dependency in this sentence was never real, and G0's own Landed note is
why.** The clause reads "needs G0 landed first to keep the suffix out of
`story_tokens`", and the trailing ` - Outlet` / ` | Outlet` strip has been in the
tokenizer since **v6**, as `stripSourceAttribution`. G0 did not add it; G0
widened it to mastheads carrying a function word inside them. So option (a) was
safe under v8 as well, and this open question was gated on nothing.

**What G0 actually bought this plane is worth recording, because it is much
larger here than where it was measured.** Both tokenizers replayed over the
harvested corpus (1,838 display names, 6,008 items), each name appended to one
fixed headline so the number is the RULE's and not the corpus's title shapes:

```
v8  peels 1,680 names (91.4%)   5,592 items (93.1%)
v9  peels 1,747 names (95.0%)   5,775 items (96.1%)
    gained: 67 names, 183 items — no name lost
```

Three points of items, over exactly the mastheads G0's own note names: "The Globe
and Mail" (33 items), "The Times of India" (30), "Council on Foreign Relations"
(11). G0 measured its prize against the Currents archive at **63 titles of
32,279 — 0.2%** — and on Google News output it is 3.0% of items, an order of
magnitude more, for the reason the whole display-name problem has: **Currents
ships an outlet's own `<title>` tag and Google writes its DISPLAY name**, and a
display name is far more often a full organisation name than a masthead is. G0's
value is concentrated in the plane that did not exist when G0 was measured.

**And the residual is small enough to close the question.** After v9, **3.9% of
items (233 of 6,008, over 91 display names) still carry outlet chrome into
`story_tokens`** — nothing like the 100% the design doc's §4 feared ("at 100% of
items it would make link mass meaningless"), because that paragraph was written
believing no strip existed at all. What survives is
overwhelmingly a name LONGER than `MAX_ATTRIBUTION_WORDS = 4`: 62 of the 91 are
five words or more ("Peterson Institute for International Economics", "Bulletin
of the Atomic Scientists"). Raising that cap is the obvious next lever and it is
NOT taken here — the cap is what keeps a headline's own tail out, G0 measured its
false positives at that setting, and moving it re-opens a question this phase has
no corpus to re-answer.

Where the residual still lands, for G6 to price: `groupArticle`'s headline match
and `story_token_df`, not the linker — nothing on this path consults the linker,
since seeded groups are attached by provenance and joined groups inherit their
existing arcs.

**Seeded groups ONLY.** An article that JOINED an existing group already has a
home, and attaching its group here would drag every other article in it into
this arc on the strength of one keyword match — precisely the judgement the
linker exists to make and this path is refusing to make. Nothing is orphaned by
that: `linkSeededGroups` would have given a seed a storyline of its own, so a
joined group already has one.

**Done when**: a click on a storyline deepens it from Google News; no new
storyline is created by the deepening plane; the cloud is unchanged by the
fetch (G2 holding under real conditions, verified — not assumed); and
`storyline_coverage` records only spans actually fetched.

**Three of those four hold under real traffic and the third does not — G6
measured it, and this clause is left standing rather than softened because the
gap between what it claims and what happens is the point.** Across 41 live
fetches: the click path works, zero storylines were formed, and coverage was
recorded on exactly the 19 calls that reached a clean end of results. But **the
cloud is NOT unchanged by the fetch.** No deepening-plane article is counted —
the `plane` predicate holds perfectly — and the board moves anyway, because an
absorbed sighting rewrites an EXISTING discovery-plane article's `published`
(which is both the volume bucket and the decay input) and a minted article can
bridge two existing groups, re-parenting discovery-plane articles into a
different arc. `plane` gates which rows are counted; it cannot gate what a
counted row says. G6's verdict carries the measurement and the fix.

**One ordering constraint on turning the flag on, and it is on a database rather
than on code.** G0's owed repair steps have run on dev only; production is a
separate hand dispatch (see G0's Landed note). Enabling the deepening plane
before that dispatch mixes v9 vocabulary from its new articles with v8
vocabulary in the history they are matched against, which biases `groupArticle`
and `story_token_df` in exactly the direction G6 would read as yield. It is
recorded in `.env.example` beside the flag, which is where an operator will be
standing.

**Landed.** Migrations `0022` (`sightings.plane`, nullable, with a CHECK) and
`0023` (the `alt_key` re-key the fold change owes). Four decisions worth
carrying forward, all of them departures from what this section assumed:

- **The plane column is NULLABLE, not `NOT NULL DEFAULT 'search'`.** This
  section asked for "every existing sighting backfilled to a non-deepening
  plane"; the archive disproves the obvious form of that. 1,791 of the dev
  archive's 32,279 articles are members of a keyword-less topic and of nothing
  else, and the keyword-less topic is the breadth sample's own fingerprint — so
  `'search'` is a claim one query refutes. Splitting the backfill does not work
  either, because `topic_articles` is per ARTICLE and cannot say which of an
  article's sightings came from which fetch. NULL is what a database says for
  "not recorded", and the predicate is `plane is distinct from 'deepening'`
  accordingly. **The byte-identical proof this section asked for holds**: 136
  storylines under both the provider list and the new predicate over a 168h
  window on the dev archive — and 0 under a bare `<>`, which is why the spelling
  is load-bearing.
- **The display-name MAP was built, measured and declined.** It loses to four
  generative rules on held-out data (12.1% residual against 6.9%) because the
  failure population is a long tail — 529 distinct failing pairs in 70 queries,
  the top 100 outlets only 61% of failing items. The decisive argument is not the
  five points: a map is a fold that changes every time an outlet is added, and
  ADR-0018 establishes that changing the fold re-keys the archive. Corpus
  committed at `fixtures/google-news-source-names.tsv` so the comparison can be
  re-run; full experiment in `stripOutletSuffix`.
- **The open question below is answered (a), and G0 turned out not to gate it.**
  See its own note.
- **The topic row survives even though its coverage does not.** "Coverage goes to
  `storyline_coverage`, not to a synthetic topic" is taken as the claim it is
  about: nothing writes `topic_coverage` on this path. The topic ROW is still
  minted, because `topic_articles` is what claims an article against retention
  and a storyline is not a claimant that table knows about. Cost: one `topics`
  row per deepened arc, one `topic_articles` row per article, and a `hit_count`
  bump on a fetch rather than on a reader.

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

### Pre-registration — written and committed before any number was looked at

This subsection was written, committed and dated **before the first Google News
call of this phase was made**, because the plan's own instruction is to state the
kill criteria before looking and because the bias G5 identified points at the
answer that says yes. What follows is a decision rule, not a summary: the
verdict below is whatever this rule returns.

**Which archive, and why it is the dev one.** The number comes from the **dev
archive** — 32,279 articles, 2026-07-14 to 2026-08-27, a real Currents corpus —
and not from production. Production has no local database access at all (the
credential exists only as a GitHub secret, and `repair (production)` is pinned to
`refs/heads/main` and runs three fixed commands), so a production number would
need a new CI job, which needs a push, which is not this phase's call to make.
The three-way classification this gate turns on is a `sightings`/`articles` join;
without psql it cannot be computed at all. Production is measured **black-box**
alongside, as corroboration and not as the number — see below.

**The confound the dev archive has, named before it is measured.** A deepening
fetch's default window is `now - 7d … now`, and on the dev archive that is its
**thinnest** week: 2026-08-22 to 2026-08-27 hold 26–219 articles a day against
1,615–3,802 a day over 2026-08-10 to 2026-08-13. An archive that never looked at
a span cannot have "already had" what Google News finds there, so measuring at
the edge would return a yield near 100% that says nothing about the design and
everything about a laptop that was switched off. Production does not have this
problem — its four crons run continuously — so measuring at the dev edge would be
unrepresentative in the flattering direction.

So the primary measurement is run over a span the dev archive **densely covers**:

- **Span A (primary), 2026-08-10T00:00Z → 2026-08-17T00:00Z** — seven days, the
  width `DEEPEN_SPAN_MS` actually asks for, holding 12,145 of the archive's
  32,279 articles over 395–675 distinct domains a day. This is the archive at its
  most competitive, so it biases the yield **down**, which is the safe direction
  for a gate that is being warned against talking itself into a number.
- **Span B (sensitivity), 2026-08-21T00:00Z → 2026-08-28T00:00Z** — the same
  seven-day width at the archive's thin edge, run on the same arcs, to show how
  much of the answer is the archive's density rather than the design's merit.

Neither span is production's condition exactly. Span A is denser than
production's steady state and Span B is thinner, so the two are reported as a
**bracket**, and the verdict is taken on Span A.

**The three classes, because two would flatter.** G5 measured a residual 6.9%
cross-provider fold failure on `fixtures/google-news-source-names.tsv`, so
roughly one in fourteen Google News items the archive already holds will mint a
second row and look brand new. Every item ingested on the deepening plane is
therefore classified:

1. **Absorbed** — the item folded onto an article the **discovery plane** already
   held. Detected as `exists (select 1 from sightings where article_id = a.id and
   plane is distinct from 'deepening')`, which is the ranker's own predicate, so
   an article this experiment itself minted can never be counted as absorbed.
2. **Genuinely new** — a row this fetch brought into existence with no
   same-domain, same-UTC-day twin in the pre-experiment archive.
3. **Fold miss** — a row this fetch brought into existence that **does** have such
   a twin. `alt_key` is scoped to `(source_domain, folded title, UTC day)`, so a
   fold miss is by construction same-domain and same-day; candidates are
   generated by a deliberately over-eager positional strip plus a folded-title
   Jaccard floor, and every candidate is reviewed by hand rather than counted.
   Class 3 is measured on this experiment's own output, not extrapolated from
   G5's 6.9%.

**Corrected yield** is class 2 alone. Class 3 is subtracted, never counted.

**The decision rule.** Let `N` be corrected yield as a share of items ingested on
the deepening plane, taken as the **median over arcs** so one enormous arc cannot
carry the verdict, and let `A` be new articles per call.

- **Kill, ahead of the yield number**, if G5's guarantee has broken: any storyline
  formed by a deepening-plane article, or any label spent on one. That is a
  correctness failure and it outranks an economics question.
- **Kill** if the fold-miss class is more than half of the apparent new articles.
  A yield that is mostly `alt_key` failing is the duplicate generator this gate
  was written to catch, wearing the answer that says go.
- **No-go on G7** if median `N` < 20% — the deepening plane's articles are then
  overwhelmingly ones Currents already had, in the plan's own words, and G3/G4
  become dead weight to revert.
- **Go on G7** if median `N` >= 20% **and** median `A` >= 8. The 8 is not
  invented: `IngestResult.articlesCreated` records the discovery plane's own
  measured baseline as "~8 of 20" unique articles per upstream call, so a
  deepening call clearing 8 is at least as productive per call as the plane the
  system already pays for.
- **Anything else is inconclusive, and inconclusive resolves to no-go.** G7 buys
  a scheduler and spends §9's invariant; an undecided gate does not pay for that.
- **Inconclusive** also if throttling or refusals cut the sample below 10 arcs
  with a completed fetch on Span A.

**What is deliberately not measured here.** Whether the deepening plane's
articles are any *good* — relevance to the arc is assumed from the provenance
rule and the `deepeningQuery` gate, and judging it needs a rater, not a query.
And nothing here re-opens `MAX_ATTRIBUTION_WORDS` or the fold: G5 closed both
with a corpus this phase has no budget to re-harvest.

### Landed — the number, and the verdict

**89.2% of what the deepening plane ingests is an article the discovery plane
did not have. The pre-registered rule therefore says GO — and the verdict on G7
is NO-GO anyway, overridden on two defects the rule was not written to catch and
the run found regardless.**

Measured on the **dev archive**, 2026-08-29, over **2026-08-10 → 2026-08-17**,
the week that archive covers most densely. 25 arcs asked, 24 fetched, one refused
by the grounding gate. The instrument is `pnpm measure:deepening-yield`, which
drives `processDeepenJob` itself rather than a re-implementation of it; the
transcripts are gitignored under `apps/api/.g6/`.

```
items the plane touched (distinct articles)   1,904
  absorbed — the discovery plane had them       126    6.6%
  minted by this fetch                        1,778   93.4%
    of which a fold miss                         79    4.1%
  CORRECTED YIELD                             1,699   89.2%

median per-arc yield share                    91.0%   (rule needed >= 20%)
median new articles per call                     82   (rule needed >= 8)
```

Both pre-registered thresholds are cleared by an order of magnitude, and they
are cleared **against the bias**: Span A is the archive at its densest, which is
the condition most favourable to "Currents already had it". The sensitivity run
over the archive's thin edge is reported below and moves the number the way the
pre-registration predicted, which is the only thing it was run to check.

**The pre-registered rule returns GO, and the NO-GO below overrides it. That is
stated plainly rather than dressed up, because the honest description of what
happened is that the rule was written to catch one thing and the run found
another.** The rule's kill-ahead-of-yield clause names a specific guarantee —
a storyline formed, or a label spent, by a deepening article — and **that
guarantee held perfectly**. What broke is a guarantee the pre-registration did
not enumerate: G5's own "the cloud is unchanged by the fetch". So the refusal of
G7 is a judgement made OUTSIDE the pre-registered rule, on evidence collected
while executing it, and a reader is entitled to weigh it differently. The
evidence is in "What absorption actually costs" and "The `pubDate` cliff"
below; the yield itself is not in dispute and nothing is reverted.

#### Is the yield real, or is it `alt_key` failing?

This is the question the plan says the whole gate turns on, so it was attacked
rather than asserted.

**The at-risk population was measured, not assumed.** Of the 1,778 minted
articles, **881 (50%) have a same-domain article in the pre-run archive within
36 hours** — the only rows that *could* be a fold miss, since `alt_key` is
scoped to `(source_domain, folded title, UTC day)`. The other 897 have no
same-domain neighbour in that window at all, and **571 of those 897 are on a
domain the archive has never held** in its whole 2,033-domain history, so no
fold of any kind could have reached them. Against the 881, best-match title
overlap distributes:

```
>= 0.9   38      0.4-0.5  17
0.8-0.9  22      0.3-0.4  29
0.7-0.8  10      0.2-0.3  52
0.6-0.7   7      0.1-0.2 178
                 0.0-0.1 523
```

That histogram is an independent recomputation against a `pg_restore` of the
pre-run archive rather than the instrument's own output, and it puts 77 rows at
or above 0.6 where the instrument reports 79 — the instrument scopes twins by
article id and the recomputation by the snapshot, which differ on a handful of
rows. Two rows either way changes the yield by one tenth of a point; both are
reported rather than reconciled.

The mass is at the bottom: 753 of 881 score below 0.3, which is a different
story from the same newsroom on the same day — an outlet covering an arc
publishes repeatedly. **Eighteen of the 79 at or above 0.6 were read by hand**
and all but two are the same story under a headline the fold could not
reconcile; the two that are not are a follow-up carrying new facts
(`nbcnews.com` naming the soldiers a day after reporting the crash). The 0.4–0.6
band was read too, ten of twenty-two, and about three quarters are real (`globalnews.ca` re-cutting a wildfire headline,
`forbes.com` "Tosses Out" against "Throws Out"), which would take the corrected
figure from 1,699 to about 1,683 — **89.2% to 88.4%.** The verdict does not turn
on that, which is why the auditable 0.6 count is the one carried above.

**Two thirds of the yield is depth and one third is breadth**, and the split is
worth naming because the design is called *deepening*: 1,207 of the 1,778 are
from newsrooms the archive already knew (more of what those outlets published on
that arc) and 571 are from 332 domains it had never seen, against a pre-run base
of 2,033 — a 16% expansion of the archive's newsroom list from 24 calls. Read on
one arc it is obvious what that buys: "Bald Range Wildfire" gained
KamloopsBCNow, Castanet, AM 1150, Victoria Buzz, Goldstream Gazette, Grand Forks
Gazette — the regional press for a British Columbia fire, none of which Currents
indexes. **Relevance was eyeballed, not measured**, exactly as the
pre-registration said it would not be: attachment is by provenance, so nothing
here rates it, and every sampled title from two arcs was on subject.

Per arc, so the medians above can be checked rather than believed. `items` is
this fetch's batch after the topic-collision correction, `net` is `new` minus
`miss`, and `gain` is how many distinct articles the ARC itself ended up
holding that it did not hold before.

```
 items absrb   new miss  net  gain  arc (Span A, 2026-08-10 - 2026-08-17)
    35     1    34    1   33    33  Infantino FIFA leadership crisis
   100     9    91   11   80    90  Leavitt White House Exit
    99     9    90    1   89    94  Google Pixel 11 Launch
    62     1    61    0   61    61  Lala Hawaii Hurricane Watch
    99     2    97    5   92    84  Canada US Trade War
   100     5    95    4   91    95  Qusra settler siege
   100     2    98    0   98    98  McIlroy St Jude Championship
    50     3    47    1   46    46  Trump Vaccine Overhaul
    55     0    55    2   53    59  USS Lincoln Deployment Crisis
   100     9    91    7   84    86  Trump Turkey Plane Decoy
    75     1    74    4   70    74  Texas Apache Crash
    24     1    23    1   22    19  Russian Torture Allegations
   100     7    93    9   84    76  Trump Turkey Flight Swap
    77    13    64    2   62    67  Ukraine Nizhnekamsk Drone Strike
    42     9    33    2   31    50  Eurovision hosting rule change
   100    11    89   10   79    90  North Korea Missile Launch
    82    13    69    4   65    68  Harvard Antisemitism Lawsuit
    55     4    51    3   48    33  Trump Catering Truck Ruse
    97     6    91    6   85    90  Transshipment Scam
   100     8    92    0   92    82  Typhoon Dolphin China
   100     5    95    3   92    95  Bald Range Wildfire
    99     6    93    4   89    82  Strait of Hormuz Crisis
    99     4    95    5   90    93  Gilman Russia Release
   100     0   100    0  100   100  Canadian Open Tennis
```

**`gain` is not `new` and drifts both ways, which is worth understanding before
either column is quoted.** Against `new`: 13 arcs gained fewer, 6 exactly as
many, and 5 MORE. Both directions have a mechanism and neither is a miscount.

*Fewer* is G5's own attachment rule working: only SEEDED groups are attached, so
a minted article that JOINED an existing same-day group brings nothing to the arc
— it inherits whatever arcs that group already had. "Trump Catering Truck Ruse"
is the extreme, 33 against 51, which says a third of its minted articles landed
in groups that already existed.

*More* is the group-merge channel: a minted article can bridge two existing
groups, and the merged group arrives carrying every article already in it.
"Eurovision hosting rule change" gained 50 on 33 minted. That is the same
re-parenting the cloud section below is about, seen from the arc's side, and it
is the one number here that a deepening fetch has no business moving.

**The yield figures above are computed from `new` and `miss`, never from
`gain`.** `gain` is reported because the plan's question says "adds to a clicked
arc" and it is the honest answer to that literal question; it is not the yield,
because it mixes in a grouping decision the fetch did not make.

#### The `pubDate` cliff — the finding that decides G7

**Google News RSS stops reporting a publication TIME for items more than about
eight days old, and reports midnight US Pacific instead.** Measured over all
3,087 deepening-plane sightings this phase produced, by the item's age at fetch:

```
age (days)     0    1    2    3    4    5    6    7    8 |    9   11   12   13   14   15   16   17   18   19   20
% at 07:00Z  0.0  0.0  0.0  1.4  1.5  2.7  4.0  0.0  3.9 | 70.8 92.5 77.4 83.5 83.2 85.4 95.0 93.9 89.8 88.7 97.1
items         11   73   65  215  194  221  101  170  103 |   24  106  124   97  107  322  398  361  246  115   34
```

07:00:00Z is midnight PDT, and `raw` carries it verbatim —
`"pubDate": "Thu, 13 Aug 2026 07:00:00 GMT"` — so this is Google's payload and
not our parse. The cliff sits between day 8 and day 9 and it is sharp:
**1.7% degraded at eight days or fresher (20 of 1,153), 89.4% beyond that
(1,729 of 1,934).**

Three consequences, in increasing order of how much they matter:

- **Intra-day ordering is gone** for anything older than a week. A day slot's
  lead article is its earliest member, and 100 items sharing one instant order
  arbitrarily.
- **`alt_key`'s day bucket breaks for about 29% of the clock.** Google says
  07:00Z of Pacific date D; the real article is anywhere in D 07:00Z … D+1
  07:00Z, so every twin Currents timestamped between 00:00Z and 07:00Z — seven
  hours of twenty-four — lands in a different UTC day and cannot fold whatever
  the fold does to the title. Two of the three worked examples are exactly this:
  `pbs.org` "Karoline Leavitt is leaving her role as Trump's White House press
  secretary", **byte-identical headlines**, Currents at `2026-08-13T00:32:39Z`
  and Google at `2026-08-12T07:00:00Z`, two rows. Same for `techradar.com` at
  `03:07:51Z`. ADR-0018 named the day bucket as load-bearing and bounded it at
  "33 articles of 31,308 straddle a UTC midnight" — a figure measured on one
  provider whose two emissions are minutes apart, and it does not survive a
  provider that emits a bare date in another timezone.

  **The defect is real and the mechanism above is wrong — corrected 2026-08-29,
  see [ADR-0022](adr/0022-a-bare-date-widens-the-lookup-not-the-fold.md).** The
  paragraph reasons from the stamp to the fix: if Google's date names a Pacific
  day, then bucketing on the Pacific day makes its assertion exactly one bucket.
  Measured against the 150 bare-date Google News sightings on the dev archive
  whose story Currents also holds, **it does the opposite** — the same-bucket
  share falls from 84.7% under UTC to 78.7% under Pacific, because Google's date
  disagrees with the archive's clock in BOTH directions (12 pairs a day early, 11
  a day late) and no fixed offset can absorb a two-sided error. All 24 hourly
  boundaries were scored; the best of them, 03:00Z, reaches 86.0%. The two worked
  examples above are genuine and are among the 12 — a fix that repaired them and
  broke 20 others would have looked like a success from here.

  So the repair is not a bucket at all: a bare-dated sighting is RESOLVED against
  its own day and the two adjacent ones and still STORED under one, which closes
  all 23 misses, matched more than one day in 0 of 1,749 sightings, and — because
  the fold is untouched — owes no migration.
- **`published = LEAST(...)` writes the degraded stamp onto articles the
  discovery plane already held.** That is the next section.

**What this does to the phases is the opposite of intuitive.** The plane as G5
ships it plans `now - 7d … now`, which is **inside the cliff** — 1.7% degraded
over the 1,153 sightings this phase drew from that window. **G7 is the phase
that walks off it**: a crawl frontier backfills history by slicing spans, and
every slice older than about eight days is in the 90% zone. So the defect is
almost invisible today and structural for the phase being decided.

#### What absorption actually costs — and G5's "the cloud is unchanged" does not hold

Absorption is not the free, silent fold the design assumes. Of the **126**
pre-existing articles a deepening sighting folded onto in Span A:

```
url replaced with a news.google.com/rss/articles/CBMi… redirect   104   83%
title replaced with the Google-chromed " - Outlet" form           101   80%
published flattened onto the 07:00Z day boundary                  104   83%
```

The mechanism is ADR-0002's own display-field handover working exactly as
written: the earliest emission wins the display fields, and a stamp of 07:00Z
is earlier than almost any real time that day, so **the degraded sighting wins**.
`dedup_key` and `alt_key` are correctly left alone — identity is safe — but
`url`, `title` and `published` are not identity, and all three get worse.

A worked case, `articles.id = 678`:

```
was  https://www.abc.net.au/news/2026-08-10/ukraine-kills-13-including-child-…/107021852
     2026-08-10 12:09:10+00
     "Ukraine kills 13 in drone attack on Russian city of Nizhnekamsk"
now  https://news.google.com/rss/articles/CBMiswFBVV95cUxNMHE4NnJDTDBoWGlqRS1q…?oc=5
     2026-08-10 07:00:00+00
     "… of Nizhnekamsk - ABC News & Headlines – Australian Broadcasting Corporation"
```

This is a reader-visible regression on an article the discovery plane held
cleanly: a link that now hops through Google, a headline carrying outlet chrome,
and a fabricated timestamp. **Note what is NOT claimed**: a *newly minted*
Google News article has no other URL to carry, so its redirect link is the price
of the provider and not a defect. Production already shows both — its
"US Venezuela Oil Deal" arc leads on a `sightingCount: 1` Google row, which is
the honest case.

**And the cloud moved, which G5's Done-when says it must not.** Re-running
`readTrendingStorylines`' exact query against the archive and against a pre-run
restore of it, three 24-hour windows:

```
2026-08-21   IDENTICAL, 20 rows
2026-08-13   Google Pixel 11 Launch 70 articles/32 domains -> 74/33;
             "Made by Google Launch" appears; "Tata Sons Leadership Transition" falls out
2026-08-14   Leavitt White House Exit unchanged at 68/49 but score 62.574 -> 54.126;
             USS Lincoln Deployment Crisis 37/33 -> 43/38; "USS Abraham Lincoln Crisis" appears
```

The plane predicate is doing its job — no deepening-only article is counted. The
leak is through the articles it does count: an absorbed sighting **moves an
existing discovery-plane article's `published`**, which changes both which
window it falls in (volume) and `max(published)` (the decay), and a minted
article can **bridge two existing groups**, which re-parents discovery-plane
articles into a different group and therefore a different arc — **259 pre-existing
articles changed `group_id`** across both runs, 211 of them in Span A alone. ADR-0019 anticipated a mislabelled plane as the
hazard; this is a channel that needs no mislabelling at all, because
`plane` gates *which rows are counted* and cannot gate *what a row says*.

> **Followed up 2026-08-29 (`docs/G6-ITEM-5-GROUP-REPARENTING.md`, gating item 5).**
> The two channels have since been SEPARATED, against a restore of this phase's
> own pre-run dump, with a harness that reproduces the three `board-pre-*` boards
> above byte-identically. **The group channel accounts for every one of the 16
> board membership changes across the three windows; the `published` handover for
> none of them.** The bridging is also not a deepening property — the same code
> path runs on both discovery-plane callers and predates the plane by 335 commits
> — so this is grouping working as ADR-0009 designed it, not a leak `plane`
> failed to gate. The count that means something is **264 pre-existing articles
> changed arc**, all by gaining, none by losing.

Both channels have a fix and neither is in this phase's scope. The narrow one:
refuse the display-field handover to a sighting whose timestamp is a bare date.
**That test is a heuristic and its error direction is the safe one**, which is
the argument for it rather than an apology: a bare date arrives as exactly
`07:00:00 GMT` in the `pubDate` string (`08:00:00` outside daylight saving, and a
backfill into winter months will see it), a real article CAN publish on that
second, and 20 of the 1,153 items this phase drew from inside the eight-day
window carry it — 1.7%. A false positive refuses one handover, which leaves the existing
article's own URL, title and timestamp in place. That is the outcome the archive
wants anyway. The broad one: stop treating a deepening sighting's `published` as
an emission time at all. Whichever is chosen owes its own measurement.

The handover splits exactly on the stamp, which is what makes the narrow fix the
right size. Over all 169 absorbed articles in both runs:

```
deepening sighting carried a bare-date stamp   126   106 lost their URL   84.1%
deepening sighting carried a real clock time    43    10 lost their URL   23.3%
```

The 43-row group is the case ADR-0002 was written for — Google genuinely saw an
earlier emission — and its 10 handovers are correct. **The defect is the 106
handovers inside the 126-row group**, not the group: the other 20 kept their
fields because the archive's own timestamp was already earlier than 07:00Z, which
is the same rule working by luck rather than by judgement.

#### The sensitivity run, and what it did NOT show

Span B, **2026-08-21 → 2026-08-28**, the archive's thin edge, same instrument, 17
arcs (only 17 clear the sample's `>= 5 articles, >= 2 domains` bar in that
window, which is itself the thinness):

```
                        Span A (dense)   Span B (thin edge)
arcs fetched                        24                   17
items touched                    1,904                1,167
absorbed                       126 6.6%              43 3.7%
fold misses (of minted)        79 4.4%             10 0.9%
median per-arc yield             91.0%                92.7%
mean yield                       89.2%                95.5%
```

Every count in that table is DISTINCT articles. The per-arc medians are per arc
and can count an article twice when two arcs both drew it, which is why the two
bases are labelled rather than mixed.

The pre-registration predicted Span B would read higher because the archive
looked less there, and it does. **The size of the gap is the finding: 6.3
points, not 40.** Had the Span A number been an artifact of a switched-off
laptop, the thin edge would have run away from it. It does not, so the yield
survives its own worst-case confound and the two spans bracket production rather
than bounding it loosely.

One number inside the table is a second confirmation of the cliff rather than a
statement about archive density: fold misses fall from **4.4% of minted articles
to 0.9%** between the spans. Span B's items are inside the eight-day window
where `pubDate` is still a real time, so the day bucket holds and the fold works
— which is what the cliff predicts and not what "the archive is thinner here"
would predict.

#### Throttling, refusals, and what a call costs

**41 live Google News calls in two runs of under seven minutes each (Span A
03:13:45–03:20:31Z, Span B 03:24:50–03:29:15Z), paced at one per 15 seconds
against a `GOOGLE_NEWS_BURST_CALL_LIMIT` of 5 per 60s. Zero throttling of any
kind: no 429, no 5xx, no breaker trip, no empty feed, no `NewsQuotaError`, and
no retry.** There is no header to read, so that is an observation over 41 calls
and not a limit — it says the ceiling was not met at roughly 3.5 calls a minute
sustained for seven minutes, and nothing whatever about where it is. Anyone
reading this as a budget should note what it does NOT cover: no burst above that
pace, no run longer than seven minutes, and nothing about a second client on the
same egress IP.

The only losses were `normalizeBatch`'s, and they are tiny and of one kind: five
calls dropped items, seven items in total across 41 calls (0.2%), every one of
them `no_identity` — an item with no usable link. No `schema`, `no_title`,
`no_url`, `bad_url` or `bad_published` drop occurred at all, which is a
statement about a feed nothing contractual guarantees and is worth re-checking
rather than assuming.

Latency, end to end including ingest, grouping and attach:

```
Span A  min 940ms   p50 1,968ms   p90 2,354ms   max 2,613ms
Span B  min 576ms   p50 1,634ms   p90 1,942ms   max 2,419ms
```

**The grounding gate fired once in 42 arcs** — "Institutional Portfolio Shifts",
an arc of 103 articles over 16 domains whose label shares no word with its own
profile. That is the gate doing exactly its job: a diffuse market-roundup arc is
one where a wrong attachment is cheap to make and expensive to keep.

**Coverage was recorded on 19 of 41 calls.** The other 22 returned a full 100
items, so `isLastPage` was false, so `recordStorylineCoverage` was correctly
skipped and the gap stays open — behaving as `processDeepenJob` documents. At a
seven-day span **more than half of all calls buy no coverage at all**, which is
a fact G7 has to plan around rather than discover: depth on this provider comes
only from narrower slices, and `DEEPEN_SPAN_MS`' seven days is explicitly "a
guess with a stated reason".

#### The G5 guarantees that DID hold

- **Zero storylines formed.** 26,883 before, 26,883 after, across 41 fetches and
  2,902 minted articles.
- **Zero labels spent.** `label_at` moved on no row. The plan asked for this
  ahead of the yield number and it is clean: `groupCreatedArticles` returns from
  the `attachTo` branch before the linker and before the label tail, and the
  archive agrees.
- **No `topic_coverage` row was written by the deepening provider**, which is
  the claim G5's "coverage goes to `storyline_coverage`" actually makes. The
  topic ROW is minted as G5 said it would be — 23 new topics for 24 Span A
  fetches, the 24th colliding with a topic a reader had already searched.
- **The plane predicate excludes what it is supposed to exclude.** Every one of
  the 2,902 minted articles is invisible to `readTrendingStorylines`. The cloud
  moved anyway, through the two channels above, which is a different failure from
  the one G2 was built to stop.

#### `MIN_SOURCE_DOMAINS` on discovery-plane domains: the floor selects, the score does not

The plan asks whether a floor computed on discovery-plane domains still selects
arcs a human would call newsworthy. Measured two ways.

**On the dev archive**, one 48-hour window, gate inputs restricted to the
discovery plane exactly as `readTrendingStorylines` restricts them: 980 arcs
clear the floor, **516 of them (53%) sit at exactly two domains** — but only 13
of those carry five or more articles, and only 6 arcs of 980 (0.6%) have the
wire-pile shape of three or more articles per domain. As a population problem
this is small.

**On production's live board, 2026-08-29** — 22 arcs — it is not a population
problem, it is a ranking one:

```
 37 art   2 dom | Securities Fraud Lawsuits         rank  3 of 22
 23 art   2 dom | Securities Fraud Class Actions    rank  4 of 22
 19 art  18 dom | Lake America Renaming Controversy rank  5 of 22
 14 art  14 dom | Lake Ontario Naming History       rank  6 of 22
```

Two wire piles — 18.5 and 11.5 articles per domain, one PR wire firing
repeatedly — rank **above** two stories with genuine multi-newsroom coverage.
The floor admitted them honestly: two domains is two domains. What promoted them
is that ADR-0014's score is `volume x decay` **with no domain term at all**, so
the same repetition that should be evidence *against* an arc is the thing
lifting it.

So the answer is split, and it matters that it is: **the floor is not the broken
part and raising it is the wrong lever.** Raising it to three would drop
"Lake America" (18 domains, 19 articles) only by accident of volume and would
still admit a three-outlet wire pile. The lever that fits the observed failure is
a domain term in the ordering — but **no threshold ships here**: this is one
board on one day, the repo's rule is that no threshold ships unmeasured, and
setting one needs a labelled sample of arcs a human has actually judged. It is
recorded as the measured observation it is, for whoever takes it.

#### The Nepal split is real, it has got worse, and it distorts per-arc yield

The brief named two arcs for one event. **Production's board on 2026-08-29 holds
three**:

```
Nepal Tibet Floods        arc 783 articles / 182 domains   window 33/24
Nepal Hydropower Floods   arc  82 articles /  50 domains   window  2/2
Nepal China Floods        arc   4 articles /   4 domains   window  2/2
```

Every per-arc number this phase reports is computed **per storyline**, so a split
event is three fetches of one subject, three coverage ledgers, and — under G5's
attachment rule — three arcs each accumulating their own Google News articles
with nothing merging them. It does not bias the yield SHARE, which is a ratio
inside each fetch. It does inflate **calls per event**, and it is the one place
where G7's economics are worse than this phase's arithmetic suggests: a crawl
frontier pays the split three times per pass, forever, and the deepening plane
feeds each fragment separately rather than growing the survivor. The label-merge
pass is the mechanism that should collapse these and has not; that is
`storyline-label-merge`'s problem and not this phase's, but G7 should not be
planned as though each arc were an event.

#### What this phase deliberately did not do

- **It did not measure production.** The reason is in the pre-registration and
  it is access, not preference. Two production facts ARE reported — the live
  cloud, and the arc payloads showing Google-redirect URLs already reaching
  readers — and both are public reads. **No arc was clicked on production**:
  once absorption was shown to replace a good URL with a redirect, manufacturing
  more of that on the live archive to corroborate a number already established
  on dev was not a trade worth making.
- **It did not rate relevance.** Attachment is by provenance and nothing here
  judges it.
- **It did not re-open the fold, `MAX_ATTRIBUTION_WORDS`, or `MIN_SOURCE_DOMAINS`'
  value.** G5 closed the first two on a corpus this phase has no budget to
  re-harvest, and the third is argued above to be the wrong lever anyway.
- **It did not fix the `pubDate` defect.** G6 is a decision gate; the fix is a
  change to the ingest fold with its own measurement to make, and inventing it
  inside a measurement phase is how a gate stops being one.

#### The obvious escape — window the crawl inside the cliff — was measured, and it is half a fix

The first thing anyone will propose on reading the cliff is to keep the frontier
on the safe side of it. **Span B already is that experiment** — 17 fetches, all
at the leading edge — so this is measured rather than argued:

```
                            Span A (backfill)   Span B (leading edge)
corrected yield                       89.2%                   95.5%
stamps degraded                        ~89%                    3.1%
fold misses (of minted)                 4.4%                   0.9%
absorbed articles losing their URL       83%                     28%
```

The fold recovers almost completely, and that is the whole of what the window
buys. Four things it does not settle, in the order they will bite.

**The window has to be about a day narrower than the cliff, and G5's current
constant already sits on the edge with no margin.** `BOUND_PADDING_MS` pads
`after:` a day outward — deliberately, so an under-fetch is impossible — so a
planner window whose far edge is D days back asks the wire for D+1. Span B's far
edge was 8 days back and **the wire returned 24 items 9 days old, 17 of them
degraded (71%)**. The arithmetic limit is therefore a far edge 7 days back, and
the bucket that lands on (day 8) is already 3.9% degraded against 0% at day 7 —
so **7 is the ceiling and 6 is the number with margin**, not 8.

Which is worth stating twice, because `DEEPEN_SPAN_MS` is *already* 7 days and
`queueStorylineDeepening` plans `to ≈ now`: the shipped leading-edge fetch puts
the wire's far edge on **day 8, the last bucket before the cliff**, by accident.
Widening that constant reads like a tuning change and is a change to how well the
fold works.

**The URL handover is a SEPARATE defect and the window does not touch it.**
Every one of the **3,087** deepening sightings this phase produced carries a
`news.google.com/rss/articles/CBMi…` redirect; **not one carries the outlet's own
URL**. So handing the display fields to a Google sighting is never an improvement
on the `url` column, whatever the timestamp says. Split by run and by stamp:

```
                         absorbed   lost their URL
Span A  bare-date stamp       123              103
Span A  real clock time         3                1
Span B  bare-date stamp         3                3
Span B  real clock time        40                9
```

Span B still loses 12 of 43, and **9 of those 12 are the honest case** — Google
genuinely saw an earlier emission, ADR-0002 says the earliest emission wins the
display fields, and the archive trades a working link for a redirect anyway. A
bare-date test fixes the timestamp and the title; it cannot fix this, because
this one is not about the timestamp.

**Group re-parenting is timestamp-independent and scales with call volume.**
259 pre-existing articles changed `group_id` across the two runs. Nothing about
a narrower window changes that, and a scheduler is a call-volume increase by
definition.

> **Corrected 2026-08-29 (`docs/G6-ITEM-5-GROUP-REPARENTING.md`, gating item 5).**
> Timestamp-independent is right; "scales with call volume" is not. Groups only
> ever coarsen and a repeated merge is a no-op, so the channel is monotone and
> idempotent and converges to a fixed point — volume changes how fast it is
> reached, not where. The count is also wrong in both directions: the figure that
> means anything is **264 pre-existing articles changed which storylines they
> belong to**, all of them by GAINING arcs, none by losing coverage.

**And the window costs G7 the thing G7 is for.** This section's own scope line is
"arcs backfilled by slicing their spans"; a six-day ceiling means an arc
discovered late can never have its history fetched at all. What survives is *the
same leading-edge fetch G5 already ships, on a timer instead of a click* — a real
thing, since it trades §9's invariant for freshness on arcs nobody clicked, but a
much smaller thing than this section describes, and it should be **re-scoped and
re-argued rather than shipped under the current framing**.

So the window is a workaround that forfeits backfill, and the handover fix is
needed for the windowed case anyway. The fix is the cheaper of the two and
forfeits nothing.

**One truncation fact that binds either way**: 9 of Span B's 17 calls hit the
100-item cap at the leading edge, so a windowed crawl still needs subdivision —
roughly three to four slices per busy arc per pass. Against 150 background calls
a day that is comfortable for production's 22-arc board and unmeasured for
anything wider; the active-arc count was not read, so no budget is asserted here.

#### The verdict on G7

**NO-GO, and it is a "not yet" rather than a "never".**

The yield rule returns GO by a wide margin and that result stands: the deepening
plane is not a duplicate generator, `alt_key` is not quietly absorbing its
output, and G3 and G4 are not dead weight. **Nothing is reverted.** Two thirds
depth and one third breadth, 71 genuinely-new articles per call against the
discovery plane's own recorded baseline of ~8 per call, is a good trade for one
HTTP request.

**G7 is refused on evidence the pre-registered rule did not ask for.** The rule
returned GO; the two findings below are not in it, and the case for letting them
outrank it is the shape of the defect rather than its current size — both get
worse in exactly the way G7 changes things:

1. **G5's "the cloud is unchanged by the fetch" is false as written**, through
   `published` handover and group re-parenting. Under a click-driven plane this
   is bounded by how often people click. Under a scheduler it is unbounded, and
   it is precisely the endogenous loop ADR-0019 built `plane` to prevent,
   arriving by a route `plane` cannot see.

   > **Corrected 2026-08-29 (gating item 5).** The claim holds; "unbounded" does
   > not, for the group half. That half converges to a fixed point and cannot
   > ratchet, so a scheduler reaches the same end state sooner rather than a worse
   > one. **Which half moved the cloud was also measured, and it is the opposite
   > of the ordering here**: over G6's three windows the group channel accounts
   > for all 16 board membership changes and the `published` handover for none —
   > its signature is score-only (`Leavitt … 68|49, 62.574 → 54.126`) plus one
   > boundary swap. ADR-0021 fixes the channel that moved the board least. The
   > residual harm is not misfiled articles but a correct merge amplifying a
   > pre-existing arc split into several inflated board rows.
2. **G7's own work is what the `pubDate` cliff punishes.** Backfilling an arc by
   slicing its span means fetching almost exclusively items older than eight
   days, where 90% of stamps are a bare date in the wrong timezone. Today's
   leading-edge fetch runs at 1.7% degraded and is fine; the crawl frontier
   would run at ~90%.

**What G7 is gated on.** Five items as written, none of them a phase of its own —
every one is a G5 correction, and together they are smaller than the measurement
that found them. The first two are unconditional; items 3 and 4 are what a windowed
frontier owes on top, and they exist because windowing was measured above and came
back half a fix. **Item 5 was discharged on 2026-08-29 — accepted in writing, on
the finding that it was not a deepening defect at all.** The description that
discharged it is `docs/G6-ITEM-5-GROUP-REPARENTING.md`, and it corrects two claims
this section makes; both are marked in place below.

**Items 1 and 2 were also discharged on 2026-08-29** — item 1 and the handover
half of item 2 by ADR-0021 (#185), the day-bucket half of item 2 by ADR-0022 — so
**the live gate is items 3 and 4, and both are conditional on the frontier being
windowed.** Which is to say: nothing unconditional is outstanding, and G7's
verdict now rests on its own argument rather than on a list of repairs. The
verdict is unchanged — the acceptance test below has not been run.

1. **Never hand a deepening sighting's `url` to an existing article.** Not
   conditional on the stamp: all 3,087 sightings this phase drew carry a
   `news.google.com/…CBMi…` redirect and none carries an outlet URL, so the
   handover is a downgrade in every case — including the 9 of Span B's 12 where
   the earlier-emission claim was true. A newly MINTED article keeps the redirect,
   which is the price of the provider and not a defect.
2. ~~**Refuse the rest of the display-field handover to a bare-date sighting**, and
   decide in the same change what a bare date means for `alt_key`'s day bucket —
   the two are one question about whether a date is an emission time.~~ The measured
   prize is the 103 of Span A's 104 corruptions that a bare stamp drove; the
   measured cost is that the test misfires on ~1.7% of in-window items, in the
   safe direction. Both numbers are above; neither ships unmeasured.

   **DISCHARGED — in two changes rather than one, and the split was the right
   call.** The handover half landed with
   [ADR-0021](adr/0021-the-earliest-emission-is-not-authoritative-for-every-field.md)
   (#185), which also discharges item 1. The day-bucket half landed with
   [ADR-0022](adr/0022-a-bare-date-widens-the-lookup-not-the-fold.md), separately
   because it was the only one of the two that could have touched the FOLD, which
   ADR-0018 prices as a migration.

   **And it did not touch it.** This item asks what a bare date means for the day
   bucket and the section above answers "Pacific". Measured, that answer is wrong
   in the expensive direction: over the 150 bare-date sightings whose story
   Currents also holds, a Pacific bucket takes the same-bucket share from 84.7%
   DOWN to 78.7%, because the disagreement between Google's date and the archive's
   clock is two-sided and no fixed offset absorbs it. So the fold stays where it
   is and the LOOKUP widens instead — a bare-dated sighting resolves against its
   own day and the two adjacent ones while still being stored under one, closing
   all 23 misses with 0 ambiguous matches in 1,749 sightings, and owing no
   migration.
3. **If the frontier is windowed, the far edge is 6 days back, not 8.** The cliff
   is at day 8/9, `BOUND_PADDING_MS` adds a day to whatever the planner asks, and
   day 8 is already 3.9% degraded. 7 is the arithmetic ceiling and 6 is the number
   with margin. Note this makes `DEEPEN_SPAN_MS` load-bearing on the fold: at 7
   days with `to ≈ now` it puts the wire's far edge on day 8 today, by accident.
4. **Do not pin that window to a measured constant without a monitor on it.** The
   cliff is Google's behaviour, not a contract, and its exact location rests on
   **24 items** — day 9 was reached by Span B alone, since Span A's window started
   at day 12. The honest form is a metric on the share of
   deepening sightings arriving with a bare-date stamp, alerting when it moves —
   not a number in config that was true on 2026-08-29.
5. ~~**Close the group-re-parenting channel, or accept it in writing.**~~
   **DISCHARGED 2026-08-29 — accepted in writing, and the item as written was
   the wrong item.** Described and measured in
   `docs/G6-ITEM-5-GROUP-REPARENTING.md`, against a restore of this phase's own
   pre-run dump. Four findings, in the order that changes the framing:

   - **It is not deepening-specific, and G6's wording above is too narrow.**
     `groupCreatedArticles` runs `groupArticle` — and so `mergeBridgedGroups` —
     over every arrival in one loop, and only *then* branches on
     `intent.attachTo`. Its other two callers are both discovery plane.
     `mergeBridgedGroups` landed in `d40cce6` (ADR-0009, 2026-08-13); the
     deepening plane landed in `0dec1fa` (#179, 2026-08-28), 335 commits later,
     and ADR-0009 measured this channel on discovery data. **`plane` was never
     going to gate it, because it is not a plane leak — it is grouping.** What
     deepening changes is arrival density: 1.90 merges per 100 arrivals against
     ADR-0009's 0.33, because a call returns 100 items about ONE story, which is
     the maximal condition for bridging.
   - **It converges; it does not scale the way this list assumed.** Groups only
     ever coarsen and a repeated merge is a no-op, so the channel is monotone and
     idempotent and has a FIXED POINT. Call volume changes how fast it is
     reached, not where it is. The "scales with call volume" claim at the top of
     this section and in the verdict's point 1 is wrong on that reading and is
     corrected in place there.
   - **The blast radius is additive, and 259 counts the wrong population.** 28 of
     the 259 changed no arc at all, and 33 articles OUTSIDE the 259 changed arc
     without changing `group_id` — the winner group's own members, whom a
     `group_id` diff cannot see. Corrected: **264 pre-existing articles changed
     which storylines they belong to, every one of them GAINED arcs, and not one
     lost coverage.** 32 of the 55 merges are the singleton adoption ADR-0005
     already permitted, so the population this item was about is 23.
   - **The merges are right.** All 13 merges moving five or more articles pair
     leads of the same story, read by hand; eleven are unambiguous syndication
     heals and two are ADR-0009's stated "same story, not the same piece" cost.
     The 43 cross-arc unions are overwhelmingly unions of arcs that were ALREADY
     duplicates of one event — Gilman ×3, Nizhnekamsk ×2, USS Lincoln ×2,
     Eurovision ×3. Genuine cross-event contamination is about 2 of 43, both
     single- or two-article.

   **So there is nothing to close at the grouping layer, and closing it would
   forfeit correct repairs** — the 38-article Swedish school attack, the
   35-article Pixel 11 launch. Refusing the merge on the deepening plane alone
   was considered and is rejected: the channel is general, so it fixes nothing in
   principle and buys a permanent divergence between the two planes' grouping.

   **What the item exposed is real, and it is a different item.** A correct merge
   multiplies a PRE-EXISTING arc split into several inflated board rows: group
   30218 absorbed three Eurovision groups and all three arcs now hold it, so
   `Burgas Eurovision Host` 37|33, `Eurovision hosting rule change` 34|32 and
   `Eurovision Conflict Rule` 33|31 take three top-20 slots for one story and push
   four arcs off the board. **That is the Nepal split recorded above, amplified**,
   and the damage is proportional to how badly `storyline-label-merge` has already
   failed on the event. The follow-up worth measuring is therefore the opposite of
   this item: **feed the merge back into label-merge as evidence** — a bridge merge
   is stronger proof that two arcs are one event than anything `mergeCollidingLabels`
   gets today, and `absorbMergedGroup` currently marks `link_dirty_at` and stops.
   That needs its own measurement and is NOT a G7 gate.

   **G7 is therefore gated on four items, not five** — and on two, not four,
   once items 1 and 2 landed later the same day.

**And re-run this instrument afterwards**, with the acceptance test being the one
G5 stated and did not get: the cloud comes back byte-identical across a run.

**If the frontier IS windowed, re-scope this section before building it.** Its own
line above is "arcs backfilled by slicing their spans", and a six-day ceiling
forecloses exactly that: an arc discovered late can never have its history
fetched. What is left is the leading-edge fetch G5 already ships, on a timer
rather than a click — still worth doing, still a genuine §9 trade, but not the
phase written here, and it should be argued as the smaller thing it is.

## G7 — The scheduler, and the §9 trade

**Depends on**: G6 saying yes. **G6 said NO — see its verdict above**, which
carried a five-item gating list; **items 1, 2 and 5 were discharged on 2026-08-29
and two remain**, both conditional on the frontier being windowed. The yield is
there; two defects it uncovered are not survivable by a scheduler, and both are
G5 corrections rather than new phases. **Windowing the crawl inside the eight-day
`pubDate` cliff was measured and is half a fix** — it restores the fold and
touches neither the URL handover nor group re-parenting, and it forecloses the
backfill this section is written around (group re-parenting is now accepted
rather than owed — item 5).

**What is left before this can start is the acceptance test, not the list.** The
repairs have landed; what has not happened is re-running G6's instrument and
seeing the cloud come back byte-identical across a run, which is the check G5
stated and did not get. Until that has been done the verdict above stands.

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

## G8 — Retire category as a user selection

**Depends on**: nothing. Independent of the rest, and it should land before G5.

**Why**: the deepening plane cannot express a category at all (see G4 — asking
for one silently discards it), so every category-scoped topic is a topic one of
the two planes can never honestly answer. Rather than carry a filter that only
half the system can serve, the filter goes.

The usage numbers support it. Production, 2026-08-27:

```
topics                        341
  country-scoped              114
  category-scoped              29
article memberships in category-scoped topics   393
```

Country is four times the demand and is served (as an edition bias). Category is
29 topics, and is the one filter that would silently lie.

**Scope**: remove `category` as something a reader can choose. The filter chip
row in `apps/web/src/filterChips.ts` offers `ChipKind = "country" | "category"`;
category comes out. The API stops accepting it, and the reference payload stops
advertising the taxonomy.

**Decide and record — this is the substance of the phase, not the chip removal**:

- **What happens to `topics.category` and the fingerprint.** `canonical.ts`
  folds category into `fingerprintOf({ keywords, language, country, category })`.
  Dropping it from the fingerprint **re-identifies every existing
  category-scoped topic** — 29 rows whose accumulated coverage and 393 article
  memberships would be orphaned under a fingerprint nothing will compute again.
  Leaving the column and the fingerprint alone, and only refusing new
  category-scoped searches, costs nothing and orphans nothing. Prefer the second
  unless you can show the first is needed; either way, say which and why.
- **Whether the reference endpoint keeps serving the taxonomy.** The Currents
  adapter still parses it from a recorded 400 body, and `ARCHITECTURE` documents
  it. Removing the plumbing is a bigger change than removing the chip.
- **Whether any existing category-scoped topic still needs to be readable.** A
  bookmarked URL carrying a category should degrade to the same search without
  it, not 400. Check `apps/web/src/route.ts` for what a stale URL does today.

**Explicitly out**: dropping the `topics.category` column, deleting the 29
topics, and anything about how Currents maps category on the wire. This phase
removes a *choice*, not a schema.

**Done when**: no reader can select a category; a URL that carries one still
resolves to a usable search; the 29 existing topics are either untouched or
migrated deliberately with the decision recorded; `apps/web` and `apps/api`
tests cover the stale-URL path.

**Landed** as [ADR-0020](adr/0020-a-reader-does-not-choose-a-category.md), no
migration. All three decisions took the preferred option:

- **The fingerprint is untouched** and `category` stays in its serialization.
  The 29 topics keep their identity, their coverage and their 393 memberships.
  `CanonicalQuery.category` stays with it, because `processSegmentJob` rebuilds
  a query from the stored row — a segment already queued against one of those
  topics must still fetch what the topic says it is.
- **A stale URL degrades on both sides, independently** — Zod strips the
  parameter (`TimelineQuery` is not `.strict()`) and `PARAM_KEYS` no longer
  names it — so a direct API consumer cannot break silently behind an app that
  looks fine. One qualification, recorded in the ADR: a link whose only filter
  was a category now takes the browser's country default, which it used to
  suppress.
- **The taxonomy keeps its plumbing and loses its offer.** `/api/v1/reference`
  serves languages and regions only, and the cold-cache path costs two upstream
  calls rather than three; `availableCategories()` and the Currents 400-body
  parse stay where they are.

No `PAGE_SHAPE_VERSION` bump: `TopicSummary` has never carried a category, and
the version keys the page cache, which this does not change.

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
