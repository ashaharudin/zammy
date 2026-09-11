# How deep is a reader's rail while ingest is in progress?

The measurement issue #211 asked for and PR #212 deliberately did not do.

Measured 2026-09-11 against production (`zammy-alpha.vercel.app` / `zammy.info`,
deployment `dpl_GyUoZPTJUtuVZ4zLLMomjop8tCwU`, which is `main` at
[#210](https://github.com/ashaharudin/zammy/pull/210) — so the fan-out was live
and unmitigated while these logs were written). Read-only throughout: `vercel
logs` and `vercel env ls`, nothing else. No deploy, no setting changed, no
database reached, no labelling quota spent.

---

## 1. The question

**While `meta.ingest.state === "in_progress"`, how many pages does a reader's
timeline rail hold — and therefore how many `/api/v1/timeline` requests does one
poll tick cost?**

#211's words: "instrument how many pages a rail actually holds when ingest is in
progress, in the wild."

The decision it feeds is #211's option 3 — replace the poll with a **wait hint**
in the response (`VERCEL-ALL-IN-SCOPE.md:676`) or with **SSE**, which
ARCHITECTURE §6.5 calls "a contained upgrade" since `meta.ingest` does not
change. Option 3 is the only remaining mitigation; #212 took option 2 (poll page
one, splice it into the infinite query's cache) and explicitly left option 3
open. Whether it is worth building turns on how big the per-poll cost actually
is on Vercel, where every page is an invocation plus a Postgres round trip
through the pooler plus a Redis one.

#211 gave an upper bound from the constants — 40 ticks × 4 pages = 160 requests
a minute — and said plainly it had not been measured.

---

## 2. What I could actually observe

### 2.1 The deployment logs the cursor, so page one is distinguishable

This was the open question, and the answer is **yes, in full**, from a source
nobody wrote for this purpose.

`apps/api/src/observations.ts`'s `TIMELINE_READ_MESSAGE` line — the ADR-0015
replacement for `/metrics` — does **not** help:

```
apps/api/src/timeline-read.ts:188
  { fingerprint, tier, cache, servedFrom, seconds }
```

No cursor, no page index, no `ingest.state`. On its own it cannot tell page one
from page four.

But Fastify's own request logger is on (`buildApp`, `server.ts:386`) and it
writes the **whole URL**, query string included:

```json
{"level":30,"time":1789152784906,"reqId":"req-2t",
 "req":{"method":"GET",
        "url":"/api/v1/timeline?q=climate&language=en&cursor=MjAyNi0wOC0yNlQxMzo1Nzo0Ny4wMDBafGI0YTZiZTliLWY5YmMtNDFmNi04NTg4LTcyOWVjNTAzZTFiZA",
        "host":"www.zammy.info","remoteAddress":"206.47.118.34"},
 "msg":"incoming request"}
```

`cursor` absent ⇒ page one. `cursor` present ⇒ a tail page. `remoteAddress`
separates readers; `time` is millisecond-resolution. That is everything the
measurement needs, and it has been there all along.

### 2.2 Commands run

```
vercel ls --prod                        # find the live deployment
vercel inspect zammy-ql5g88hdj-…        # confirm the aliases
vercel logs --json --since <ISO> --until <ISO> -n 2000
vercel env ls production                # names only; every value is Sensitive
```

Two traps in `vercel logs` (CLI 59.5.0) that a future run must not fall into:

- **Rows come back duplicated.** A `-n 2000` pull returned 2000 lines that
  deduped to **50** distinct `id`s — each row repeated 40×. An analysis that
  does not dedupe on the outer `id` reports a rail 40 times deeper than it is.
  (My first pass said "2000 timeline requests in 33 seconds". It was 50.)
- **`-n` caps *distinct* rows, so a busy slice silently truncates.** The
  18:46:30–18:47:00 slice hit the cap and dropped the first half of an ingest
  episode; the coarse pull showed a rail appearing at 6 pages out of nowhere
  after a 53-second gap. Re-pulling that window in 2-second slices recovered the
  missing rows and showed the rail growing 1 → 3 → 5 → 7. **The truncation
  biases depth downward and hides the growth**, which is the interesting part.

Both files and the analysis scripts are in the session scratchpad, not the repo.

### 2.3 Retention: one hour, rolling — confirmed by watching the floor move

`VERCEL-ALL-IN-SCOPE.md:738` prices Hobby runtime logs at 1 hour, and §5 of the
Phase-5 log says a measured pull once "returned no lines at all". Both are
consistent with what I saw, and the documented figure is the right one.

| probed at (UTC) | window asked for | result |
|---|---|---|
| 19:27 | 17:27 → 18:27 | 0 rows |
| 19:27 | 18:27 → 19:27 | rows present |
| 19:33 | 18:38 → 18:40 | rows present (oldest 18:38:42) |
| 19:40 | 18:30 → 18:40 | **0 rows** |
| 19:40 | 18:40 → 18:45 | rows present (oldest 18:44:22) |

The floor advanced from 18:38 to past 18:40 between 19:33 and 19:40. That is a
**rolling one-hour window**, not a per-deployment buffer.

The consequence is the important part: **this measurement is not repeatable
retroactively.** There is no archive. It worked only because two ingest episodes
happened to fall inside the hour I looked at. Ask this question tomorrow about
today and there is nothing to ask it of.

### 2.4 Traffic reality — thin, and that bounds everything below

Everything in the retained hour, deduped:

```
distinct log rows (all paths): 251
retained span: 18:38:42 .. 19:30:00 UTC
by path: /api/v1/timeline 198 | /api/queues/ingest 43 | /api/drain 6
         /api/v1/reference 2  | /api/v1/trending 2

/api/v1/timeline: 198 requests, all HTTP 200
  client IPs : [('206.47.118.34', 198)]     <- one
  hosts      : [('www.zammy.info', 198)]
  topics     : climate 190, houthi 4, malaysia 4
  page one (no cursor): 52 | with cursor: 146
  span       : 18:44:33 .. 18:53:04  (8.5 minutes)
```

**One client IP. One browsing session. Three topics. 8.5 minutes of reading
inside a 52-minute window, and silence either side of it.** Two of those topics
(`houthi`, `malaysia`) never got past page one. All the depth is `climate`.

I cannot tell from the logs whether that client was a reader or a developer
exercising the page, and I did not try to identify it further.

---

## 3. The answer, and the size of n

### 3.1 The number

**Two poll episodes. The rail reached 7–8 pages in the first and 4–7 in the
second. Per-tick fan-out multiplier 5.9× and 3.3×.**

Reading each page-one request together with the cursored chain that follows it
within 1.5s (a fan-out leg lands 0.16–0.25s after the last, so the chains are
unambiguous):

```
episode q='climate'  18:46:15..18:47:01 UTC  45.9s
  ticks           : 17
  depths          : [3, 3, 5, 4, 6, 5, 7, 6, 6, 6, 6, 8, 7, 7, 7, 7, 7]
  max 8   median 6
  requests total  : 100   (131/min sustained)
  if page-one only: 17    -> fan-out multiplier 5.9x
  tick period     : min 1.97s  median 2.69s  max 3.90s

episode q='climate'  18:51:56..18:52:55 UTC  59.0s
  ticks           : 23
  depths          : [1, 1, 1, 1, 1, 1, 1, 4, 3, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 5, 5, 7]
  max 7   median 4
  requests total  : 75    (76/min sustained)
  if page-one only: 23    -> fan-out multiplier 3.3x
  tick period     : min 1.68s  median 2.32s  max 5.38s
```

One tick, in raw form (the full trace, with cursors elided to their first 16
characters):

```
18:46:56.324  +1.67s  page one    q='climate'
18:46:56.486  +0.16s  cursor=MjAyNi0wOS0wOVQw
18:46:56.649  +0.16s  cursor=MjAyNi0wOS0wMlQy
18:46:56.820  +0.17s  cursor=MjAyNi0wOC0yOFQy
18:46:56.980  +0.16s  cursor=MjAyNi0wOC0yNFQx
18:46:57.140  +0.16s  cursor=MjAyNi0wOC0xOFQx
18:46:57.304  +0.16s  cursor=MjAyNi0wOC0xM1Qx
18:47:00.221  +2.92s  page one    q='climate'      <- next tick, same six cursors
18:47:00.452  +0.23s  cursor=MjAyNi0wOS0wOVQw
...
```

Sequential, same cursor set every tick, repeating on a metronome. That is the
fan-out #211 read off the code, in production, exactly as described.

**#211's upper bound was right to within a factor of one.** It reasoned 160
requests a minute at 4 pages; observed 131/min at a median of 6.

### 3.2 The rail is short when polling starts, and grows *during* the ingest

This is the part I did not expect to see so cleanly, and it is the direct
confirmation of #211's argument about #210.

Episode B opens with **seven consecutive single-page ticks** and then jumps to
4, 3, 5, 4 and settles. Episode A's recovered rows show 1 → 1 → 1 → 3 → 3 → 5 →
4 → 6 → 5 → 7. The reader does not arrive with a deep rail; the rail deepens
under the poll, because `LoadOlder`'s `IntersectionObserver` (`rootMargin:
"400px"`) sits inside the root margin of a short first paint, fires, and fires
again as each new page brings the sentinel back into view. §8.2's "often 6–15
cards" first paint is precisely the condition that triggers it.

So paging during ingest is the common path, not the rare one — measured, not
inferred.

### 3.3 The fan-out slows the poll down, which is its own small harm

`refetchInterval` is re-evaluated on every query state change, so the 1.5s timer
effectively restarts when a fetch settles. The observed tick period is therefore
**1.5s + the fan-out's own duration**: median 2.32s at depth 4, 2.69s at depth
6–7, against the 1.5s §8.2 specifies.

The deeper the reader scrolls, the slower progressive fill delivers. Nobody is
harmed much by it, but it is the opposite of what the mechanism is for, and it
partially self-limits the cost — which is why 131/min rather than the 160/min
the constants predict.

### 3.4 Be honest about n

**n = 2 episodes, 1 client, 1 topic, 1 hour.** That is not a distribution and
nothing here should be quoted as one. What it is:

- an **existence proof at scale** — the fan-out reaches 7–8 pages in production,
  not the 2–3 someone might have hoped;
- a **confirmation of #211's arithmetic** to within a factor of one;
- a **confirmation of the #210 mechanism** — short first paint, sentinel inside
  the root margin, rail deepening under the poll.

What it is **not**: a median, a p95, or a claim about a different reader, a
different topic, a different screen height (the root margin's effect depends on
viewport), or a slower network (a fan-out that takes longer stretches the tick
further and lowers the sustained rate).

Both episodes are the same reader on the same topic minutes apart, so they are
barely independent.

### 3.5 An anomaly this surfaced and did not resolve

`RATE_LIMIT_PER_MINUTE` is **not set in production** (`vercel env ls production`
lists 21 variables and it is not among them), so it takes its default of **60**
(`packages/config/src/index.ts:368`). The limit is per-IP, Redis-held, and
applies to all of `/api/*` (`server.ts:435`).

Episode A sustained **131 requests a minute from one IP** and **every one of the
198 timeline requests returned 200**. No 429s at all.

`skipOnError: true` and the cold-instance Upstash handshake failure the
`server.ts` comment already documents ("SEVEN of them came back
`x-ratelimit-remaining: 60` — a number `INCR` cannot produce") is the obvious
candidate, but I did not verify it and it is outside this measurement. Flagging
it because it means **the per-IP ceiling is not doing what it is written to do
for at least this shape of traffic**, and a single reader's ingest poll is
enough to expose that — which is worth its own issue.

---

## 4. What this means for option 3

**Option 3 is not worth building on this evidence. #212 is enough.**

The arithmetic, using the measured depths:

| | requests per cold-topic read | Vercel invocations |
|---|---|---|
| before #212 (measured) | **75–100** over ~46–60s | 75–100 |
| after #212 (one page per tick) | 17–23 | 17–23 |
| option 3 (wait hint / SSE) | ~1–2 | ~1–2 |

#212 removes **69% of episode B's cost and 83% of episode A's**, and it is
already written and reviewed. The remaining ~20 invocations per cold-topic read
is the part option 3 would buy back, and on Hobby's 1M included invocations, at
this traffic level, ~20 invocations per cold read is not a number worth a
protocol change for. The entire retained hour of production contained **198
timeline requests**; after #212 the same hour would have been roughly 60–70 (52
ticks at one request each, plus the reader's own paging).

Two things would change that answer, and neither is true today:

- **Many concurrent readers.** The cost is per reader per cold topic. At one
  reader it is noise; the break-even is somewhere in the hundreds of concurrent
  cold reads, which this deployment is nowhere near and is not licensed for
  (Hobby is personal, non-commercial — §7).
- **The poll window getting longer or the interval shorter.** Both are constants
  in `ingestPoll.ts` and neither is under pressure.

There is a residual UX argument for option 3 that this measurement weakens
rather than strengthens: the reason the poll felt costly was partly §3.3's
period stretching, and that is a *symptom of the fan-out*, which #212 removes.
After #212 the tick period returns to ~1.5s + one request, which is what §8.2
asked for in the first place.

**Recommendation: merge #212, close #211 with this measurement, and leave option
3 unbuilt.** If it is ever revisited, revisit it for the reason ARCHITECTURE
§6.5 names — that `meta.ingest` does not change, so SSE is a contained upgrade —
and not for cost.

---

## 5. Instrumentation, if this has to be answered again

The answer to §3 was "data, with a small n", so the instrumentation design is
not the deliverable. But the retention finding (§2.3) means **this measurement
cannot be reproduced after the fact**, so it is worth saying what a durable
version would cost — and why I recommend against building one.

### 5.1 Nothing needs to be added to the client, and that is the cheapest finding here

The obvious design — the client knows its page count, so have it report one —
runs straight into the obstacle #211 hints at. `apps/web/src/upstreamHealth.ts`
is the existing pattern for "a fact worth knowing, shaped so a web-logging
transport could ship it", and its call site says the quiet part:

> `apps/web/src/CommandBar.tsx:239` — "console is the transport until the app has
> a real one; the record is already the shape a transport would ship, so adopting
> one is a change of sink, not of caller."

**There is no such transport.** Adding one means an ingest endpoint, a schema, a
rate limit on it, a retention story, and a privacy posture for client-reported
data — all to answer a question the server-side request log already answers for
free. That is the wrong trade by a wide margin.

The same objection sinks the cheaper client variants (a `pages=N` query param on
the poll request, an `X-Zammy-Rail-Pages` header): they are small on the wire —
6–10 bytes — but they put a field on the public API surface whose only consumer
is a measurement, and they still land in a log with one-hour retention.

### 5.2 What is actually missing is retention, not signal

If the question must be answerable later, the minimum viable change is to get
the request log somewhere durable. In rough order of contained-ness:

1. **Re-run this analysis live** (what I did): open the app, read a cold topic,
   and pull `vercel logs` within the hour. Cost: zero code. Limitation:
   measures whoever you can arrange to measure, which is how n ended up at 2.
2. **A Vercel log drain** to any sink. Cost: a Pro plan (drains are not on
   Hobby) or a third-party integration, plus a place to put the logs.
   `VERCEL-ALL-IN-SCOPE.md:738` already names this as the fix for the same
   problem in the chores context ("without shipping logs somewhere").
3. **A server-side counter in the `chore_runs` record** — the one durable
   surface ADR-0015 kept. The server cannot count a rail's pages (a poll request
   carries no cursor and no session), but it *can* count requests-per-topic
   per-IP per-minute in Redis and roll the daily max into the nightly chore
   record. One `INCR`+`EXPIRE` on the read path, a `ZADD` of the day's peak, and
   a field in the chore digest. That is a few dozen lines and it answers a
   blunter question — "what is the worst fan-out any reader caused today?" —
   without touching the client or the wire.

Only (3) is new code, and only (3) survives a week.

### 5.3 Weighed against not measuring

**Not measuring is the right call, once #212 is merged.** After #212 the quantity
this instrument would watch — pages per poll tick — is pinned at 1 by
construction, and #212's own tests pin the two TanStack premises that could
regress it. A meter on a number a test already holds at 1 is a meter for a
regression that would fail CI first.

If #212 is *not* merged, option (3) above is worth its few dozen lines, because
then the number is live and unbounded and nothing else watches it.

---

## 6. What I did not or could not check

- **`meta.ingest.state` is never in the logs.** The `TIMELINE_READ_MESSAGE` line
  carries `fingerprint / tier / cache / servedFrom / seconds` and no ingest
  state. Everything above infers "ingest was in progress" from the **1.5s-plus-
  fan-out metronome**, which nothing else in the client produces
  (`refetchOnWindowFocus` is off; pull-to-refresh is a single manual event). The
  inference is strong — the episodes also stop at 45.9s and 59.0s, both inside
  `INGEST_POLL_WINDOW_MS`'s 60s — but it is an inference, not a read of the
  field.
- **Nothing older than one hour.** No history, and none recoverable. Everything
  here comes from a single 52-minute retained window on 2026-09-11.
- **One client.** I did not attempt to determine who 206.47.118.34 is, whether
  it was a reader or a developer exercising the page, or whether the browsing
  was organic. If it was a developer driving the app, the depths are still real
  but the *frequency* of such episodes in genuine use is entirely unmeasured.
- **Viewport is unmeasured and it matters.** `LoadOlder`'s 400px root margin
  interacts with screen height and card density; a taller window fires the
  sentinel more often and should reach a deeper rail. Nothing in the logs
  records it, and I did not add anything that would.
- **The rate-limit anomaly (§3.5) is unexplained.** I did not reproduce it, did
  not inspect Redis, and did not check `x-ratelimit-remaining` on a live
  response, because that would have meant issuing production reads — which
  trigger refresh-on-read, enqueue ingest and spend Currents quota. Read-only
  against the logs was the whole brief.
- **No production database access**, by design: every production env var is
  marked Sensitive, so `sightings` / `topics` could not be consulted to
  corroborate that an ingest was genuinely running during either episode. The
  corroboration I do have is indirect: `per-topic daily call cap reached;
  topic stops deepening until tomorrow` warnings on `fingerprint
  ae74e872…c35` are interleaved with the same requests, so refresh-on-read was
  firing on that topic throughout.
- **I did not test #212's branch against production.** It is unmerged and under
  review elsewhere; the "after #212" row in §4 is arithmetic on the measured tick
  counts, not an observation.
