# Phase 1 — Ground

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
generating it is a human step. §6 leaves OCI Resource Manager open as the alternative: server-side
state, no secret key at all.

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
