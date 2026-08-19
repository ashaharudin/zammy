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
  # arrange. §6 also leaves OCI Resource Manager open as the alternative: it
  # keeps state server-side and needs no secret key at all.
  #
  # Ready to enable — the namespace below is this tenancy's, so uncommenting and
  # running `terraform init -migrate-state` is the whole change.
  #
  # ⚠️ Do NOT uncomment before the credentials exist. Once a backend is declared,
  # every terraform command in this directory needs it — including the
  # `terraform state list` in retry-capacity.sh, which would start failing and take
  # the capacity retry down with it. Credentials first, then this, then migrate.
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
