---
status: accepted (amends ADR-0029: its token, its "never what it asked", its built-in examples and its record panel are gone)
---

# A trace says what was asked, and the newest ten are listed

ADR-0029 built request playback as an instrument an operator aimed: a request was traced only
when it presented `x-zammy-trace: Bearer <REQUEST_TRACE_TOKEN>`, a trace held the stations it
touched and never the data it touched them with, and the page opened on seven hand-written
examples, with a panel that made one real request under the token. Using it, the instrument was
aimed at the wrong thing. The question an operator brings to `/?trace` is "what just happened to
*that* request" — a search that felt slow, a storyline that opened empty — and neither the
examples nor a fresh request made from the panel answer it. The request worth watching is one
that was already served, and a trace that cannot say which search it was cannot be found among
others.

**With tracing on, every request to a traceable route is traced — no header, no token. Each
record carries its SUBJECT: what the request asked for. The newest ten are listed, and the page
is a dropdown of them; the examples and the record panel are gone.**

## The change

1. **No token.** `REQUEST_TRACE_TOKEN` is removed from the config, with its three boot checks and
   its redaction; a value left in an environment is ignored (zod strips an undeclared key), so
   removing it from Vercel is tidying, not a prerequisite. `REQUEST_TRACE_ENABLED` is the whole of
   the opt-in. The shared `TRACE_REQUEST_HEADER` and `traceAuthorization` are gone, and so is the
   logger's redaction of `x-zammy-trace`.
2. **Every traceable request is traced** — `GET /api/v1/timeline` (a search or a view),
   `GET /api/v1/storylines`, `POST /api/v1/storylines/:id/refresh`, `GET /api/v1/trending` and
   `GET /api/v1/reference`, exactly ADR-0029's five routes. HEAD, OPTIONS, `/topics`, the health
   checks and the trace routes are still never traced. ADR-0029's per-instance bounds stay and
   change job: 30 opens a fixed minute and 8 at once were there to keep a leaked token cheap, and
   are now what keeps reader traffic from making every request a traced one.
3. **A record carries its subject** (`RequestTrace.subject`, `TraceSubject`), read in
   `trace-redact.ts` from the request's own query and route params (`subjectOf`) and, for a
   storyline view, its reply (`withViewLabels`):

   | Route | Subject |
   | --- | --- |
   | `timeline_search` | `keywords`, `language`, `country` |
   | `storylines_search` | `keywords` |
   | `timeline_view` | `storylines`: each viewed arc's id and label, from the reply's `storylines` (aliases resolved to survivors), then any requested id the reply did not name, unlabelled; only the requested ids, unlabelled, when the reply names none |
   | `storyline_open` | `storylines`: the one id, **no label** |
   | `trending` | `language`, when one was asked for |
   | `reference` | none (`subject: null`) |

   The values are the reader's own, before canonicalization, each cut to its bound (200
   characters for keywords and labels, 8 for a filter, `MAX_VIEW_STORYLINES` storylines) rather
   than refused, so an overlong query still stores. A value the subject cannot hold at all — a
   repeated parameter, which arrives as an array, or a storyline that is not a UUID — is left out,
   so a 400 about one has no subject for it. An open's 202 carries no label and the planner's read of it is not
   threaded out, so an open names its storyline by id alone; widening the refresh reply or the
   planner's outcome for a diagnostic was the larger change and was not made.
4. **The newest ten are listed.** `putTrace` now pipelines, in order, the record's `SET`, an
   `LPUSH` of its id onto `<queue>:trace:recent`, an `LTRIM` to ten and a `PEXPIRE` at the trace
   TTL. Its answer is still the record's — a trace whose list entry was lost can still be opened by
   its id. `GET /api/v1/traces` (`TRACE_RECENT_ROUTE`) reads the ids and `MGET`s their records, so
   an entry whose record has expired drops out rather than being listed as a trace nobody can open,
   and answers `RecentTracesResponse`: `TraceSummary` rows (id, route, method, status, start,
   duration, subject — never the touches), newest first. It has the read route's posture: its own
   rate-limit bucket (10 a minute), GET only, `no-store` on every answer, 503 rather than an empty
   list when Redis errors, and it exists only while tracing is on.
5. **The page lists what was served.** `/?trace` is now a dropdown (`TracePicker.tsx`) of the
   recent list, each row "12:04:31 · search “quokka zebra” → 200 in 812 ms", re-read every 20 s
   and on **Refresh**. A bare `/?trace` plays the newest; `/?trace#t=<id>` still plays one trace,
   and one that has fallen out of the newest ten is listed as the current trace rather than
   silently absent. The status plate says what the trace asked for. A 404 from the list is
   "tracing is off" (`TracingOff`), final and said as such. An old `/?trace=<slug>` example link
   reads as a bare `/?trace`.
6. **The examples are test fixtures now.** The seven JSON files moved to
   `apps/web/src/playback/fixtures/` behind `traceFixtures.ts`, which nothing the page ships
   imports; the choreography, frame, drawing, transport and wording tests still drive every path
   with them. Their citation checks (`exampleTraces.test.ts`) and the API-side fidelity test that
   pinned their paths to real recordings (`trace-examples.test.ts`) are deleted with the claim they
   guarded: a fixture is not shown to a reader as a description of the code. `traceSignature` stays
   in the shared contract; `trace-http.test.ts` still reads a real cold search's signature with it.
7. **The record panel is gone**, and with it `recordRequest`, the browser-only traces it drew for a
   CDN hit or a platform 504, and their notices. The renderer still draws an `edge` touch and an
   `origin: null` record — the `edge-hit` fixture exercises both — but the page can no longer
   produce one.

## Why no token

The token made tracing an instrument for requests an operator made on purpose, and the requests
worth watching are the ones readers made. Keeping a token and adding a list would have meant a
token on the list, the dropdown and every poll: ADR-0029 kept the token out of the read route
precisely because a token in a poll is a token in a URL, a log line and a query cache. The flag is
already a deliberate act — a `vercel env` change and a redeploy — and "on for a session, then off"
bounds how long requests are recorded; each record's TTL bounds how long it stays readable.

ADR-0029 refused "a tokenless development mode" as one mis-set variable from an open tracer in
production. That argument was about a mode keyed on `NODE_ENV` or `CURRENTS_MODE` opening tracing
**as a side effect** of something else. Here there is exactly one variable, it means tracing, and
it is off by default.

## What it gives up, stated

- **Readers' searches are recorded, and readable by anyone, while tracing is on.** ADR-0029's
  schema-as-redaction-boundary held that a trace names stations, never content, and its sharpest
  argument was that "a hash of a two-word query is the query to anyone with a dictionary". Now the
  query itself is on the record, and the list that finds it needs nothing to read. That is the
  point of the change and its cost, and it is larger than ten rows: the list names the newest ten,
  so anyone who polls it collects EVERY traced request's keywords and storylines for the session,
  and each record stays readable by its id until its TTL — `REQUEST_TRACE_TTL_SECONDS`, up to a day,
  and readable again if tracing is turned back on inside it. The trace id, which ADR-0029 called
  the read capability, is no capability any more: the list hands the newest out. **Keep sessions
  short, and the TTL at its default.**
- **ADR-0029 refused sampling reader traffic** because it would turn the trace "from an operator's
  instrument into a record of reader behaviour". It is now exactly that, bounded by the flag, the
  TTL, the ten-row list and the per-instance budget.
- **The boundary moved, and did not vanish.** Everything ADR-0029's enums keep off a TOUCH and a
  JOB RUN is still kept off them: no Redis key or fingerprint, no job id, no URL, no SQL value, no
  header, no error message. The subject is the one field holding free text, it is on the request
  record alone, and it is bounded. `trace-http.test.ts` runs a real search for `quokka zebra`,
  finds the words in `subject` and — with `subject` removed — none of the query, the fingerprint,
  the key prefixes, the address, a URL or a job-id prefix anywhere in the stored trace or its job
  run.
- **Trending loses its edge cache while tracing is on.** A traced reply is `no-store`, so no CDN
  hands one caller's trace id to the next, and now every trending request within the budget is
  traced. The alternative — letting a cached traced reply carry its id — would make the
  `x-zammy-trace-id` a CDN copy carries name someone else's trace.
- **It costs more.** Four Redis commands per traced request (was one), and an open playback page
  re-reads the list every 20 s at three commands a read (the limiter's, `LRANGE`, `MGET`) — about
  540 an hour. The list route's bucket is 10 a minute per address, tighter than the read route's
  30, because anyone can call it; one address polling both routes flat out still spends about 120
  commands a minute, which a long session on a free tier would feel.
- **Readers can wait on a Redis that is down.** A traced reply is held until its record is written,
  and a record write waits up to 1.5 s for a client still connecting (ADR-0029's cold-instance
  ready-wait). That used to be paid by an operator's own requests; now it is paid by readers. So a
  ready-wait that runs out is not repeated for a minute (`TRACE_READY_BACKOFF_MS`): an instance
  whose Redis stays down pays it once a minute and answers the rest `unstored` at once.
- **An untraced request is now the exception**: one past the bounds, or HEAD. The command-stream
  test that proves an untraced request is unchanged now drives HEAD through the same handler.

## Considered and refused

**Keep the header, drop only the token.** A header anyone can send is not an opt-in, and it would
leave the list holding only the requests an operator made with curl — the ones they already know
the subject of.

**Thread the label through the storyline open** (`StorylineRefreshOutcome` gaining a `label`, the
202 body gaining one). The planner reads the storyline row already, so the label is free to the
planner and not to the reply; changing six outcome shapes and a response body so a diagnostic can
name an arc by label was more than naming it by id, which is what the open's own request carries.

**A list keyed by a sorted set, or listing from `SCAN`.** `SCAN` over `<queue>:trace:*` is a
table walk per poll. A sorted set by start time buys ordering an `LPUSH` already has, since
records are pushed as they are stored.

**Keep the examples on the page beside the list.** They made the page whole with tracing off,
which now matters less than it did: the page's job is to find a served request, and with tracing
off there is none to find. The page says so instead.
