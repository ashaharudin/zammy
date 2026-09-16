# Storyline day summaries

The historical preserve: one sentence per storyline-day, and one per populated
six-hour UTC segment of it, written once and kept for ever. The decision is
[ADR-0023](adr/0023-a-days-coverage-is-preserved-as-a-sentence.md); the source of
truth is [the migration](../packages/storage/src/migrations/0024-storyline-day-summaries.ts)
(what a row is), [storyline-summaries.ts](../packages/storage/src/storyline-summaries.ts)
(the reads), [storyline-summary.ts](../apps/api/src/storyline-summary.ts) (the
prompts and the contract) and
[storyline-summary-service.ts](../apps/api/src/storyline-summary-service.ts)
(what gets written and when). This page is the map.

**One reader now sees these rows**: the storyline view draws the *day* sentence
beside each day's heading. [What a reader sees](#what-a-reader-sees) is the whole
of it — the quarters are still written and still unread.

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

- **no row** — no articles landed in that segment, *or* the model could not be
  reached when it was tried.
- **row, `summary` null** — the model answered and the answer was unusable.
- **row, `summary` set** — the sentence.

The middle one is a **refusal** and costs the span an attempt. The line between
the two is drawn by the client, on `GenerateResult.failure`, never on the reason
string:

| the model… | | costs an attempt? |
|---|---|---|
| answered, and the answer failed the contract | refusal | yes |
| blocked the prompt (`SAFETY`) | refusal | yes |
| answered with an empty candidate, or only thinking | refusal | yes |
| 429, 5xx, timeout, network fault | unreachable | **no** |
| a 4xx, an unparseable body, a shape we do not know | unreachable | **no** |
| the local pacer declined to queue the call | unreachable | **no** |

Collapsing the two is how three nights of quota errors would take every span in
the window to `SUMMARY_MAX_ATTEMPTS` without the model having declined one of
them. Collapsing them the other way is just as bad: a storyline whose headlines
trip the safety filter would look like an outage, and the pass's
outage-circuit-breaker would halt at the same day every night.

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
  `article_count` alone, so the rewrite is still owed and will be retried. An
  unreachable model does not even bump the attempt.
- **The day sentence follows its quarters, window or no window.** If any quarter
  was written or rewritten, the day is rewritten too — the sentences it was built
  from are not the ones it was built from. This outranks the freeze on purpose:
  a quarter can legitimately change past the window (a first write of a quarter
  that had no row, a successful retry of a refusal), and a frozen day sentence
  beside a quarter it has never seen would be a day summary that omits part of
  its own day.

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

The contract is one sentence about **what happened** rather than about the
coverage. Its length is asked for in **words** (35) and enforced in
**characters** (300), and the mismatch is deliberate: a model cannot count
characters and can roughly count words, so the prompt uses the unit it can act
on and the stored row is checked in the unit a reader can check exactly.

That was not the original shape, and the measurement is why it changed. Under a
240-*character* instruction, 31 of the first 48 live answers landed between 216
and 240 characters and the longest was exactly 240 — the model writes to whatever
limit it is given, and three spilled over. Those refusals were sentences one or
two words too long, not bad answers. At 35 words ≈ 234 characters against a
300-character backstop, a refusal now means the answer is genuinely not one
sentence about one day. The **first** ask is at temperature 0, so the
same coverage names the same day on a replay; a **retry** is not, because the
failures worth retrying are deterministic ones. Measured live 2026-08-29: a
refused answer re-asked at temperature 0 came back byte-identical and 241
characters long again, and the same span re-asked warm answered in 217. Two of those are enforced by
[`validateSummary`](../apps/api/src/storyline-summary.ts); the third is the
prompt's, exactly as "name the event, not the entity" is the label prompt's.
A wrapper (`**Summary:** "…"`) is stripped rather than refused — a chat-tuned
model returns one often enough that refusing would make refusal the common case.
The segment names are deliberately *not* in the strip list: "Evening — the talks
collapsed." is a correct answer whose first word is part of the sentence.

**The sentence-count check knows about abbreviations**, and that is not a
nicety: `U.S. officials paused the wall` is a period, a space and a capital
letter inside one sentence, and a naive boundary test rejects every summary that
names a country.

## What a reader sees

In the **storyline view**, and there alone, a day's heading carries its sentence:

```
● TODAY. Rescuers reached the valley as the river fell for the first time in a week.
● TUESDAY, SEP 8. The evacuation order widened to three more districts.
```

The heading is still the day and still the collapse control; the sentence is a
span beside it, in the page's own casing rather than the heading's. Both halves
of the format are already there — `dayLabel` produces "Today" / "Tuesday, Sep 8"
and the heading uppercases it — so the only new mark is the separating period.

Four decisions, each of which is a place this could have gone differently:

| | |
|---|---|
| **the day sentence only** | the quarters are its own input, and the rail already cuts a day into the parts of the **reader's** day. Four UTC quarters drawn against four local parts is two divisions of one day on top of each other. |
| **the view only** | a search's slot holds the members that matched the keywords, so a sentence about the whole day would describe coverage the row does not show. `toEntry` leaves `daySummary` null; `toStorylineEntry` fills it. |
| **matched by DATE** | the rail cuts days in the **reader's** zone and a sentence is written over a day in **UTC**, so the coverage one sentence describes routinely lands in two rail days. The sentence goes under the heading reading its own date — see below. |
| **absent = refused** | a null `summary` is a row, but a reader gets the heading they always had either way. The difference matters to the pass, never to the page. |

### Two calendars, one date

The rail's days are the **reader's** (`Intl` zone, §8.1); a sentence is written
over a **UTC** day. They hold different instants, so a storyline-day's cards are
routinely split across two rail days and there is no rail day that *is* the day
the sentence covers.

Filing the sentence by the slot — under whichever rail day its earliest article
fell in — was the first answer and was wrong. For a reader six hours west, a
storyline-day whose earliest article ran at 01:00 UTC leads in the *previous*
local day, so the 22nd's sentence drew under **"FRIDAY, AUG 21"** while the rest
of the 22nd's coverage sat below under Saturday. Caught by rendering the real
view in a real browser, which is the only place both calendars are visible at
once — no unit test on either side of the wire can see it.

So the match is by **date label**, not by instants: `2026-08-22`'s sentence goes
under the rail day called `2026-08-22`. The two calendars disagree about which
instants a day holds and agree exactly about what to call it, and the sentence is
a claim about a date — it names its own ("as the August 19 deadline approaches"),
so a heading reading a different one contradicts the prose beside it. That is why
`daySummary` is an object: `dayKey` travels with the text, because the browser
cannot derive which calendar day an instant fell in under a zone it does not
know the server used.

The cost, stated: a sentence whose date has no rail day on the page is not drawn.
It takes a day whose every article ran in the few hours falling outside the
reader's like-named day.

A **merge** is the one case the read has to work for. The preserve never follows
one — the rows stay on the id they were written for — while the view resolves a
bookmark forward to the winner, so
[`readArcDaySummaries`](../packages/storage/src/storyline-summaries.ts) walks the
alias chain *downward* and gathers every id that merged into this one. Two rows
can then answer for one day; the one with the higher `article_count` wins,
because it was written over more of that day.

The sentences can be turned **off**, with the `summary` toggle in the command
bar's meta row (a reader preference in `localStorage`, on by default, only ever
recording an *off* — `apps/web/src/daySummaryPreference.ts`). The toggle appears
in the storyline view only, since it is the only place with sentences to
suppress. Collapsing a day does **not** hide its sentence: collapsing hides the
coverage, and what that coverage said is then the reason to open it again.

`TimelineEntry.daySummary` is the wire field, defaulted so a response from an
instance that predates it parses as the silence it is.

## Running it

**Nightly**, as the `summaries` chore pass at `0 5 * * *` UTC — its own schedule,
not a step of the 04:00 storyline night, because that pass is already the
expensive one and they spend the same key. It writes nothing at all until
`SUMMARIES_ENABLED=true`.

Its window is whole UTC days at **both** ends: `SUMMARY_WINDOW_DAYS` (8) back
from the start of today, up to the start of today. Today is excluded because the
pass fires at 05:00, inside the `night` quarter it would otherwise summarise and
then freeze — a night sentence permanently describing five sixths of its span.

Within that window the walk is **two phases** (ADR-0023's amendment):

1. the newest `SUMMARY_FRESH_DAYS` (3) days, **newest first**, until they are
   done or `SUMMARY_FRESH_SHARE` (0.6) of the budget is spent;
2. the whole window, **oldest day first** — the original walk.

Oldest-first alone is what ADR-0023 chose, and the reason still holds: the days
about to fall out of the window cannot wait, and the newest day can. What it did
not anticipate is a **promotion burst**. A newly promoted arc brings its whole
back-history as first-write candidates, so one day's inflow can be several times
another's, and it pre-empts the newest days for as long as it takes to drain. On
2026-09-16 that was long enough to leave the two newest UTC days with 45
qualifying storyline-days and no sentence at all, through six firings that spent
379 calls between them.

The fresh phase is **bounded** rather than merely first, and that bound is what
keeps the original guarantee: it cannot spend the night, so the old end still
gets two fifths of every firing. Two details follow from it, both of which are
easy to get wrong:

- a day the fresh phase **bounces off** is handed back to the second walk rather
  than counted as done, or the share boundary becomes a one-day hole that reports
  as `exhausted`;
- the second walk covers the **whole** window, so budget the fresh phase did not
  spend still reaches fresh days.

`SUMMARY_MAX_PER_RUN` is a *spend* bound and `SUMMARY_BUDGET_MS` is the *clock*
bound — the same split `CHORE_MAX_LABELS` and `CHORE_LABEL_BUDGET_MS` make. The
budget is what actually stops a healthy night: about **128 calls** at 275 s and
`SUMMARY_MAX_RPM` 28. And a run of unreachable asks stops the pass early rather
than spending the whole ceiling discovering the API is still down.

**The pacing is measured from one call's START, not from its return.** That is
not a detail: sleeping a full interval *after* each answer runs the pass at
`60000 / (spacing + latency)`, which is not the rate anybody configured. Measured
on 2026-09-16, 2 s of spacing plus ~1.3 s of latency gave 18 calls a minute
against a key that allows 30, and about 40% of every firing was the pass asleep
with the key idle. `SUMMARY_MAX_RPM` is its own knob and sits below
`GEMINI_MAX_RPM` so the drain's organic label promotions keep a share of the key
— of the rpm window and of the 16k input-tokens-per-minute one alike.

**The budget aborts what it cannot stop.** `SUMMARY_BUDGET_MS` bounds when a
call is *admitted*; a call in flight runs to three `GEMINI_TIMEOUT_MS` attempts
plus backoff, up to 60.75 s, against a 300 s `maxDuration`. `runSummaryChore`
arms an abort ten seconds past the budget, so the sum that has to clear 300 s is

```
2.1s boot + 275s budget + 10s grace + ~1s chore_runs write = ~288s
```

with both measured halves taken from production. **Raising `SUMMARY_BUDGET_MS`
means redoing that sum**: overshooting leaves a `chore_runs` row with a null
`finished_at`, which `check-chores.sh` reports as a failed night. An abort costs
the preserve nothing — it reads as `unreachable`, so no row and no attempt.

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

The CLI does **not** consult `SUMMARIES_ENABLED`. That flag exists so the nightly
pass does not start spending unattended; typing the command is the deliberate act
it protects.

`--rate` matters more than it looks. The pacer's scope is one **process**, so a
CLI run against a live server puts two pacers on one key and up to 2× the ceiling
through it. What that costs is not this run — it is the server's labels falling
back to the bigram extractor, which are sticky until the drift trigger fires.

The CLI **runs the pass** — `runChorePass("summaries", …)`, the same call the 05:00
firing makes — rather than re-implementing it. So it takes the same advisory lock
and skips (exit 0) if the nightly pass holds it, and it **writes a `chore_runs`
row**, which it did not until it was routed this way: a manual backfill used to
leave no durable record that it had run, no `model_calls` against the night it
spent them on, and no non-UTC `APP_TIMEZONE` warning. On one-hour log retention
that row is all that outlives the terminal.

The lock is the half that was always right, and it is the only operator command
here that takes one: every other writes state a later pass rebuilds, and these
rows are the one thing nothing rebuilds — two runs deciding independently what a
span should say, and the loser overwriting the winner, is not a race worth having.

`--from`/`--to`/`--storyline` reach the pass as `summaryWindow` and
`summaryStorylineId` on the chore deps. They are deliberately **not** query
parameters on `/api/chores`: a scheduler naming its own window would be a
schedule disagreeing with `supabase-cron.sql` from inside a query string.
`--dry-run` and `--show` stay outside the pass entirely — no model, no writes, and
a `chore_runs` row for a read would record a night that never happened.

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
`SUMMARY_SETTLING_DAYS` + `SUMMARY_RECOMPUTE_DELTA` (what may be rewritten),
`SUMMARY_CLIFF_DAYS` (which days get quarters), and `SUMMARY_FRESH_DAYS` +
`SUMMARY_FRESH_SHARE` (which end of the window goes first, and for how long —
set `SUMMARY_FRESH_DAYS=0` to restore the single oldest-first walk).

The ones that set the pace: `SUMMARY_MAX_RPM`, `SUMMARY_BUDGET_MS` and
`SUMMARY_MAX_PER_RUN`. The first two are coupled to things outside this file —
the key's shared rate and token limits, and the route's `maxDuration` — so
neither is a number to nudge without reading its comment.
