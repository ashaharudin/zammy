---
status: accepted
---

# A traced request records what it touched, never what it asked

An operator who wanted to watch one request be served had nothing to watch. Fastify writes a
request line with a duration, the planners write their observation lines (`observations.ts`),
Vercel keeps an hour of either per function, and nothing joins a search to the jobs it queued —
which run seconds later in another function, five minutes later on a redelivery, or a quarter
of an hour later from the drain. Which cache answered, whether the single-flight lock was won,
whether the Currents call went out, what the background jobs then did: all of it was inferable
from the code and none of it was observable for a given request.

This ADR adds request tracing to the API and a page that plays a trace back as a 16-bit
warehouse: a robot carries the request past a turnstile, a rack of Redis bins, a Postgres vault
and a Currents mast, and drops its jobs through a hatch onto a belt, where worker robots pick
them up and carry them out to the machines they need. **A request is traced only when it
presents a token, and only while tracing is switched on; a trace names the stations it touched
and the class of what happened at each, never the data it touched them with; and seven built-in
examples mean the page is never empty — with tracing off, which is the default, they are the
whole of it.**

## The words

The vocabulary is in [CONTEXT.md](../../CONTEXT.md) ("Operations") and at the head of
`packages/shared/src/request-trace.ts`, and the code uses it exactly:

- **Trace** — one opted-in API request, recorded as the ordered touches it made and joined by
  the job runs of the jobs it enqueued.
- **Touch** — one call from our code to one station: when it started, how long it took, an
  outcome class, and never its arguments. The rate-limit touch is inferred, not observed.
- **Station** — a dependency a touch can reach: the CDN edge, the rate limiter, Redis,
  Postgres, the queue, Currents, Google News, Gemini. The page draws each as a machine.
- **Job run** — one attempt at a job a trace enqueued, by whichever consumer ran it: a Vercel
  Queues delivery, a BullMQ attempt, or the drain.
- **Playback** — the page, `/?trace`.

_Avoid_ **span**: Coverage owns it, and a coverage span is a stretch of time a provider walked,
not a call. _Avoid_ **replay**: `storyline-replay.ts` owns it, for the linker re-run in memory
to measure a threshold. _Avoid_ **segment** for a stretch of a trace: Segment is the rail's
part of the reader's day, and `segment` is already a job kind a trace records. The web code has
one word of its own, **stop** — consecutive touches drawn as one stay — and it never leaves
`apps/web/src/playback/`.

## The change

1. **A flag and a token.** `REQUEST_TRACE_ENABLED` is an enum defaulting to `false`, so `ture`
   refuses to boot. `REQUEST_TRACE_TOKEN` is required whenever the flag is on, in every
   environment, at least 24 characters and without whitespace; `redactConfig` masks it, and the
   logger's redact list gains `req.headers["x-zammy-trace"]` beside `authorization`.
   `REQUEST_TRACE_TTL_SECONDS` (1800–86400, default 3600) is how long everything a trace writes
   lives; `REQUEST_TRACE_MAX_TOUCHES` (32–400, default 240) bounds one record. **Off means
   absent**: `Services.tracing` is only built when the flag is on, and without it no hook,
   request decorator, route or consumer-side lookup is registered. A deployment that never
   turns tracing on runs the code it ran before this ADR.
2. **The opt-in is a header on five routes.** `x-zammy-trace: Bearer <REQUEST_TRACE_TOKEN>`,
   checked with the cron routes' `isAuthorized`, on `GET /api/v1/timeline` (a search or a
   storyline view), `GET /api/v1/storylines`, `POST /api/v1/storylines/:id/refresh`,
   `GET /api/v1/trending` and `GET /api/v1/reference`. HEAD, OPTIONS, `/topics`, the health
   checks and the trace route itself are never traced. A missing or wrong token is simply not
   traced — no error, no response header, one debug line. Past the token, each instance opens
   at most 30 traces per fixed minute and holds at most 8 open at once; beyond either the
   request is served untraced, again without a signal.
3. **A traced request gets a traced copy of its dependencies.** Each traceable handler's first
   act is `scopedDeps(request, boot)`, which returns the boot bag itself, by identity, for an
   untraced request, and for a traced one a copy in which `db`, `redis`, `currents`,
   `deepening`, `queue`, `labeler` and `summarizer` record: `db.withPlugin(TouchPlugin)`, an
   ioredis `Proxy` that traps `sendCommand` and nothing else, and interface-level proxies over
   the news clients, the queue and both text generators. Every other key of every bag passes
   through by identity, and a test that builds real `Services` fails on a key that is in
   neither list (`TRACED_KEYS`, `PASS_THROUGH_KEYS`) — a dependency added later is a red test
   until someone decides whether it reaches a station.
4. **A touch is a station, two numbers and a closed vocabulary.** A Redis touch is a command
   (`GET`, `MGET`, `SET`, `DEL`, `INCR`, `EXPIRE`, `EVAL`, `ZCARD`, `other`) and a key CLASS
   (`page_cache`, `fill_lock`, `topic_budget`, … ten in all) with an outcome read off the
   reply's shape — `hit`/`miss`, `acquired`/`held`, `released`/`lost`, `not_ready`. A Postgres
   touch is an operation and at most six table names. An upstream touch is a call and its
   priority — for Gemini, its purpose, `label` or `summary` — and, when it failed, a failure
   kind (a `NewsError` kind, or the model's `answered`/`unreachable`). A queue touch is a job
   kind, a plane, a local ref (`"1"`, `"2"`, … `"99"`, and `"2.1"` for a child a run of job 2
   enqueued) and whether its link landed. The rate-limit touch is **inferred** from the gap
   between `onRequest` and `preParsing` and the `x-ratelimit-*` headers, because the limiter
   holds the boot client and no proxy of ours sees its EVALSHA: a 429 is `limited`,
   `remaining === limit` is `fail_open` (read through `isFailOpen`, the reading
   `rate-limit-fail-open.ts` already logs from), and anything else is `counted`. Each
   station's outcomes are one closed enum in the shared contract (`RedisOutcome`,
   `PostgresOutcome`, `UpstreamOutcome`, `QueueOutcome`, `RateLimitOutcome`, `EdgeOutcome`),
   and the server's outcome readers (`redisOutcomeOf`, `rateLimitOutcome`) return those types,
   not local copies of them, so the schema and a reader cannot drift apart unseen. The
   recorder keeps the first 60% of its cap in full and a ring of the newest; what the ring
   evicts is counted into one elision — how many, of which stations, over what span — because
   a cold search makes 300+ Postgres statements and the parts worth drawing are its opening and
   its epilogue.
5. **The record is sealed, parsed and stored before the response leaves.** In `onSend` the
   recorder seals — a touch that never ended reads `{ ms: null, outcome: "open" }`, and nothing
   begun afterwards is kept — the draft goes through `RequestTrace.safeParse`, and the PARSE
   OUTPUT is written with `SET <queue>:trace:<id> … PX <ttl>` on the boot client. That client
   has `enableOfflineQueue: false`, so a write issued mid-handshake would be refused on the
   spot and every cold instance's first trace lost: when it is not ready the write waits up to
   1.5 s for it (`waitForRedis`), skipping the wait for a client already `end`ed, then gets
   300 ms. The trace's `ms` is taken at seal, before that wait. The reply gains
   `x-zammy-trace-id: <id>` — or `unstored` when the write failed — and
   `cache-control: no-store`, which overrides trending's `s-maxage` so no CDN hands a traced
   answer and its id to the next caller. **The body is byte-identical to an untraced one**;
   `PAGE_SHAPE_VERSION` did not move. A trace that fails its schema or its write is warned
   about under `TRACE_UNSTORED_MESSAGE`, at most once a minute per process, with a count of the
   ones folded into it and nothing but a reason and issue paths as fields.
6. **A job is linked to its trace beside the job, by the job's own id.** Before a traced
   enqueue publishes, it writes the member `<traceId>|<ref>` into the set
   `<queue>:trace:job:<jobId>`, with the same TTL, under a 250 ms deadline and with no
   ready-wait; the time is counted into the trace's `overheadMs`. The job object handed on is
   the caller's, untouched, and a link that fails is recorded `linked: false` while the publish
   goes ahead. Every consumer reaches its processor through `ingestDispatch(services, source?)`
   — the in-process BullMQ worker, the push-mode Vercel function and the drain, which passes
   `"drain"` since it runs under the Vercel driver and is not a delivery. With tracing on, that
   dispatch looks the job's links up (`traceRuns`, one `SMEMBERS`); with none it runs the plain
   handler over the boot bundles by identity; with some it runs the same processor over a
   traced copy, appends a job run to every linked trace (`RPUSH <queue>:trace:<id>:runs`,
   keeping the first sixteen), rethrows whatever the processor threw unchanged, and removes the
   links only after an ok run. A child the run enqueues is linked in turn, as `<parent>.<n>`,
   four levels deep at most. A run that fails its schema or its append is warned about under
   `TRACE_UNSTORED_MESSAGE` like a record; one past the sixteenth is not. The store answers
   each append `stored`, `capped` or `failed` (`appendRun`), and `capped` — Redis took the run
   and the trim dropped it — is the designed limit listed under *What is deliberately not
   seen*: a warning blaming Redis for it would send an operator to debug a Redis that is fine.
7. **The read route is its own bucket and needs no token.** `GET /api/v1/traces/:id` exists
   only while tracing is on — otherwise it is Fastify's own 404. It has a route-level rate
   limit of 30 a minute, which gives the limiter a child key
   (`ratelimit:GET/api/v1/traces/:id-<ip>`) so a page polling a trace never spends the
   allowance a reader's search needs. **It is GET only** (`exposeHeadRoute: false`): Fastify
   would otherwise clone a HEAD with the same route config, and since the limiter keys a
   route's bucket by method and URL, that HEAD would be a second 30 a minute over the same
   trace-store reads. The page never sends one, so HEAD is Fastify's 404 and reads nothing.
   The id is 122 random bits and is the capability for one TTL, over a record that holds enums
   and numbers. A malformed id is a 400 before any trace-store command (the limiter's own
   EVALSHA has run); an unknown, expired or unparseable one — a future `v` included — is a 404;
   a Redis error is a 503, never a 404 that would tell the page the trace does not exist; a
   found one is a 200 `TraceReadResponse` whose `expiresAt` is `startedAt` plus the TTL,
   computed rather than read with a PTTL. **Every answer is `no-store`**, the errors and the
   limiter's 429 included, since a trace still gathering runs must never be answered from a
   cache. The header is set in the route's own `onSend`, not its handler, because the 429 is
   answered from the limiter's `onRequest` and never reaches the handler; `onSend` sees the
   handler's replies, the error handler's and the limiter's alike.
8. **The playback view.** `/?trace` plays the default example, `/?trace=<slug>` a named one,
   and `/?trace#t=<uuid>` a recorded trace, polled while its job runs land. It is a lazy chunk,
   and none of the trace schemas reach the reader's main chunk. The seven examples — a cache
   hit, a cold search with its four jobs (one of them failing and redelivered), a storyline
   open fanning out to all three planes, a 429, a search refused for quota, a cold instance
   inside the Redis handshake, and a CDN hit that ran no function — are `TraceReadResponse`
   JSON parsed with the shared schema, and are pinned to the code (see *Consequences*). A panel
   records a real request from the page with the operator's token. *The page*, below, has the
   rest.

## Why a copy of the deps, and not AsyncLocalStorage

The house style is explicit construction — `wiring.ts` builds every planner's dependencies and
`buildServices` hands them over — and nothing in the repo uses ambient context. That alone is a
reason to need a reason, and AsyncLocalStorage has none that holds up here:

- **It loses the context in exactly the places this page is about.** The in-process BullMQ
  worker boots with its own context; the Vercel consumer is another process; ioredis flushes
  its offline queue from the connect handler, outside any request. A job run, which is half of
  what the page draws, would be untraceable by construction.
- **Postgres would still need a Kysely hook**, because ALS tells you whose statement it is but
  not what the statement was. The plugin is needed either way, and once a per-request plugin
  exists the rest of the bag follows the same shape.
- **What it would add is sight of the callers held at boot**: the rate limiter's EVALSHA, the
  quota governors' EVALs and the pending ledger's ZADD inside an enqueue. The first is inferred
  from hooks and headers. The other two happen INSIDE an upstream touch and a queue touch
  respectively, which is where the page draws them, and the page says so in its notes rather
  than pretending to a precision it does not have. A transport observer that would make the
  quota and retry steps visible without ambient context is deferred, not refused.

The copy has costs of its own, stated: every traceable handler calls `scopedDeps` once, and a
dependency reached around the bag — a module-level client, a closure over the boot `redis` — is
invisible to the trace. The exhaustiveness test keeps the bag itself honest, and nothing on the
traced routes reaches a station around it today except the boot-held callers listed under *What
is deliberately not seen*.

**The wrappers observe; they never intervene.** Each calls the real member with the same
arguments and receiver, returns what it returned and rethrows the same error instance; the
recorder calls around it are each in their own `try`, and the inner call never is. The Redis
trap attaches its own `then` to `command.promise` and returns the real return value — never a
chained promise, which would add ticks, change identity, and put the tracer between a command
and its caller. `TouchPlugin.transformQuery` always returns the node it was given. The traced
db shares the boot pool and must never be destroyed.

## Why the trace is enums

**The schema is the redaction boundary, and the server stores what the schema lets through.**
Every string a trace can hold is an enum member or matches a pattern (`TraceId`, `JobRef`), its
objects are not `.strict()`, so zod strips a key it does not declare, and `onSend` and the run
append both persist `safeParse(draft).data` — never the draft. A classifier with a bug can
therefore mislabel a touch, and cannot leak a key; that is the order of failure this feature is
willing to have. `trace-http.test.ts` injects a field the recorder should not have kept and
checks it is not stored, since in normal operation the draft and the parse output are equal and
a regression to storing the draft would otherwise be invisible.

What the enums keep out is not hypothetical, because almost every raw value on these paths
carries the reader's search:

- **Redis keys carry fingerprints** — `page:v<shape>:<fingerprint>:…`,
  `lock:refresh:<fingerprint>:…`, `budget:topic:<fingerprint>:…` — and a fingerprint is a
  SHA-256 of the canonical search. A hash of a two-word query is the query to anyone with a
  dictionary. So a key is classified by PREFIX, first match wins, inside `classifyRedisKey`,
  and never leaves it; an unrecognised prefix is `other`, which misdraws a bin and leaks
  nothing.
- **Job ids embed the fingerprint** (`seg_<plane>_<fp>_…`, `topup_<plane>_<fp>_…`) or a
  storyline id, which is why a job is named in a trace by a local ref instead.
- **Upstream errors carry URLs**, and the Currents URL carries the keywords.
  `upstreamFailureOf` reads a `NewsError`'s `kind` and nothing else; anything it does not
  recognise is `unknown`.
- **SQL parameters are values.** `pgTablesOf` collects `TableNode` names and runs a
  `from|join|into|update` pattern over a raw node's SQL FRAGMENTS — the template's literal
  text, which is code — and walks a raw node's parameters only where they are themselves
  fragments of code (a nested `sql` template, a `sql.join`); without that, tables named only
  inside a nested fragment, like `storyline-timeline.ts`'s `join topic_articles`, were lost. It
  never enters a `ValueNode`, `ValueListNode` or `PrimitiveValueListNode`, so a parameter whose
  value is `"from storyline_days"` adds nothing. Every name then goes through
  `TRACEABLE_TABLES`, which `satisfies Record<keyof Database, true>` at compile time and equals
  `PgTable` by test, and that is what drops CTE aliases. The walk stops after 400 nodes,
  because it runs synchronously on the request path.
- **The request itself** is recorded as its route enum, its method, the NAMES of the query
  parameters present (never a value), how many storylines a view named, its status, its
  response `meta` less `asOf`, and — for a storyline open — what each plane's gate decided. Not
  the path, not the IP, not a header.

The redaction test runs a real search for `quokka zebra`, runs one of the jobs it enqueued the
way a consumer would, and searches the stored trace and run for the words, the fingerprint hex,
the prefixes of the keys that search and its job build (`page:v`, `lock:refresh`,
`budget:topic`, `ingest:pending`) and the limiter's (`ratelimit`), `127.0.0.1`, `://`, `?q=`,
the token and the job-id prefixes; it finds none. It is not a search for every prefix
`classifyRedisKey` knows: `ref:`, the trending cache and sample lock, and the summarize lock
belong to other routes and jobs, and what keeps them out of a record is the schema — every
string an enum member or a patterned id — rather than this test. A second test checks that a
traced search's cached page holds no trace id.

## Why the job is linked by its id

A job runs where the request is not: seconds later in the consumer function, +305 s later on a
redelivery, 15–25 minutes later from the drain. Something has to carry "this job is owed to
trace T" across that gap, and the two places it could have ridden were both wrong.

- **Not on the payload.** `parseIngestJob` whitelists fields, so a `traceId` on the job would
  be stripped under Vercel Queues and passed through under BullMQ — the same trace would follow
  its job under one driver and lose it under the other. And the drain never sees a payload at
  all: it rebuilds each job from its pending-set id alone (`parseIngestJobId`), so nothing but
  the id survives to it.
- **Not in the id.** `ingestJobId` is the Vercel `idempotencyKey` (a 900 s dedup window), the
  BullMQ `jobId` and the pending-set member. A trace id in it would make every traced enqueue a
  unique job, defeating the dedup the id exists for — the trace would change the behaviour it
  was there to observe.

So the link sits **beside** the job, in a set keyed by the id every consumer already has, and
the rest follows from that:

- **Written before the publish**, because both the in-process worker and a Vercel push can
  start the job before the request that enqueued it has answered; a link written after would
  miss the run it exists for.
- **Deduplication falls out.** Two traces that enqueue the same job both land a member; if the
  job has not started, its one run is appended to both, with `sharedWith: 2`.
- **Consumed only after an ok run.** A run that threw leaves the members in place, so the
  redelivery or the drain finds them and appends another record under the same ref — the page
  shows each attempt. An ok run removes them, so a LATER identical job someone else enqueues,
  once the dedup window has passed, is never appended to this trace.
- **Read once, at dispatch start.** A run that had already started when the link landed is not
  seen; the page shows that ref as having no recorded run.
- **The TTL has a floor of 1800 s** because the drain takes entries at least 900 s old, every
  ten minutes, so a drained run arrives up to 25 minutes after its enqueue and must still find
  its link.
- **Refs are local and bounded.** A record hands out `"1"` to `"99"`; the 100th enqueue in one
  record is published unlinked rather than given a ref that names two jobs, and a child that
  would nest past four levels keeps its local ref and reads unlinked.

## Why the token gates every environment

The token is the whole of the opt-in, and it is required wherever the flag is on. That is
stricter than `CRON_SECRET`, where an unset secret switches the routes off rather than opening
them: here the flag on with no token **refuses to boot** — the API, the consumer and the drain
alike — because whoever turned the flag on meant it, and the misconfiguration is better told
at deploy time than discovered as a tracer nobody can open. There is no tokenless development
mode, because a mode keyed on `NODE_ENV` or
`CURRENTS_MODE` is one mis-set variable away from a production that traces anyone who sends the
header. What a trace reveals is not reader data — that is the point of the enums — but it is
not nothing: which stations answer and how fast, the instance's configuration (queue driver,
provider modes, which planes are on), how many requests it has served, and each trace spends
Redis commands from a free-tier budget. None of that should be free to a stranger.

A wrong token learns nothing: the request is served as if the header were absent, with no
error, no response header and a debug-level line whose only field is the reason. `isAuthorized`
is the cron routes' comparison — constant-time over the characters, and it leaks the token's
length, which is accepted here as it is there. Boot refuses a token under 24 characters, and
one with whitespace, since it travels as `Bearer <token>` and a folded or trimmed copy would be
a token nobody can present. The page sends it only in the header and keeps it in component
state for one visit; it is never in a URL, in storage or in a log line. A leaked token buys at
most 30 opens a minute and 8 concurrent per instance, under the per-IP limiter as well;
rotating it is a `vercel env` change and a redeploy.

## What it costs

Nothing while off. While on, against Upstash's free tier of about 16K commands a day
([VERCEL-ALL-IN-SCOPE](../VERCEL-ALL-IN-SCOPE.md)):

| Moment | Redis commands |
| --- | --- |
| An untraced request | 0 |
| A traced request's record | 1 (`SET`) |
| Each traced enqueue's link | 2 (`SADD`, `PEXPIRE`) |
| **Every job delivery, traced or not** | 1 (`SMEMBERS`) |
| Each linked run | 2–3 (`RPUSH`, `PEXPIRE`, sometimes `LTRIM`), plus 1 `SREM` if it was ok |
| Each read of the trace route | 3 (the limiter's `EVALSHA`, `GET`, `LRANGE`) |

The page polls a recorded trace every 3 s for its first 30 s, every 10 s to two minutes, every
30 s to ten, and once a minute to thirty, by the trace's age — the LARGER of its age by the
server's clock (`now − startedAt`) and the time since this page first read it, so a browser
clock running behind the server's cannot hold the 3 s cadence or stretch the window
(`tracePoll.ts`, `traceAgeMs`) — and stops as soon as every linked enqueue has an ok run, or
at the first 404. A cold search with four jobs and one redelivery at +305 s is read about 27
times, which comes to **about 110 commands** for the whole episode. Whether Upstash bills an
`EVALSHA` as one command or as the commands its script runs is not recorded anywhere: the
limiter's script is an `INCR` and then a `PEXPIRE` or a `PTTL`, so under the second reading
each read is 4 and the same episode is about 140. A trace whose jobs wait on the drain is read
about 55 times at most, however the two clocks disagree.

**The `SMEMBERS` per delivery is the standing charge**, paid for every job while the flag is on
whether or not anyone is tracing. That is why the operating policy is **on for a session, then
off** — in production each change is a `vercel env` edit and a redeploy.

The observer effect is bounded and confined to the traced request. Each traced enqueue waits
one link round trip (at most 250 ms, reported as `overheadMs`, not drawn). The record write can
hold a traced response up to about 1.8 s on a cold instance — 1.5 s of ready-wait, then 300 ms
— outside the `ms` the trace reports. That is the ceiling, reached only by a handshake that
finishes late and a write that is then slow; a client that never becomes ready costs the 1.5 s
and answers `unstored`, because its write is then refused at once (no offline queue), and one
already `end`ed costs nothing. Link writes never wait for Redis, so a cold instance enqueues
exactly as it would untraced.

## What is deliberately not seen

The page draws what the trace recorded and its notes name what it could not. Not seen:

- **The boot-held Redis callers.** The rate limiter's EVALSHA (inferred instead), the quota
  governors' EVALs (inside the upstream touch), and the queue's own Redis clients — the pending
  ledger's `ZADD` inside an enqueue, BullMQ's own commands. `pendingCount` is the one ledger
  read a handler makes, and it is recorded as the `ZCARD pending_ledger` touch it is, at the
  queue interface.
- **Inside an upstream call**: the circuit breaker, the quota reserve and observe, transport
  retries and their backoff. One touch covers the call; GNews, where enabled, is inside the
  composite's one touch.
- **Postgres failures and transaction bracketing.** Kysely calls a plugin's `transformResult`
  only for a query that succeeded, so a failed statement reads `open`, like one still running —
  the schema has no `failed` for Postgres for that reason. BEGIN and COMMIT go through the
  driver and are not seen. A builder from the traced db embedded in another query as a
  subquery, and `executeTakeFirstOrThrow`'s no-result path, begin touches that never end and
  read `open`; this codebase's subqueries compile through expression builders and CTE
  callbacks, which carry no plugin, so none do today. A Postgres touch's duration includes
  waiting for one of the pool's two connections, and no region latency is assumed anywhere.
- **Anything after the seal.** The label tail `grouping-service.ts` fires and forgets is
  recorded up to the moment the response leaves; its touches begun before that read `open`, and
  nothing begun after is kept. The same holds for a job run's recorder at return. Whether a
  frozen instance ever finishes that tail is unmeasured.
- **The SDK around a delivery**: the Vercel Queues lease extension and acknowledgement, and the
  message handler's retry-or-give-up decision, which reads the rethrown error unchanged.
- **Runs outside the link**: one that started before its link landed, one on a deployment with
  tracing off — from before this ADR, or a drained one after an off redeploy, since the drain
  is a cron call to the production alias and so runs in the newest deployment — and any past
  the sixteenth for a trace.
- **The untraced surfaces**: `/topics`, `/healthz` and `/readyz` inside the API, and outside
  it the server-rendered storyline and sitemap functions, the drain, chore and keepalive routes
  as requests (the drain's job runs ARE recorded), and the cron that calls them.
- **A platform 504.** `onSend` never runs, so there is no record. The page's recorder
  synthesizes a browser-only trace from the 504 instead, as it does for a CDN `HIT` or `STALE`
  (`x-vercel-cache`), where no function ran at all; those are the only traces with
  `origin: null` and an `edge` touch, and neither is stored. The two are not the same event,
  and the record result keeps them apart (`cause: "cache" | "timeout"`, `traceFetch.ts`): a
  504 is the platform answering in the API's place, most likely because a function ran to its
  time limit and was stopped before it could store a trace, so nothing the page says about
  it — the notice (`recordNotice`), the headline or the honesty notes (`stepText.ts`, which
  read the edge touch's `miss`) — claims that no function ran.

## The page is an operator's view on `/`

**`/?trace`, not `/replay`.** Production has no SPA fallback: an unknown path is Vercel's 404,
and a rewrite for one would fail `cron-routes.test.ts`, which pins every rewrite destination to
a public entrypoint. `/` is served from `index.html` whatever its query, so a parameter needs
no `vercel.json` change, and the page's canonical is already `/`. The recorded id rides in the
**fragment**, `#t=<uuid>`, which is never sent to a server, so the PAGE's request never carries
the read capability: not in its query string, the static file's CDN cache key or its log. The
page's own reads of the trace do carry it, in the read route's path, through the edge to the
function and its request log (*Consequences* says where else it appears); the fragment keeps
it out of every URL but that one. The page switches what it plays with
`history.replaceState` only, so Back leaves it, and follows a pasted `#t=` through
`hashchange`. It injects `<meta name="robots" content="noindex">` and its own title while
mounted and removes both on the way out; nothing links to it ([docs/SEO.md](../SEO.md)).

**It stays out of the reader's bundle.** The chunk is lazy, and `playbackRoute.ts`, which
`App.tsx` reads at load to decide whether to fetch it, imports nothing — `TRACE_ID_PATTERN` is
repeated there as a string and a test pins the two equal, because importing it would drag the
trace schemas in. The shared contract is a subpath export, `@zammy/shared/request-trace`, and
deliberately not re-exported from the package index: the package does not declare
`sideEffects: false`, so anything the index reaches ships in the main chunk.

**Two paces.** Readable compresses real time logarithmically — a stop dwells
`280 + 420·log10(1 + ms/2)` ms, clamped to 280–2400 — so a 1 ms cache hit and a 712 ms Currents
call are both long enough to see and the second is still visibly longer; a real gap of 2 s or
more is skipped with a `+N S LATER` step rather than drawn. Real time keeps real durations with
a 60 ms floor and drops the walking. Consecutive touches at one station within 15 ms are one
stop, captioned with their count, and an elided middle is one fast-forward step; a call that
overlaps the runner at another station, or was still running when the response left, is carried
by a helper drone; each job run is a worker robot's walk from the bay and back, and runs that
overlapped in real time overlap on screen. **Every step starts at its own instant**: two that
would start together — at real pace the 60 ms floor lines concurrent job runs up — are moved
1 ms apart (`separateTies` in `choreography.ts`), because the transport keeps only a time and
reads its step back from it, and a step sharing its start with an earlier one could never be
landed on by a seek, a step or the step list. A pace change keeps the reader on the same step,
found by what it is rather than by its index (`carryAcrossPace` in `playbackClock.ts`), since
the two paces order the same steps differently.

**The canvas is decoration; the words are the page.** The canvas is `aria-hidden`. A list of
steps — one real button per step, in the page's own prose (`describeStep`) — carries the same
content and seeks the stage when activated; the scrubber's `aria-valuetext` is the landing step
in words; a status plate says what is playing, where it came from and how long a recorded trace
has left — never more than the TTL from this page's first read of it, so skew cannot inflate
it, and "no longer stored" once a read 404s; and a legend under the stage lists what this trace
could not show (`honestyNotes`). The live region is the house one: one announcer for the whole
page portals into the static `#rail-status`, and speaks once per EVENT, never per frame — a
reader's transport action (play, pause, a step, a seek), a record run coming back, a
read of the trace that brings something new (its headline, job runs arriving, a failure, said
once however many polls repeat it) and the poll window closing with runs still missing
(`pageNotices.ts` words and decides all but the transport's). With motion allowed the page
autoplays once, never loops, and pausing is always one press away — the Play toggle,
`aria-pressed` while playing, or Space (WCAG 2.2.2). Under `prefers-reduced-motion` it does
not autoplay, shows a static overview of the whole route with numbered badges first, and plays
by holding each step 1.4 s and jumping to the next; reduced motion switched on mid-play keeps
the stage rather than swapping in the overview. The keyboard shortcuts (Space or K, the arrows
or J/L, Home, End, `[`/`]`) keep working while a button has focus; only Space is left to a
button, link or summary, which already activates natively. The single-character ones — K, J,
L, the brackets, `+`, `=` and `-` — are live page-wide, which WCAG 2.1.4 allows only if they
can be turned off, since a speech-input user's misheard phrase arrives as keystrokes: a
"Letter shortcuts" toggle beside the key legend turns them off, the legend then lists only the
keys that still work, and the choice is remembered per browser (`playbackPreferences.ts`,
where only "off" is stored). Space, the arrows, Home and End are not character keys and stay.

**It is the one exception to ARCHITECTURE §8.3's visual rules, and the exception is the art,
not the words.** The floor is drawn in a fixed sixteen-colour palette (Sweetie 16, by
GrafxKid), identical in both themes — the precedent is `TrendingCloud`'s recency ramp,
decoration the step list makes redundant — with sprites as string literals, 1-px outlines and
one light, on a 320×180 wide plan or a 160×240 tall one at an integer scale, so a 375 px phone
gets a clean 2×. Canvas lettering is a 5×7 bitmap font defined in code, because anti-aliased
`fillText` on a pixel floor reads as a diagram and a web font would be a request. But **every
word the canvas draws is in the page's own ink tokens on an ink backing** — plates, bubbles,
the clock, the banner, and the station lamps, which are signals rather than decoration — so its
contrast is the theme's; `drawList.test.ts` fails on any text op carrying a palette colour.
Everything outside the canvas is ordinary page UI in `MONO` on tokens.

**Recording from the page.** "Record a real request" makes one real request of any traced kind
with the token in the header and reads only the response HEADERS — the body is cancelled
unread, since a traced body is identical to an untraced one. It warns that a search nobody ran
recently spends upstream quota, and never retries for that reason. The token is a password
field in that panel's state and nowhere else, which is why the page switches to the new trace
without a reload: the token survives consecutive recordings in one visit, and no longer. An
answer with no trace id that is neither an edge-cache answer nor a 504 is `untraced`, and the
page lists the possible reasons without knowing which, because the server is built not to say;
an `unstored` one likewise lists all three causes of a record that did not store, and points
at the API's log for which.

## Considered and refused

**AsyncLocalStorage over the `ioredis:command` diagnostics channel.** The channel sees every
command on every client, the boot-held ones included, and ALS would attribute them to a
request. Refused for the reasons above: the context is lost at the BullMQ worker, at the
process boundary to the consumer and at offline-queue flushes, which is where job runs happen;
Postgres would need its hook anyway; and it is ambient context in a codebase that has none. The
one comparison a command stream is good for is made in a test instead, with a spy on the
harness client's `sendCommand`: an untraced request with tracing on issues the same Redis
commands, in the same order, with the same body, as one with tracing absent.

**A `traceId` on the job payload.** Dropped by `parseIngestJob` under one driver and kept by
the other, invisible to the drain, and a change to the payload of every job for a diagnostic.
See *Why the job is linked by its id*.

**OpenTelemetry.** New runtime dependencies, an exporter, and a collector that nothing on Hobby
runs. Its instrumentations record attributes by default — statement text, full URLs — so the
redaction posture would be subtractive, a list of things to turn off, where this one is
additive: a closed list of things allowed on. And its unit is the span.

**A tokenless development mode.** One mis-set variable from an open tracer in production, for
the convenience of not pasting a token; `openssl rand -hex 16` is the whole setup.

**Sampling reader traffic.** It would trace readers who did not ask, which turns the trace from
an operator's instrument into a record of reader behaviour, and it would make the standing cost
permanent.

**The trace id in the response body.** The body stays byte-identical so that tracing cannot
change what a reader or a cache sees: an id in the body is a `PAGE_SHAPE_VERSION` bump, and the
page cache would store one trace's id and serve it to everyone who hit that entry.

**`/replay`, with a rewrite to `index.html`.** A new path is a 404 at the edge without one, and
a rewrite to a static file fails the rewrite-destination test. A parameter on `/` needs
neither.

**Widening the client contracts.** An alternative design threaded events through the existing
interfaces instead: an `onEvent` on `CallOpts` and on `GenerateRequest`, options on every
`enqueue*`, a second argument to `IngestHandler`, `PendingSet.add` returning a boolean, a new
`Drainable.dispatch`. It would see more — retries, the ledger — and it changes six contracts,
every driver and every consumer test for one opt-in feature, and makes the tracer something the
code calls into rather than a copy of what the code is handed.

**A `vercel.json` noindex header on `/`.** `/` is the cached home page, and a header rule
matching it risks deindexing the site to keep an operator view out of search. The chunk's own
meta tag applies only where the view renders.

## Consequences

- **Every example is a claim about the code, and is tested like one.** `traceSignature`
  (shared, so both sides compare the same thing) reduces a trace to the path the code decided —
  dropping Postgres, the reference refill and label-tail Gemini calls, which timing and cache
  warmth vary — and each example's signature is pinned to a table, whose one home is
  `SIGNATURES` in `trace-examples.test.ts`. That test records five of the seven for real over a
  fixture harness (the cache hit, the cold search, the 429, the quota refusal and the storyline
  open, whose expected form is built from the planes the response reports) and requires the
  recorded signature to equal the example's. The cold instance and the edge hit are checked
  against the table only: the first needs an instance inside a Redis handshake, and the second,
  by definition, runs no function. Each example also names the code its path follows, as
  `mirrors` entries of `path:first-last` and the text line `first` holds, and
  `exampleTraces.test.ts` fails when the file is gone, the range overruns it or line `first` no
  longer holds that text — so an edit above a cited range fails a web test until its numbers
  move, which is the price of citations that cannot drift unseen. Timings in every example are
  illustrative, and each one says so.
- **Not yet recorded end to end**: the Vercel Queues consumer path (it takes the default source
  and is otherwise unchanged), a Gemini label tail against a real labeler (the tests use stub
  generators), and the cold-instance `fail_open` path. No test covers a run record that fails
  its schema and is only warned about.
- **Tracing shares the boot Redis client with the page cache and the locks.** Its keys are
  scoped by the queue's name the way `<queue>:trending:*` is, so production's are
  `ingest:trace:*` and a test harness's uniquely named queue never meets them. Losing all of
  them costs the traces and nothing else: the read route reads the record and runs keys, and
  the consumer's dispatch reads the job-link key on every delivery, running the plain handler
  when it is gone.
- **`ingestDispatch` split in two.** `dispatchOver(bundles)` is the job → processor mapping
  over explicit bundles, and `ingestDispatch(services, source?)` is that mapping over the boot
  bundles, with the link lookup in front only while tracing is on. `trace-dispatch.ts` takes
  `dispatchOver` as a parameter so it never imports `server.ts` at runtime.
- **The reader's main chunk grew by about 4.2 KB raw, 1.3 KB gzipped**, more than
  `playbackRoute.ts` and the `App.tsx` branch account for. zod lives in the main chunk, so the
  zod classes only the playback chunk uses (its discriminated union and literal) are kept there
  too; the trace schemas themselves are absent from it, checked by searching the built chunk. A
  `manualChunks` rule for zod would recover the difference and was not made.
- **The id is a read capability for redacted data, for one TTL** (an hour by default), and it
  does appear in places: the read route's path on every poll, and so the function log's
  request line for it, and possibly GA4, if its page location ever carries a fragment —
  unverified. Both audiences are operators or aggregate analytics, and the record holds no
  reader data.
- **Clocks disagree.** A job run's offset from its trace is two instances' wall clocks
  subtracted, so the page labels it approximate. The 30-minute poll window is bounded on one
  side only: the trace's age is the larger of the server's `startedAt` against the browser's
  clock and the page's own time since its first read, so a browser clock running BEHIND the
  server's cannot stretch the window past thirty minutes of the page's own time, but one
  running AHEAD still reads the trace as older than it is and stops polling early, and nothing
  in the record can correct that half. "Check again" is the way back.
- **Turning tracing off makes stored traces unreadable before they expire.** The read route
  exists only in a deployment with tracing on, so after the off redeploy every read from the
  production URL is a 404, and the page's notice lists the causes a 404 cannot tell apart —
  expired, mistyped, or tracing off (`readFailureNotice`) — rather than assuming expiry. The
  keys stay in Redis to their TTL, and turning tracing back on inside it makes them readable
  again. The drain runs in the new deployment too, so a job left to it after the off redeploy
  runs untraced and its run is never appended.
- **ioredis marks `sendCommand` `@ignore`.** The identity tests pin the behaviour the trap
  relies on; if an upgrade breaks it, Redis touches disappear and requests are unaffected.
- **Deferred**: a transport observer that emits the breaker, reserve, fetch, observe and
  backoff steps of an upstream call without a URL or params; GNews as its own touch; tracing
  the SSR, sitemap, cron and health functions; stitching one reader's session together; a
  capability probe so the page knows whether tracing is on before a recording says; links to a
  step, export, and sound.
