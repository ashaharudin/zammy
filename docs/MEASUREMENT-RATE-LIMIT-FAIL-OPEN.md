# The per-IP limiter is enforced, and it still let 131/min through

Resolves the anomaly `docs/MEASUREMENT-RAIL-PAGE-DEPTH.md` §3.5 flagged and did
not explain.

Measured 2026-09-11 against production. Read-only: live `GET`s to
`/api/v1/reference` and `/api/v1/timeline`, `vercel logs`, `vercel env ls`,
`vercel ls/inspect`, plus the previous session's archived log pulls. No deploy,
no setting changed, no database reached, no labelling quota spent.

---

## 1. The headline

**The limiter is not decorative. It is non-deterministic.**

`§3.5`'s inference — "the per-IP ceiling is not doing what it is written to do"
— is right about the episode and wrong as a general statement. Driven directly
today, the limiter enforces exactly as written: **HTTP 429 on request 61**, from
one IP, across ~30 distinct instances, sharing one Redis bucket.

What actually happened in the episode is narrower and worse to reason about: a
**fraction of instances hold an unusable Redis client**, `skipOnError: true`
turns each of their requests into "not limited", and the effective ceiling
becomes `60 ÷ (fraction of instances that can reach Redis)` — a number nobody
chose and nothing reports.

---

## 2. What the limiter does today

`/api/v1/reference` is the right probe: it is under `/api/v1/` so the global
hook applies, it shares the one per-IP bucket with every other `/api/v1/*`
route, and it spends no upstream quota.

```
seq 1..61  200   remaining 59 → 0     (one bucket, ~30 distinct x-vercel-ids)
seq 62..75 429   retry-after 39..36
```

- `x-ratelimit-limit: 60` confirms `RATE_LIMIT_PER_MINUTE` is unset and taking
  its default (`packages/config/src/index.ts:368`). It is genuinely absent from
  the 21 production variables; `TRUSTED_PROXY_HOPS` **is** set.
- The bucket is shared across routes as `server.ts`'s comment claims. Five
  `/api/v1/timeline` reads between two `/api/v1/reference` probes moved the
  counter 59 → 53, one decrement per request, no gaps.
- Keying is correct. All 198 archived timeline rows carry
  `"remoteAddress":"206.47.118.34"` — one stable value, not a per-invocation
  forwarded chain. **The `trustProxy` / per-request-varying-`request.ip`
  hypothesis is dead**: a fresh bucket per instance would have shown up as a
  counter that never advances, and the counter advances monotonically across
  ~30 instances.

### 2.1 The fail-open has an unambiguous signature

`@fastify/rate-limit@11.2.0` computes `remaining = max - current` and leaves
`current = 0` when the store throws and `skipOnError` swallows it
(`index.js`, `applyRateLimit`). So:

| response | meaning |
|---|---|
| `x-ratelimit-remaining: 59`, `reset: 60` | counted — `INCR` returned 1 |
| `x-ratelimit-remaining: 60`, `reset: 0` | **fail-open** — the store threw |
| no `x-ratelimit-*` headers at all | `allowList` matched |

`remaining: 60` is the number `INCR` cannot produce that `server.ts` already
names. `reset: 0` is its companion and makes the reading certain.

Measured rate today: **2 of 76** sequential requests, and **1 of 24** concurrent
across 22 distinct instances. The `server.ts` comment's preview measurement —
7 of 24 — is ~10× worse than production is behaving now.

---

## 3. Why the episode saw zero 429s

### 3.1 A working limiter would have emitted 22 of them

The previous session's raw log pulls survive in its scratchpad, so the episode
is reconstructable at millisecond resolution. Replaying all 200 `/api/v1/*`
requests from `206.47.118.34` through the plugin's own algorithm — `INCR`,
`PEXPIRE 60_000` only when `current == 1`, 429 when `current > 60`:

```
all 200 requests counted        -> 22 × 429, first at 18:46:51.961
only 169.254.39.75  counted     ->  0 × 429
only 169.254.44.149 counted     ->  0 × 429
```

Observed: **0**.

So this is not window alignment. A fixed window *can* swallow a burst when its
boundary falls mid-episode, and that was worth ruling out — episode A's 100
requests span 45.9 s, short enough to straddle one boundary. It does not save
this case: the real timestamps, including the 280 s gap between the episodes,
put 22 requests over the line.

### 3.2 Only two instances served the whole session, and one could not reach Redis

```
/api/v1/timeline, 198 requests:  169.254.44.149 × 100   169.254.39.75 × 98
```

Two long-lived instances, `reqId` counters running sequentially on each. Not a
scale-out storm — the opposite of the burst the `server.ts` comment measured.

Both booted at 18:44:22. One of them logged, at boot:

```
level 40  hostname 169.254.39.75
msg  "shared burst window unavailable; counting in-process"
err  "Stream isn't writeable and enableOfflineQueue options is false"
     at ioredis@5.11.1 Redis.js:376 sendCommand
```

That is the quota governor's fallback firing because the **shared** Redis client
was unusable — the same client the rate limiter is handed
(`buildServices`, `server.ts:166`). The episode's `NewsQuotaError` stack traces
name `InProcessQuotaGovernor.reserve` throughout, confirming it stayed on the
in-process path.

The two simulations above are the point: **if either instance alone was
counting, the answer is exactly zero 429s.** Roughly half the traffic going
uncounted is sufficient and necessary to explain the observation, and there is
direct log evidence of exactly that on one of the two instances.

I cannot prove the split was precisely 50/50 or that `.39.75` was blind for its
entire life — its page cache did register one hit out of 98, so its client was
not dead for every command. A partially-blind pair of instances fits the
evidence equally well. The conclusion does not depend on which: the limiter
counted about half of what it should have, and half of 131/min fits under 60.

### 3.3 Why a client stays unusable, and why nothing says so

Reproduced locally against ioredis 5.11.1 with `buildServices`' exact options
(`maxRetriesPerRequest: 2`, `lazyConnect: true`, `enableOfflineQueue: false`,
un-awaited `connect()`), pointed at a closed port:

```
boot connect rejected: Connection is closed.
t=0.3s  status=reconnecting -> command THREW: Stream isn't writeable …
t=3.3s  status=reconnecting -> command THREW: Stream isn't writeable …
t=8.3s  status=reconnecting -> command THREW: Stream isn't writeable …
```

The client does keep retrying, so it recovers once the host is reachable. But
while it is in `reconnecting`, **every command throws instantly** — the offline
queue that would otherwise hold them is deliberately off. On Vercel the instance
is frozen between invocations and the backoff timers freeze with it, so a client
that lost its connection can stay in `reconnecting` across many invocations.

`redis-ready.ts` documents this seam precisely, and says the request path
deliberately does not wait — correctly, for a cache. `waitForRedis` is awaited
by `drain.ts` and `vercel-queue.ts` and **not** by `vercel.ts`.

The reason it is invisible is the part worth fixing on its own:

- the rate limiter logs **nothing** when it fails open — `applyRateLimit`'s
  catch is `if (!params.skipOnError) throw err`, and that is all;
- the page cache degrades to a miss, which is indistinguishable from a real
  miss during ingest (197 of 198 reads missed, which on its own proves nothing);
- only the quota governor announces its fallback, and only once per instance.

So the sole live tell is `x-ratelimit-remaining: 60` on a response nobody reads.

---

## 4. What this means for `RATE_LIMIT_PER_MINUTE`

**60 survives #212, but with ~1.3× headroom rather than the margin the
pre-fix arithmetic implied. Pin it; do not assume it is generous.**

*Updated after #212 (`60b2692`) and #213 landed on `main` and production
redeployed. The conditional this section used to carry is resolved, and the
number it resolved to is not the one that was projected — see §4.1.*

The rail-depth measurement is the relevant input: one ordinary reader, polling
during ingest, sustained **131 requests a minute** with a per-tick fan-out of 6–8
pages, against a ceiling of 60. #211's arithmetic bounds it at 160/min.

So on a fleet where every instance can reach Redis, today's traffic shape is
**a single reader being 429'd 22 times in 46 seconds** — during ingest, which is
exactly when the rail is trying to fill. Repairing the fail-open on its own, and
leaving the fan-out where it is, converts a silent gap into a visible product
failure.

**#212 removes that problem, and its verdict on #211 option 3 ("not worth
building on this evidence") stands** — nothing here argues for the wait hint or
SSE. But the cost it leaves behind is larger than the projection, for a reason
the rail-depth measurement itself supplies.

### 4.1 The 17–23 figure does not survive the fix that produced it

That number is the pre-fix **tick count** — 17 ticks in 46 s, 23 in 59 s — used
as a stand-in for requests once each tick costs one request. It cannot be
carried across the fix, because §3.3 of the rail-depth measurement already
recorded why those ticks were so few:

> the observed tick period is therefore **1.5s + the fan-out's own duration**:
> median 2.32s at depth 4, 2.69s at depth 6–7, against the 1.5s §8.2 specifies.

The fan-out was *throttling its own poll*. Remove it and the throttle goes with
it. `ingestPoll.ts` reschedules after the fetch resolves
(`if (!controller.signal.aborted) schedule()`), so the period is now
`INGEST_POLL_INTERVAL_MS` (1500, unchanged by #212) plus one page-one fetch —
0.05–0.06 s in the archived `TIMELINE_READ_MESSAGE` rows. About **1.56 s**, so a
full `INGEST_POLL_WINDOW_MS` (60 s, also unchanged) is **~38 ticks, not 17–23**.

Add the reader's own paging, which #212 does not touch — it stopped the *poll*
from re-fetching loaded pages, while the initial load of each page is still a
request, and #210's sentinel drove episode A's rail to 7–8 pages. So one reader,
one cold topic, one ingest window:

| | per cold-topic read | per minute |
|---|---|---|
| before #212 (measured) | 75–100 | 131 |
| after #212 (projected in §4) | 17–23 | ~22–30 |
| **after #212 (this arithmetic)** | **~38 poll + ~7 paging ≈ 45** | **~45** |

**This is arithmetic, not an observation** — the same kind of arithmetic that
was wrong the first time, and it should be replaced by a measurement the next
time a cold-topic read happens in production with logs still retained. What it
is enough to establish is the shape: 45 of a 60/min ceiling is ~75%, so the
ceiling holds for one reader and has no room for two visible tabs on different
topics, or for a reader who pages while polling.

The three levers, in the order they should be decided:

1. **Pin the limit explicitly.** #212 has landed, so the fan-out is gone and the
   ~240–300/min branch is off the table. What remains is a choice between 60 and
   something with real headroom. 60 is defensible — one reader fits, at ~75% of
   it — and pinning it costs nothing: the default is currently load-bearing in
   production by accident, and `x-ratelimit-limit: 60` is the only place the
   number is written down. **120 is the better number** if §4.1's arithmetic is
   even roughly right, because 1.3× is not headroom for a ceiling whose failure
   mode is 429ing a real reader mid-ingest, and 120 is still two orders of
   magnitude below what novel-fingerprint spam would need to matter against
   `PER_TOPIC_DAILY_CALL_CAP` (20) and `INTERACTIVE_RESERVE` (250). Measure a
   post-#212 cold read before committing to 60.
2. **Repair the Redis seam**, so the ceiling is the number chosen rather than
   that number divided by the healthy fraction of the fleet. Sequencing matters:
   this is the lever that makes the limit bite, so it should land *after* 1 has
   settled what the limit is.
3. **Make the fail-open observable.** Nothing here was diagnosable from the
   logs; it took replaying archived rows through the plugin's own algorithm.
   A one-line warn on the skipped path — the same shape and the same once-per
   -instance discipline the quota governor already uses — would have made §3.5 a
   five-minute answer instead of an open question. Free, independent of the
   other two, and worth doing whatever is decided about them.

---

## 5. Caveats

- **n = 1 session, 2 instances, 1 hour.** The same single-client, 8.5-minute
  window as the measurement it resolves. The fail-open *rate* measured today
  (2/76 and 1/24) is a different fleet on a different day and should not be
  quoted as a constant — it was 7/24 on preview when `server.ts` was written.
- **Production runtime log retention is one hour, rolling.** §3's reconstruction
  was possible only because the previous session's raw pulls were still on disk
  in its scratchpad; the logs themselves were gone before this session started.
  Nothing here is re-derivable tomorrow.
- **The deployment changed underneath the two measurements.** The episode ran on
  `dpl_GyUoZPTJUtuVZ4zLLMomjop8tCwU` (live 17:57 UTC); it was replaced at 19:00
  UTC by `dpl_7FTQbHe1Q5uYmXSVnyVhYVgbc1Pe`, which is what §2 drove. Same commit
  — `main` has not moved past #210 — and the only env change was
  `STORYLINE_COHERENCE_GATE`, which the limiter does not read. The code is
  identical; the instance population is not, and that is the whole finding.
- **The old deployment could not be probed directly** to compare: its URL is
  behind deployment protection and 302s to SSO.
