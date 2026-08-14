# Deployment plan — Oracle Cloud Infrastructure (OCI)

**Status: planned, not started.** OCI is now the deployment target. AWS (the original target,
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
| Redis 7 | `redis:7` container | ElastiCache | **OCI Cache** (Redis-compatible) — or a Redis container, see §5 |
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

1. **Fix the api Dockerfile `deps` stage.** It copies the manifests for `shared`, `config`,
   `currents-client`, and `api` — but not `packages/storage/package.json`, and `@zammy/api` now
   depends on `@zammy/storage`. `pnpm install --frozen-lockfile` in that stage fails against the
   lockfile's importer list. The image is the deploy artifact; it must build before anything else
   here matters.
2. **Pick the CPU architecture.** OCI's Ampere (arm64) shapes are markedly cheaper than x86 and
   `node:22-alpine` is multi-arch, but the image has only ever been built for the host arch.
   Decide (recommend **arm64**), build and test that image once locally, and pin `--platform` in CI
   so the choice is explicit rather than whatever the builder happened to be.
3. **CI publishes to OCIR.** Build on push to `main`, tag with the git SHA, push to a private OCIR
   repo. Terraform deploys by digest, never by `latest` — the README already documents the stale-
   image failure mode this prevents locally; it is worse in production.
4. **Verify `rediss://` support.** OCI Cache endpoints are TLS-only (**verify**). Confirm the Redis
   client accepts a `rediss://` URL end to end; if it does not, that is an application fix that
   must precede the move.

## 3. Network layout

One VCN, three subnets:

- **Public subnet** — the load balancer only.
- **Private app subnet** — Container Instances. Egress via a **NAT gateway** (the api must reach
  the Currents API and the Gemini endpoint) plus a **service gateway** for OCIR pulls, Vault, and
  Logging without hairpinning through NAT.
- **Private data subnet** — OCI Database with PostgreSQL and OCI Cache. Both services are
  VCN-native and private-endpoint only, which is the topology we want anyway.

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

### Redis — OCI Cache, with an honest alternative

OCI Cache's floor is a 2 GB node (~$28/month at $0.0194/GB-hr). Our dev ceiling is 256 MB, so the
floor is ~8× oversized — but it buys a managed, replicated store for the ingest queue, whose keys
deliberately carry no TTL (see the compose file's eviction-policy note).

The alternative is a Redis container instance (~$5–10/month). ARCHITECTURE 11 makes queue loss
survivable — a lost job re-opens a coverage gap the next reader repairs — so this is *permissible*,
just a paid-in-latency-and-quota risk rather than a correctness one. **Recommendation: start with
OCI Cache.** $30/month is cheap insurance against operating our own persistence, and the swap in
either direction is a `REDIS_URL` change.

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
| **0. Pre-flight** | buildable arm64 image in OCIR, CI publish | Dockerfile fix (§2.1), CI workflow |
| **1. Ground** | VCN, subnets, NSGs, gateways, Vault, state bucket | — |
| **2. Data** | PostgreSQL + OCI Cache, private endpoints | `rediss://` verification (§2.4) |
| **3. api** | Container Instances, LB `/api/*` routing, migration job, first end-to-end deploy | — |
| **4. web** | static container, path routing, domain + TLS on the LB | `apps/web/Dockerfile` |
| **5. Ops** | OCI Logging for container stdout, Monitoring alarms (LB unhealthy-backend count, 5xx rate, api restart count), backup verification | — |

Phase 3 is the milestone that proves the shape: image → migrate → roll → healthy behind the LB.
Everything after is accretion.

A note on the **Always Free tier**: OCI's free Ampere allowance (4 OCPU / 24 GB) can run the entire
Compose stack on one VM. That is a legitimate zero-cost *staging* environment, and a tempting
production shortcut. Resist the shortcut — it recreates the pet-server failure modes the
architecture spent effort avoiding — but a free always-on staging box is worth having and costs
one cloud-init script.

## 8. What this plan deliberately does not do

- **No application code changes** beyond the pre-flight fixes. If OCI work ever seems to require
  one, that is a smell — stop and check which side is wrong.
- **No CDN, no multi-region, no autoscaling.** Each has a named trigger (CDN: measured latency or
  egress cost; scaling/OKE: ingestion outgrowing 3 instances) rather than a date.
- **No AWS burn-down.** ARCHITECTURE 4.1's AWS table stays valid. The only asset this plan creates
  that AWS cannot reuse is the Terraform provider layer, which was always going to be
  target-specific.

## 9. Open questions

1. **Region** — pick by latency to users; also constrains which shapes/services are available.
2. **Domain and DNS** — where is the zone hosted, and does TLS terminate on the OCI LB with an OCI
   Certificates cert or a Let's Encrypt cert managed in CI?
3. **OCI Cache vs. container Redis** (§4) — recommendation is Cache; confirm the ~$30/month is
   acceptable.
4. **Gemini egress** — labels are optional by design, but confirm the NAT egress path and the
   pinned model are reachable/valid from the chosen region on day one, or labels silently fall back
   to the bigram extractor and nobody notices.
