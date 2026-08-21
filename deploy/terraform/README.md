# Phase 1 — Ground


> ## ⛔ ARCHIVAL — NOT IN USE
>
> **This configuration is frozen. zammy is not deploying on OCI (decided 2026-08-21 — see
> [DEPLOYMENT-OCI](../../docs/DEPLOYMENT-OCI.md) for the capacity evidence).** Nothing further will
> be applied, planned or migrated here.
>
> **The 45 resources it already created are being left in place, not destroyed** — they sit inside
> Always Free and cost nothing. Do **not** run `terraform destroy` on the assumption that walking
> away requires it; and do not run `apply`, since the only thing left to add is the staging VM that
> has no capacity to land on.
>
> Two tasks referenced below are **moot** and should not be started: generating the Customer Secret
> Key, and migrating state to the bucket. State stays local. `retry-capacity.sh` is likewise dead —
> its crontab entry was removed 2026-08-20.

The VCN, subnets, gateways, route tables, NSGs and state bucket of
[DEPLOYMENT-OCI](../../docs/DEPLOYMENT-OCI.md) §3 and §7, plus adoption of the vault, its key and
the budget that already exist.

Nothing applied yet. `tofu plan` against the real tenancy reports **3 to import, 25 to add, 2 to
change, 0 to destroy** — the two changes are freeform tags moving from
`managed-by: manual-pending-terraform` to `terraform`.

## Running it

```
cp terraform.tfvars.example terraform.tfvars   # fill in compartment_ocid
terraform init
terraform plan
```

Credentials come from `~/.oci/config`, the same profile the `oci` CLI uses.

## Bootstrap order, and why state is local at first

`state.tf` creates the bucket meant to hold this configuration's state, and a backend cannot depend
on a resource in the configuration it stores. So:

1. First apply runs with **local state** and creates `zammy-tfstate`.
2. Uncomment the `backend "s3"` block in `versions.tf`, fill in the namespace from the
   `tfstate_bucket` output, and run `terraform init -migrate-state`.

OCI has no native Terraform backend; Object Storage is reached through the S3 compatibility API,
which needs a **Customer Secret Key** (User settings → Customer secret keys) — a credential, so
generating it is a human step.

**That key is unavoidable — Resource Manager is not an escape from it.** An earlier version of this
section offered RM as "server-side state, no secret key at all". RM does keep state server-side,
but it cannot host *this* state: probing every version it accepts (2026-08-20) showed it rejects
`terraformVersion` 1.6.x through 1.15.x and accepts only **1.5.x**. This configuration declares
`required_version >= 1.9.0`, which 1.5 would refuse to run, and the local state was written by
**1.15.8** (format 4), which 1.5 cannot read. The version constraint could be relaxed; the state
cannot — Terraform has no downgrade path — so no RM stack can ever adopt it. The bucket backend is
version-agnostic storage and has no such limit.

## Two things to know before applying

- **The imports are load-bearing.** The vault, key and budget exist already (§4, §9.6). Without the
  `import` blocks a plain apply would create a *second* vault and a second key version — and a
  vault cannot be deleted promptly (OCI only schedules deletion, 7 days minimum). `prevent_destroy`
  guards both.
- **The data subnet has no route to the internet, by design.** The Redis container living there
  (§4) can only pull its image from OCIR: `docker.io/redis:7` is unreachable from that subnet.
  Mirroring redis into OCIR is the intended answer and fits the deploy-by-digest rule; the
  alternative — a NAT route on the data subnet — would give the data stores outbound internet
  access purely to fetch a public image.

## Not in this slice

The staging VM, the load balancer, its listener and the certificate. Phase 1 as §7 defines it is
the network and the state bucket; the compute on top is the next slice, where the Ampere capacity
question (§9.1) and `TRUSTED_PROXY_HOPS=1` (§9.2) first bite.

## The lock file

`.terraform.lock.hcl` is committed, pinning `registry.terraform.io/oracle/oci` at `7.32.0`. Do not
delete it to "fix" a provider problem: unpinned, the next `init` can bring a different version and
a plan that differs from the one reviewed.

Verified with Terraform v1.15.8: `fmt` clean, `validate` passes, `plan` against the live tenancy
reports the numbers above with **0 to destroy** and no attribute removals. An earlier revision was
checked with OpenTofu as a stand-in; both agree — reassuring, but the committed lock is the reason
to trust it.
