# Deployment plan — Oracle Cloud Infrastructure (OCI)

**Status: pre-flight nearly complete; no OCI resources provisioned yet.** The first environment is
**staging on the Always Free tier** (§7); production follows. OCI is now the deployment target. AWS (the original target,
ARCHITECTURE 4.1) remains an option but not an immediate goal — nothing in this plan may leak
OCI-specific behaviour into application code, so the AWS mapping stays a Terraform rewrite away.
The discipline that made the AWS plan cheap to hold is the same one that makes this swap cheap:
one image, environment variables as the only difference between environments, migrations as a
discrete deploy step, `/healthz` for liveness and `/readyz` for routing.

Verified against Oracle's docs as of 2026-08-14; facts that may drift are marked **verify**.

## 1. Service mapping

| Unit | Local dev (Compose) | AWS plan (4.1) | OCI target |
|---|---|---|---|
| `api` + in-process consumer | container | ECS Fargate + ALB | **Container Instances** behind an **OCI Flexible Load Balancer** |
| `web` | Vite dev server | S3 + CloudFront | static-serving container behind the **same LB**, path-routed (§4) |
| Postgres 17 | `postgres:17` container | RDS | **OCI Database with PostgreSQL** — PG 17 supported since 2026-04 |
| Redis 7 | `redis:7` container | ElastiCache | a **`redis:7` Container Instance**, one shared (§4) — *not* OCI Cache |
| Image registry | — | ECR | **OCIR** (OCI Registry) |
| Secrets | `.env` | Secrets Manager | **OCI Vault** |
| IaC | — | "Terraform or CDK" | **Terraform** (this also settles the open 4.1 choice: CDK is AWS-only) |

**Why Container Instances and not OKE.** The system is one service. Container Instances are the
Fargate analog — serverless containers, per-second billing, no cluster to operate. What they lack
versus Fargate is orchestration: no native autoscaling, no rolling-deploy primitive, no automatic
LB registration. At one-to-three instances, Terraform supplies all three (§6); the day ingestion
outgrows that, OKE is the escalation path, and it is an infrastructure change only —
ARCHITECTURE 9.1 already survives instance recycling, which is the hard part.

**Why one load balancer for both `web` and `api`.** OCI has no first-class CDN — there is no
CloudFront equivalent to put in front of an Object Storage bucket, and buckets do not serve custom
domains with TLS on their own. Path-routing one LB (`/api/*` → api backend set, everything else →
static web backend set) gives one origin, which also deletes the CORS surface entirely:
`CORS_ORIGIN` becomes same-origin in production. If a CDN is ever wanted, front the whole thing
with Cloudflare later; that is additive, not structural.

## 2. Pre-flight — work that must land before any OCI work

Status as of 2026-08-14: 1, 2 and 4 are done; 3 is drafted and waiting on tenancy credentials.

1. ~~**Fix the api Dockerfile `deps` stage.**~~ ✅ **Done** (`01a0e5e`). It now copies
   `packages/storage/package.json`, and the deploy-tree import guard resolves all four `@zammy/*`
   packages at build time — so the failure is closed, not merely hidden.
2. ~~**Pick the CPU architecture.**~~ ✅ **Decided: arm64** — and it was never really a choice, since
   the Ampere shapes this plan targets are arm64-only. Verified 2026-08-14 by building the image for
   `linux/arm64` (192 MB, node 22 arm64, import guard green). Pinned not by a `--platform` flag but
   by the CI runner label (`ubuntu-24.04-arm`, native arm64), which is harder to forget.
3. **CI publishes to OCIR.** Build on push to `main`, tag with the git SHA, push to a private OCIR
   repo. Terraform deploys by digest, never by `latest` — the README already documents the stale-
   image failure mode this prevents locally; it is worse in production.
   🚧 **Drafted** at `.github/workflows/ci.yml`; needs the tenancy credentials listed below before
   it can run.
4. ~~**Verify `rediss://` support.**~~ ✅ **Verified 2026-08-14, no application change needed.**
   Tested against a TLS-only Redis 7 with the plaintext port disabled, exercising the real
   construction path — a bare URL string with no TLS options, as in `server.ts`, `ingest-queue.ts`
   and `chores.ts`. ioredis negotiated TLSv1.3 (`authorized: true`) and completed a set/get
   roundtrip; a BullMQ queue and worker over the same URL enqueued and completed a job. Plaintext
   `redis://` against that server and `rediss://` against an untrusted certificate both failed, as
   they should. `REDIS_URL` is validated as a non-empty string only, so no schema gate blocks it.
   **One condition, now dormant:** this works because the certificate chains to a root Node already
   trusts. A managed endpoint presenting an Oracle private CA would fail — with the unhelpful message
   `Connection is closed.`, no mention of TLS — and the remedy stays out of application code
   (`NODE_EXTRA_CA_CERTS` as a container environment variable), so §8 holds either way. Since §4 now
   settles on a Redis container reached over plaintext `redis://` inside the VCN, nothing in the
   current plan exercises this. It is recorded so that adopting OCI Cache later stays a `REDIS_URL`
   change plus a CA check, not a discovery.

   ⚠️ **An unreachable Redis will not fail a deploy — whatever the cause.** Redis down is survivable
   by design: `/readyz` returns **200** with `status: "degraded"` when only Redis is failing
   (`health.ts`), and a boot-time Redis error is logged as a warning and swallowed (`server.ts`). So
   a wrong `REDIS_URL`, an NSG that forgot the cache port, or a Redis container that never started
   all yield healthy LB checks, instances taking traffic, and an ingest queue that silently does
   nothing. This applies more to a self-run container than it did to a managed endpoint, since there
   are more ways for it to simply not be there. Phase 2's acceptance check must assert
   `status == "ready"` and inspect `checks.redis` — both already in the `/readyz` payload — not
   merely assert HTTP 200. Empirically confirmed 2026-08-14: with Redis stopped, `/readyz` returned
   200 and `degraded`, and the `zammy-deploy` gate blocked on it.

### What CI needs from the tenancy

Repository-level **variables** (not environment-level — `ci.yml` declares no `environment:`, so
environment-scoped values would be invisible to it):

- `OCI_REGISTRY` = **`ocir.ca-toronto-1.oci.oraclecloud.com`** (the legacy `yyz.ocir.io` form still
  resolves). Keep the registry in the same region as the instances that pull from it; cross-region
  pulls work but buy egress and latency on every deploy.
- `OCI_NAMESPACE` — the tenancy's object-storage namespace, an auto-generated string rather than the
  tenancy name. Profile → Tenancy, same page as Home Region.
- `OCI_REPO_PREFIX` = **`zammy`** — the grouping only, not the component. The job appends `/api`
  itself; Phase 4's web job will append `/web`.

Repository **secrets**: `OCI_USERNAME` — `<namespace>/<user>`, or
`<namespace>/<domain-name>/<user>` on a tenancy with identity domains, where the default IDCS domain
is literally named `oracleidentitycloudservice`. The console's Profile menu displays the
`<domain>/<user>` portion for federated users, so it can be read off rather than guessed. And
`OCI_AUTH_TOKEN`, an auth token generated under User settings → Tokens and keys — not the console
password, which OCIR does not accept.

#### Repository naming

One repository per deployable image, grouped under `zammy`:

| Image | OCIR repository | Built from |
|---|---|---|
| api | `<namespace>/zammy/api` | `apps/api/Dockerfile` |
| web | `<namespace>/zammy/web` | `apps/web/Dockerfile` (Phase 4, does not exist yet) |

**Why the component is hardcoded in the workflow rather than held in a variable.** Which image a job
publishes is a property of that job — it is decided by the Dockerfile it builds — while the variable
carries only what differs per tenancy. Splitting them that way makes it impossible for the api job
to publish over the web path, or for a variable edit to silently redirect a build. The cost is one
line per job; the alternative is a class of mistake that is invisible in the diff.

Create both repositories as **private** in OCIR before the first push. A push to a non-existent repo
auto-creates it, but visibility then comes from a tenancy default rather than a decision, and
reserving `zammy/web` now costs nothing.

## 3. Network layout

One VCN, three subnets:

- **Public subnet** — the load balancer only.
- **Private app subnet** — Container Instances. Egress via a **NAT gateway** (the api must reach
  the Currents API and the Gemini endpoint) plus a **service gateway** for OCIR pulls, Vault, and
  Logging without hairpinning through NAT.
- **Private data subnet** — OCI Database with PostgreSQL (VCN-native, private-endpoint only, which
  is the topology we want anyway) and the Redis Container Instance (§4). Redis being a container
  rather than a managed service means *we* own keeping it off the public internet: it gets no public
  IP and no LB backend, and the NSG below is what enforces that rather than a service default.

Network security groups, not security lists: LB → app on the api port; app → 5432 and the cache
port; nothing else. No public path to data stores exists even misconfigured.

## 4. The pieces

### api — Container Instances behind the LB

- Two instances minimum from day one. ARCHITECTURE 9.1 was built so that instance count is a knob;
  running one instance in production would be paying for that work and not using it.
- **LB backend health check → `/readyz`**; **container restart health check → `/healthz`**. This is
  the split health.ts encodes: a failing dependency must take an instance out of *rotation*, not
  get it *restarted* — restarting fixes nothing and a restart loop during an upstream outage would
  mask the actual signal. Do not wire `/readyz` to anything that restarts.
- `stop_grace_period` 15s in Compose was chosen to match the ECS stop timeout; Container Instances
  have the same graceful-shutdown window concept (**verify** the default; set it to ≥15s). The app
  drains on SIGTERM as PID 1 — no init shim, same as the Dockerfile.
- Shape: start at 1 OCPU / 4–8 GB per instance (Ampere). The api is I/O-bound and quota-bound, not
  CPU-bound; measure before buying more.

### web — static container on the same LB

A minimal nginx (or Caddy) image whose build stage runs `pnpm --filter @zammy/web build` and whose
runtime stage serves `dist/`. The web API base URL is build-time configurable (ARCHITECTURE 4.1);
with same-origin routing it is simply `/api`. This needs a second small Dockerfile
(`apps/web/Dockerfile`) — new work, listed in §7.

### Postgres — OCI Database with PostgreSQL

- PG 17, matching `postgres:17-alpine` in dev — supported on the service since April 2026, so no
  version downgrade is forced on us.
- Smallest available shape to start; automated backups on; **verify** PITR configuration — the AWS
  plan promised RDS-grade PITR and the OCI service's backup/restore granularity should be checked
  against that promise, not assumed.
- `DATABASE_URL` points at the private endpoint. Kysely + `pg` need nothing OCI-specific.

### Redis — a container, decided

**Decision (2026-08-17): a Redis container, not OCI Cache.** ~$5–10/month against OCI Cache's ~$28
floor for a 2 GB node that would sit ~8× oversized next to our 256 MB dev ceiling. ARCHITECTURE 11
is what makes this a cost decision rather than a correctness one: a lost queue job re-opens a
coverage gap the next reader repairs. The swap back is a `REDIS_URL` change if that ever stops
being true.

**One shared instance, never a sidecar per api instance.** This is the part that can quietly go
wrong. Three things in Redis are cross-instance by design — the ingest queue (§9.1), single-flight
(§7) and the per-topic daily cap (§9.4) — so giving each api instance its own Redis would fragment
all three: two instances would each plan the same segment, and a hot topic's 20-call cap would be
enforced twice over. Run it as its own Container Instance in the private data subnet, with both api
instances pointed at it.

**Storage is ephemeral, and that is acceptable.** Container Instances support `EMPTYDIR` and
`CONFIGFILE` volumes; block volumes cannot be attached, and while File Storage (NFS) mounts exist,
Redis persistence over NFS is a worse idea than no persistence at all. So this Redis is in-memory
only and a recycle flushes it. What that costs, precisely:

- **Queue jobs** — dropped, and re-opened as coverage gaps the next reader repairs (§11). The
  designed-for case.
- **Page cache** — all TTL'd; a flush costs latency and quota, never correctness (§7.1).
- **Per-topic daily caps** — reset, so a topic can exceed its 20-call share on a recycle day.
  Bounded by the global daily quota, which is *not* in Redis: the governor observes upstream's
  `x-ratelimit-*` headers, so the 1000/day ceiling survives a flush intact. Fairness degrades; the
  budget does not blow.
- **Single-flight locks** — lost, so briefly duplicated work. Self-correcting.

Set `--maxmemory` with `volatile-lru`, as the dev compose file does and for the same reason: cache
keys may be evicted freely, queue keys carry no TTL and must not be.

**This takes `rediss://` off the critical path.** Traffic is plaintext `redis://` inside the VCN, so
§2.4's verification is now recorded insurance rather than a Phase 2 blocker — it is what makes the
move to OCI Cache a `REDIS_URL` change if the fairness or persistence argument ever flips.

### Secrets — OCI Vault

`CURRENTS_API_KEY`, `GEMINI_API_KEY`, and the DB password live in Vault. Terraform reads them and
injects them as Container Instance environment variables. Two consequences to accept explicitly:

- Secrets transit Terraform state → the state backend must be an encrypted, private OCI Object
  Storage bucket, and state access is secret access.
- Rotation means re-applying Terraform, which redeploys the api. Acceptable at this scale; the
  upgrade (app fetches from Vault at boot via instance principals) is a code change deferred until
  rotation frequency makes it worth having.

Everything non-secret stays a plain env var in Terraform, mirroring `.env.example` — including
`CURRENTS_USER_AGENT`, which must be non-empty and should identify the deployment (Cloudflare 403s
default UAs; PROBE-FINDINGS 2).

## 5. Migrations — a discrete deploy step, never on boot

The rule stands (ARCHITECTURE 4). The api image already contains the runner: `pnpm deploy`
materializes `@zammy/storage` into `node_modules`, and its `files` list ships `dist/migrate-cli.js`.
So the migration step is a one-shot Container Instance running **the same image digest being
deployed** with the command overridden to:

```
node node_modules/@zammy/storage/dist/migrate-cli.js
```

Sequence per release: push image → run migration instance to completion → roll the api backends.
No second image, no drift between "what migrated" and "what runs".

## 6. Deploys

Terraform owns the whole release, keyed on image digest:

1. New digest in → Terraform creates replacement Container Instances (`create_before_destroy`).
2. New instances join the backend set; LB health checks (`/readyz`) gate traffic onto them.
3. Old instances drain (connection draining on the backend set, ≥ the 15s SIGTERM window) and are
   destroyed.

This is a poor man's rolling deploy, and at 2–3 instances it is enough. What it does not give —
autoscaling on load, sub-minute rollback — is the OKE trigger listed in §1.

Run Terraform from CI. OCI Resource Manager is optional sugar (it runs Terraform server-side with
state managed for you); decide when the CI pipeline is being written, it changes nothing above.

## 7. Phases

| Phase | Delivers | New work outside IaC |
|---|---|---|
| **0. Pre-flight** | buildable arm64 image in OCIR, CI publish | Dockerfile fix ✅, CI workflow ✅ drafted, OCIR credentials ⬜ |
| **1. Ground** | VCN, subnets, NSGs, gateways, Vault, state bucket | staging VM cloud-init ✅ drafted |
| **2. Data** | PostgreSQL private endpoint + one shared Redis Container Instance | assert `/readyz` says `ready`, not just 200 (`rediss://` ✅ verified but unused — §4) |
| **3. api** | Container Instances, LB `/api/*` routing, migration job, first end-to-end deploy | — |
| **4. web** | static container, path routing, domain + TLS on the LB | `apps/web/Dockerfile`, plus an `image` job publishing to `zammy/web` |
| **5. Ops** | OCI Logging for container stdout, Monitoring alarms (LB unhealthy-backend count, 5xx rate, api restart count), backup verification | — |

Phase 3 is the milestone that proves the shape: image → migrate → roll → healthy behind the LB.
Everything after is accretion.

A note on the **Always Free tier**: OCI's free Ampere allowance still runs the entire Compose stack
on one VM. That is a legitimate zero-cost *staging* environment, and a tempting production
shortcut. Resist the shortcut — it recreates the pet-server failure modes the architecture spent
effort avoiding — but a free always-on staging box is worth having and costs one cloud-init script.
It is also where this plan now starts: see the staging note below.

### Staging first, on Always Free

**Staging is the first environment we build.** Phases 1–3 are executed against the free tier before
any paid production footprint exists. The image is the same image; only environment variables
differ, which is the whole point of the discipline in §1.

This runs in **`ca-toronto-1`**, the tenancy's home region — a requirement, not a preference: Always
Free resources are offered only there (§9.1).

The allowance, verified against Oracle's Always Free reference 2026-08-14:

| Resource | Always Free | Note |
|---|---|---|
| Ampere A1 compute | **2 OCPU / 12 GB** (1,500 OCPU-hrs, 9,000 GB-hrs per month) | **halved from 4/24 on 2026-06-15** |
| Block volume | 200 GB total, 47 GB minimum boot volume | 5 backups |
| Flexible Load Balancer | 1, fixed 10 Mbps | enough to mirror the §4 path-routing topology |
| OCI Database with PostgreSQL | **not included** | staging runs `postgres:17-alpine` on the VM |
| OCI Cache | **not included** | staging runs `redis:7-alpine` on the VM |

⚠️ Oracle cut the Ampere allowance in half on 2026-06-15 without a public announcement, and gave
existing tenancies until **2026-08-18** to shrink or have over-limit resources terminated. Anything
sized against the old 4 OCPU / 24 GB figure — including earlier drafts of this document — is wrong.
2 OCPU / 12 GB still runs the stack comfortably (the Compose limits total under 1 GB), but **verify**
the tenancy is inside the new limit before building on it.

The VM bootstrap is `deploy/staging/cloud-init.yaml` — pass it as the instance's `user_data`. It
installs Docker, writes the staging compose file, a `.env` template and the `zammy-deploy` /
`zammy-migrate` helpers, and enables a systemd unit that starts the stack on boot. It contains **no
secrets**: `user_data` is readable from the instance metadata service and via the API, so the `.env`
is filled in once over SSH. Swapping that for an instance principal reading OCI Vault is the same
upgrade §4 defers for production, and it changes nothing else.

Staging runs **`CURRENTS_MODE=live`**, so it exercises the real upstream — the Cloudflare
User-Agent rule, the `x-ratelimit-*` headers and the 7-day `date_range` ceiling are things fixtures
replay rather than enforce. The cost is quota: the free tier's 1000 calls/day are **per key**, so
staging sharing production's key can starve it. Give staging its own Currents key, or cap its share
with `CURRENTS_DAILY_CALL_LIMIT` (and `INTERACTIVE_RESERVE` below it, or the process refuses to
boot). A live mode with no key is also a boot refusal — `zammy-deploy` checks for it before pulling.

`zammy-deploy` implements the §5/§6 sequence on one host — pull the digest, run migrations as a
discrete step with the *same* digest, roll the api, then poll `/readyz` until `status == "ready"`.
It refuses an image reference that is not digest-pinned.

**What staging therefore does not prove.** Postgres and Redis are containers on the VM, not managed
services, so a green staging says nothing about: managed-service private endpoints (§3), PITR
(§4), `rediss://` against a real TLS endpoint (§2.4 — staging talks plaintext `redis://` over the
VM's loopback), or the multi-instance rolling deploy (§6), since the free tier affords one app
instance. Those first execute in production. Staging proves the *shape* — image → migrate → roll →
healthy behind the LB — and that is worth having on day one.

## 8. What this plan deliberately does not do

- **No application code changes** beyond the pre-flight fixes. If OCI work ever seems to require
  one, that is a smell — stop and check which side is wrong.
- **No CDN, no multi-region, no autoscaling.** Each has a named trigger (CDN: measured latency or
  egress cost; scaling/OKE: ingestion outgrowing 3 instances) rather than a date.
- **No AWS burn-down.** ARCHITECTURE 4.1's AWS table stays valid. The only asset this plan creates
  that AWS cannot reuse is the Terraform provider layer, which was always going to be
  target-specific.

## 9. Open questions

1. ~~**Region**~~ ✅ **Resolved 2026-08-17: Canada Southeast (Toronto)** — identifier `ca-toronto-1`,
   region key `yyz`. It is also the tenancy's **home region**, which is the part that matters: Always
   Free resources exist only in the home region, so the §7 staging plan is actually available rather
   than merely priced. (OCI labels both Toronto and Montreal "Canada Southeast"; Montreal is
   `ca-montreal-1` / `yul`. The identifier, not the label, is what goes in config.)

   Two consequences to carry forward:

   - **One availability domain.** `ca-toronto-1` has a single AD, so there is no second AD to retry
     into when free-tier Ampere capacity is unavailable — a routine, transient condition rather than
     a misconfiguration. Asking for less than the full 2 OCPU / 12 GB is likelier to be granted, and
     the stack's own limits total under 3 GB, so a smaller shape runs it comfortably.
   - **Service availability is now checkable, not hypothetical.** Before Phase 2, **verify** that OCI
     Database with PostgreSQL is offered in `ca-toronto-1` — regional service coverage varies, and a
     single-AD region is exactly where a gap would show up. Same for the Phase 4 Flexible LB.
2. **Domain and DNS** — where is the zone hosted, and does TLS terminate on the OCI LB with an OCI
   Certificates cert or a Let's Encrypt cert managed in CI?
3. ~~**OCI Cache vs. container Redis**~~ ✅ **Resolved 2026-08-17: container Redis** (§4). The
   ~$30/month for a managed cache is not worth it when queue loss is survivable by design. Revisit
   if per-topic fairness resets or flush-driven latency ever start showing up in practice.
4. **Gemini egress** — labels are optional by design, but confirm the NAT egress path and the
   pinned model are reachable/valid from the chosen region on day one, or labels silently fall back
   to the bigram extractor and nobody notices.
