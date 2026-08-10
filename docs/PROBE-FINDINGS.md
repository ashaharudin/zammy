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

## 7. Quota cost of this exercise

41 calls total; `x-ratelimit-remaining` went 999 → 977 over the measured span, day resetting at
`2026-08-05T00:00:00+00:00`. Well within budget.

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
