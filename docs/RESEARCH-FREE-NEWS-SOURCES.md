# Free news sources — a probe survey

2026-08-27, ~30 live calls from a residential IP with an explicit `User-Agent`.
Question: what else can we ingest for free, given Currents (coverage-bearing)
and GNews (off)? Direct outlet feeds like `cbc.ca` explicitly in scope.

**Finding: two candidates are worth building, and they are worth building for
opposite reasons.** The Guardian Open Platform is the only candidate that is
*better* than Currents at Currents' own job — true paging, an 11-year archive,
every field `articles` wants, and rate-limit headers the existing
`QuotaSnapshot` parser already understands — and it is one outlet, licensed
non-commercially on the free tier. Google News RSS is the only free candidate
with **18+ months of keyword-searchable, date-windowed breadth across all
outlets**, and it pays for that with an opaque URL that breaks `dedupKey`, a
title suffix on 100% of items that poisons the tokenizer, and no license to
speak of.

Everything else is either a firehose with no query surface (direct RSS), a
provider I could not get to answer (GDELT), or a smaller version of Currents.

The verified constraint table is §1; the two integration land-mines that apply
regardless of which source is chosen are §6.

---

## 1. Verified constraints

Probed live. "—" means the capability is absent, not untested.

| Candidate | Key | Keyword search | Date window | Depth | Paging | Per-query cap | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Guardian Open Platform** | free | yes, `q` | `from-date`/`to-date` | **≥ 2015 (11y)** | **true cursor** (`total`, `pages`) | none | 200, 4 calls |
| **Google News RSS** | **none** | yes, `q` | **`after:`/`before:`** | **≥ 18 months** | — (subdivide time) | 100 items | 200, 3 calls |
| GDELT DOC 2.0 | **none** | yes, + AND/OR/NOT | `startdatetime`/`enddatetime` | ~3 months | — (no offset) | 250 records | **1 of 6 calls** |
| Wikinews (MediaWiki) | none | yes, `srsearch` | sort only | full | `sroffset` | 500 | 200, 1 call |
| CBC RSS | none | — | — | ~20 items | — | 20 | 200, 7 feeds |
| Other direct RSS | none | — | — | 10–139 items | — | feed size | 200, 6 feeds |

### Guardian — the strong one

```
GET content.guardianapis.com/search
  ?q=climate&from-date=2026-08-10&to-date=2026-08-12
  &page-size=5&show-fields=trailText,byline,thumbnail&api-key=test
```

- `{"total": 63, "pageSize": 5, "currentPage": 1, "pages": 13}` — a **cursor,
  not a wall.** Every other provider here, Currents included, makes the planner
  subdivide time to get past a retrievable-results ceiling (`clampSearchParams`
  throws rather than clamp `pageNumber`, deliberately). The Guardian just pages.
- Reached `2015-03-13` on a `from-date=2015-03-01` query. Currents' lookback is
  30 days, and *exactly* 30 days already 400s (PROBE-FINDINGS 1).
- `show-fields=trailText,byline,thumbnail` fills `description`, `author`,
  `image_url`. `webPublicationDate` is a real publication time, not a seen-time.
  `webTitle` carries **no outlet suffix** — see §6b for why that matters.
- Ships rate-limit headers, on the shared `test` key:
  ```
  x-ratelimit-limit-day: 50000      x-ratelimit-remaining-day: 33979
  x-ratelimit-limit-minute: 720     x-ratelimit-remaining-minute: 689
  ```
  Currents-shaped, so `QuotaSnapshot` parsing carries over. This is a real
  advantage over GNews, which sends nothing and therefore cannot correct a
  restart's optimism.
- `api-key=test` is Guardian's shared demo key and its numbers above are not
  ours. The free **Developer** key is documented at 5,000 calls/day, 12/sec —
  *not verified here*, and **licensed for non-commercial use only.** A
  commercial key is a separate application. See §5.

**What it is not:** breadth. One outlet, however deep. It contributes one member
per group and can never be the second domain a `domains`-independence bridge
needs.

### Google News RSS — the breadth one

```
GET news.google.com/rss/search
  ?q=climate+after:2026-08-10+before:2026-08-12&hl=en-CA&gl=CA&ceid=CA:en
```

- **`after:`/`before:` work, but they resolve at US Pacific midnight rather than
  UTC** — found by G4 and confirmed here, twice, with the DST offset tracking:

  ```
  after:2026-08-20 before:2026-08-22  → 07:00Z … 07:00Z   (midnight PDT, UTC-7)
  after:2026-02-10 before:2026-02-12  → 08:00Z … 08:00Z   (midnight PST, UTC-8)
  ```

  So a window is strictly inside the requested one *in Pacific terms* and offset
  seven or eight hours from it in UTC. An adapter must pad a day outward at each
  edge: wider over-fetches harmlessly, whereas narrower would let a caller record
  coverage over hours it never actually fetched. `when:1d` returned 100 items
  spanning 19h43m.
- **Depth ≥ 18 months.** `"bank of canada" after:2025-02-01 before:2025-02-03`
  returned 20 items inside the window from **17 distinct publisher domains**
  (`barrons.com`, `bbc.com`, `cbc.ca`, `financialpost.com`, …). That is ~18×
  Currents' horizon, over every outlet at once — the only free thing here that
  extends the *archive* rather than the *present*.
- 100 items per query, no paging. That is exactly the wall `clampSearchParams`
  already models: subdivide the window, do not page past the cap.
- The publisher **domain** is recoverable — `<source url="https://www.theguardian.com">The Guardian</source>`
  — but only if the adapter sets `sourceDomain` from it *instead of* from the
  canonical URL, which is not what either existing adapter does. Follow the
  convention and every article is attributed to `news.google.com`; see §6a, where
  that turns into manufactured breadth on the cloud's two-newsroom gate.
- The publisher **URL is not.** `<link>` and `<guid>` are both an opaque
  `news.google.com/rss/articles/CBM...` redirect. See §6a — this is the one that
  decides whether it is buildable.
- No usable `description`: the field is an `<a href>` blob wrapping the same
  redirect.
- No documented quota, no key, no terms that contemplate this use.

### GDELT DOC 2.0 — could not establish throughput

Keyless, keyword search with real boolean operators, `startdatetime`/
`enddatetime`, `sourcelang:`, ~3-month window, 250 records with no offset.
On paper the best fit of the three to `SearchParams`.

**In practice, 1 of 6 calls answered.** The one success took **21.2s**. The
other five died as silent `connection timed out` at 30–75s — not 429, not 503,
no body. Small queries (`maxrecords=3`) and large (`maxrecords=250`) failed
alike, so query weight is not the explanation; something at or before GDELT's
edge is dropping this IP. I could not distinguish a per-IP throttle from a
transient outage with the call budget spent here, and the honest statement is
that **GDELT's throughput is unproven, not bad.**

What the one success did establish: fields are `url`, `url_mobile`, `title`,
`seendate`, `socialimage`, `domain`, `language`, `sourcecountry`. Note
`seendate` — **GDELT's observation time, not the publication time.** For a
system whose entire timeline axis is `published`, that is a substantive
mismatch, not a field rename. There is no `description` and no `author`.
A `sourcelang:eng` filter is mandatory: a bare `query=climate` returned
Portuguese and Turkish articles.

Worth one more probing session from the production egress before writing it off
— a keyless, boolean-capable, 250-record provider is cheap breadth if it
actually answers.

### Direct outlet feeds — a different shape entirely

Working, HTTP 200, item counts as probed:

| Feed | Items | Notes |
| --- | --- | --- |
| `rss.dw.com/rdf/rss-en-all` | 139 | largest single feed found |
| `theconversation.com/ca/articles.atom` | 50 | **CC BY-ND**, see §5 |
| `abc.net.au/news/feed/51120/rss.xml` | 25 | |
| `aljazeera.com/xml/rss/all.xml` | 25 | |
| `france24.com/en/rss` | 24 | |
| `cbc.ca/webfeed/rss/rss-{topstories,world,canada,politics,business,technology}` | 19–20 each | also `rss-canada-calgary` and siblings; legacy `rss.cbc.ca/lineup/topstories.xml` still serves |
| `feeds.bbci.co.uk/news/world/rss.xml` | ~20 | |
| `feeds.npr.org/1001/rss.xml` | 10 | |
| `globalnews.ca/feed/` | 10 | already reaching us via Currents |
| `nationalpost.com/feed/` | 10 | needs redirect-following |

Dead or gated: `apnews.com/index.rss` → **401**, `reuters.com/arc/outboundfeeds/…`
→ **404**, `ctvnews.ca/rss/TopStories` → **404** (both wire services have closed
public RSS), `thestar.com/feeds.articles.news.rss` → 200 with zero items.

**These do not fit `search(SearchParams)` and should not be forced into it.** A
feed has no keyword parameter, no date window, and ~20 items of memory. Behind
the `NewsClient` interface a feed adapter would have to fetch everything and
filter locally — and PROBE-FINDINGS 3 already established why that is not a
substitute for an upstream query: only 7 of 20 articles Currents returned for
`climate` contained the word anywhere we can see, because matching runs against
body text we never receive. A local filter returns a *different* set and would
under-report the topic while `topic_coverage` recorded the span as fetched.
That is the ADR-0012 failure mode with the provider names changed.

The shape that does fit is a **firehose chore**: poll feeds on a schedule, write
`articles` and `sightings` globally, attach nothing to any topic, and claim no
coverage. `grouping.ts` and the storyline layer read `articles` globally, not
through `topic_articles`, so firehose articles would reach groups, storylines,
labels and the cloud without touching the topic/coverage machinery at all. The
timeline for a *searched* topic would not see them, and that asymmetry is the
honest version of what a feed can offer.

**One thing to fix first, if CBC is the target:** CBC's own `pubDate` is
unreliable in its top-stories feed. The 20 items were **not** in date order and
spanned `2026-08-07` to `2026-08-27`; the first item — a story published that
morning — carried `Wed, 12 Aug 2026 15:00:00 EDT`, twenty days stale. In this
codebase that lands the article at the wrong point on the timeline *and* inside
a span `topic_coverage` may already call covered, so nothing revisits it. A feed
adapter would need `latest_seen`-style handling rather than trusting `pubDate`,
or a documented decision to accept misplacement.

### Wikinews — complete for its size, and its size is tiny

`en.wikinews.org/w/api.php?action=query&list=search&srsearch=climate&srsort=create_timestamp_desc`
gives keyword search, `totalhits`, and `sroffset` paging over the full archive,
keyless, under **CC BY 2.5** — the only unambiguously republishable source here.
`totalhits` for "climate" was **465, all-time.** Volunteer-written, so it is a
licensing curiosity rather than a source of volume. Not recommended.

---

## 2. What was not probed

Every remaining candidate needs a key, so only documented terms are available
and none of it is verified: NewsData.io (200 credits/day, 48h window on free),
NewsAPI.ai / Event Registry (2,000 searches, no card), World News API,
Mediastack (~500/month), APITube, NewsMesh (50/day). NewsAPI.org's free tier is
localhost-only with a 24h delay and no commercial use — unusable in production
regardless of limits. NYT Article Search is free at a documented 500/day, 5/min
with an 1851-deep archive and explicit attribution requirements; it is the same
shape as the Guardian (one deep outlet) at a tenth the call budget, and is the
obvious second pick if the Guardian's non-commercial clause is disqualifying.

---

## 3. Fit against the existing seam

`NewsClient.search()` wants: keyword list, language, country, category, domain,
a date window, 1-indexed page, page size — and must return `isLastPage`,
`rawCount`, and a `QuotaSnapshot` or an explicit null.

| | Guardian | Google News | GDELT | Direct RSS |
| --- | --- | --- | --- | --- |
| `keywords` | yes | yes | yes, + booleans | **no** |
| `startDate`/`endDate` | yes | yes | yes | **no** |
| `pageNumber` | yes, real | cap only | cap only | **no** |
| `isLastPage` honest | yes (`pages`) | yes (<100) | yes (<250) | meaningless |
| `quota` | **headers** | none | none | n/a |
| `published` is real | yes | yes | **no** (`seendate`) | **CBC: no** |
| `url` is the article | yes | **no** (§6a) | yes | yes |
| `description` | yes | no | no | CBC: `<img>` blob |

Two consequences follow from ADR-0012 rather than from any of these tables:

**Any new provider is a supplement, never coverage-bearing.** Currents keeps
`isLastPage`. This holds even for the Guardian, whose paging is *better* — a
Guardian `pages` count is authoritative about the Guardian and says nothing
about the day, and treating it as coverage would record spans no one fetched.

**Adding a provider makes the others spend more.** The composite intersects
page sizes. The Guardian's default page size is 10; wiring it in at that ceiling
would halve the shared page size from Currents' 20 and double Currents' calls
for the same window — the same trap ADR-0012 documents for GNews. The Guardian
accepts `page-size` up to 50, so this one is avoidable by asking for 20, unlike
GNews Free's hard 10.

---

## 4. Recommendation

**Build the Guardian first**, as a best-effort supplement in the ADR-0012 mould,
*if* the non-commercial clause is acceptable (§5 — that is a call about what
zammy is, not a technical one). It is the lowest-risk adapter here: real
publication times, real URLs, every display field, quota headers the existing
parser handles, and an archive that finally lets a topic reach past 30 days.
Its weakness is the one thing this system already handles well — a single
domain is just one member of a group.

**Then measure Google News RSS against §6a before committing to it.** It is the
only free path to breadth *and* history, and the question that decides it is not
whether Google is self-consistent — measured, it largely is — but whether a
Google-reported story can be collapsed onto the *same* story arriving from
Currents. That needs the redirect resolved, and resolution is the afternoon's
experiment.

**Re-probe GDELT from the production egress.** One success in six is not a
verdict, and the capability on offer is good.

**Treat direct feeds as a firehose chore, not a provider.** CBC is fine as the
first one — seven working feeds, real URLs — provided the `pubDate` problem in
§1 and the `cmp` problem in §6b are handled and the "FOR PERSONAL USE ONLY"
notice in §5 is resolved.

---

## 5. Licensing — the part that is not a technical decision

Stated plainly because three of the best candidates carry a restriction and the
choice between them is not ours to make silently:

- **CBC RSS** channels carry `<description>FOR PERSONAL USE ONLY</description>`
  verbatim in the feed. Every CBC feed probed had it. Headline-and-link
  aggregation is a long way from republication, but the notice is explicit and
  it is in the payload rather than buried in a terms page.
- **Guardian free Developer tier is non-commercial only.** If zammy is or
  becomes commercial, this needs a commercial key application rather than a
  code change.
- **Google News RSS** has no developer terms covering this. It is not a
  published API; it is a feed endpoint behind Google's general ToS.
- **The Conversation is CC BY-ND 4.0**, which *permits commercial use*,
  requires author + institution + The Conversation credit and a link back, and
  forbids edits. It is the only candidate here that is both freely
  republishable and commercially usable. Small, but clean.
- **Wikinews is CC BY 2.5.** Clean, negligible volume.
- **GDELT** indexes metadata and links rather than redistributing text; the
  DOC API is documented as open.

## 6. Two land-mines that apply regardless

### a. Google News' opaque URL breaks article identity

Measured after the first draft of this document, which overstated the
within-Google half of it. The corrected picture:

**The `CBM...` id is stable per story.** Across a repeated query, guid was
identical on 100/100 shared titles; across two different queries (`climate` vs
`climate change`), 51/53; across `hl=en-CA` vs `hl=en-US`, 70/71. So repeated
fetches and overlapping windows *do* collapse correctly, and the planner can
subdivide time without re-ingesting. The residual ~1-2% is real: one story
(`dailysabah.com`, identical title, identical `pubDate` to the second) carried
two different CBM ids of different lengths — the outlet published it at two URLs
and Google indexed both. Marginal, not structural.

**The structural failure is cross-provider, and it is total.** `Sighting.dedupKey`
documents itself as identifying the same article "including across providers,
which is exactly what makes fan-out cheap". Google News breaks precisely that:

```
via Currents      https://www.theguardian.com/technology/2026/aug/11/ai-will-...
via Google News   https://news.google.com/rss/articles/CBMiigFBVV95cUxOWl9P...?oc=5
```

`canonicalizeUrl` cannot reconcile those, so `deriveDedupKey` — sha256 of the
canonical URL — yields two keys, and the fold upserts **two rows in `articles`**.
Not two sightings of one article; two articles. Per ADR-0002 each row then runs
its own `published = LEAST` and earliest-sighting display logic independently, so
both look complete and neither knows the other exists, and `topic_articles` links
both — the topic timeline shows the headline twice.

This hurts Google News specifically more than it would hurt any other candidate
here, because Google News' entire value is breadth over outlets Currents already
reports. The overlap *is* the point, and the overlap is exactly what fails to
collapse.

**The second-order damage is attribution, and it lands on the cloud.** Both
existing adapters set `sourceDomain: sourceDomain(url)` — derived from the same
canonical URL. Follow that convention and every Google News article gets
`source_domain = "news.google.com"`. Then `trending-storylines.ts`:

```sql
having count(distinct a.source_domain) >= 2   -- MIN_SOURCE_DOMAINS
```

That gate exists to ask "are several newsrooms covering this NOW". One outlet's
story plus its Google News duplicate is two distinct `source_domain` values, so
it passes — **manufactured breadth on every story Google reports**, which would
flood the cloud with single-newsroom stories. `window_sources` and `source_count`
in the same query inflate identically.

The publisher domain *is* recoverable — `<source url="https://www.theguardian.com">`
— so an adapter can set `sourceDomain` independently of `url` and keep the gate
honest. That fixes attribution and leaves identity broken, at the cost of the
first rows in the schema where `sourceDomain(url) != source_domain`.

**So the redirect can be made harmless for attribution, but not for identity.**
Identity needs the real URL, and modern `CBM...` ids no longer decode to one —
they need a live round trip per article, at 100 articles per query. There is
nothing to add to `TRACKING_PARAMS` here: the redirect is not a parameter on the
URL, it is the whole URL. `sightings.raw` does leave an escape hatch — its own
comment notes a widened canonicalization can re-normalize history without
refetching — but because `articles` is *keyed* on `dedup_key`, cashing that in
means merging article rows, i.e. a migration rather than a re-normalize.
**Establish whether redirect resolution is reliable and affordable before
building anything else on this source.**

### b. Title suffixes and `?cmp=` — small, cheap, already known to bite

**`100 of 101` Google News titles carried a ` - Outlet` suffix** ("… - The
Guardian"). We have measured this exact damage before, from Currents:
`" | Globalnews.ca"` leaked `winnipeg`/`globalnew`/`ca` into `story_tokens` and
pre-loaded **19.6 of the 20-point link-mass floor** on its own. At 100% of
items rather than one outlet's, an unstripped Google News suffix would make
link mass meaningless. The shared tokenizer needs the suffix stripped at
normalization — the Guardian's `webTitle`, for contrast, is clean.

**`TRACKING_PARAMS` was missing `cmp` — now fixed.** CBC's feed links all end
`?cmp=rss`, so a CBC article from RSS and the same article from Currents
canonicalized differently and became **two articles for one story** — the §6a
failure at one-line cost. `cmp` was added on the publishers' own evidence rather
than on the name: fetched with and without it, both CBC's and the Guardian's
`rel="canonical"` tags declare the bare URL canonical. The match is
case-insensitive, so the Guardian's `?CMP=share_btn_url` is covered by the same
entry. No committed fixture carried `cmp=`, so no existing `dedup_key` moved.

### c. `SearchParams.domain` is plumbed and unused

Worth knowing before building anything: `SearchParams` already carries
`domain?: string`, Currents' `domain=` filter is verified working
(PROBE-FINDINGS 1, `domain=coindesk.com`), and **nothing in `apps/api` ever
sets it.** A domain-scoped topic would pull `cbc.ca` through the provider we
already pay for, with real URLs, real publication times, real descriptions and
full coverage semantics — no adapter, no firehose, no license question beyond
the one we already accepted. It costs Currents calls out of the same 1,000/day
budget and it is bounded by the same 30-day lookback, so it is not a substitute
for either recommendation above. But for "ingest cbc.ca specifically," it is
the cheapest thing on this page by a wide margin and it should be measured
first.

---

## Reproducing

Every probe was a single `curl` with `-4 --http1.1` and an explicit
`User-Agent`; the default library UA is not safe to use against Currents
(PROBE-FINDINGS 2) and was avoided everywhere. No key was used except the
Guardian's shared `api-key=test`. Item counts came from
`grep -oc '<item\|<entry'`, date spans from
`email.utils.parsedate_to_datetime` over `<pubDate>`.
