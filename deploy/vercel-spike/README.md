# The Plan A shape spike — throwaway

> **Answered, 2026-08-23. Every question in the table below came back, and the results are recorded
> in [VERCEL-PHASE-0-FINDINGS §8](../../docs/VERCEL-PHASE-0-FINDINGS.md) and
> [VERCEL-ALL-IN-SCOPE §3.1](../../docs/VERCEL-ALL-IN-SCOPE.md).** Phase 0 is complete and Phase 1's
> code has landed against these answers. This directory and the `zammy-vercel-spike` project are
> now deletable — see the last section — and the only reason to keep either is to re-test Queues
> dedup deliberately before Phase 2 leans on it.

Phase 0, item 1 of [VERCEL-ALL-IN-SCOPE.md](../../docs/VERCEL-ALL-IN-SCOPE.md) §9. **Not part of the
build, not in the pnpm workspace, delete it when the questions are answered.** Everything here
exists to settle what no amount of reading settles, because the documentation never shows this
combination: every Queues example is Next.js App Router, and Vercel's Vite guidance steers Vite
projects toward Nitro rather than a bare `api/` directory.

The three numbers Phase 0 also wanted are already measured and needed no deployment — see
[VERCEL-PHASE-0-FINDINGS.md](../../docs/VERCEL-PHASE-0-FINDINGS.md).

## Run it

```bash
cd deploy/vercel-spike && npm install && npx vercel deploy
```

`vercel` will ask to link a project — let it create a **new** one. Nothing here should share a
project with anything real.

Then, with `URL` set to the deployment URL it prints:

```bash
curl -s "$URL/api/v1/echo/deep/path?q=1"; curl -s "$URL/healthz"; curl -s "$URL/api/v1/coldstart"; curl -s "$URL/api/enqueue?key=spike-1"; curl -s "$URL/api/enqueue?key=spike-1"; curl -s -X POST "$URL/api/chores?pass=spike&sleep=8000"
```

```bash
npx vercel logs "$URL"
```

## What each answer means

| Question | How to read it | If it fails |
|---|---|---|
| **Does the Vite preset build the SPA *and* the `api/` directory?** | The deployment root serves the page, and its `<pre>` fills in with three live responses. | §1.1's fallback: two projects joined by a rewrite. Costs a proxy hop and makes `TRUSTED_PROXY_HOPS` 2. |
| **Does Fastify see the real path?** | `/api/v1/echo/deep/path?q=1` returns `fastifySaw: "/api/v1/echo/deep/path?q=1"`. Anything shorter means a rewrite collapsed it, and every route would 404. | Same fallback, or an explicit rewrite that preserves the path. |
| **Do the out-of-`/api` probes work?** | `/healthz` returns `ok: true` and reports which path arrived. This is §3.1's "two rewrites" watch item. | Move the probes under `/api`, or keep the rewrites and register the rewritten paths. |
| **Does a `queue/v2beta` trigger fire on a bare `api/` function?** | `vercel logs` shows `"spike": "consumer fired"` with a `messageId` and `deliveryCount: 1`, within seconds of the enqueue. **This is the load-bearing answer.** | §3.2 loses its shape. Exits are Nitro's `queues.triggers` config, poll mode driven by cron, or the two-project layout. |
| **Does dedup work — and is Queues on Hobby at all?** | The second `enqueue?key=spike-1` failing with `error: "DuplicateMessageError"` is the **pass**. `UnauthorizedError` on the *first* call is the answer to Phase 0 item 5: Queues is not available here, and §8's $0 column needs revisiting. | Neither the Queues pricing page nor the Hobby plan page publishes a Hobby Queues allowance, so this curl is the only source. |
| **Does 202 + `waitUntil` outlive the response?** | The chores POST returns 202 immediately; ~8 s later the log shows `"chore finished after the response"`. Time the curl — the 202 latency from cold is what has to fit inside pg_net's timeout (§3.3). | The chore route needs a synchronous shape, and the 300 s ceiling would apply to the request rather than the background half. |
| **What does a cold start cost here?** | `/api/v1/coldstart` reports `buildMs` and `warm`. Hit it once, wait 6+ minutes for the instance to be reclaimed, hit it again. Compare against ~360 ms measured locally (findings §7). | Nothing breaks; it recalibrates the §3.3 timeout and the read-path latency budget. |
| **Does the cron entry validate?** | The deploy succeeds and the project's Cron Jobs tab lists `0 4 * * *`. Hobby runs it once a day, ±59 min. | Supabase Cron was already the intended driver (§3.3); this is only a cross-check. |

Two things to try once the happy path is green, because they are the failure modes §3.2 accepts
rather than avoids:

- `curl "$URL/api/enqueue?key=poison"` — the handler throws, and the log should show `deliveryCount`
  climbing to 4 and then stopping (the `retry` callback acknowledges it; there is no DLQ). **Note the
  cadence: the first redelivery is ~305 s, and this producer publishes with `retentionSeconds: 300`,
  so the message expires before it can come back and you will see exactly ONE delivery.** That is
  the bug VERCEL-ALL-IN-SCOPE §10 question 0 turned out to be; re-running this poison unchanged on
  2026-08-25 produced one delivery where 2026-08-22 saw four. Raise the retention to observe the
  retries.
- `curl -X POST "$URL/api/chores?sleep=400000"` — work that outlives `maxDuration`. The log should
  show the response already sent and the background half cut off, which is the shape a chore pass
  over the 300 s ceiling will have.

## Two corrections this spike's reading already produced

Both are in the scope doc's §3.2 table, and both are wrong the same way — they quote the raw API's
numbers rather than the SDK's, and we would be on the SDK:

- **The TTL option is `retentionSeconds`**, and the SDK's `visibilityTimeoutSeconds` defaults to
  **300 s with automatic lease extension while the handler runs** — not the 60 s the API defaults to.
- ~~**`retryAfterSeconds` is Nitro-only.**~~ **Wrong, corrected 2026-08-25.** It *is* a documented
  `vercel.json` `experimentalTriggers` option (alongside `initialDelaySeconds`), defaulting to 60 s.
  It is also **measured inert** on this layout — a topic declared with `retryAfterSeconds: 20`
  redelivered at +305 s, identically to one that omitted it — so the practical conclusion held even
  though the reason given for it did not. Retry timing comes from the server-assigned visibility
  lease, not from the trigger option and not from the SDK's `retry` callback; see
  VERCEL-ALL-IN-SCOPE §3.2.

There is also a shape detail worth carrying into §3.2: the consumer uses **`handleNodeCallback` on a
`QueueClient`**, not the top-level `handleCallback`. `handleCallback` returns a Web-standard `POST`
handler, and an `api/` directory function on the Node runtime is handed `(req, res)`.

## Then delete it

```bash
npx vercel project rm zammy-vercel-spike && git rm -r deploy/vercel-spike
```
