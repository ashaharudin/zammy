terraform {
  required_version = ">= 1.9.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }

  # State is deliberately LOCAL for the first apply, because the bucket that will
  # hold it is created by this same configuration (state.tf) — a backend cannot
  # depend on a resource in the configuration it stores.
  #
  # After the first apply, uncomment and run `terraform init -migrate-state`.
  # OCI has no native backend; Object Storage is reached through the s3 backend's
  # compatibility API, which needs a Customer Secret Key (an access key/secret
  # pair generated under User settings → Customer secret keys) — a credential,
  # and therefore a deliberate human step rather than something this file can
  # arrange.
  #
  # This is the ONLY viable path, and the Customer Secret Key is unavoidable.
  # An earlier version of this comment offered OCI Resource Manager as the
  # alternative that "needs no secret key at all". RM does keep state
  # server-side, but it cannot host THIS state — verified 2026-08-20 by probing
  # every version it accepts:
  #
  #   RM rejects terraformVersion 1.6.x, 1.7.x, 1.8.x, 1.9.x, 1.12.x, 1.15.x
  #   and accepts only 1.5.x.
  #
  # Two independent disqualifiers follow. The `required_version` above is
  # >= 1.9.0, so Terraform 1.5 would refuse to run this configuration at all;
  # and the existing local state was written by 1.15.8 (format 4), which 1.5
  # cannot read. The first could be relaxed. The second cannot — Terraform has
  # no state downgrade — so an RM stack can never adopt this state. The bucket
  # backend has no such problem: it is storage, version-agnostic.
  #
  # Ready to enable — the namespace below is this tenancy's, so uncommenting and
  # running `terraform init -migrate-state` is the whole change.
  #
  # ⚠️ Do NOT uncomment before the credentials exist. Once a backend is declared,
  # every terraform command in this directory needs it — including the
  # `terraform state list` in retry-capacity.sh, which would start failing.
  # (That script's crontab entry was removed 2026-08-20, so this no longer breaks
  # an unattended job; it still breaks a manual run.) Credentials, then this,
  # then migrate.
  #
  # backend "s3" {
  #   bucket = "zammy-tfstate"
  #   key    = "phase1/terraform.tfstate"
  #   region = "ca-toronto-1"
  #
  #   # OCI has no native backend; Object Storage is reached through its S3
  #   # compatibility API, which is why every skip_* below is here — they turn off
  #   # AWS-specific behaviour that OCI does not implement. use_path_style is
  #   # required rather than optional: OCI does not do virtual-host-style buckets.
  #   endpoints                   = { s3 = "https://yzj9bnmurdga.compat.objectstorage.ca-toronto-1.oraclecloud.com" }
  #   use_path_style              = true
  #   skip_region_validation      = true
  #   skip_credentials_validation = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  # }
}
