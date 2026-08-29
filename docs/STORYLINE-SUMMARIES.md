# Storyline day summaries

The historical preserve: one sentence per storyline-day, and one per populated
six-hour UTC segment of it, written once and kept for ever. The decision is
[ADR-0022](adr/0022-a-days-coverage-is-preserved-as-a-sentence.md); the source of
truth is [the migration](../packages/storage/src/migrations/0024-storyline-day-summaries.ts)
(what a row is), [storyline-summaries.ts](../packages/storage/src/storyline-summaries.ts)
(the reads), [storyline-summary.ts](../apps/api/src/storyline-summary.ts) (the
prompts and the contract) and
[storyline-summary-service.ts](../apps/api/src/storyline-summary-service.ts)
(what gets written and when). This page is the map.

**UI is not in scope here.** Nothing reads these rows yet.

## What a row is

`storyline_day_summaries`, keyed `(storyline_id, day_key, segment)` with
`segment ∈ night | morning | afternoon | evening | day`.

| | |
|---|---|
| `day_key` | YYYY-MM-DD, **always UTC** — unlike `storyline_days.day_key`, which is `APP_TIMEZONE` |
| `summary` | the sentence, or **null** when the model was asked and refused |
| `article_count` | what the sentence was written over — the recompute trigger's input |
| `label` | the arc's label **as it read at write time**; labels drift, so this is not a join |
| `attempts` | asks spent since the last sentence; three and the span is retired |
| `segmented` | false on a day summarised whole — see [the cliff](#the-cliff) |

Three states, and the difference between the first two is the whole feature:

- **no row** — no articles landed in that segment.
- **row, `summary` null** — the model was asked and would not answer.
- **row, `summary` set** — the sentence.

**No foreign key on `storyline_id`, deliberately.** `storyline_groups` and
`storyline_days` cascade from `storylines`, which is right for them and would be
fatal here: a preserve that cascades away with its arc is a preserve that deletes
itself. A merge leaves these rows on the id they were written for, and
`storylines.merged_into` resolves it — the same hop every other holder of a
storyline UUID makes.

## The segments

Even six-hour quarters, in UTC:

| segment | hours (UTC) |
|---|---|
| night | 00:00–06:00 |
| morning | 06:00–12:00 |
| afternoon | 12:00–18:00 |
| evening | 18:00–24:00 |

Even rather than the uneven spans the words name in speech, because an uneven
night straddles midnight and would put part of a "night" in the previous day.
Bucketing is on `articles.published`, not on when we collected the article.

## What qualifies

Three clauses, ANDed, in [`readSummaryCandidateDays`](../packages/storage/src/storyline-summaries.ts):

1. the arc is not `provisional` and is not an alias;
2. the day holds **more than `SUMMARY_MIN_ARTICLES_PER_DAY`** articles (4, so
   five);
3. from **at least `SUMMARY_MIN_GROUPS`** distinct groups (2).

(2) and (3) are different tests and the difference is the common case here: one
wire story syndicated six times is six articles in **one** group. Once a day
qualifies, *every* non-empty quarter gets a sentence — there is no per-segment
bar, because a five-article bar per six-hour quarter would suppress the segments
on nearly every day that qualifies.

## When a sentence changes

| state | what happens |
|---|---|
| no row | **write** — always allowed, however old the day is |
| refused (`summary` null) | **retry**, until `SUMMARY_MAX_ATTEMPTS` |
| written, day < `SUMMARY_SETTLING_DAYS` old, span gained > `SUMMARY_RECOMPUTE_DELTA` | **recompute** |
| written, day older than the window | **frozen** |

Two consequences worth knowing:

- **A refusal never destroys a sentence that stands.** A rewrite the model
  declines bumps `attempts` and leaves the older sentence and its
  `article_count` alone, so the rewrite is still owed and will be retried.
- **The day sentence follows its quarters.** If any quarter was rewritten, the
  day is rewritten too — the sentences it was built from are not the ones it was
  built from.

## The cliff

Google News drops the pubDate **time** beyond ~8 days and stamps 89.4% of those
rows midnight US Pacific (07:00/08:00 UTC), so nearly all of them land in
"morning". A day older than `SUMMARY_CLIFF_DAYS` therefore gets the **day
sentence alone**, built from its articles, with `segmented = false`.

Quarters written while the day was fresh are left exactly where they are — they
were honest when they were written, and ageing does not make them false.

## What the model is asked

Per quarter: up to `SUMMARY_SEGMENT_SAMPLE` (8) articles, chosen
`sighting_count DESC` — the dominant coverage of the quarter rather than whatever
was published first — and rendered oldest-first with descriptions trimmed to 200
characters, which is the labeler's rendering. The arc's **label** is included and
nothing else: not the previous quarter's summary, because chaining lets one bad
sentence poison every later one and stops the quarters being independently
recomputable.

The **day** call is over the quarters' own sentences: ~150 tokens instead of
~3,000, and consistent with them by construction. Only a day with no quarters —
past the cliff, or one whose every quarter was refused — falls back to the
articles.

The contract is one sentence, at most 240 characters, about **what happened**
rather than about the coverage. Two of those are enforced by
[`validateSummary`](../apps/api/src/storyline-summary.ts); the third is the
prompt's, exactly as "name the event, not the entity" is the label prompt's.
A wrapper (`**Summary:** "…"`) is stripped rather than refused — a chat-tuned
model returns one often enough that refusing would make refusal the common case.

**The sentence-count check knows about abbreviations**, and that is not a
nicety: `U.S. officials paused the wall` is a period, a space and a capital
letter inside one sentence, and a naive boundary test rejects every summary that
names a country.

## Running it

**Nightly**, as the `summaries` chore pass at `0 5 * * *` UTC — its own schedule,
not a step of the 04:00 storyline night, because that pass is already the
expensive one and they spend the same key. It looks back
`SUMMARY_WINDOW_DAYS` (8) from the start of today's UTC day, and it writes
nothing at all until `SUMMARIES_ENABLED=true`.

```bash
pnpm chores summaries --max-summaries=30 --summary-rate=10
```

**By hand**, for the backfill and for verification:

```bash
pnpm summaries:storylines --dry-run --from=2026-06-01
pnpm summaries:storylines --storyline=<uuid> --max-summaries=60 --rate=10
pnpm summaries:storylines --storyline=<uuid> --show
```

Run `--dry-run` first: it names the qualifying days and an upper bound on the
calls, which is the only way to see what a backfill costs before spending it.

`--rate` matters more than it looks. The pacer's scope is one **process**, so a
CLI run against a live server puts two pacers on one key and up to 2× the ceiling
through it. What that costs is not this run — it is the server's labels falling
back to the bigram extractor, which are sticky until the drift trigger fires.

## Verifying it

Fixtures cover the client and the contract
(`fixtures/gemini-summary-responses.json`, and note its provenance header: the
response *shapes* are recorded, the *texts* are not). What fixtures cannot answer
is whether this model honours a one-sentence prose contract — the labeler's own
history is a model changing its response shape under a pinned id. So:

```bash
pnpm summaries:storylines --storyline=<uuid> --max-summaries=60 --rate=10
```

against **dev**, then `--show` to read what came back. Production is a separate
dispatch.

## The knobs

All of them are in [`.env.example`](../.env.example) with their reasoning.
The ones that change behaviour rather than pace: `SUMMARIES_ENABLED`,
`SUMMARY_MIN_ARTICLES_PER_DAY` + `SUMMARY_MIN_GROUPS` (the gate),
`SUMMARY_SETTLING_DAYS` + `SUMMARY_RECOMPUTE_DELTA` (what may be rewritten), and
`SUMMARY_CLIFF_DAYS` (which days get quarters).
