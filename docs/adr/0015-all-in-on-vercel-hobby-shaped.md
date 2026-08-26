---
status: accepted
---

# All in on Vercel, Hobby-shaped

Zammy deploys as Plan A of RESEARCH-VERCEL-SUPABASE: the api as a Vercel
Function, the ingest consumer as a Vercel Queues push consumer, Postgres on
Supabase, Redis on Upstash, chores as an HTTP route driven by Supabase Cron —
all on free tiers. This **reverses the research doc's recommendation of Plan B**
(a persistent host for the api), and it is worth recording why, because a
reader who finds both documents will see them pointing in opposite directions.

## Why B lost after being recommended

Two facts changed between the research doc (2026-08-19) and this decision
(2026-08-22), and one disappeared:

- **Vercel Queues went to public beta** — first-party, at-least-once,
  idempotency keys, push consumers with no public URL. The research doc's case
  against A rested on the consumer having nowhere to live and the third-party
  queue alternatives being the wrong shape; a first-party queue that matches
  BullMQ's delivery semantics turns the §9.1 consumer from a redesign into a
  reimplementation behind the existing `IngestQueue` surface.
- **The quota governor was found to be unbuilt** on *both* plans. ARCHITECTURE
  §9.1 claimed the consumer draws from the shared snapshot (§5.4); quota.ts
  says that snapshot is designed and not built. Plan B at one replica hides
  this; Plan A forces the build. That is a cost A carries — but the honest
  accounting is that B was quietly deferring it, not avoiding it.
- **OCI was abandoned** (2026-08-21, no free Ampere capacity), leaving no
  deployment target at all. A recommendation is only binding while its
  alternative exists; B's persistent host was never provisioned.

## The trade accepted

The $0 column is real and it is the reason: a genuinely free production
deployment, against Plan B's ~$15–20/month floor. What it buys with that
saving, eyes open:

- **A public-beta queue in the load-bearing position** (`queue/v2beta`).
  Accepted because the Redis pending set stays as our own at-least-once
  backstop, and the blast radius of a trigger regression is degraded ingest,
  not data loss. The fallback if the beta breaks is a manual drain via the
  chores route; if the trigger is withdrawn entirely, the two-project layout
  and a cron-driven pull drain are the exits, and both are worse than what
  §4.1 asked for — that is the bet.
- **Hobby's ceilings**: 300 s per function (bounds the nightly label pass —
  `--max-labels` becomes a deployment parameter), 1-hour log retention (which
  is why chore runs write a durable `chore_runs` record instead of relying on
  logs), non-commercial fair use (Zammy is personal), and no WAF (which is why
  the per-IP limit moves to Redis rather than staying decorative).
- **Deploy and migration cannot be atomic** — no post-deploy hook, so
  expand/contract discipline becomes a requirement (VERCEL-ALL-IN-SCOPE §6).

## Decisions bundled with the adoption

Settled in the same review (2026-08-22), recorded here because they shape the
build rather than the code that exists today:

- **Previews get their own free-tier Supabase + Upstash pair**, in fixture
  mode. Fixture mode still ingests; previews pointed at production would
  pollute the real corpus. A per-PR CI step migrates the preview database —
  doubling as a rehearsal of every migration against a real pooler before it
  touches production.
  **Retired 2026-08-26**: Upstash's free tier supports only one Redis
  database per project, which forces a choice once a project actually needs
  one. Production kept its Upstash database; the preview pair (Supabase
  project and Upstash database both) was decommissioned, along with the
  Preview-scoped Vercel env vars and the per-PR `migrate (preview)` CI job.
  See [deploy/vercel/README.md](../../deploy/vercel/README.md).
- **The quota governor ships burst-window-only** (plus the Currents
  observed-snapshot write), **fail-open** to in-process counting when Redis is
  unreachable. The day-rolling local ledger exists for headerless providers;
  its only customer is GNews, which is not on the horizon. Deferred alongside
  `GNEWS_ENABLED=false`, not forgotten.
- **The per-IP rate limit moves to Redis**, fail-open, matching the governor's
  posture. The in-process comment's warning about coupling was written for a
  platform with few replicas; elastic instances make the in-process ceiling
  `RATE_LIMIT_PER_MINUTE × N`, and this guard protects the thing that actually
  runs out — the Currents daily quota.
- **`/metrics` is deleted, and its story with it.** Per-process prom-client
  counters mean nothing across ephemeral instances and nothing scrapes them.
  Platform observability covers latency and invocations; the numbers §12 cares
  about (quota headroom, calls per request) live on as structured log fields
  and in the chore-run record.
- **Chores stay scheduled** (Supabase Cron → HTTP route → 202 + `waitUntil`,
  advisory lock unchanged), with all seven passes individually addressable by
  query parameter for on-demand reruns. A dedicated daily keep-alive ping
  through the pooler guards against Supabase free-tier pausing independently
  of chore health — the docs do not promise that pg_cron's own activity
  prevents a pause, and the guard for "the database stays awake" must not
  share a failure mode with the most complex nightly job.
- **Production is seeded from the dev corpus** at cutover — one dump/restore
  through the session pooler. The storyline arcs and label history are the
  product; starting empty would make the first production weeks worse than
  dev.

## What would reverse this

Hobby's fair-use policy (if Zammy stops being personal), the queue beta
breaking badly enough that the pending-set backstop is carrying real traffic,
or the corpus outgrowing Supabase Free's 500 MB with the label pass not
fitting 300 s — the last two both land on Pro (~$45–55/month), which is a
tier change, not a re-architecture. The application code is deliberately
deployment-agnostic (VERCEL-ALL-IN-SCOPE §2's "Unchanged" row); what this ADR
commits is wiring, not shape.
