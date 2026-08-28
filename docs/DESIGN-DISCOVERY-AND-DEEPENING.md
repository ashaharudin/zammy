# Two planes: Currents discovers, Google News deepens

2026-08-27. A design sketch, not a decision. Question: what does it look like if
the cloud is populated from Currents and its tokens drive searches against
Google News?

**The measurement that motivates it.** ADR-0014 recorded four label-shaped
queries against Currents and what each returned:

| Label | Currents | Google News (measured today) |
| --- | --- | --- |
| `Jason Arday plagiarism controversy` | **0** | **100 items, 63 domains** |
| `Hashemi ICE family detention` | **0** | 27 items, 20 domains |
| `lunar space pollution` | **0** | 96 items, 82 domains |
| `Ma'a Nonu solo haka` | **1** | 64 items, 46 domains |

Same words, same day, one query each. The arc ADR-0014 said "was in the store
the whole time: three articles" returns a hundred from the BBC, NYT, Guardian,
Reuters, Al Jazeera, NPR, CNN, CBC and the Times of India.

**And the full label beat the grounded pair.** `cloudQuery` exists (ADR-0014) to
cut a label down to the two words the arc's coverage actually says, because
Currents ANDs terms against body text we never receive (PROBE-FINDINGS 3). Sent
whole to Google News, the four-word label returned *more* than its grounded pair
did — 100 items / 63 domains vs 92 / 55 for Arday, 96 / 82 vs 72 / 58 for lunar.

So `cloudQuery` is not a general truth about labels. It is a workaround for one
provider's matcher, and the other provider does not need it.

---

## 1. The reframing

ADR-0012 put two providers behind one interface and had to spend the whole ADR
defending the archive from the consequences. That was the right call for two
providers doing the *same job*. These two do not do the same job:

|  | Currents | Google News |
| --- | --- | --- |
| Answers a label | no (0/0/0/1) | **yes (100/27/96/64)** |
| Horizon | 30 days | **≥ 18 months** |
| Honest end-of-results | **yes** | cap only |
| Real URL / description | **yes** | no / no |
| Coverage semantics | **yes** | none |

They are not peers to be merged. They are **stages to be pipelined**:

- **The discovery plane (Currents).** Breadth samples and user searches →
  articles → groups → storylines → labels → cloud. Coverage-bearing,
  `isLastPage` its own, `topic_coverage` untouched. Exactly ADR-0012's
  coverage-bearing role, unchanged.
- **The deepening plane (Google News).** The cloud's storylines are the work
  list. Each already has a query (its label) and a span (its arc). Fetch
  (label × span slice), attach the results to *that storyline*.

The unit of coverage differs per plane — a topic fingerprint for discovery, a
storyline for deepening — and that is the point. The two planes never write each
other's coverage, so ADR-0012's failure mode (one provider manufacturing
coverage over spans another never fetched) cannot arise: they are not making
claims about the same thing.

**Arcs are backfillable, not just toppable-up.** Slicing one arc's span weekly:

```
"jason arday" after:2026-07-25 before:2026-08-01    33 items  21 domains
"jason arday" after:2026-08-01 before:2026-08-08   100 items  60 domains   <- capped
"jason arday" after:2026-08-08 before:2026-08-15   100 items  68 domains   <- capped
"jason arday" after:2026-08-15 before:2026-08-22   100 items  61 domains   <- capped
"jason arday" after:2026-08-22 before:2026-08-29   100 items  80 domains   <- capped
```

433 items where the unsliced query gave 92. `rawCount < 100` means the slice is
complete; `== 100` means subdivide. That is `isLastPage` in all but name, and
the planner already speaks it.

---

## 2. What has to change in the database

### a. Identity moves off the URL — the enabling change

This is forced, not chosen. Probed today: the `CBM…` link does **not** HTTP
redirect. It returns a 602KB JavaScript interstitial titled "Google News" in
which the publisher's own name appears **zero times**. Resolution needs a
headless browser or the reverse-engineered `batchexecute` RPC, per article, at
100 articles a slice — and Google breaks that RPC periodically.

So Google News cannot supply `articles.url`, and `dedup_key` is sha256 of
exactly that. Under this design that is fatal rather than awkward: the design
*intends* both planes to cover the same arcs, so the overlap is maximal by
construction and every doubly-covered story becomes two rows.

The fix is a **fallback identity**, not a replacement:

```sql
ALTER TABLE articles ADD COLUMN alt_key bytea;   -- sha256(source_domain | title_fold | published_day)
CREATE UNIQUE INDEX articles_alt_key_idx ON articles (alt_key) WHERE alt_key IS NOT NULL;
```

Ingest resolves in order: **URL key → alt key → insert.** Then

- a Currents article populates *both* keys;
- a Google News item populates *only* `alt_key`, so it lands as a **sighting of
  the article Currents already has** — contributing a sighting and nothing else,
  which is honest, because it carried no information the row did not have;
- a Google News item for a story Currents never saw mints a row with `alt_key`
  only, `url` = the redirect (a working link in a browser, just not an identity)
  and `description` null.

Why fallback rather than replacement: titles drift and URLs do not. Making
`(domain, title, day)` the *primary* key would split a Currents article whose
headline was edited between sightings — a regression URL identity does not have.
Keeping URL first means the Currents-sourced majority is unaffected and only the
URL-less path pays.

The precedent is in the probe data: 100 raw Currents articles collapsed to **42
unique URLs and 41 unique (title, domain)** — near-identical discriminating
power, with `(title, domain)` very slightly more aggressive.

`title_fold` must strip the trailing ` - Outlet` suffix, which Google News
appends to **100 of 101** items. That strip is needed anyway (see §4).

### b. Coverage gains a provider, and a second subject

ADR-0012 deferred exactly this and named it: "`topic_coverage` gaining a
provider column so each provider's spans are tracked and repaired
independently." This design cashes it in and adds the storyline subject:

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

The `DEFAULT 'currents'` backfills every existing row correctly, for the same
reason migration 0013's did.

### c. What does *not* change

`articles`, `sightings`, `groups`, `storylines`, `topic_articles` keep their
shape. `sightings.provider` already exists (migration 0013) and already has its
index — it was added for "per-provider yield", which is precisely the number
that decides whether this design is working.

---

## 3. What breaks — in order of severity

### a. The cloud would measure its own fetching

**This is the serious one, and it is inherent to the proposal.** The cloud ranks
by window article volume decayed by recency (ADR-0014). If cloud membership
drives fetching and fetching adds articles, volume becomes **endogenous**: a
storyline that reaches the cloud once gets fetched, gains volume, ranks higher,
gets fetched more. Rich-get-richer with no damping, and the cloud stops
answering "what is the world covering" and starts answering "what have we been
fetching".

The fix is a rule, and it is the load-bearing rule of the whole design:

> **The plane that measures is the plane that is not steered.**
> The cloud ranks on discovery-plane articles only.

Concretely, `trending-storylines.ts` counts and gates on articles with a
Currents sighting:

```sql
and exists (select 1 from sightings s
             where s.article_id = a.id and s.provider = 'currents')
```

Deepening-plane articles stay fully visible in the timeline and invisible to the
ranker. This needs no migration — `sightings_provider_idx` is already there.

### b. `MIN_SOURCE_DOMAINS` becomes free

`having count(distinct a.source_domain) >= 2` asks "are several newsrooms
covering this NOW". Google News returns 20–82 domains per query, so any
storyline it touches clears a two-newsroom bar instantly and the gate stops
meaning anything. Same fix as (a), same clause — the gate counts discovery-plane
domains.

### c. Bad labels become bad ingestion

Today a wrong label is cosmetic. Here it spends quota and fills a storyline with
off-topic articles. Labels are model-generated and the labeling backlog is
already real.

The mitigation is pleasing: `cloudQuery`'s grounding — label words ∩ profile
tokens — stops being a *query rewriter* and becomes a *confidence gate*. Send
the full label as the query (it performs better), but only fetch at all when the
grounding is non-empty. An ungrounded label is a label we do not trust enough to
spend on.

### d. Deepening must not create new storylines

Google News can return 100 articles for one arc. Left to the normal path those
form groups, groups form provisional storylines, and every promotion demands a
model label — against a 500/day/model quota with a backlog. That would make
labeling the binding constraint on the entire system.

Rule: **deepening-plane articles join the storyline that fetched them and are
excluded from storyline formation.** Label demand stays flat at zero additional
labels, and the deepening plane can only make known arcs richer, never mint new
ones. This is a real constraint on `grouping-service`, not a config flag.

### e. §9's invariant is on the table

"Every upstream call traces back to a real user request" (§9), which ADR-0017
went out of its way to preserve. A cloud that fetches on a schedule fetches
because it exists, not because anyone asked. That is a deliberate trade, and it
should be made consciously rather than discovered later — see the staging in §5,
where step 1 does not make it.

### f. No quota signal at all

No key, no documented ceiling, no rate-limit headers — so the governor has
nothing to correct itself with, which is GNews' problem without GNews' published
number. GDELT's behaviour under this session's probing (1 of 6 calls answered,
silent connection timeouts) is what an unhappy keyless endpoint looks like, and
it is a fair preview. Needs a self-imposed conservative budget and the existing
breaker, and the terms question from the survey does not go away.

---

## 4. Carried over from the survey

The ` - Outlet` suffix on 100/101 titles must be stripped at normalization. We
have measured this exact damage: `" | Globalnews.ca"` alone pre-loaded **19.6 of
the 20-point link-mass floor**. At 100% of items it would make link mass
meaningless — and here it would also corrupt `alt_key`, which is derived from
the folded title.

---

## 5. A staged path

Superseded by [DISCOVERY-DEEPENING-PLAN.md](DISCOVERY-DEEPENING-PLAN.md), which
sequences this as G0–G7 with `alt_key` folded in as phase G1. The shape of the
argument is unchanged: everything that protects the existing system lands before
the first Google News article is ingested, and G6 is a kill gate.

## 6. Open questions

- ~~Does `alt_key` over-collapse on real data?~~ **Measured — see §7.**
- Is a headless-browser resolution of `CBM…` affordable enough to make Google
  News articles first-class (real URL, real description)? If yes, §2a becomes
  optional rather than enabling.
- Google News terms, unchanged from the survey: no key, no developer terms
  contemplating this.

---

## 7. Measured: `alt_key` against the production archive

2026-08-27, read-only, against production (37,077 articles / 38,691 sightings)
via the `DATABASE_SESSION_URL` path `check-chores.sh` already uses. `alt_key`
computed as `(source_domain, folded title, UTC day)`, folding = lowercase,
trailing ` - Outlet` / ` | Outlet` stripped, non-alphanumerics collapsed.

```
articles                    37,077
distinct URL keys           37,077     (unique by construction)
distinct alt_keys           36,666
rows alt_key would absorb      411     (1.1%)
```

**Essentially all 411 are duplicates URL identity failed to collapse.** Every
sampled group, at every size, was one story under several URLs:

| Domain | What differed |
| --- | --- |
| `space.com` (×6) | one eclipse liveblog under six slug variants |
| `standard.co.uk` (×5) | one story, SEO slug keywords rotated and reordered |
| `ansa.it` (×4) | one story under four section paths |
| `spectrumlocalnews.com` (×4) | one syndicated piece under four regional paths |
| `inquirer.net` (×3) | `/?p=2279017`, `/2279017/…`, `/148361/…` — permalink vs pretty URL |
| `rte.ie` (×2) | same article id under `/entertainment/` and `/news/dublin/` |
| `haaretz.com` (×2) | `/ty-article/.premium/…` vs `/ty-article/…` — paywall variant |
| `vulners.com` (×2) | `/cve/CVE-…` vs `/cvelist/CVELIST:CVE-…` |
| `middleeasteye.net` (×2) | same story as liveblog update and as article |
| `commondreams.org` (×2) | `?share_id=983848` — **an unstripped referral param** |

**The over-collapse risk class is real, small, and identifiable.** It is
templated or truncated titles: `hkexnews.hk` filed three distinct regulatory
disclosures on 2026-08-06 whose titles are *already truncated by the source* —
`[00232.HK] Disclosure of...` — so three different filings share one folded
title. Measured across the whole archive:

```
collision groups                       375
rows absorbed                          411
absorbed with a truncated title          4   (1.0% of absorbed, 0.011% of archive)
```

Four rows. A `title like '%...'` guard would exclude even those, at the cost of
declining to collapse a handful of genuine duplicates.

**So `alt_key` is not merely the enabling change for Google News — it is a net
improvement to dedup on the corpus we already have.** That strengthens §2a
considerably: the fallback key earns its place on Currents data alone, before
Google News delivers a single article.

**What this does not measure.** The title-drift regression is prospective, not
visible in a snapshot: an outlet editing a headline between two emissions would
split under alt_key and not under URL. The hybrid ordering (URL first) is what
protects against it, and this data cannot confirm the rate — it can only confirm
that alt_key loses nothing that URL identity currently catches, since URL keys
are unique here and alt_keys are strictly fewer.

**Side finding, same class as the `cmp` fix.** `commondreams.org` duplicates
differ only by `?share_id=…`. `TRACKING_PARAMS` does not strip it. Worth the
same treatment as `cmp`, on the same evidence standard.
