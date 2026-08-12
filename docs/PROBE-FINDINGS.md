# Currents API — Probe Findings

**Date:** 2026-08-04 · **Method:** 45 live calls against `https://api.currentsapi.services/v1` with a
Free-tier key · **Captured payloads:** [`fixtures/`](../fixtures) — committed, key-free, and used as
the regression basis for the sighting→article collapse, term scoring and the client error
taxonomy (ARCHITECTURE §12)

Probes used a *closed* time window (`2026-08-02T00:00 → 2026-08-03T00:00`) so the result set was
stable across calls and any difference was attributable to the parameter under test rather than to
news drift. A deliberate bogus parameter (`zzz_not_a_real_param`) established the control: **unknown
parameters are silently ignored, returning a byte-identical result set.** So "no change" reliably
means "not supported."

---

## 1. Verified constraints

| Property | Value | Evidence |
| --- | --- | --- |
| Auth (header) | `Authorization: <key>` | 200 |
| Auth (query) | `?apiKey=<key>` **also works** | 200 |
| No / bad key | `401` `{"status":"401","msg":"Invalid token"}` | 401 |
| Daily quota | **1000 requests**, resets midnight UTC | `x-ratelimit-limit: 1000` |
| Burst quota | **60 requests / 60s** | `x-ratelimit-burst-limit: 60` |
| `page_size` | works; **max 20 on Free tier** | 400: `"Max page_size for Free tier is 20"` |
| `page_number` | works; **1-indexed** | 400 on `0`: `"Min value: 1"` |
| **Max retrievable results** | **100 per query (5 pages)** | 400: `"Max retrievable results for Free tier is 100"` |
| **Max lookback** | **30 days** | 29d → 200; 31d → 400 `"Max lookback is 30 days"` |
| Past-end page | `200` + `{"status":"ok","news":[]}` | clean end-of-results signal |
| Default page size | 20 | |
| Default sort | `published` DESC, verified monotonic | undocumented but consistent |
| `domain` | **works** (`domain=coindesk.com` → filtered) | |
| `limit` | works, behaves as a `page_size` alias | |
| `offset` | **ignored** (identical to control) | |
| `sort_by` | **ignored** — no sort control exists | |
| `start_date` alone | valid (open-ended window) | |
| `start_date`/`end_date` bounds | **both inclusive** — closed `[start, end]`, second precision | §6e |
| Extra response field | `source_category` (absent from OpenAPI spec) | |

## 2. Cloudflare blocks default library User-Agents

The first 11 probes returned `403` with Cloudflare `error code: 1010` — including the no-auth call,
which should have been `401`. Cause: Python `urllib`'s default `User-Agent`. Setting any explicit UA
fixed every call. `curl`'s default UA passes.

**Implication:** the client must always send an explicit `User-Agent`. A `403` with a non-JSON body
must be surfaced as a distinct "client blocked" error, never as an auth failure — the diagnostics
differ completely.

## 3. Keyword matching is against text we never receive

Searching `climate` returned 20 articles, but only **7 of 20** contained "climate" anywhere in the
`title` or `description` fields. Searching `bitcoin volcano` returned 1 article containing *neither*
term in those fields.

Matching therefore runs against full article body text that the response does not include.

- Multi-term keywords **narrow** results (`bitcoin`: 20, `volcano`: 20, `bitcoin volcano`: 1) —
  conjunctive in effect.
- Comma-separating **breaks the query**: `bitcoin,volcano` → **0 results**. Always space-join terms.
- Quoted `"climate policy"` and bare `climate policy` return *different* sets (5/20 overlap), so
  quoting is not a no-op, but neither behaves as a strict phrase match.

**Implication:** we cannot reproduce, verify, or re-rank upstream relevance locally. A local
full-text index over stored articles would return a *different* set than upstream, so it can never
serve as a substitute for an upstream query. This directly demotes the `search_vec` idea in the
original proposal.

## 4. Severe upstream duplication — the headline finding

Frequently-updated pages are re-ingested as brand-new articles: same `url`, same `title`, **distinct
UUIDs**, timestamps minutes apart.

Measured across the full retrievable depth for `keywords=climate` (5 calls, 100 slots):

| Metric | Count |
| --- | --- |
| Raw articles returned | 100 |
| Unique upstream `id` | 100 |
| Unique URLs | **42** |
| Unique (title, domain) | 41 |

One URL — a daily link-roundup post — appeared **50 times**, occupying half the entire retrievable
depth for that query. A second appeared 10 times. Duplicates also span page boundaries (page 2
contained 9 in-page-unique articles but only 7 not already seen on page 1).

Cumulative unique yield per call: 15 → 22 → 30 → 34 → **42**.

**Two implications:**

1. Without URL-collapsing the product is unusable — over half the timeline is one repeated post.
   This is why `sightings` and `articles` are separate tables (ADR-0002).
2. **Effective retrievable depth is ~40 unique articles per query, not 100.** Deduplication is not a
   tidiness feature; it is load-bearing for both the feed and capacity planning.

## 5. Error body shapes

`400` responses are richly structured and worth parsing rather than logging:

```jsonc
{ "status": "400", "msg": "Bad request", "code": "INVALID_QUERY",
  "message": "Bad request",
  "details": { "message": "Invalid parameters",
               "errors": { "page_size": "Max page_size for Free tier is 20" } } }
```

`details.errors` is a field→message map naming the exact violated limit. Neither this shape nor the
`401` shape matches the OpenAPI spec's `ApiResponse` definition.

## 6. Reference data

- **23 languages**, returned as `{"languages": {"English": "en", …}}` — a *name → code* map, not an
  array as the spec implies. Note `"Malay": "msa"` (three letters) and the typo `"Vietnamise"`;
  always use the values, never derive codes from names.
- **Regions**: name → 2-letter code map, with typos in names (`"United State"`, `"German"`).
- **Categories**: `{"categories": [...47 strings...]}` — includes junk values (`crap`, `notsure`,
  `redundant`) that should be filtered out of any user-facing picker.

## 6b. Keywordless / category-sliced search — the wordcloud corpus

Probed to validate the landing-page wordcloud (ARCHITECTURE §10):

- `/search` works with **no `keywords`**, taking only `language` (+ optional `category`) → 20 results.
- **Category slices are disjoint**: `category=technology` vs `category=politics` shared 0 ids, and
  `page_number=2` was disjoint from page 1. So ~12 categories × 1–2 pages yields a few hundred
  articles for **12–24 calls**, a viable daily corpus at 1–2% of quota.
- A day-bounded keywordless call returns the **newest 20 in that window**, not a spread across it — so
  this is a breadth-first snapshot of recent news per category, not a census of the day.
- This 80-article sample had **80 unique URLs** — the heavy duplication in §4 is specific to certain
  sources and keyword queries, not universal.

**But naive term-frequency scoring on this corpus failed.** Top unigrams by document frequency were:

```
cve-, earlier, jenkins, plugin, attackers, permission, credentials, how, not, just, found, read
```

Three separate failure modes, each needing its own fix:

1. **Single-source burst domination** — a run of near-identical Jenkins security advisories took the
   cloud. These are *distinct, non-duplicate* articles, so URL-based collapsing does **not** catch
   them.
   Fix: weight by distinct source domains and require `df_domains >= 2`.
2. **Generic news vocabulary survives stopwording** ("earlier", "found", "read", "how"). Raw frequency
   cannot distinguish these from real topics. Fix: score against a rolling baseline.
3. **Tokenization artifact** — a regex split `CVE-2026-1234` into `cve-`, which then ranked first.

Conclusion: domain-breadth gating, a rolling baseline, and careful tokenization are **requirements for
the first cut**, not later polish. Specifying the naive version would have shipped a cloud that reads
as broken.

## 6c. `/v2/latest-news` — the multi-category sample endpoint (probed 2026-08-10)

Probed to resolve ARCHITECTURE §14 open question 6 before moving the §10.1 breadth sample off
keywordless `/search`. 8 calls; recorded in `fixtures/latest-news-v2-sample.json`.

- **Multi-category is comma-separated**: `category=science_technology,politics_government` → 200,
  and every returned item's `category` intersected the requested set (0 leaks). A **repeated
  parameter does not merge** — only the first occurrence is read — so commas are the wire format.
- **v2 uses a new, fixed 16-value category taxonomy.** v1 names are rejected:
  `category=technology` → 400 with `details.errors.category` listing the allowed values verbatim
  (`general, society, science_technology, politics_government, economy_business_finance,
  arts_culture_entertainment, lifestyle_leisure, human_interest, sport, crime_law_justice,
  education, environment, labour, health, automotive, real_estate`). The `/v1/available/categories`
  list does **not** apply to v2 — a curated sample list must use these names, and validating v2
  categories against the v1 reference data would reject every valid value.
- **The ~20-item page is shared across categories, not multiplied.** A two-category call returned
  20 items, same as unfiltered.
- **The filter filters; it does not balance.** The two-category call came back 19× science_technology
  and 1× politics_government — newest-matching-any wins, so one busy category can crowd a
  multi-category sample. Category *steering* is exclusion, not allocation.
- **v1 and v2 serve the same feed, relabeled.** Unfiltered v1 vs v2: 20/20 id overlap; the same
  articles carry old-taxonomy labels on v1 (`mining`, `regional`, `world`…) and new-taxonomy labels
  on v2. Ingesting from both would mix taxonomies in `articles.categories`.
- **`page_number` works on v2** (response carries a top-level `page`; page 2 was disjoint from
  page 1), so a sample can page deeper if 20 proves thin. No date parameters, as on v1.
- This sample had 20/20 unique URLs — consistent with §6b's finding that heavy duplication is
  keyword/source-specific, not universal.
- Response item shape is identical to v1 (`id, title, description, url, author, image, language,
  category, source_category, published`); the normalizer needs no changes.

Unmeasured: feed turnover between hourly samples — needs observations an hour apart, and the §10.1
cadence knob exists precisely to absorb whatever it turns out to be.

## 6d. Drift: per-call date range now capped at 7 days (observed 2026-08-11)

The first live run after the wordcloud work surfaced a constraint that did not exist on
2026-08-04: `/search` with a 30-day `start_date`/`end_date` span — which §1 verified working —
now returns `400` with `details.errors.date_range: "Max range is 7 days"`. Lookback is still 30
days; what changed is how much of it one CALL may span. Consequences taken into the design:

- The planner slices gap segments to `CURRENTS_MAX_RANGE_DAYS` (§6.3), so a 30-day cold window is
  ~5 fetchable segments instead of one 400.
- The client refuses over-range requests locally (same posture as the page-cap wall): clamping
  down instead would record coverage for days that were never fetched.
- A reminder that upstream limits DRIFT. §1's table is a snapshot of 2026-08-04; treat any limit
  not enforced by our own pre-flight checks as subject to silent change.

## 6e. `start_date` / `end_date` bounds are both INCLUSIVE (probed 2026-08-11)

Probed to close a gap §1 left open: it verified that the date parameters *work* and §6d caught the
range cap, but never measured **inclusivity at each end**. That matters because §6.3 slices coverage
gaps into 7-day segments — if both bounds were exclusive, an article published exactly on a seam
instant would never be returned while coverage was recorded across it. A silent hole, in the same
class as the "full page-5 means truncated" bug: real data loss that reports no error.

4 calls; recorded in `fixtures/search-date-bound-inclusivity.json`.

Method: one discovery call over a closed day (`2026-08-08`) for `keywords=climate`, then pick a target
article whose `published` instant is **unique** in that set (ties would make presence/absence
ambiguous). With `P` = that instant, two 120-second probe windows place the target on each bound in
turn:

| Probe | Window | Target position | Result | Verdict |
| --- | --- | --- | --- | --- |
| `start_eq_P` | `[P, P+120s]` | oldest in window | returned, 1 row | `start_date` **inclusive** (`>=`) |
| `end_eq_P` | `[P-120s, P]` | newest in window | returned, 1 row | `end_date` **inclusive** (`<=`) |
| `start_eq_end_eq_P` | `[P, P]` | only member | returned, 1 row | degenerate window is a valid single-instant query |

So the upstream window is a **closed interval `[start, end]`**.

Two guards make the absence-side of this trustworthy rather than assumed:

- **Truncation guard.** In `start_eq_P` the target is the *oldest* row, so under the 20-row page cap a
  crowded window could push it off page 1 and fake an "exclusive" verdict. The probe therefore only
  reads absence as exclusion when the window returned **fewer than 20 rows**; both windows returned 1,
  so absence would have been meaningful. Encoded in the script as an explicit `INDETERMINATE` verdict
  it never had to use.
- **Precision check.** 20 rows over the 24-hour discovery window collapsed to 1 row over each
  120-second window, so second-level bounds are genuinely honoured — not silently rounded to the day,
  which would have made the whole result meaningless (and is the failure mode §1's bogus-parameter
  control exists to catch).

**Implication — the mismatch is safe, and load-bearing.** Our own windows are half-open `[from, to)`
(ARCHITECTURE §6.3, and `tstzrange`'s default in §7.2); upstream's are closed. Asking for `[A, B)`
therefore returns the article at `B` too. That surplus row is harmless — `ON CONFLICT (id) DO NOTHING`
absorbs it — and recording coverage as `[A, B)` leaves `B` uncovered, so a later request re-fetches
rather than trusting coverage it never earned. Both errors fall on the re-fetch side. The dangerous
pairing was the inverse (exclusive upstream, inclusive coverage), and it is now ruled out by
measurement rather than by assumption.

Unmeasured: whether the bounds stay inclusive. §6d is the standing reminder that upstream limits
drift, and this is a behaviour our own pre-flight checks do not enforce — so it is exactly the kind of
thing that can change silently. The convention is written down (§6.3) precisely so a re-probe has
something to contradict.

## 7. Quota cost of this exercise

41 calls total; `x-ratelimit-remaining` went 999 → 977 over the measured span, day resetting at
`2026-08-05T00:00:00+00:00`. Well within budget.

The §6c follow-up (2026-08-10) spent 8 further calls; `x-ratelimit-remaining` ended at 992.

The §6e follow-up (2026-08-11) spent 4 further calls; `x-ratelimit-remaining` ended at 914,
`x-ratelimit-burst-remaining` at 56.

---

## 8. Capacity arithmetic that follows

With 1000 calls/day and ~40 unique articles per (topic, window) query:

- A full 30-day backfill for **one** broad topic at daily granularity: 30 windows × up to 5 pages =
  **~150 calls, or 15% of the entire daily quota**. Backfill must be lazy, prioritized, and
  explicitly budgeted — never automatic on first search.
- Incremental refresh of a topic (only the window since last fetch) is typically **1 call**. But
  *scheduled* polling does not fit: ~50 hot topics at 15-minute intervals ≈ 4800 calls/day, nearly 5×
  over budget, and even 20 topics hourly spends half the budget whether or not anyone visits.

**This arithmetic is why the architecture is demand-driven rather than polled** (see
[ARCHITECTURE.md §9](./ARCHITECTURE.md)). Ingestion triggered by real searches costs nothing when
idle and spends only on topics that demonstrably have readers, which fits 1000/day comfortably. The
constraint it exposes is the reverse of what we expected: the risk is not a poller exhausting the
budget, but *users* driving spend — hence per-topic and per-IP caps.
