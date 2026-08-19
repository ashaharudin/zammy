# Deployment plan — Oracle Cloud Infrastructure (OCI)

**Status: pre-flight complete (2026-08-18); nothing provisioned yet beyond the two OCIR
repositories.** The tenancy was not empty — an unrelated `oci-dev-tools` quickstart stack collided
with §3 (resolved, §9.5). The first environment is **staging on the Always Free tier** (§7);
production follows. OCI is the deployment target; AWS (ARCHITECTURE 4.1) remains an option, not an
immediate goal. Nothing here may leak OCI-specific behaviour into application code, so the AWS
mapping stays a Terraform rewrite away — the same discipline that made the AWS plan cheap to hold:
one image, env vars as the only difference between environments, migrations as a discrete deploy
step, `/healthz` for liveness, `/readyz` for routing.

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
| IaC | — | "Terraform or CDK" | **Terraform** (settles the open 4.1 choice: CDK is AWS-only) |

**Why Container Instances, not OKE.** One service. Container Instances are the Fargate analog —
serverless containers, per-second billing, no cluster. They lack orchestration (autoscaling,
rolling deploys, automatic LB registration); at 1–3 instances Terraform supplies all three (§6).
If ingestion outgrows that, OKE is the escalation path, infrastructure-only — ARCHITECTURE 9.1
already survives instance recycling, the hard part.

**Why one LB for both `web` and `api`.** OCI has no first-class CDN, and Object Storage buckets do
not serve custom domains with TLS. Path-routing one LB (`/api/*` → api backend set, everything
else → static web) gives one origin and deletes the CORS surface: `CORS_ORIGIN` becomes same-origin
in production. A CDN later means fronting the whole thing with Cloudflare — additive, not
structural.

## 2. Pre-flight — work that must land before any OCI work

All four done as of 2026-08-18; nothing here blocks provisioning.

1. ✅ **api Dockerfile `deps` stage fixed** (`01a0e5e`): copies `packages/storage/package.json`,
   and the deploy-tree import guard resolves all four `@zammy/*` packages at build time — closed,
   not hidden.
2. ✅ **CPU architecture: arm64** — never really a choice; the targeted Ampere shapes are
   arm64-only. Verified 2026-08-14 by building for `linux/arm64` (192 MB, node 22 arm64, import
   guard green). Pinned by the CI runner label (`ubuntu-24.04-arm`, native arm64) rather than a
   `--platform` flag, which is harder to forget.
3. ✅ **CI publishes to OCIR — first image 2026-08-18.** Build on push to `main`, tag with the git
   SHA, push to a private OCIR repo. Terraform deploys by digest, never `latest` (the README
   documents the stale-image failure mode this prevents; it is worse in production). The `publish
   image to OCIR` job in `.github/workflows/ci.yml` ran green on `main` (run `32179012381`, commit
   `d7929cd`), pushing

   ```
   ocir.ca-toronto-1.oci.oraclecloud.com/yzj9bnmurdga/zammy/api@sha256:f9505b8dbc7a1c12548aaed56070d7064d671a8fe8a4d2a9a65181cde88ea927
   ```

   Read the digest from the job's `digest`/`image` outputs rather than reconstructing it by hand.
4. ✅ **`rediss://` verified 2026-08-14, no application change needed.** Tested against a TLS-only
   Redis 7 (plaintext port disabled) via the real construction path — a bare URL string with no TLS
   options, as in `server.ts`, `ingest-queue.ts`, `chores.ts`. ioredis negotiated TLSv1.3
   (`authorized: true`) and completed a set/get; a BullMQ queue and worker over the same URL
   completed a job. Plaintext `redis://` against that server and `rediss://` against an untrusted
   certificate both failed, correctly. **One dormant condition:** this works because the cert
   chains to a root Node trusts; an Oracle private CA would fail with the unhelpful `Connection is
   closed.` (no mention of TLS), remedied outside application code via `NODE_EXTRA_CA_CERTS`, so §8
   holds. §4 settles on plaintext `redis://` inside the VCN, so nothing current exercises this —
   recorded so adopting OCI Cache later is a `REDIS_URL` change plus a CA check, not a discovery.

   ✅ **Partly fixed 2026-08-18: a malformed `REDIS_URL` is now a boot refusal.** It was validated
   as any non-empty string, so `http://cache:6379`, `redis//cache:6379` and `redis:6379` all
   passed — the last worst: ioredis resolves protocol-with-no-host to *localhost*, connecting to
   the wrong Redis and reporting healthy. It must now parse as `redis://`/`rediss://` **with a
   host** — the one cause that can never heal becomes the boot refusal every other unusable setting
   gets (ARCHITECTURE 12). A well-formed URL pointing at something not answering still degrades and
   keeps serving, on purpose.

   ⚠️ **The rest of the hazard stands for causes configuration cannot see.** Redis down is
   survivable by design: `/readyz` returns **200** with `status: "degraded"` when only Redis fails
   (`health.ts`); a boot-time Redis error is logged as a warning and swallowed (`server.ts`). So an
   NSG that forgot the cache port, or a Redis container that never started, yields healthy LB
   checks and an ingest queue silently doing nothing. It must stay that way — unreadying every
   instance over a survivable dependency turns degradation into an outage — so Phase 2's acceptance
   check must assert `status == "ready"` and inspect `checks.redis` (both in the `/readyz`
   payload), not merely HTTP 200. Confirmed 2026-08-14: with Redis stopped, `/readyz` returned 200
   and `degraded`, and the `zammy-deploy` gate blocked on it.

### What CI needs from the tenancy

Repository-level **variables** (not environment-level — `ci.yml` declares no `environment:`, so
environment-scoped values would be invisible to it):

- `OCI_REGISTRY` = **`ocir.ca-toronto-1.oci.oraclecloud.com`** (legacy `yyz.ocir.io` still
  resolves). Keep the registry in the instances' region; cross-region pulls buy egress and latency
  per deploy.
- `OCI_NAMESPACE` = **`yzj9bnmurdga`** — the tenancy's object-storage namespace (auto-generated,
  not the tenancy name); Profile → Tenancy, same page as Home Region.
- `OCI_REPO_PREFIX` = **`zammy`** — grouping only; the job appends `/api`, Phase 4's web job
  `/web`.

Repository **secrets**: `OCI_USERNAME` — `<namespace>/<user>`, or
`<namespace>/<domain-name>/<user>` with identity domains (the default IDCS domain is literally
`oracleidentitycloudservice`; the console's Profile menu shows `<domain>/<user>` for federated
users, so read it off). `OCI_AUTH_TOKEN` — User settings → Tokens and keys; OCIR does not accept
the console password.

**All five set** 2026-08-17; the push in item 3 proves the pair authenticates. `OCI_AUTH_TOKEN` is
registry-scoped (push/pull only). Terraform and the `oci` CLI need a separate API signing key —
which does not exist yet and should not be a repository secret shared with the build.

#### Repository naming

One repository per deployable image, grouped under `zammy`:

| Image | OCIR repository | Built from |
|---|---|---|
| api | `<namespace>/zammy/api` | `apps/api/Dockerfile` |
| web | `<namespace>/zammy/web` | `apps/web/Dockerfile` (Phase 4, does not exist yet) |

The component is hardcoded in the workflow, not a variable: which image a job publishes is a
property of that job (its Dockerfile), while the variable carries only what differs per tenancy —
so the api job cannot publish over the web path and a variable edit cannot silently redirect a
build. Cost: one line per job.

Create repositories **private** before the first push — auto-create on push takes visibility from a
tenancy default rather than a decision, and reserving `zammy/web` costs nothing.

✅ **Both exist, both private**, verified 2026-08-18. Created 2026-08-17 at 20:33/20:34 UTC, before
the first push at 22:10 — so visibility was a decision and `zammy/web` is reserved. `zammy/api`
holds 4 distinct digests across 5 tags; `ecb7fc9` and `d7929cd` share a digest — the reproducible
build working, not a mis-tag.

## 3. Network layout

One VCN, three subnets:

- **Public** — the load balancer only.
- **Private app** — Container Instances. Egress via a **NAT gateway** (the api reaches the Currents
  API and Gemini) plus a **service gateway** for OCIR, Vault and Logging without hairpinning
  through NAT.
- **Private data** — OCI Database with PostgreSQL (VCN-native, private-endpoint only — the wanted
  topology) and the Redis Container Instance (§4). Redis is a container, so *we* keep it off the
  public internet: no public IP, no LB backend, enforced by the NSG rather than a service default.

NSGs, not security lists: LB → app on the api port; app → 5432 and the cache port; nothing else. No
public path to data stores exists even misconfigured.

## 4. The pieces

### api — Container Instances behind the LB

- Two instances minimum from day one: ARCHITECTURE 9.1 made instance count a knob; one instance
  would pay for that work and not use it.
- **LB backend health check → `/readyz`; container restart check → `/healthz`** — the split
  health.ts encodes. A failing dependency must take an instance out of *rotation*, not get it
  *restarted*: restarting fixes nothing, and a restart loop during an upstream outage masks the
  signal. Never wire `/readyz` to anything that restarts.
- `stop_grace_period` 15s in Compose matched the ECS stop timeout; Container Instances have the
  same graceful-shutdown window (**verify** the default; set ≥15s). The app drains on SIGTERM as
  PID 1 — no init shim.
- Shape: 1 OCPU / 4–8 GB per instance (Ampere). The api is I/O- and quota-bound, not CPU-bound;
  measure before buying more.

### web — static container on the same LB

A minimal nginx (or Caddy) image: build stage runs `pnpm --filter @zammy/web build`, runtime serves
`dist/`. The web API base URL is build-time configurable (ARCHITECTURE 4.1); with same-origin
routing it is simply `/api`. Needs a new `apps/web/Dockerfile` (§7).

### Postgres — OCI Database with PostgreSQL

- PG 17, matching dev — supported since April 2026, no forced downgrade.
- Smallest shape to start; automated backups on; **verify** PITR — the AWS plan promised RDS-grade
  PITR, so check the OCI service's backup/restore granularity against that promise.
- `DATABASE_URL` points at the private endpoint. Kysely + `pg` need nothing OCI-specific.

### Redis — a container, decided

**Decision (2026-08-17): a Redis container, not OCI Cache.** ~$5–10/month against OCI Cache's ~$28
floor for a 2 GB node ~8× oversized next to the 256 MB dev ceiling. ARCHITECTURE 11 makes this a
cost decision, not correctness: a lost queue job re-opens a coverage gap the next reader repairs.
The swap back is a `REDIS_URL` change if that ever stops being true.

**Its image comes from OCIR, not Docker Hub — a requirement.** The private data subnet has no
internet route (§3; `deploy/terraform/network.tf` has no default route at all), so a Container
Instance there reaches OCIR over the service gateway and cannot reach `docker.io`. The
alternative — a NAT route on the data subnet — would give the data stores outbound internet access
purely to fetch a public image. Set up 2026-08-19:

- `<namespace>/zammy/redis` created **private**, explicitly rather than by push auto-create (§2).
- `.github/workflows/mirror-image.yml` copies on `workflow_dispatch`. It runs in CI because pushing
  needs `OCI_USERNAME`/`OCI_AUTH_TOKEN`, already secrets there — no registry credential handled by
  hand, and a version bump is one click.
- The upstream is **digest-pinned**; the job refuses a bare tag, which would copy something
  different each run. `redis:7-alpine` is currently
  `sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2` (index), with
  `linux/arm64/v8` at `sha256:102aa93d02c163a634662ec18a1a1db51bf5b8b6a2f28547ce24626218a40d54`.
- The whole manifest index is copied, and the job **asserts the mirrored digest equals
  upstream's** — a mismatch would mean the mirror is not the image reviewed.

⚠️ **Not for staging**, which runs Postgres and Redis as containers on one VM in the app subnet
(NAT egress on 443) and pulls `redis:7-alpine`/`postgres:17-alpine` from Docker Hub per cloud-init.
The mirror is for the production topology, where Redis is a Container Instance in the data subnet;
pointing staging at it is reasonable later, not what unblocks anything today.

**One shared instance, never a sidecar per api instance.** Three things in Redis are cross-instance
by design — the ingest queue (§9.1), single-flight (§7), the per-topic daily cap (§9.4) —
per-instance Redis fragments all three: two instances each plan the same segment, and a hot topic's
20-call cap is enforced twice over. Run it as its own Container Instance in the private data
subnet.

**Storage is ephemeral, acceptably.** Container Instances support only `EMPTYDIR`/`CONFIGFILE`
volumes; block volumes cannot attach, and Redis persistence over File Storage (NFS) is worse than
none. A recycle flushes it, costing precisely:

- **Queue jobs** — dropped; re-opened as coverage gaps the next reader repairs (§11). The
  designed-for case.
- **Page cache** — all TTL'd; a flush costs latency and quota, never correctness (§7.1).
- **Per-topic daily caps** — reset, so a topic can exceed its 20-call share on a recycle day.
  Bounded by the global daily quota, which is *not* in Redis — the governor observes upstream's
  `x-ratelimit-*` headers, so the 1000/day ceiling survives. Fairness degrades; the budget does
  not blow.
- **Single-flight locks** — lost; briefly duplicated work. Self-correcting.

Set `--maxmemory` with `volatile-lru`, as dev compose does: cache keys may be evicted freely; queue
keys carry no TTL and must not be.

**This takes `rediss://` off the critical path** — traffic is plaintext inside the VCN, so §2.4's
verification is recorded insurance, not a Phase 2 blocker.

### Secrets — OCI Vault

`CURRENTS_API_KEY`, `GEMINI_API_KEY`, `GNEWS_API_KEY` and the DB password live in Vault; Terraform
reads them and injects them as Container Instance env vars. Two accepted consequences:

- Secrets transit Terraform state → the state backend must be an encrypted, private OCI Object
  Storage bucket, and state access is secret access.
- Rotation = re-apply Terraform = redeploy the api. Acceptable at this scale; the upgrade (app
  fetches from Vault at boot via instance principals) is deferred until rotation frequency warrants
  it.

#### The vault exists — created by hand 2026-08-18; Terraform must **import** it

Phase 1 owns the vault in IaC, but it pre-exists; a `oci_kms_vault` resource without an import
would create a second one:

| Resource | Name | OCID |
|---|---|---|
| Vault (`DEFAULT`) | `zammy` | `ocid1.vault.oc1.ca-toronto-1.evvij2j7aaemg.ab2g6ljrocken2bfqla5mn4xxenlvsilkkccl6iovt4k2wk3a4anlziovtnq` |
| Master key (AES-256, `SOFTWARE`) | `zammy-secrets` | `ocid1.key.oc1.ca-toronto-1.evvij2j7aaemg.ab2g6ljrsqognh3zn7khhzolsytn4bn7orkpohou77s4uty3u7hbcfbws4ra` |

Both live in the **tenancy root** compartment (§9.5 — no other exists), tagged
`managed-by: manual-pending-terraform` so the imports are identifiable without this table. The
management endpoint is `https://evvij2j7aaemg-management.kms.ca-toronto-1.oraclecloud.com` —
vault-specific; `kms management` CLI commands need it as `--endpoint`.

**Type `DEFAULT`, deliberately.** `virtual-private-vault-count` is **0** here, so the expensive
private-partition type cannot be created even by accident — useful given §9.6.

✅ **The vault is Always Free — an earlier draft got this wrong.** The free tier covers **20 HSM
key versions and 150 secrets**, against 1 key version and 4 secrets in use; §7's worry that the
vault was the resource most exposed to a trial ending was misplaced.

⚠️ **Unsettled: this key is `SOFTWARE`; the free entitlement names `HSM`.** The limits API meters
them separately (`virtual-vault-keyversion-count` vs `virtual-vault-softwarekeyversion-count`), so
whether a software key version is equally free is **verify**. Small, not urgent: HSM is explicitly
free to 20 versions and stronger (a key created today would be HSM), but switching means recreating
all four secrets by hand — a secret's encryption key is **fixed at creation** (`oci vault secret
update` takes no `--key-id`). **Leave it; §9.6's alert answers it:** nothing billing through a full
cycle means software key versions are free; a few cents prices the decision.

⚠️ **A vault cannot be deleted promptly** — deletion is only *scheduled*, minimum 7 days out. Not a
resource to create speculatively; a Phase 1 teardown is not same-day.

**What the vault holds**, verified by name 2026-08-19 — seven active secrets of 150. Terraform
reads these **by name**, which is why the names are agreed rather than improvised:

| Secret | Holds |
|---|---|
| `staging-currents-api-key` | `CURRENTS_API_KEY` |
| `staging-gemini-api-key` | `GEMINI_API_KEY` — optional; absent means labels fall back to the bigram extractor (§9.4) |
| `staging-gnews-api-key` | `GNEWS_API_KEY` — only consumed when `GNEWS_ENABLED=true` |
| `staging-postgres-password` | `POSTGRES_PASSWORD` for the staging compose stack |
| `zammy-info-tls-key` | the certificate's private key (§9.2) |
| `zammy-info-tls-cert` | the leaf certificate |
| `zammy-info-tls-chain` | SSL.com's intermediates — the LB listener needs these separately, not folded into the leaf |

**Two naming conventions, deliberately.** Credentials are **environment-prefixed** — production
needs its own values for the same four names, and a second vault would only add a key version. TLS
material is **domain-keyed** — a property of `zammy.info`, not an environment; one certificate,
whichever environment answers for the name (§7). Do not "tidy" the TLS three into a `staging-`
prefix: names are **immutable** (`oci vault secret update` takes no `--secret-name`), so a wrong
prefix can only be duplicated, never renamed. **No dates or serials in names:** renewal (first due
2027-03-05) adds a *version* to the same secret, keeping "what is deployed now" answerable from
version history — a `…-2026` name would force a fresh secret every 197 days.

Secret *values* are set outside this repo and outside any agent's hands — Console, or
`oci vault secret create-base64` with the value from a prompt, never an argument. Contents were not
read back, so two paste-time mistakes remain possible, neither surfacing until a listener refuses
to start: a key not paired to the certificate, and a "chain" that is really the leaf again.
**Phase 1 should compare the stored key against the `pubkey_sha256` in §9.2 before configuring the
listener** — one command, far cheaper than debugging an LB.

Everything non-secret stays a plain env var in Terraform, mirroring `.env.example` — including
`CURRENTS_USER_AGENT`, which must be non-empty and identify the deployment (Cloudflare 403s default
UAs; PROBE-FINDINGS 2).

## 5. Migrations — a discrete deploy step, never on boot

The rule stands (ARCHITECTURE 4). The api image contains the runner: `pnpm deploy` materializes
`@zammy/storage` into `node_modules`, whose `files` list ships `dist/migrate-cli.js`. The migration
step is a one-shot Container Instance running **the same image digest being deployed** with the
command overridden to:

```
node node_modules/@zammy/storage/dist/migrate-cli.js
```

Per release: push image → run migration instance to completion → roll the api backends. No second
image, no drift between "what migrated" and "what runs".

## 6. Deploys

Terraform owns the release, keyed on image digest:

1. New digest → replacement Container Instances (`create_before_destroy`).
2. They join the backend set; LB `/readyz` checks gate traffic onto them.
3. Old instances drain (connection draining ≥ the 15s SIGTERM window) and are destroyed.

A poor man's rolling deploy — enough at 2–3 instances. What it lacks (autoscaling, sub-minute
rollback) is the OKE trigger in §1.

Run Terraform from CI. OCI Resource Manager (server-side Terraform, managed state) is optional
sugar; decide when the CI pipeline is written.

## 7. Phases

| Phase | Delivers | New work outside IaC |
|---|---|---|
| **0. Pre-flight** | buildable arm64 image in OCIR, CI publish | ✅ **complete** — Dockerfile fix, CI workflow, OCIR credentials, first digest pushed (§2) |
| **1. Ground** | VCN, subnets, NSGs, gateways, Vault, state bucket | ~~delete the `oci-dev-tools` stack first (§9.5)~~ ✅; budget + spend alert (§9.6) ✅; import the existing vault **and budget** rather than creating them (§4, §9.6) ⬜; staging VM cloud-init ✅ drafted |
| **2. Data** | PostgreSQL private endpoint + one shared Redis Container Instance | assert `/readyz` says `ready`, not just 200 (`rediss://` ✅ verified but unused — §4) |
| **3. api** | Container Instances, LB `/api/*` routing, migration job, first end-to-end deploy | seed the database from the dev archive once, after the first migrate (§7) ⬜ |
| **4. web** | static container, path routing, domain + TLS on the LB | `apps/web/Dockerfile`, plus an `image` job publishing to `zammy/web`; point `www` at the LB rather than Namecheap parking, which also brings `www` under this zone's CAA (§9.2) ⬜ |
| **5. Ops** | OCI Logging for container stdout, Monitoring alarms (LB unhealthy-backend count, 5xx rate, api restart count), backup verification | **certificate-expiry alarm — first renewal 2027-03-05, manual, ~2×/year (§9.2)** ⬜ |

Phase 3 proves the shape: image → migrate → roll → healthy behind the LB. Everything after is
accretion.

**Always Free note:** the free Ampere allowance runs the entire Compose stack on one VM — a
legitimate zero-cost *staging* environment and a tempting production shortcut. Resist the shortcut
(it recreates the pet-server failure modes the architecture avoided), but free always-on staging
costs one cloud-init script, and it is where this plan starts.

### Staging first, on Always Free

**Staging is the first environment built.** Phases 1–3 run against the free tier before any paid
production footprint exists. Same image; only env vars differ. This runs in **`ca-toronto-1`**, the
home region — a requirement: Always Free resources exist only there (§9.1).

The allowance, verified against Oracle's Always Free reference 2026-08-14:

| Resource | Always Free | Note |
|---|---|---|
| Ampere A1 compute | **2 OCPU / 12 GB** (1,500 OCPU-hrs, 9,000 GB-hrs per month) | **halved from 4/24 on 2026-06-15** |
| Block volume | 200 GB total, 47 GB minimum boot volume | 5 backups |
| Flexible Load Balancer | 1, fixed 10 Mbps | enough to mirror the §4 path-routing topology |
| OCI Database with PostgreSQL | **not included** | staging runs `postgres:17-alpine` on the VM |
| OCI Cache | **not included** | staging runs `redis:7-alpine` on the VM |

⚠️ Oracle halved the Ampere allowance on 2026-06-15 without public announcement, giving existing
tenancies until **2026-08-18** to shrink or be terminated over-limit. Anything sized against the
old 4 OCPU / 24 GB — including earlier drafts of this document — is wrong. 2 OCPU / 12 GB still
runs the stack: the *staging* compose limits total **4.62 GiB** (`postgres` 2G + `redis` 640M +
`api` 2G) — not the "under 1 GB" an earlier draft claimed by reading the dev compose (512M + 320M)
instead of `deploy/staging/cloud-init.yaml`.

✅ **Checked 2026-08-18 — nothing to shrink: A1 usage is zero** (`standard-a1-core-regional-count`
0 used, likewise memory; the only running instance was the x86 micro of §9.5). The deadline passes
with no exposure.

ℹ️ **The tenancy's A1 limits are `16` cores / `96 GB` regional — 4–8× the free allowance.** An
earlier draft read that as evidence of a PAYG upgrade. **Wrong, recorded rather than quietly
edited:** the console (2026-08-18) shows **Free Tier, no payment method on file**. The inference
confused a *service limit* with the *account's spending capability* — separate mechanisms; a Free
Tier account can show generous limits while the allowance is enforced by account type at create
time. What follows:

- **An over-allowance create cannot bill** — it draws trial credits (if the 30-day trial still
  runs) or is refused.
- **The hazard is reclamation, not cost:** at trial end anything outside Always Free is stopped and
  reclaimed, not invoiced. A comfortably sized staging box could simply stop.
- **The staging shape below is safe either way** — 1 OCPU / 12 GB is inside the allowance and
  survives trial end.
- ~~the vault is at risk~~ ✅ Wrong — the vault *is* Always Free (§4). Nothing in the tenancy waits
  to be reclaimed, so the trial's end date is a detail, not a deadline.

**verify** — the one missing fact: **whether the 30-day trial is still running, and its end date**
(credit balance and expiry under Billing & Cost Management → Overview). The raised limits are
consistent with both a live trial and a post-trial Always Free account; only the console's credit
balance separates them.

#### Does staging actually fit? Checked line by line, 2026-08-18

Against the allowance above and `deploy/staging/cloud-init.yaml` as written:

| Allowance | What staging needs | Verdict |
|---|---|---|
| 12 GB memory | 4.62 GiB of container limits + OS | ✅ ~7 GB spare |
| 2 OCPU | no CPU limits set; three containers | ✅ |
| **1,500 OCPU-hrs / 9,000 GB-hrs per month** | 1 OCPU / 12 GB running 24×7 | ✅ fits — 49.6% of OCPU-hrs, **99.2%** of GB-hrs; see below |
| 200 GB block, 47 GB min boot | one boot volume; `postgres-data` on it, Docker logs capped at 10m×3, corpus pruned nightly (TRAILING-CORPUS: ~135k rows) | ✅ ample |
| 1 Flexible LB @ 10 Mbps | staging uses one — the api publishes `3000` for the LB to reach by private IP | ✅ decided, see below |
| Managed PostgreSQL / Cache not included | `postgres:17-alpine` + `redis:7-alpine` as containers | ✅ as designed |
| arm64 | both images publish `linux/arm64` manifests; the api image is built arm64 (§2.2) | ✅ verified |

Two of those needed decisions.

⚠️ **A 2 OCPU / 12 GB VM running all month is 99.2% of the allowance.** A 31-day month is 744
hours: 2 × 744 = **1,488 of 1,500** OCPU-hrs; 12 × 744 = **8,928 of 9,000** GB-hrs. The slack is 12
OCPU-hrs — *six hours of a second 2-OCPU VM per month*. (At 1 OCPU the same six hours survives on
the other axis: 72 spare GB-hrs = six hours of a second 12 GB VM.) So a rebuild whose replacement
overlaps the original spends a meaningful fraction of the month, and there is no room for a second
test instance. The overflow does *not* bill (no payment method — it spends trial credits or is
refused); carelessness costs a staging box that stops, not an invoice.

➡️ **Decided 2026-08-18: keep 12 GB. Revised 2026-08-19 to 1 OCPU.** The alternative, 1 OCPU / 8 GB
(744/1,500 OCPU-hrs = 49.6%; 5,952/9,000 GB-hrs = 66.1%), lost because 12 GB is not slack — it is
Postgres page cache. The seeded corpus is ~163 MB across 28k articles and `story_token_days` is the
largest table (TRAILING-CORPUS); the read paths staging exists to exercise behave like production
only with the working set resident. Memory is the binding constraint, and trimming OCPU alone
changes nothing on the GB axis. The 1-OCPU revision is strictly better — identical memory and page
cache; the second core was bought to no purpose (see the capacity finding below):

| | 2 OCPU / 12 GB | **1 OCPU / 12 GB** |
|---|---|---|
| OCPU-hrs | 1,488 / 1,500 (99.2%) | **744 / 1,500 (49.6%)** |
| GB-hrs | 8,928 / 9,000 (99.2%) | 8,928 / 9,000 (99.2%) |

What the thin GB-hour margin obliges:

- **Never let two staging instances exist at once.** Terraform must **replace destructively** —
  `create_before_destroy` on the staging VM boots the replacement alongside the original and eats a
  6-hour monthly budget. The *opposite* of §6's production rolling deploy; the two environments
  want different lifecycle rules and cannot share a module.
- **Routine deploys are not the risk:** `zammy-deploy` rolls *containers* on one host. Only a
  Terraform-level VM replacement creates a second instance — rare, and now with a named rule.
- **The tightest case is a 31-day month** (February: 1,344/1,500, 89.6%); a plan that holds at 31
  days holds always.
- **§9.6's alert is a canary, not a brake:** with no payment method an overflow cannot bill; what
  the alert detects is *credit consumption* — the earliest sign something outside the allowance is
  running and will not survive trial end.

➡️ **Decided 2026-08-18: staging takes the one free Flexible LB.** The compose comment ("the load
balancer reaches this instance by its private IP") already assumed it, and the LB is half of what
staging is *for*: §7's shape ends "healthy behind the LB", and staging reached directly on port
3000 would skip the step carrying path routing, health-check behaviour and same-origin
`CORS_ORIGIN` (§4). Three consequences:

- **Production's LB is a paid resource the moment it exists** — a Phase 4 budget line, not a
  surprise.
- **Do not share one LB across environments.** Path- or hostname-routing both couples staging
  traffic to production's data plane — the specific thing staging exists to avoid. A saved LB is
  not worth a shared failure domain.
- **10 Mbps is fixed, not burstable — fine for staging.** Keep it in mind in Phase 4, when the LB
  also serves the web bundle (~355 KB JS, ~108 KB gzipped): one cold load is comfortable; a dozen
  concurrent cold loads on a 1.25 MB/s ceiling is not. A slow staging page under parallel testing
  is the shape, not a regression.

⚠️ **Staging therefore meets §9.2 first.** TLS terminates on the LB, so the domain-and-DNS question
(which zone; OCI Certificates vs Let's Encrypt in CI) needs an answer for *staging* before Phase 4
needs one for production. It can be deferred by running staging on plain HTTP behind the LB, at the
cost of not exercising the TLS path production depends on.

#### The instance could not be created at all: capacity, not configuration

🚩 **Phase 1 applied 2026-08-19 with one thing missing — the staging VM.** Every create returned
`500-InternalError, Out of host capacity`. Everything else landed: VCN, three subnets, three route
tables, all three gateways, four NSGs, the state bucket, and the LB with both listeners and the
real certificate installed. `terraform plan` sat at **2 to add** — the instance and its backend.

**Sizing is not the lever, and OCI says so in one call.** Twenty create attempts across
2 OCPU / 12 GB, 1 OCPU / 12 GB and 1 OCPU / 6 GB all refused — ninety minutes to learn what the
**capacity report** answers immediately, read-only, creating nothing:

```
oci compute compute-capacity-report create --compartment-id <c>   --availability-domain PFaU:CA-TORONTO-1-AD-1   --shape-availabilities '[{"instanceShape":"VM.Standard.A1.Flex",
                            "instanceShapeConfig":{"ocpus":1,"memoryInGBs":12}}]'
```

| Shape | Status |
|---|---|
| `VM.Standard.A1.Flex` 1 OCPU / 6 GB | `OUT_OF_HOST_CAPACITY` |
| `VM.Standard.A1.Flex` 2 OCPU / 12 GB | `OUT_OF_HOST_CAPACITY` |
| `VM.Standard.E2.1.Micro` | `OUT_OF_HOST_CAPACITY` |

**Reach for that report before changing a shape.** Shrinking to 6 GB gave up the page cache 12 GB
was chosen for and bought nothing — the mistake the report exists to prevent.

⚠️ **There is no escape hatch:** the AD is the region's only one (§9.1); Always Free exists only in
the home region, so no other region; `VM.Standard.E2.1.Micro` is out of capacity too *and* cannot
run the arm64-only image (§2.2); and a paid shape is unavailable, not merely unwanted — the account
has no payment method. Ampere in this AD or nothing.

**The remaining lever is time, automated.** `deploy/terraform/retry-capacity.sh` polls the capacity
report and runs `terraform apply` only on `AVAILABLE`. It exits once the instance exists (retiring
itself); an atomic lock stops two runs fighting over state; it runs locally because Terraform state
and `~/.oci` both live on one machine. Crontab entry every 30 minutes from 2026-08-20.

The VM bootstrap is `deploy/staging/cloud-init.yaml`, passed as the instance's `user_data`. It
installs Docker, writes the staging compose file, a `.env` template and the `zammy-deploy` /
`zammy-migrate` helpers, and enables a systemd unit starting the stack on boot. It contains **no
secrets** — `user_data` is readable from the instance metadata service and the API — so the `.env`
is filled in once over SSH. Swapping that for an instance principal reading Vault is the same
upgrade §4 defers for production.

#### Staging serves `zammy.info` itself, for now

Decided 2026-08-19. The issued certificate covers `zammy.info` and `www.zammy.info` and nothing
else (§9.2), so this needs no second certificate and fits §7's order. Staging's `CORS_ORIGIN` is
therefore **`https://zammy.info`** — the same-origin value §4 wants, not a staging exception.

Be clear-eyed: **this makes "staging" the public site.** Three consequences:

- **Everything broken is broken in public**, on the real domain. Acceptable with no users; stops
  being so the moment there are any.
- **The per-IP rate limit is exposed to the internet**, promoting `TRUSTED_PROXY_HOPS=1` from tidy
  setting to the thing standing between the ceiling and a forged header (§9.2 — the reason it is a
  count, not a boolean). Set it when the LB goes in front, not afterwards.
- **A public hostname invites indexing.** A staging-quality timeline being crawled deserves a
  deliberate decision — the cheap answer is `noindex` until the system is meant to be found.

⚠️ **The deferred half returns with production, with two problems at once:** production wants
`zammy.info`, so staging moves to something like `staging.zammy.info` — *not covered by this
certificate* — while the single free LB must serve two environments, and sharing one is ruled out
above. Cheap today, a two-part bill later: a second certificate and a second load balancer. Price
it when planning Phase 4, not at cutover.

One simplification: the quota advice below is moot until production exists — there is no production
key to starve, because staging *is* the deployment.

Staging runs **`CURRENTS_MODE=live`**, exercising the real upstream — the Cloudflare User-Agent
rule, `x-ratelimit-*` headers and the 7-day `date_range` ceiling are things fixtures replay rather
than enforce. The cost is quota: the free 1000 calls/day are **per key**, so staging sharing
production's key can starve it. Give staging its own Currents key, or cap its share with
`CURRENTS_DAILY_CALL_LIMIT` (with `INTERACTIVE_RESERVE` below it, or boot refuses). Live mode with
no key is also a boot refusal — `zammy-deploy` checks before pulling.

`zammy-deploy` implements the §5/§6 sequence on one host — pull the digest, run migrations
discretely with the *same* digest, roll the api, poll `/readyz` until `status == "ready"`. It
refuses an image reference that is not digest-pinned.

#### Seed the first staging deployment from the dev database

An empty staging database proves the deploy *shape*, nothing about the read paths — storylines,
trending, the trailing corpus and every ranking decision need a populated corpus, and growing one
live takes weeks at 1000 calls/day. The dev archive is that corpus: **import it once during the
first staging deploy** (Phase 3), then run live. A seed, not a sync — no ongoing replication, none
wanted.

Measured on the dev stack 2026-08-18: **163 MB total**, 28,475 articles spanning 2026-07-14 →
2026-08-18 in one language; sightings are real provider data (`currents` 29,054, `gnews` 483), not
fixture replay — which is what makes importing worth it over synthetic rows. 163 MB is nothing
against the boot volume, and importing consumes no Currents quota.

**Use a logical dump, never a copy of `/var/lib/postgresql/data`** — the dev box and the A1 VM are
different CPU architectures, and `PGDATA` is not a supported transport across them. `pg_dump` is.

The order matters — schema comes from the image being deployed, data from the dump:

1. **`zammy-migrate` first**, so the schema is what the deployed digest says. Confirm the dump's
   origin matches: dev's `kysely_migration` head is `0015-storyline-formation-refusals`; restoring
   into an image built before `0015` (or after a later `0016`) fails on missing or extra columns.
   Compare heads on both sides before starting.
2. **Dump data only, excluding the migration ledger** — `kysely_migration` and
   `kysely_migration_lock` are already correct on the target from step 1; restoring dev's copies
   desynchronises the ledger from the schema:

   ```
   docker exec zammy-postgres-1 pg_dump -U zammy -d zammy -Fc --data-only \
     --exclude-table=kysely_migration --exclude-table=kysely_migration_lock > zammy-dev.dump
   ```

3. **Restore on the VM** into the staging `postgres` container. Custom format lets `pg_restore`
   order inserts around foreign keys; `--disable-triggers` covers what ordering cannot:

   ```
   docker exec -i zammy-postgres-1 pg_restore -U zammy -d zammy --data-only \
     --disable-triggers --no-owner --no-privileges < zammy-dev.dump
   ```

4. ⚠️ **Advance the sequences afterwards** — a data-only restore does not. Left at 1, the first
   live ingest fails on a duplicate primary key, which looks like an ingest bug and is not one:

   ```
   select setval('articles_id_seq',  (select max(id) from articles));
   select setval('fetch_log_id_seq', (select max(id) from fetch_log));
   ```

5. **Expect the first nightly prune to delete some of it.** Retention is 30 days with topic-hit
   protection; the corpus reaches ~35 days back, so the oldest slice goes on the first chore run —
   retention working, not data loss, but morning-after row counts will not match the dump.

**What staging does not prove:** Postgres and Redis are containers, not managed services, so a
green staging says nothing about managed private endpoints (§3), PITR (§4), `rediss://` against a
real TLS endpoint (§2.4 — staging talks plaintext over loopback), or the multi-instance rolling
deploy (§6 — the free tier affords one app instance). Those first execute in production. Staging
proves the *shape*, and that is worth having on day one.

## 8. What this plan deliberately does not do

- **No application code changes** beyond the pre-flight fixes. If OCI work ever seems to require
  one, that is a smell — stop and check which side is wrong.
- **No CDN, no multi-region, no autoscaling.** Each has a named trigger (CDN: measured latency or
  egress cost; scaling/OKE: ingestion outgrowing 3 instances) rather than a date.
- **No AWS burn-down.** ARCHITECTURE 4.1's AWS table stays valid. The only asset AWS cannot reuse
  is the Terraform provider layer, which was always going to be target-specific.

## 9. Open questions

1. ~~**Region**~~ ✅ **Resolved 2026-08-17: Canada Southeast (Toronto)** — `ca-toronto-1`, region
   key `yyz`, the tenancy's **home region**, which is the part that matters: Always Free exists
   only there, so §7's staging plan is actually available. (OCI labels both Toronto and Montreal
   "Canada Southeast"; Montreal is `ca-montreal-1`/`yul`. The identifier, not the label, goes in
   config.) Two consequences:

   - **One availability domain** — no second AD to retry into when free Ampere capacity is
     unavailable, a routine transient rather than a misconfiguration. Smaller asks are likelier
     granted, and the stack's own limits total under 3 GB.
   - ✅ **Service availability checked 2026-08-18 — all three offered in `ca-toronto-1`.** OCI
     Database with PostgreSQL offers versions 13–18 (PG 17 holds, 18 available later); its shapes
     are `VM.Standard3.Flex` (Intel) and `VM.Standard.E5.Flex` (AMD), no Ampere — irrelevant, since
     the arm64 decision is about *our* image and the managed database does not run it. The LB
     offers the `flexible` shape; `VM.Standard.A1.Flex` is listed for compute. Listed ≠ capacity at
     create time — the retry problem stands.

2. **Domain and DNS** — ✅ **half resolved 2026-08-18: the domain is `zammy.info`**, registered
   through Namecheap, zone on Namecheap's own nameservers. Verified from DNS the same day:

   | Record | Value | Reading |
   |---|---|---|
   | `NS` | `dns1/dns2.registrar-servers.com` | Namecheap BasicDNS — records are edited in their panel (or API), not OCI DNS |
   | `A zammy.info` | `162.255.119.225` | Namecheap parking IP — nothing of ours served yet |
   | `CNAME www` | `parkingpage.namecheap.com` | parked |
   | `TXT` | `v=spf1 include:spf.efwd.registrar-servers.com ~all` | Namecheap email forwarding — unrelated; do not clobber when adding records |
   | `CAA` | `0 issue "ssl.com"`, `0 issue "letsencrypt.org"`, `0 issuewild ";"` | added 2026-08-19, after issuance — see below |

   ✅ **TLS half resolved: a Namecheap *Standard SSL* certificate, issued 2026-08-19** — a real
   SSL.com-issued domain-validated certificate, not a proxy, so **TLS terminates on the OCI LB
   exactly as §4 assumes**, `CORS_ORIGIN` is same-origin, and no third party sits in the request
   path. The feared alternative (Namecheap URL forwarding is a 301/302 redirect, not a reverse
   proxy, and could not serve an application) does not apply.

   **The issued certificate**, read from Certificate Transparency rather than the panel:

   | | |
   |---|---|
   | Names | `zammy.info` **and** `www.zammy.info` |
   | Issuer | `C=US, O=SSL Corporation, CN=SSL.com TLS Issuing RSA CA R1` — the intermediate the chain needs |
   | Valid | 2026-08-19T13:59:15Z → **2027-03-05T13:58:09Z** |
   | Lifetime | **197 days**, not a year |
   | `cert_sha256` | `8be9cf14ffee75ed5270a098be297e89a64ae6de0d9475735fbc117cc00c7e07` |
   | `pubkey_sha256` | `2a220e6e3965af6efa0275a0b62a5f1bc11eac8e1303a7d182863c7b14320e16` |

   🔑 **Key pairing verified; the fingerprint is how to re-verify.** The certificate's public key
   hashes to the same value as the private half of the submitted CSR. Check again before
   configuring a listener and at every renewal — a mismatch is a listener that refuses, far cheaper
   caught on a laptop than on an LB:

   ```
   openssl pkey -in zammy.info.key -pubout -outform DER | openssl dgst -sha256
   ```

   **197 days sizes everything else**, worse than the year assumed earlier. Renewal falls due
   **2027-03-05** and ~2×/year after — each manual, each needing a fresh DCV record. So the Phase 5
   certificate-expiry alarm is the only thing between an unattended date and an outage, and
   ACME-in-CI becomes the proportionate answer for *renewal* (settled here only for first
   issuance) at twice the manual toil of a 365-day certificate. A manual step with a hard deadline
   and no alarm is how a site goes dark on a Sunday.

   Between here and a working listener:

   - ✅ **Validated over DNS, not HTTP** — the CNAME was satisfied against a still-parked domain,
     so no listener had to exist first and Phase 1 can bring the LB up with TLS in hand. Keep as
     the renewal method.
   - **Upload the full chain.** An OCI LB listener needs the leaf, the private key *and* SSL.com's
     intermediates. Omitting intermediates gives the classic split failure — fine in a browser that
     cached the issuer, broken for `curl`, Android and strict verifiers — which reads as an app bug
     and is not one.
   - ✅ ~~verify coverage and validity~~ — answered by the table: `www` is a SAN, one certificate
     serves both names; the lifetime is 197 days.

   ⚠️ **The issuer is SSL.com, not Sectigo — an earlier version said Sectigo, and acting on it
   would have broken issuance.** Established twice over: the activation surfaced an `ssl.com` API
   error, and the DCV record requested is a CNAME to **`dcv.ssl.com`**, which is conclusive. It
   matters most for CAA: pinning `sectigo.com` would have told every CA that SSL.com may **not**
   issue — a hard validation failure whose error says nothing about CAA. The records above were
   added 2026-08-19, verified at the authoritative nameserver (a recursive lookup still served a
   cached "no such record"):

   ```
   zammy.info.  IN  CAA  0 issue "ssl.com"
   zammy.info.  IN  CAA  0 issue "letsencrypt.org"
   zammy.info.  IN  CAA  0 issuewild ";"
   ```

   **`letsencrypt.org` is authorised deliberately** — pinning `ssl.com` alone would repeat the
   mistake: ACME-in-CI is this section's own answer to renewal, and a CAA naming only the incumbent
   turns that migration into an issuance failure whose error points at ACME rather than DNS.
   Pre-authorising costs nothing — a listed CA still has to complete domain validation.
   `issuewild ";"` denies wildcards outright, restricting nothing in use (both hosts are named
   explicitly); that row is what to change if a wildcard is ever wanted.

   ⚠️ **These records do not govern `www` yet.** Under RFC 8659, CAA processing *follows* a CNAME
   rather than climbing the validated name's tree, and `www` is still a CNAME to Namecheap parking
   — so a CA validating `www.zammy.info` consults CAA at `parkingpage.namecheap.com` and upward,
   not here. Currently harmless: verified 2026-08-19, neither `parkingpage.namecheap.com`,
   `parking.d.parity.domains` nor `namecheap.com` publishes CAA (also why the certificate covered
   `www` without difficulty). But a third party holds a lever over `www` renewals invisible from
   this zone — if Namecheap ever publishes CAA on that chain, `www` renewal fails for reasons no
   inspection of `zammy.info` reveals. **Phase 4 closes this** by pointing `www` at the LB: no
   longer a CNAME to a third party, the CAA climb reaches this apex.

   **The validation used**, recorded because renewal repeats it: DCV by CNAME —
   `_<order-token>.zammy.info` → `dcv.ssl.com` — added in Namecheap's Advanced DNS as the **host
   label alone** (the panel appends the domain; a full name silently becomes
   `_token.zammy.info.zammy.info` and never validates). `dcv.ssl.com` resolves to nothing by
   design — the CA compares the CNAME's *target string* in the zone, so a failed ping on it is not
   a fault. The token is per-order: expect a fresh record at renewal.

   🔑 **The private key has no backup.** Generated outside the repo on an operator's machine,
   paired to the submitted CSR; losing it means reissuing, not recovering. It must reach the vault
   (§4) before Phase 1 configures a listener, so production TLS is not one file on one laptop.

   ℹ️ **Not retired by this resolution:** working out what a front proxy implied surfaced a bug
   that exists without one — `server.ts` set `trustProxy` to a boolean, trusting the whole
   `X-Forwarded-For` chain, so the client-supplied leftmost entry became `request.ip` and a forged
   header defeated the per-IP rate limit (ARCHITECTURE 12). True behind a single LB, the topology
   just chosen. Fixed by counting hops: **`TRUSTED_PROXY_HOPS=1` is correct here**; over-counting
   to `2` reintroduces the hole exactly as the boolean did.

3. ~~**OCI Cache vs. container Redis**~~ ✅ **Resolved 2026-08-17: container Redis** (§4).
   ~$30/month managed is not worth it when queue loss is survivable by design. Revisit if per-topic
   fairness resets or flush-driven latency show up in practice.

4. **Gemini egress** — narrowed 2026-08-19 to the NAT path alone; the other two halves were
   answerable from what already exists.

   ✅ **The pinned model is valid, on evidence.** `GEMINI_MODEL` defaults to
   `gemini-3.1-flash-lite` against `generativelanguage.googleapis.com/v1beta`, and that exact id is
   the recorded provenance on 1,259 dev storylines — the name resolves and the endpoint answers,
   with no quota spent and no key handled.

   ✅ **The fallback is not silent**, so "nobody notices" was the wrong worry. Two independent
   detectors: `storyline-label-service.ts` logs fallback at **`warn`** with the failure reason
   (Phase 5's OCI Logging surfaces it without new instrumentation), and `storylines.label_source`
   persists the provenance, indexed (`storylines_label_source_idx … WHERE merged_into IS NULL`) —
   the stronger signal: cumulative, queryable, never ages out of retention.

   **So the day-one check is a comparison, not a judgement.** Dev baseline — of 2,028 labelled
   storylines, **393 (~19%) fell back to bigram**:

   | `label_source` | count |
   |---|---|
   | `(null)` | 21,631 |
   | `gemini-3.1-flash-lite` | 1,259 |
   | `bigram` | 393 |
   | `model` | 376 |

   Acceptance: is staging's bigram share near 19% or near 100%. ⚠️ Query the **failure** value
   (`label_source = 'bigram'`), not success values — the 376 rows reading plain `model` predate the
   model id being recorded (`deps.modelId ?? "model"`), so success-keyed queries miscount.

   🚧 **Open: only the NAT path, untestable before it exists.** A Phase 1 item: one `curl` to the
   Gemini endpoint from an instance in the private app subnet, before anything depends on it. An
   NSG or route table that forgets egress produces exactly the 100%-bigram outcome; the fix is
   infrastructure, not application code.

5. ~~**An unrelated `oci-dev-tools` stack squats §3's address space.**~~ ✅ **Deleted 2026-08-18 —
   the tenancy now has no VCN, so `10.0.0.0/16` is free for Phase 1's natural range.** Found the
   same day: VCN `oci-dev-tools-vcn` at **`10.0.0.0/16`**, subnet `10.0.1.0/24`, an NSG, and a
   **running** `VM.Standard.E2.1.Micro` (x86, public IP), created 2026-08-17 by an OCI quickstart
   (tag `Reference: oci-dev-tools`). Deleted by hand rather than imported — nothing worth keeping.
   That settled both problems:

   - **The CIDR:** `10.0.0.0/16` is the default a fresh VCN would claim; coexisting was survivable
     between separate VCNs but forecloses peering and makes route tables ambiguous to read.
   - **Its NSG allowed SSH (tcp/22) and ICMP from `0.0.0.0/0`** on a public-IP instance — the
     quickstart's default, not §3's posture. Nothing of ours exposed, but an internet-reachable
     host in the same tenancy as future production data stores; deletion beats a rule to remember.

   **Removed in dependency order** (OCI refuses a VCN with children): instance
   `instance20260817174112` (terminated) → subnet → route table → internet gateway → NSG → security
   list → VCN → the instance's **47 GB boot volume**. Notes for the next quickstart teardown — two
   cost a retry here:

   - **Route table before internet gateway:** deleting the gateway while a route table references
     it fails with "you must remove the reference".
   - **The boot volume outlives the instance:** `--preserve-boot-volume true` left a 47 GB volume
     `AVAILABLE` and billing; deleted separately after confirming nothing wanted. It had no
     backups — worth checking, since deleting a volume does **not** delete its backups.
   - **The public IP was ephemeral** and died with the instance; a reserved one would survive as an
     orphan — look rather than assume.

   A `TERMINATED` boot-volume record still shows in `bv boot-volume list` — a tombstone: bills
   nothing, ages out.

   Verified after: no VCNs, live instances, block volumes, boot-volume backups or reserved public
   IPs; `standard-a1-core-regional-count` back to 0. What remains is exactly what the plan wants —
   the two OCIR repositories (§2), the vault (§4), the budget (§9.6). Also noted: **no compartment**
   exists beyond the tenancy root. Worth deciding deliberately, not blocking: a compartment can
   hold new resources without moving the OCIR repositories, and both can move later.

6. ~~**No budget or spending alert exists.**~~ ✅ **Created 2026-08-18**, on the tenancy root so
   nothing can be created outside its scope. The cheapest guardrail in the plan and the only one
   catching the failure Always Free invites — not a runaway bill (no payment method, §7) but a
   *single* resource quietly outside the allowance. Everything provisioned is meant to cost nothing
   (and as of 2026-08-19 actually is inside the free tier, vault included), so alert on **actual**
   spend at a low threshold — the first cent sends mail:

   - **Actual, not forecast:** forecast rules need spend history; near zero they stay silent or
     swing wildly.
   - **The email is the point:** a budget with no alert rule notifies nobody — the default state
     this fixes. Send it somewhere read daily, not to the console.
   - **Two shapes to watch**, both easy to reach by accident: Ampere past the free **2 OCPU /
     12 GB** (not the old 4/24), and §1's managed PostgreSQL — no free tier, Phase 2's largest line
     item.

   A budget alert is a smoke detector — it fires after spend starts — so it does not replace
   checking a shape's price before creating it.

   **What exists**, created by hand — so, like the vault (§4), Phase 1 must **import** rather than
   create:

   | Resource | Name | Setting |
   |---|---|---|
   | Budget | `tenancy-any-spend` | $1 / `MONTHLY`, target = tenancy root compartment |
   | Alert rule | `any-spend-at-all` | `ACTUAL`, `ABSOLUTE`, threshold **$0.01** → `ashaharudin@me.com` |

   ```
   ocid1.budget.oc1.ca-toronto-1.amaaaaaahy65lfiaiyqw7hcj5bg737dxyyo56ouzwwx237zukw3iqlqpesda
   ```

   **The $1 amount is not a spending plan.** OCI has no "alert at zero", so the amount is a
   denominator making the first cent the trigger: $0.01 absolute against it means "anything at all
   is billing". It enforces nothing — a budget alert cannot stop a create, only report one; on this
   tenancy it reports credit consumption rather than an invoice, an early warning that something
   outside the allowance is running, not a financial control.

   Two expectations, so neither reads as a fault: **it is not instant** (budgets evaluate
   periodically and cost data lags — mail within hours of the first recorded cent), and **silence
   is the expected outcome**, which makes it a real canary: mail arriving is information, and the
   one open case it settles is whether a `SOFTWARE` key version is free where the allowance names
   `HSM` (§4).

   One CLI trap for whoever automates this: `oci budgets budget alert-rule create
   --wait-for-state` throws `missing 1 required positional argument: 'alert_rule_id'` — a bug in
   the CLI's poller, not a failed create; the rule lands ACTIVE. Omit the flag and verify with
   `alert-rule list`.
