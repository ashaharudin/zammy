# Deployment plan — Oracle Cloud Infrastructure (OCI)

**Status: pre-flight complete (2026-08-18); nothing in this plan is provisioned yet beyond the two OCIR
repositories.** The tenancy is not empty, though — an unrelated `oci-dev-tools` quickstart stack is
running in it and collides with §3 (see §9). The first environment is
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

Status as of 2026-08-18: all four are done. Nothing in this section blocks provisioning any more.

1. ~~**Fix the api Dockerfile `deps` stage.**~~ ✅ **Done** (`01a0e5e`). It now copies
   `packages/storage/package.json`, and the deploy-tree import guard resolves all four `@zammy/*`
   packages at build time — so the failure is closed, not merely hidden.
2. ~~**Pick the CPU architecture.**~~ ✅ **Decided: arm64** — and it was never really a choice, since
   the Ampere shapes this plan targets are arm64-only. Verified 2026-08-14 by building the image for
   `linux/arm64` (192 MB, node 22 arm64, import guard green). Pinned not by a `--platform` flag but
   by the CI runner label (`ubuntu-24.04-arm`, native arm64), which is harder to forget.
3. ~~**CI publishes to OCIR.**~~ ✅ **Done — first image published 2026-08-18.** Build on push to
   `main`, tag with the git SHA, push to a private OCIR repo. Terraform deploys by digest, never by
   `latest` — the README already documents the stale-image failure mode this prevents locally; it is
   worse in production. The tenancy credentials below are now set on the repository, and the
   `publish image to OCIR` job in `.github/workflows/ci.yml` has run green end to end on `main`
   (run `32179012381`, commit `d7929cd`), pushing

   ```
   ocir.ca-toronto-1.oci.oraclecloud.com/yzj9bnmurdga/zammy/api@sha256:f9505b8dbc7a1c12548aaed56070d7064d671a8fe8a4d2a9a65181cde88ea927
   ```

   So the digest Phase 1 hands to Terraform is a real object now, not a placeholder — and the job's
   `digest`/`image` outputs are the supported way to read it, rather than reconstructing the
   reference by hand.
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

   ✅ **Partly fixed 2026-08-18: a malformed `REDIS_URL` is now a boot refusal.** `@zammy/config`
   validated it as a non-empty string, so `http://cache:6379`, `redis//cache:6379` and `redis:6379`
   all passed — the last being the worst, since it carries the right protocol with no host and ioredis
   resolves that to *localhost*: it connects, to the wrong Redis, and reports itself healthy. It is now
   required to parse as a `redis://` or `rediss://` URL **with a host**, which turns the one cause that
   can never heal into the boot refusal every other unusable setting already gets (ARCHITECTURE 12).
   The survivable case is untouched on purpose: a well-formed URL pointing at something not answering
   yet still degrades and keeps serving.

   ⚠️ **The rest of this hazard stands, for the causes configuration cannot see.** Redis down is survivable
   by design: `/readyz` returns **200** with `status: "degraded"` when only Redis is failing
   (`health.ts`), and a boot-time Redis error is logged as a warning and swallowed (`server.ts`). So
   an NSG that forgot the cache port, or a Redis container that never started, both yield healthy LB
   checks, instances taking traffic, and an ingest queue that silently does nothing. Config validation
   cannot help here — the URL is correct, the thing it names is absent — and it must not: taking every
   instance out of rotation over a survivable dependency would turn degradation into an outage. This
   applies more to a self-run container than it did to a managed endpoint, since there are more ways
   for it to simply not be there. Phase 2's acceptance check must assert
   `status == "ready"` and inspect `checks.redis` — both already in the `/readyz` payload — not
   merely assert HTTP 200. Empirically confirmed 2026-08-14: with Redis stopped, `/readyz` returned
   200 and `degraded`, and the `zammy-deploy` gate blocked on it.

### What CI needs from the tenancy

Repository-level **variables** (not environment-level — `ci.yml` declares no `environment:`, so
environment-scoped values would be invisible to it):

- `OCI_REGISTRY` = **`ocir.ca-toronto-1.oci.oraclecloud.com`** (the legacy `yyz.ocir.io` form still
  resolves). Keep the registry in the same region as the instances that pull from it; cross-region
  pulls work but buy egress and latency on every deploy.
- `OCI_NAMESPACE` = **`yzj9bnmurdga`** — the tenancy's object-storage namespace, an auto-generated
  string rather than the tenancy name. Profile → Tenancy, same page as Home Region.
- `OCI_REPO_PREFIX` = **`zammy`** — the grouping only, not the component. The job appends `/api`
  itself; Phase 4's web job will append `/web`.

Repository **secrets**: `OCI_USERNAME` — `<namespace>/<user>`, or
`<namespace>/<domain-name>/<user>` on a tenancy with identity domains, where the default IDCS domain
is literally named `oracleidentitycloudservice`. The console's Profile menu displays the
`<domain>/<user>` portion for federated users, so it can be read off rather than guessed. And
`OCI_AUTH_TOKEN`, an auth token generated under User settings → Tokens and keys — not the console
password, which OCIR does not accept.

**All five are set** as of 2026-08-17 — the three variables above plus both secrets — and the push
recorded in item 3 proves the pair actually authenticates, which listing them cannot. Note what
`OCI_AUTH_TOKEN` is *not*: it is registry-scoped, so it can push and pull images and nothing else.
Terraform and any `oci` CLI use will need a separate API signing key, which does not exist yet and
should not be a repository secret shared with the build.

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

✅ **Both exist and both are private**, verified against the tenancy 2026-08-18. They were created
2026-08-17 at 20:33 and 20:34 UTC — *before* the first push at 22:10 — so visibility was a decision,
not a tenancy default, and `zammy/web` is reserved. `zammy/api` holds 4 distinct digests across 5
tags; `ecb7fc9` and `d7929cd` resolve to the same digest, which is the reproducible build working as
intended rather than a mis-tag.

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

`CURRENTS_API_KEY`, `GEMINI_API_KEY`, `GNEWS_API_KEY` and the DB password live in Vault. Terraform
reads them and injects them as Container Instance environment variables. Two consequences to accept
explicitly:

- Secrets transit Terraform state → the state backend must be an encrypted, private OCI Object
  Storage bucket, and state access is secret access.
- Rotation means re-applying Terraform, which redeploys the api. Acceptable at this scale; the
  upgrade (app fetches from Vault at boot via instance principals) is a code change deferred until
  rotation frequency makes it worth having.

#### The vault exists — created by hand 2026-08-18, and Terraform must **import** it

Phase 1 owns the vault in IaC, but it was created ahead of that by hand, so writing a
`oci_kms_vault` resource without importing first would try to create a second one:

| Resource | Name | OCID |
|---|---|---|
| Vault (`DEFAULT`) | `zammy` | `ocid1.vault.oc1.ca-toronto-1.evvij2j7aaemg.ab2g6ljrocken2bfqla5mn4xxenlvsilkkccl6iovt4k2wk3a4anlziovtnq` |
| Master key (AES-256, `SOFTWARE`) | `zammy-secrets` | `ocid1.key.oc1.ca-toronto-1.evvij2j7aaemg.ab2g6ljrsqognh3zn7khhzolsytn4bn7orkpohou77s4uty3u7hbcfbws4ra` |

Both live in the **tenancy root** compartment (§9.5 — no other compartment exists yet) and carry
`managed-by: manual-pending-terraform` as a freeform tag, so the ones needing an import are
identifiable without consulting this table. The management endpoint is
`https://evvij2j7aaemg-management.kms.ca-toronto-1.oraclecloud.com` — vault-specific, and the `kms
management` CLI commands need it passed as `--endpoint`.

**Type `DEFAULT`, deliberately.** `virtual-private-vault-count` is **0** in this tenancy, so the
expensive private-partition type cannot be created here even by accident — a useful accident not to be
able to have, given §9.6.

✅ **And the vault is Always Free, which an earlier draft of this section got wrong.** Oracle's free-tier
listing covers **20 key versions of HSM-protected master encryption keys and 150 secrets** — against
which this vault uses **1 key version and 4 secrets**, two orders of magnitude inside the allowance. So
the vault is not the cents-scale expense recorded here before, and §7's worry that it was the resource
most exposed to a trial ending was misplaced.

⚠️ **One detail the allowance wording does not settle: this key is `SOFTWARE`, and the free entitlement
names `HSM`.** The limits API meters the two separately (`virtual-vault-keyversion-count` versus
`virtual-vault-softwarekeyversion-count`), so a software key version is a different metered resource
rather than a cheaper flavour of the same one — and whether it is equally free is **verify**, not
established. Two things make this a small question rather than an urgent one:

- HSM is *explicitly* free to 20 versions and is the stronger mode, so there is no argument for
  `SOFTWARE` on cost or on security. Were the key being created today, HSM would be the choice.
- Switching now is not free of effort: a secret's encryption key is **fixed at creation** —
  `oci vault secret update` takes no `--key-id` — so moving to an HSM key means recreating all four
  secrets and re-entering their values by hand.

**So leave it, and let §9.6's alert answer the question.** If nothing bills through a full cycle, a
software key version is free and there is nothing to do; if a few cents appear, the alert has both
proved itself and priced the decision. That is a better use of the guardrail than churning four secrets
against an unknown.

⚠️ **A vault cannot be deleted promptly.** OCI only *schedules* deletion, minimum 7 days out. So this
is not a resource to create speculatively, and tearing down a Phase 1 mistake will not be same-day.

**What the vault holds**, verified by name 2026-08-19 — seven active secrets, against an allowance of
150. Terraform reads these **by name**, which is the whole reason the names are worth agreeing rather
than improvising:

| Secret | Holds |
|---|---|
| `staging-currents-api-key` | `CURRENTS_API_KEY` |
| `staging-gemini-api-key` | `GEMINI_API_KEY` — optional; absent means labels fall back to the bigram extractor (§9.4) |
| `staging-gnews-api-key` | `GNEWS_API_KEY` — only consumed when `GNEWS_ENABLED=true` |
| `staging-postgres-password` | `POSTGRES_PASSWORD` for the staging compose stack |
| `zammy-info-tls-key` | the certificate's private key (§9.2) |
| `zammy-info-tls-cert` | the leaf certificate |
| `zammy-info-tls-chain` | SSL.com's intermediates — the LB listener needs these separately, not folded into the leaf |

**Two naming conventions, deliberately.** The credentials are **environment-prefixed** because
production needs its own values for the same four names and a second vault would only add a key
version. The TLS material is **domain-keyed** because it is a property of `zammy.info` rather than of
an environment — one certificate, whichever environment currently answers for that name (§7). Nobody
should "tidy" the TLS three into a `staging-` prefix: names are **immutable** (`oci vault secret
update` takes no `--secret-name`), so a wrong prefix cannot be renamed, only duplicated.

**No dates or serials in any of these names, on purpose.** Renewal — first due 2027-03-05 — adds a new
*version* to the same secret. That keeps "what is deployed now" answerable from the secret's version
history, which a `…-2026` name would destroy by forcing a fresh secret every 197 days.

The secret *values* are set outside this repo and outside any agent's hands — Console, or
`oci vault secret create-base64` with the value read from a prompt rather than an argument. The table
above records names and existence only; what is *inside* each one has not been read back, so two
paste-time mistakes remain possible and neither surfaces until a listener refuses to start: a key that
is not the one paired to the certificate, and a "chain" that is really the leaf again. **Phase 1 should
compare the stored key against the `pubkey_sha256` in §9.2 before configuring the listener** — that is
a one-command check with the value in hand, and much cheaper than debugging an LB.

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
| **0. Pre-flight** | buildable arm64 image in OCIR, CI publish | ✅ **complete** — Dockerfile fix, CI workflow, OCIR credentials, first digest pushed (§2) |
| **1. Ground** | VCN, subnets, NSGs, gateways, Vault, state bucket | ~~delete the `oci-dev-tools` stack first (§9.5)~~ ✅; budget + spend alert (§9.6) ✅; import the existing vault **and budget** rather than creating them (§4, §9.6) ⬜; staging VM cloud-init ✅ drafted |
| **2. Data** | PostgreSQL private endpoint + one shared Redis Container Instance | assert `/readyz` says `ready`, not just 200 (`rediss://` ✅ verified but unused — §4) |
| **3. api** | Container Instances, LB `/api/*` routing, migration job, first end-to-end deploy | seed the database from the dev archive once, after the first migrate (§7) ⬜ |
| **4. web** | static container, path routing, domain + TLS on the LB | `apps/web/Dockerfile`, plus an `image` job publishing to `zammy/web`; point `www` at the LB rather than Namecheap parking, which is also what brings `www` under this zone's CAA (§9.2) ⬜ |
| **5. Ops** | OCI Logging for container stdout, Monitoring alarms (LB unhealthy-backend count, 5xx rate, api restart count), backup verification | **certificate-expiry alarm — first renewal 2027-03-05, manual, ~2×/year (§9.2)** ⬜ |

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
2 OCPU / 12 GB still runs the stack comfortably — the *staging* compose limits total **4.62 GiB**
(`postgres` 2G + `redis` 640M + `api` 2G), not the "under 1 GB" an earlier draft of this line claimed by
reading the dev compose file (512M + 320M) instead of `deploy/staging/cloud-init.yaml` — but **verify**
the tenancy is inside the new limit before building on it.

✅ **Checked 2026-08-18 — nothing to shrink: A1 usage is zero.** `standard-a1-core-regional-count`
reports 0 of its limit used, likewise memory, and the only running instance is the x86 micro of §9.5.
The deadline above passes today with no exposure.

ℹ️ **The tenancy's A1 limits are `16` cores / `96 GB` regional — four to eight times the free
allowance.** An earlier draft of this section read that as strong evidence the account had been
upgraded to Pay-As-You-Go. **That was wrong, and it is worth saying so plainly rather than quietly
editing:** checked in the console 2026-08-18, the plan type is **Free Tier with no payment method on
file**. The inference confused a *service limit* with the *account's spending capability*; the two are
separate mechanisms, and a Free Tier account can show generous service limits while the free allowance
is enforced by account type at create time.

What follows from Free Tier + no payment method is nearly the opposite of what the PAYG reading
implied:

- **An over-allowance create cannot produce a bill**, because there is nothing to bill it to. It either
  draws on trial credits, if the 30-day trial is still running, or is refused.
- **So the hazard is not cost, it is reclamation.** If the trial is still active, the raised limits are
  temporary: at trial end anything outside the Always Free allowance is stopped and reclaimed rather
  than invoiced. A staging box sized comfortably today could simply stop.
- **The 2 OCPU / 12 GB decision below is safe either way** — it sits inside the Always Free allowance,
  so it survives trial end untouched. That is now a reason to be *more* confident in it, not less.
- ~~⚠️ **The vault (§4) is the resource actually at risk.**~~ ✅ **Wrong — OCI Vault *is* Always Free**,
  at 20 HSM key versions and 150 secrets, against 1 and 4 in use (§4). It therefore survives a trial
  ending like everything else here, and this section no longer has a named resource waiting to be
  reclaimed. Which also drains most of the urgency from the question below: with nothing in the tenancy
  outside the allowance, the trial's end date stops being a deadline and becomes a detail.

**verify** — the one fact still missing is **whether the 30-day trial is still running, and if so its
end date**, visible as a credit balance and expiry under Billing & Cost Management → Overview. That
date, if it exists, is a real deadline for the vault rather than a curiosity. Ambiguity remains because
the raised limits are consistent with a live trial *and* with a post-trial Always Free account whose
allowance is enforced separately from its limits; the credit balance is what separates them, and only
the console shows it.

#### Does staging actually fit? Checked line by line, 2026-08-18

Against the allowance above and `deploy/staging/cloud-init.yaml` as written:

| Allowance | What staging needs | Verdict |
|---|---|---|
| 12 GB memory | 4.62 GiB of container limits + OS | ✅ ~7 GB spare |
| 2 OCPU | no CPU limits set; three containers | ✅ |
| **1,500 OCPU-hrs / 9,000 GB-hrs per month** | 2 OCPU / 12 GB running 24×7 | ✅ fits, at **99.2%** — decided, see below |
| 200 GB block, 47 GB min boot | one boot volume; `postgres-data` on it, Docker logs capped at 10m×3, corpus pruned nightly (TRAILING-CORPUS: ~135k rows) | ✅ ample |
| 1 Flexible LB @ 10 Mbps | staging uses one — the api publishes `3000` for the LB to reach by private IP | ✅ decided, see below |
| Managed PostgreSQL / Cache not included | `postgres:17-alpine` + `redis:7-alpine` as containers | ✅ as designed |
| arm64 | both images publish `linux/arm64` manifests; the api image is built arm64 (§2.2) | ✅ verified |

Two of those need a decision rather than a note.

⚠️ **A 2 OCPU / 12 GB VM running all month is 99.2% of the allowance, not comfortably inside it.** A
31-day month is 744 hours: 2 × 744 = **1,488 of 1,500** OCPU-hrs and 12 × 744 = **8,928 of 9,000**
GB-hrs. The slack is 12 OCPU-hrs — *six hours of a second 2-OCPU VM per month*. So rebuilding the
staging box, if the replacement boots before the original is terminated, spends a meaningful fraction
of the month's remaining allowance, and there is no room at all for a second instance to test
anything. What the overflow does *not* do is bill: with no payment method on file (above), exceeding
the allowance spends trial credits or is refused outright. The cost of being careless here is a
staging box that stops, not an invoice.

➡️ **Decided 2026-08-18: keep 2 OCPU / 12 GB.** The alternative considered was 1 OCPU / 8 GB —
744/1,500 OCPU-hrs (49.6%) and 5,952/9,000 GB-hrs (66.1%), headroom on both — since memory is the
binding constraint and trimming OCPU alone changes nothing (1 OCPU / 12 GB is still 99.2%). The full
size wins anyway, for a reason the fit table understates: 12 GB is not slack, it is Postgres page
cache. The seeded corpus is ~163 MB across 28k articles and `story_token_days` is the largest table
(TRAILING-CORPUS), so the read paths staging exists to exercise behave like production only if the
working set is actually resident. Sizing down to protect an allowance the deploy path does not spend
would trade the thing being tested for a margin nothing draws on.

What the decision obliges, since 12 OCPU-hrs of slack is not a margin you can be careless with:

- **Never let two staging instances exist at once.** Terraform must **replace destructively** here —
  `create_before_destroy` on the staging VM would boot the replacement alongside the original and eat
  hours out of a 6-hour monthly budget. Note this is the *opposite* of §6's production rolling deploy,
  which depends on `create_before_destroy`; the two environments want different lifecycle rules and the
  module cannot share one.
- **The routine deploy path is not the risk.** `zammy-deploy` rolls *containers* on one host, so a
  normal deploy creates no second instance and spends nothing extra. Only a Terraform-level VM
  replacement does — which is rare, and now has a named rule attached to it.
- **The tightest case is a 31-day month.** Shorter months have real slack (February: 1,344/1,500,
  89.6%), so a plan that holds in a 31-day month holds always.
- **§9.6's alert is a canary, not a brake.** With Free Tier and no payment method (above), an overflow
  cannot become a bill, so the alert is not standing between a typo and an invoice — what it detects is
  *credit consumption*, which is the earliest visible sign that something outside the Always Free
  allowance is running and will therefore not survive trial end. Useful, for a different reason than
  the one it was created for.

➡️ **Decided 2026-08-18: staging takes the one free Flexible LB.** The allowance is a single LB at a
fixed 10 Mbps, and the compose comment ("the load balancer reaches this instance by its private IP")
already assumes staging has it. Confirmed as the deliberate choice, because the LB is not an
optimisation here — it is half of what staging is *for*. §7 says staging proves the shape, "image →
migrate → roll → healthy behind the LB", and a staging environment reached directly on port 3000 would
prove the first three steps and skip the one that carries the path-routing topology, the health-check
behaviour and the same-origin `CORS_ORIGIN` (§4). Three consequences:

- **Production's LB is a paid resource the moment it exists.** Not a surprise to discover in Phase 4 —
  it is the cost of having decided this, and it belongs in that phase's budget line rather than in a
  bill. Nothing else in §4's production topology becomes cheaper by staging having gone first.
- **Do not share one LB across both environments.** Path- or hostname-routing a single LB to both is
  possible and worse: it couples staging traffic to production's data plane, which is the specific
  thing having a staging environment exists to avoid. A saved LB is not worth a shared failure domain.
- **10 Mbps is fixed, not burstable — and that is fine for what staging is.** One or two people
  exercising the API is nowhere near it. The one place to keep it in mind is Phase 4, when the LB also
  serves the web bundle (~355 KB of JS, ~108 KB gzipped): a cold page load is comfortable, a dozen
  concurrent cold loads on a 1.25 MB/s ceiling is not, so a slow staging page under parallel testing
  is the shape rather than a regression.

⚠️ **This also means staging meets §9.2 first.** TLS terminates on the LB, so the open domain-and-DNS
question — which zone, and an OCI Certificates cert versus a Let's Encrypt one managed in CI — needs an
answer for *staging* before Phase 4 needs one for production. It can be deferred by running staging on
plain HTTP behind the LB, at the cost of not exercising the TLS path that production will depend on.

The VM bootstrap is `deploy/staging/cloud-init.yaml` — pass it as the instance's `user_data`. It
installs Docker, writes the staging compose file, a `.env` template and the `zammy-deploy` /
`zammy-migrate` helpers, and enables a systemd unit that starts the stack on boot. It contains **no
secrets**: `user_data` is readable from the instance metadata service and via the API, so the `.env`
is filled in once over SSH. Swapping that for an instance principal reading OCI Vault is the same
upgrade §4 defers for production, and it changes nothing else.

#### Staging serves `zammy.info` itself, for now

Decided 2026-08-19. The issued certificate covers `zammy.info` and `www.zammy.info` and nothing else
(§9.2), so this is the option that needs no second certificate — and it fits §7's order, where staging
is built first and production follows. `CORS_ORIGIN` for staging is therefore **`https://zammy.info`**,
which is the same-origin value §4 wants rather than a staging-specific exception.

The thing to be clear-eyed about: **this makes "staging" the public site.** It is not a private
environment behind an unadvertised name, and three things follow that would otherwise be someone's
unpleasant discovery:

- **Everything broken is broken in public**, on the real domain, for as long as production does not
  exist. That is an acceptable trade for a system with no users yet, and it stops being one the moment
  there are any.
- **The per-IP rate limit is now exposed to the internet rather than to a test harness**, which
  promotes `TRUSTED_PROXY_HOPS=1` from a tidy setting to the thing standing between the ceiling and a
  forged header (§9.2, and the reason it is a count rather than a boolean). It must be set at the same
  time the LB is put in front, not afterwards.
- **A public hostname invites indexing.** A staging-quality timeline being crawled and cached is worth
  a deliberate decision rather than an accident — the cheap answer is `noindex` until the system is
  meant to be found.

⚠️ **The deferred half returns when production arrives, and it returns with two problems at once.**
Production will want `zammy.info`, which means staging must move to a hostname like
`staging.zammy.info` — and *this certificate does not cover that name*, so the move needs a
certificate that does not exist yet. At the same moment the single free Flexible LB (§7 above) has to
serve two environments, and the paragraph there rules out sharing one. So "staging keeps the apex" is
cheap today and buys a two-part bill later: a second certificate and a second load balancer. Worth
pricing when Phase 4 is planned rather than discovering at cutover.

One thing this simplifies: the quota advice below is moot until production exists. There is no
production key for staging to starve, because staging *is* the deployment — so a single Currents key
and the caps below are the whole story for now.

Staging runs **`CURRENTS_MODE=live`**, so it exercises the real upstream — the Cloudflare
User-Agent rule, the `x-ratelimit-*` headers and the 7-day `date_range` ceiling are things fixtures
replay rather than enforce. The cost is quota: the free tier's 1000 calls/day are **per key**, so
staging sharing production's key can starve it. Give staging its own Currents key, or cap its share
with `CURRENTS_DAILY_CALL_LIMIT` (and `INTERACTIVE_RESERVE` below it, or the process refuses to
boot). A live mode with no key is also a boot refusal — `zammy-deploy` checks for it before pulling.

`zammy-deploy` implements the §5/§6 sequence on one host — pull the digest, run migrations as a
discrete step with the *same* digest, roll the api, then poll `/readyz` until `status == "ready"`.
It refuses an image reference that is not digest-pinned.

#### Seed the first staging deployment from the dev database

An empty staging database proves the deploy *shape* and nothing about the read paths — storylines,
trending, the trailing corpus and every ranking decision need a populated corpus to say anything at
all, and growing one from live ingest takes weeks at 1000 calls/day. The dev archive already is that
corpus, so **import it once as part of the first staging deploy** (Phase 3), then let staging run live
from that point. This is a seed, not a sync: there is no ongoing replication and none is wanted.

Measured on the running dev stack 2026-08-18: **163 MB total**, 28,475 articles spanning 2026-07-14 →
2026-08-18 in one language, and the sightings are real provider data (`currents` 29,054, `gnews` 483)
rather than fixture replay — which is what makes the import worth doing rather than generating
synthetic rows. 163 MB is nothing against the boot volume.

**Use a logical dump, never a copy of `/var/lib/postgresql/data`.** Same Postgres major version or
not, the dev box and the A1 staging VM are different CPU architectures, and `PGDATA` is not a
supported transport across them. `pg_dump` is.

The order matters, because schema and data come from different places — the schema from the image
being deployed, the data from the dump:

1. **`zammy-migrate` first**, so the schema is whatever the deployed digest says it is. Then confirm
   the dump's origin matches: dev's `kysely_migration` head is `0015-storyline-formation-refusals`,
   and restoring dev data into an image built before `0015` (or after a later `0016`) fails on columns
   that do not exist yet or are missing. Compare the head on both sides before starting, not after.
2. **Dump data only, and exclude the migration ledger** — `kysely_migration` and
   `kysely_migration_lock` are Kysely's bookkeeping, already correct on the target from step 1, and
   restoring dev's copies over them desynchronises the ledger from the schema:

   ```
   docker exec zammy-postgres-1 pg_dump -U zammy -d zammy -Fc --data-only \
     --exclude-table=kysely_migration --exclude-table=kysely_migration_lock > zammy-dev.dump
   ```

3. **Restore on the VM** into the staging `postgres` container. Custom format lets `pg_restore` order
   the inserts around foreign keys; `--disable-triggers` covers what ordering cannot:

   ```
   docker exec -i zammy-postgres-1 pg_restore -U zammy -d zammy --data-only \
     --disable-triggers --no-owner --no-privileges < zammy-dev.dump
   ```

4. ⚠️ **Advance the sequences afterwards.** A data-only restore does not, and there are two:
   `articles_id_seq` and `fetch_log_id_seq`. Left at 1, the first live ingest after the import fails
   on a duplicate primary key — a failure that looks like an ingest bug and is not one:

   ```
   select setval('articles_id_seq',  (select max(id) from articles));
   select setval('fetch_log_id_seq', (select max(id) from fetch_log));
   ```

5. **Expect the first nightly prune to delete some of it.** Retention is 30 days with topic-hit
   protection, and the imported corpus reaches ~35 days back, so the oldest slice goes on the first
   run of the chore. That is the retention policy working, not data loss — but it means row counts
   taken the morning after will not match the dump, and anyone comparing them needs to know why first.

Importing consumes no Currents quota, which is the other reason to prefer it over waiting for live
ingest to fill the window.

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
   - ~~**Service availability is now checkable, not hypothetical.**~~ ✅ **Checked against the tenancy
     2026-08-18 — all three are offered in `ca-toronto-1`.** OCI Database with PostgreSQL offers
     versions 13 through 18, so the §1 claim of PG 17 holds with 18 already available as a later
     upgrade; its shapes are `VM.Standard3.Flex` (Intel) and `VM.Standard.E5.Flex` (AMD), no Ampere
     option — which matters not at all, since the arm64 decision is about *our* image and the managed
     database does not run it. The load balancer offers the `flexible` shape Phase 4 wants, and
     `VM.Standard.A1.Flex` (Ampere, arm64) is listed for compute. Listed is not the same as
     *capacity available at create time* — the free-tier Ampere retry problem in the bullet above is
     unaffected by this.
2. **Domain and DNS** — ✅ **half resolved 2026-08-18: the domain is `zammy.info`, registered through
   Namecheap, with the zone on Namecheap's own nameservers.** Verified from DNS the same day:

   | Record | Value | Reading |
   |---|---|---|
   | `NS` | `dns1/dns2.registrar-servers.com` | Namecheap BasicDNS — the zone is theirs, so records are edited in their panel (or via their API) rather than in OCI DNS |
   | `A zammy.info` | `162.255.119.225` | Namecheap parking IP — nothing of ours is served yet |
   | `CNAME www` | `parkingpage.namecheap.com` | parked |
   | `TXT` | `v=spf1 include:spf.efwd.registrar-servers.com ~all` | Namecheap email forwarding is configured; unrelated to the app but do not clobber it when adding records |
   | `CAA` | `0 issue "ssl.com"`, `0 issue "letsencrypt.org"`, `0 issuewild ";"` | added 2026-08-19, after issuance — see below for why two CAs and not one |

   ✅ **TLS half resolved: a Namecheap *Standard SSL* certificate, issued 2026-08-19.**
   That is a certificate, not a proxy — an **SSL.com**-issued domain-validated cert — so **TLS terminates on
   the OCI load balancer exactly as §4 assumes**, `CORS_ORIGIN` becomes same-origin in production, and no
   third party sits in the request path. The alternative reading feared here (Namecheap URL forwarding is
   a 301/302 redirect, not a reverse proxy, and could not serve an application at all) does not apply.

   **The issued certificate**, read from Certificate Transparency rather than from the panel:

   | | |
   |---|---|
   | Names | `zammy.info` **and** `www.zammy.info` |
   | Issuer | `C=US, O=SSL Corporation, CN=SSL.com TLS Issuing RSA CA R1` — the intermediate the chain needs |
   | Valid | 2026-08-19T13:59:15Z → **2027-03-05T13:58:09Z** |
   | Lifetime | **197 days**, not a year |
   | `cert_sha256` | `8be9cf14ffee75ed5270a098be297e89a64ae6de0d9475735fbc117cc00c7e07` |
   | `pubkey_sha256` | `2a220e6e3965af6efa0275a0b62a5f1bc11eac8e1303a7d182863c7b14320e16` |

   🔑 **The key pairing is verified, and that fingerprint is how to re-verify it.** The certificate's
   public key hashes to the same value as the private half of the CSR that was submitted, so the key held
   outside the repo is the only key this certificate works with. Checking that again — before configuring
   a listener, and at every renewal — is one command against the file:

   ```
   openssl pkey -in zammy.info.key -pubout -outform DER | openssl dgst -sha256
   ```

   A mismatch there is the difference between a listener that serves and one that refuses, and it is far
   cheaper to catch on a laptop than on an LB.

   **197 days is the number everything else is sized by, and it is worse than the "a year" assumed
   above.** Renewal falls due **2027-03-05** and roughly twice a year after that — each time manual, each
   time needing a fresh DCV record. Two consequences promote themselves from tidy to necessary: the
   certificate-expiry alarm in Phase 5 is now the only thing between an unattended date and an outage,
   and ACME-in-CI stops being the elegant option for *renewal* and starts being the proportionate one, at
   roughly twice the manual toil per year that a 365-day certificate would have cost.

   What remains between here and a working listener:

   - ~~**Validate over DNS, not over HTTP.**~~ ✅ Done exactly that way, and it worked as intended: the
     CNAME was satisfied against a still-parked domain, so no listener had to exist first and Phase 1 can
     bring the LB up with TLS already in hand. Worth keeping as the method for renewals.
   - **Upload the full chain, not just the certificate.** An OCI LB listener needs the leaf, the private
     key *and* SSL.com's intermediates. Omitting intermediates produces the classic split failure —
     fine in a desktop browser that happens to have cached the issuer, broken for `curl`, Android and
     anything doing strict verification — which reads as an app bug and is not one.
   - ~~**verify the coverage and the validity period.**~~ ✅ Both answered by the table above: `www` is
     covered as a SAN, so one certificate serves both names the plan needs, and the lifetime came back at
     197 days rather than the year that was assumed.
   - ⚠️ **Renewal is manual, and that is now a scheduled operational obligation.** Nothing here is ACME,
     so no automation renews this. That makes two follow-ons real rather than theoretical: a certificate
     expiry alarm belongs in Phase 5's monitoring alongside the others, and the ACME-in-CI option this
     question originally posed stays on the table as the answer to *renewal*, having been settled only
     for *first issuance*. A manual step with a hard deadline and no alarm is how a site goes dark on a
     Sunday.

   ⚠️ **The issuer is SSL.com, not Sectigo — an earlier version of this section said Sectigo, and acting
   on it would have broken issuance.** Namecheap issues this product through SSL.com. Established twice
   over: the activation surfaced an `ssl.com` API error, and the DCV record SSL.com asked for is a CNAME
   to **`dcv.ssl.com`**, which is conclusive. The correction matters most for `CAA`: the record this
   section previously proposed, pinning `sectigo.com`, would have told every CA that SSL.com may **not**
   issue for this name — turning a hardening step into a hard validation failure whose error message says
   nothing about CAA. Any CAA record here must authorise **`ssl.com`** (**verify** their published
   identifier). That gate lifted once the certificate issued, and the records were added 2026-08-19 —
   verified at the authoritative nameserver rather than through a resolver, since a recursive lookup was
   still serving a cached "no such record" from before they existed:

   ```
   zammy.info.  IN  CAA  0 issue "ssl.com"
   zammy.info.  IN  CAA  0 issue "letsencrypt.org"
   zammy.info.  IN  CAA  0 issuewild ";"
   ```

   **`letsencrypt.org` is authorised deliberately, and pinning `ssl.com` alone would have been the same
   mistake twice.** This section's own conclusion is that ACME-in-CI is the proportionate answer to
   renewal at a 197-day lifetime; a CAA naming only the incumbent CA turns that migration into an
   issuance failure whose error points at ACME rather than at DNS. Pre-authorising costs nothing in
   safety — a CA listed in CAA still has to complete domain validation before it can issue — and it
   removes a trap that would otherwise be discovered mid-migration. `issuewild ";"` denies wildcards
   outright, which restricts nothing in use: the certificate names `zammy.info` and `www.zammy.info`
   explicitly, so a wildcard has no role here and the row is what to change if that ever stops being true.

   ⚠️ **These records do not govern `www` yet, and the reason is easy to misread.** Under RFC 8659, CAA
   processing *follows* a CNAME rather than climbing the tree of the name being validated — and `www`
   is still a CNAME to Namecheap's parking page. So a CA validating `www.zammy.info` today consults CAA
   at `parkingpage.namecheap.com` and upward, not here. That is currently harmless: verified 2026-08-19,
   neither `parkingpage.namecheap.com`, `parking.d.parity.domains` nor `namecheap.com` publishes any CAA
   record, which is also why the issued certificate covered `www` without difficulty. But it leaves a
   third party holding a lever over `www` renewals that is invisible from this zone — if Namecheap ever
   publishes CAA on that chain, `www` renewal can fail for reasons no inspection of `zammy.info` will
   reveal. **Phase 4 closes this** by pointing `www` at the load balancer instead of at parking: once it
   is no longer a CNAME to a third party, the CAA climb reaches this apex and both names are governed
   here. Worth doing for that reason as well as the obvious one.

   **The validation that was used**, recorded because renewal will repeat it: DCV is by CNAME —
   `_<order-token>.zammy.info` → `dcv.ssl.com` — added in Namecheap's Advanced DNS with the **host label
   alone**, since the panel appends the domain and a full name silently becomes
   `_token.zammy.info.zammy.info` that validates forever. Note also that `dcv.ssl.com` resolves to
   nothing at all, by design: the CA compares the CNAME's *target string* read out of the zone, so a
   failed ping on it is not a fault worth chasing. The token is per-order, so expect a fresh record at
   renewal rather than a standing one.

   🔑 **The private key is the part with no backup.** It was generated outside the repo on an operator's
   machine, paired to the CSR that was submitted; the certificate is worthless without it, and losing it
   means reissuing rather than recovering. It needs to reach the vault (§4) before Phase 1 configures a
   listener, so that the key for production TLS is not a single file on one laptop.

   ℹ️ **One thing this resolution does *not* retire.** Working out what a front proxy would have implied
   surfaced a bug that exists without one: `server.ts` set `trustProxy` to a boolean, trusting the whole
   `X-Forwarded-For` chain, so the client-supplied leftmost entry became `request.ip` and a forged header
   defeated the per-IP rate limit (ARCHITECTURE 12). That is true behind a single load balancer, which is
   the topology just chosen. Fixed separately by counting hops (`TRUSTED_PROXY_HOPS`) — **`1` is the
   correct value for this topology**, and over-counting to `2` would reintroduce the hole exactly as the
   boolean did.
3. ~~**OCI Cache vs. container Redis**~~ ✅ **Resolved 2026-08-17: container Redis** (§4). The
   ~$30/month for a managed cache is not worth it when queue loss is survivable by design. Revisit
   if per-topic fairness resets or flush-driven latency ever start showing up in practice.
4. **Gemini egress** — narrowed 2026-08-19 to the NAT path alone. The other two halves of this
   question turned out to be answerable from what already exists.

   ✅ **The pinned model is valid, on evidence rather than on a day-one test.** `GEMINI_MODEL` defaults
   to `gemini-3.1-flash-lite` against `generativelanguage.googleapis.com/v1beta`, and that exact model
   id is the recorded provenance on 1,259 storylines in the dev corpus — so the name resolves and the
   endpoint answers. No live call was needed to establish it, which also means no quota spent and no
   key handled.

   ✅ **The fallback is not silent, so "nobody notices" was the wrong worry.** Two independent detectors
   already exist:

   - `storyline-label-service.ts` logs the fallback at **`warn`**, with the failure reason attached — so
     Phase 5's OCI Logging surfaces it without new instrumentation.
   - `storylines.label_source` **persists** the provenance and is indexed
     (`storylines_label_source_idx … WHERE merged_into IS NULL`). This is the stronger signal:
     cumulative and queryable, and unlike a log line it does not age out of retention.

   **Which turns the day-one check into a comparison rather than a judgement.** The dev corpus gives a
   baseline — of 2,028 labelled storylines, **393 (~19%) fell back to bigram**:

   | `label_source` | count |
   |---|---|
   | `(null)` | 21,631 |
   | `gemini-3.1-flash-lite` | 1,259 |
   | `bigram` | 393 |
   | `model` | 376 |

   So the acceptance check is not "did Gemini work" but "is staging's bigram share near 19% or near
   100%", which nobody has to interpret. ⚠️ Query the **failure** value — `label_source = 'bigram'` —
   rather than enumerating success values: those 376 rows reading plain `model` predate the model id
   being recorded (`deps.modelId ?? "model"`), so a query keyed on success values silently miscounts.

   🚧 **What remains open is only the NAT path, and it cannot be tested before it exists.** There is no
   VCN, no NAT gateway and no instance to test from, so this is a Phase 1 item: one `curl` to the Gemini
   endpoint from an instance in the private app subnet, before anything depends on it. That is also the
   one failure this section's original worry describes correctly — an NSG or route table that forgets
   egress produces exactly the 100%-bigram outcome above, and the fix is infrastructure rather than
   application code.
5. ~~**An unrelated `oci-dev-tools` stack is already in the tenancy, and it squats §3's address
   space.**~~ ✅ **Deleted 2026-08-18 — the tenancy now contains no VCN at all, so `10.0.0.0/16` is
   free for Phase 1 to take as its natural range.** Found earlier the same day: a VCN `oci-dev-tools-vcn` at **`10.0.0.0/16`** with one subnet `10.0.1.0/24`, an
   NSG, and a **running** `VM.Standard.E2.1.Micro` instance (x86, so unrelated to anything here) with
   a public IP, created 2026-08-17 by an OCI quickstart — freeform tag `Reference: oci-dev-tools`.
   Deleted by hand rather than imported into state, since nothing here was worth keeping. It settled
   both of the problems it created:

   - **The CIDR.** `10.0.0.0/16` is the obvious default a fresh VCN would claim, and deleting frees it
     so Phase 1 can take the natural range instead of documenting a detour. Coexisting was the
     alternative: not fatal between separate VCNs, but it forecloses peering later and makes every
     route table ambiguous to read.
   - **Its NSG allows SSH (tcp/22) from `0.0.0.0/0`**, plus ICMP from anywhere, on an instance with a
     public IP — the quickstart's default rather than a considered choice, and not the posture §3
     describes for anything here. Nothing of ours is exposed by it, but it is an internet-reachable
     host in the same tenancy as the production data stores to come, and deletion removes it rather
     than leaving a rule to remember.

   **What was removed**, in the order it had to happen — OCI refuses a VCN that still has children:

   instance `instance20260817174112` (terminated) → subnet `oci-dev-tools-subnet` → route table
   `oci-dev-tools-route-table` → internet gateway → NSG → security list → VCN → the instance's
   **47 GB boot volume**.

   Three notes for anyone tearing down a quickstart stack again, since two of them cost a retry here:

   - **Route table before internet gateway, not after.** Deleting the gateway while a route table still
     references it fails with an explicit "you must remove the reference" error. An earlier draft of
     this item said "internet gateway and any route table" without an order, which is how the wrong one
     got attempted first.
   - **The boot volume outlives the instance.** Terminating with `--preserve-boot-volume true` leaves a
     47 GB volume `AVAILABLE` and still costing whatever block storage costs on this tenancy; it was
     deleted separately and deliberately, after confirming the box held nothing wanted. It had no
     backups — worth checking, because deleting a volume does **not** delete its backups.
   - **The public IP was ephemeral**, so it died with the instance. Had the quickstart reserved one it
     would have survived as an orphan, which is why it is worth looking rather than assuming.

   A `TERMINATED` boot-volume record still appears in `bv boot-volume list`. That is a tombstone, not a
   resource: it bills nothing and ages out on its own.

   Verified after the fact: no VCNs, no live instances, no block volumes, no boot-volume backups, no
   reserved public IPs, and `standard-a1-core-regional-count` usage back to 0. What remains in the
   tenancy is exactly what the plan wants — the two OCIR repositories (§2), the vault (§4) and the
   budget (§9.6).

   Also noted while looking: **no compartment** exists other than the tenancy root — the OCIR
   repositories and everything above live directly in it. Worth deciding deliberately rather than by
   default, but it is not blocking: a compartment can hold new resources without moving the OCIR
   repositories, and both can move later.
6. ~~**No budget or spending alert exists.**~~ ✅ **Created 2026-08-18** (details at the end of this
   item), on the tenancy root so nothing can be created outside its scope. This is the cheapest guardrail in the
   whole plan and the only one that catches the failure the Always Free tier invites — not a runaway
   bill (§7: the account carries no payment method, so there is no bill to run away), but a *single*
   resource that quietly sits outside the allowance. Everything §7 provisions is meant to cost nothing —
   and as of 2026-08-19 everything in the tenancy actually is inside the free tier, the vault included
   (§4) — so the useful threshold is low: a small monthly amount with an alert rule on **actual** spend
   at a low percentage means the first cent sends mail. Specifically:

   - **Alert on actual, not forecast.** Forecast rules need a spend history to extrapolate from; on a
     tenancy sitting at or near zero they either stay silent or swing wildly. Actual spend crossing a
     couple of dollars is unambiguous.
   - **The email is the point.** A budget with no alert rule attached records a number and notifies
     nobody — which is the default state this item is fixing. Send it somewhere read daily, not to the
     console.
   - **Two shapes to watch**, because both are easy to reach by accident: an Ampere allocation past the
     free **2 OCPU / 12 GB** (§7 — *not* the old 4/24), and the managed PostgreSQL of §1, which has no
     free tier at all and is the largest line item Phase 2 introduces.

   A budget alert is a smoke detector: it fires after the spend has started, not before, so it does
   not replace checking a shape's price before creating it.

   **What exists**, created by hand ahead of the Terraform that should own it — so, like the vault
   (§4), Phase 1 must **import** rather than create:

   | Resource | Name | Setting |
   |---|---|---|
   | Budget | `tenancy-any-spend` | $1 / `MONTHLY`, target = tenancy root compartment |
   | Alert rule | `any-spend-at-all` | `ACTUAL`, `ABSOLUTE`, threshold **$0.01** → `ashaharudin@me.com` |

   ```
   ocid1.budget.oc1.ca-toronto-1.amaaaaaahy65lfiaiyqw7hcj5bg737dxyyo56ouzwwx237zukw3iqlqpesda
   ```

   **The $1 amount is not a spending plan.** OCI has no "alert at zero", so the amount is a
   denominator chosen to make the first cent the trigger: a $0.01 absolute threshold against it means
   "anything at all is billing". Reading it as a budget in the ordinary sense — a limit somebody
   intends to spend up to — inverts what it is for. And it enforces nothing: a budget alert cannot stop
   a create, only report one. On this tenancy what it reports is credit consumption rather than an
   invoice, since there is no payment method (§7) — which makes it an early warning that something
   outside the free allowance is running, not a financial control.

   Two things to expect from it, so neither reads as a fault:

   - **It is not instant.** Budgets are evaluated periodically and cost data itself lags, so the mail
     arrives within hours of the first cent being recorded, not on the second.
   - **Silence is now the expected outcome, which makes it a real canary.** Nothing currently in the
     tenancy is known to sit outside the free tier — the vault included (§4) — so mail arriving is
     information rather than noise. The one open case it would settle is whether a `SOFTWARE` key
     version is free where the allowance names `HSM` (§4); a few cents against this budget answers that
     question more cheaply than any amount of reading.

   One CLI trap, for whoever automates this: `oci budgets budget alert-rule create --wait-for-state`
   throws `missing 1 required positional argument: 'alert_rule_id'`. That is a bug in the CLI's
   poller, not a failed create — the rule lands ACTIVE regardless. Omit the flag and verify with
   `alert-rule list`.
