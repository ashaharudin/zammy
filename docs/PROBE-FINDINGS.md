# Currents API — Probe Findings

**Date:** 2026-08-04 · **Method:** 45 live calls against `https://api.currentsapi.services/v1` with a
Free-tier key · **Captured payloads:** [`fixtures/`](../fixtures) — committed, key-free, the
regression basis for the sighting→article collapse, term scoring and the client error taxonomy
(ARCHITECTURE §12)

Probes used a *closed* time window (`2026-08-02T00:00 → 2026-08-03T00:00`) so any difference between
calls was attributable to the parameter under test, not news drift. A deliberate bogus parameter
(`zzz_not_a_real_param`) established the control: **unknown parameters are silently ignored,
returning a byte-identical result set** — so "no change" reliably means "not supported."

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
| **Max lookback** | **30 days**, edge is live | 29d → 200; 31d → 400 `"Max lookback is 30 days"`; **exactly 30d also 400s** (prod 2026-08-26 — second-precision encoding floors it back out) |
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
which should have been `401`. Cause: Python `urllib`'s default `User-Agent`. Any explicit UA fixed
every call; `curl`'s default passes.

**Implication:** always send an explicit `User-Agent`, and surface a `403` with a non-JSON body as a
distinct "client blocked" error, never as an auth failure.

## 3. Keyword matching is against text we never receive

Searching `climate` returned 20 articles, only **7 of 20** containing "climate" in `title` or
`description`. `bitcoin volcano` returned 1 article containing *neither* term. Matching runs against
full body text the response does not include.

- Multi-term keywords **narrow** results (`bitcoin`: 20, `volcano`: 20, `bitcoin volcano`: 1) —
  conjunctive in effect.
- Comma-separating **breaks the query**: `bitcoin,volcano` → **0 results**. Always space-join.
- Quoted `"climate policy"` vs bare returns *different* sets (5/20 overlap) — quoting is not a no-op,
  but neither is a strict phrase match.

**Implication:** upstream relevance cannot be reproduced, verified, or re-ranked locally. A local
full-text index would return a *different* set, so it can never substitute for an upstream query.
This demotes the original proposal's `search_vec` idea.

## 4. Severe upstream duplication — the headline finding

Frequently-updated pages are re-ingested as new articles: same `url` and `title`, **distinct UUIDs**,
timestamps minutes apart. Measured across the full retrievable depth for `keywords=climate` (5 calls,
100 slots):

| Metric | Count |
| --- | --- |
| Raw articles returned | 100 |
| Unique upstream `id` | 100 |
| Unique URLs | **42** |
| Unique (title, domain) | 41 |

One URL — a daily link-roundup post — appeared **50 times**; a second appeared 10 times. Duplicates
span page boundaries (page 2: 9 in-page-unique, only 7 unseen). Cumulative unique yield per call:
15 → 22 → 30 → 34 → **42**.

**Implications:**

1. Without URL-collapsing, over half the timeline is one repeated post — why `sightings` and
   `articles` are separate tables (ADR-0002).
2. **Effective retrievable depth is ~40 unique articles per query, not 100.** Deduplication is
   load-bearing for both the feed and capacity planning.

## 5. Error body shapes

`400` responses are richly structured and worth parsing:

```jsonc
{ "status": "400", "msg": "Bad request", "code": "INVALID_QUERY",
  "message": "Bad request",
  "details": { "message": "Invalid parameters",
               "errors": { "page_size": "Max page_size for Free tier is 20" } } }
```

`details.errors` is a field→message map naming the exact violated limit. Neither this shape nor the
`401` shape matches the OpenAPI spec's `ApiResponse`.

## 6. Reference data

- **23 languages**, returned as `{"languages": {"English": "en", …}}` — a *name → code* map, not an
  array as the spec implies. Note `"Malay": "msa"` (three letters) and the typo `"Vietnamise"` (`vi`,
  1 of 23); always use the values, never derive codes from names.
- **Regions**: name → 2-letter code map, with typos.
- **Categories**: `{"categories": [...47 strings...]}` — includes junk values (`crap`, `notsure`,
  `redundant`) to filter out of any user-facing picker.

### 6a. The reference NAMES are misspelled, and they are what a picker draws

Counted over the recorded bodies (`fixtures/error-and-reference-bodies.json`, captured 2026-08-04),
**five of 102 reference names are typed wrong** — four of 79 regions and one of 23 languages:

| endpoint | code | upstream name | correct |
|---|---|---|---|
| regions | `US` | `United State` | United States |
| regions | `DE` | `German` | Germany |
| regions | `GH` | `Gahana` | Ghana |
| regions | `ID` | `Indonedia` | Indonesia |
| languages | `vi` | `Vietnamise` | Vietnamese |

Note `German` is correct as the name of the LANGUAGE `de` and wrong only as the name of the country
`DE` — the same string, right in one map and wrong in the other, which is why the repair tables in
`currents-client/client.ts` are keyed by code rather than matched by string.

These are typos, not a fold: `Philippines` (`PH`), `Netherlands` (`NL`) and `United Arab Emirates`
(`AE`) come from the same map with their trailing `s` intact. Worth stating, because "United State"
in the command bar was first read as evidence that something in our own pipeline was stripping a
trailing `s`. Nothing was; the one fold that shortens words (`singular`) never runs on this data.

`repairedRegions` / `repairedLanguages` spell-check them for user-facing pickers. The **codes** are
authoritative and untouched — §2's rule stands, and a filter is still validated against exactly what
upstream accepts. `Saudi-Arabia` (`SA`) is left alone: punctuated oddly, not spelled wrong.

## 6b. Keywordless / category-sliced search — the wordcloud corpus

Probed to validate the landing-page wordcloud (ARCHITECTURE §10):

- `/search` works with **no `keywords`**, taking only `language` (+ optional `category`) → 20 results.
- **Category slices are disjoint**: `technology` vs `politics` shared 0 ids; page 2 disjoint from
  page 1. So ~12 categories × 1–2 pages yields a few hundred articles for **12–24 calls** (1–2% of
  quota).
- A day-bounded keywordless call returns the **newest 20 in that window**, not a spread — a
  breadth-first snapshot per category, not a census of the day.
- This 80-article sample had **80 unique URLs** — §4's heavy duplication is specific to certain
  sources and keyword queries, not universal.

**Naive term-frequency scoring on this corpus failed.** Top unigrams by document frequency:

```
cve-, earlier, jenkins, plugin, attackers, permission, credentials, how, not, just, found, read
```

Three failure modes, each needing its own fix:

1. **Single-source burst domination** — near-identical Jenkins advisories took the cloud. Distinct,
   non-duplicate articles, so URL-collapsing does **not** catch them. Fix: weight by distinct source
   domains and require `df_domains >= 2`.
2. **Generic news vocabulary survives stopwording** ("earlier", "found", "read", "how"). Fix: score
   against a rolling baseline.
3. **Tokenization artifact** — a regex split `CVE-2026-1234` into `cve-`, which ranked first.

Conclusion: domain-breadth gating, a rolling baseline, and careful tokenization are requirements for
the first cut, not later polish.

## 6c. `/v2/latest-news` — the multi-category sample endpoint (probed 2026-08-10)

Probed to resolve ARCHITECTURE §14 open question 6 before moving the §10.1 breadth sample off
keywordless `/search`. 8 calls; recorded in `fixtures/latest-news-v2-sample.json`.

- **Multi-category is comma-separated**: `category=science_technology,politics_government` → 200,
  every item's `category` intersecting the requested set (0 leaks). A repeated parameter does not
  merge — only the first occurrence is read.
- **v2 uses a new, fixed 16-value category taxonomy.** v1 names are rejected: `category=technology`
  → 400 with `details.errors.category` listing the allowed values verbatim (`general, society,
  science_technology, politics_government, economy_business_finance, arts_culture_entertainment,
  lifestyle_leisure, human_interest, sport, crime_law_justice, education, environment, labour,
  health, automotive, real_estate`). `/v1/available/categories` does **not** apply to v2; validating
  v2 categories against it would reject every valid value.
- **The ~20-item page is shared across categories, not multiplied** — a two-category call returned
  20 items, same as unfiltered.
- **The filter filters; it does not balance.** The two-category call came back 19:1 —
  newest-matching-any wins, so one busy category can crowd a multi-category sample. Category
  steering is exclusion, not allocation.
- **v1 and v2 serve the same feed, relabeled**: 20/20 id overlap, old-taxonomy labels on v1
  (`mining`, `regional`, `world`…), new on v2. Ingesting from both mixes taxonomies in
  `articles.categories`.
- **`page_number` works on v2** (top-level `page` field; page 2 disjoint from page 1), so a sample
  can page deeper. No date parameters, as on v1.
- 20/20 unique URLs — consistent with §6b.
- Item shape is identical to v1 (`id, title, description, url, author, image, language, category,
  source_category, published`); the normalizer needs no changes.

Unmeasured: feed turnover between hourly samples — needs observations an hour apart; the §10.1
cadence knob absorbs whatever it turns out to be.

## 6d. Drift: per-call date range now capped at 7 days (observed 2026-08-11)

`/search` with a 30-day `start_date`/`end_date` span — verified working in §1 — now returns `400`
with `details.errors.date_range: "Max range is 7 days"`. Lookback is still 30 days; what changed is
how much of it one call may span. Consequences taken into the design:

- The planner slices gap segments to `CURRENTS_MAX_RANGE_DAYS` (§6.3), so a 30-day cold window is
  ~5 fetchable segments instead of one 400.
- The client refuses over-range requests locally (same posture as the page-cap wall): clamping down
  would record coverage for days never fetched.
- Upstream limits DRIFT. §1's table is a snapshot of 2026-08-04; treat any limit not enforced by our
  own pre-flight checks as subject to silent change.

## 6e. `start_date` / `end_date` bounds are both INCLUSIVE (probed 2026-08-11)

Closes a gap in §1: inclusivity at each end was never measured. It matters because §6.3 slices
coverage gaps into 7-day segments — if both bounds were exclusive, an article published exactly at a
seam instant would never be returned while coverage was recorded across it: a silent hole, real data
loss reporting no error. 4 calls; recorded in `fixtures/search-date-bound-inclusivity.json`.

Method: one discovery call over a closed day (`2026-08-08`, `keywords=climate`), then pick a target
article whose `published` instant is **unique** in that set (ties would make presence/absence
ambiguous). With `P` = that instant:

| Probe | Window | Target position | Result | Verdict |
| --- | --- | --- | --- | --- |
| `start_eq_P` | `[P, P+120s]` | oldest in window | returned, 1 row | `start_date` **inclusive** (`>=`) |
| `end_eq_P` | `[P-120s, P]` | newest in window | returned, 1 row | `end_date` **inclusive** (`<=`) |
| `start_eq_end_eq_P` | `[P, P]` | only member | returned, 1 row | degenerate window is a valid single-instant query |

The upstream window is a **closed interval `[start, end]`**. Two guards make the absence side
trustworthy:

- **Truncation guard.** In `start_eq_P` the target is the *oldest* row, so under the 20-row page cap
  a crowded window could push it off page 1 and fake an "exclusive" verdict. Absence is only read as
  exclusion when the window returned **fewer than 20 rows**; both returned 1. Encoded in the script
  as an explicit `INDETERMINATE` verdict it never had to use.
- **Precision check.** 20 rows over the discovery day collapsed to 1 over each 120-second window, so
  second-level bounds are genuinely honoured — not silently rounded to the day, the failure mode
  §1's bogus-parameter control exists to catch.

**Implication — the mismatch is safe, and load-bearing.** Our windows are half-open `[from, to)`
(ARCHITECTURE §6.3, `tstzrange`'s default in §7.2); upstream's are closed. Asking `[A, B)` returns
the article at `B` too — harmless, `ON CONFLICT (id) DO NOTHING` absorbs it — and coverage recorded
as `[A, B)` leaves `B` uncovered, so a later request re-fetches rather than trusting coverage it
never earned. Both errors fall on the re-fetch side. The dangerous pairing was the inverse
(exclusive upstream, inclusive coverage), now ruled out by measurement.

Unmeasured: whether the bounds stay inclusive. Per §6d, limits drift, and this behaviour is not
enforced by our pre-flight checks. The convention is written down (§6.3) precisely so a re-probe has
something to contradict.

## 7. Quota cost of this exercise

41 calls; `x-ratelimit-remaining` went 999 → 977, day resetting at `2026-08-05T00:00:00+00:00`.
The §6c follow-up (2026-08-10) spent 8 calls, ending at 992. The §6e follow-up (2026-08-11) spent
4, ending at 914 (`x-ratelimit-burst-remaining` 56).

---

## 8. Capacity arithmetic that follows

With 1000 calls/day and ~40 unique articles per (topic, window) query:

- A full 30-day backfill for **one** broad topic at daily granularity: 30 windows × up to 5 pages =
  **~150 calls, 15% of the daily quota**. Backfill must be lazy, prioritized, explicitly budgeted —
  never automatic on first search.
- Incremental refresh of a topic is typically **1 call**. But *scheduled* polling does not fit:
  ~50 hot topics at 15-minute intervals ≈ 4800 calls/day (5× over budget); even 20 topics hourly
  spends half the budget whether or not anyone visits.

**This arithmetic is why the architecture is demand-driven rather than polled**
([ARCHITECTURE §9](./ARCHITECTURE.md)). Demand-driven ingestion costs nothing idle and spends only on
topics with readers. The exposed risk is the reverse of the expected one: not a poller exhausting the
budget, but *users* driving spend — hence per-topic and per-IP caps.
