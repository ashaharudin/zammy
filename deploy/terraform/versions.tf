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
  # backend "s3" {
  #   bucket                      = "zammy-tfstate"
  #   key                         = "phase1/terraform.tfstate"
  #   region                      = "ca-toronto-1"
  #   endpoints                   = { s3 = "https://<namespace>.compat.objectstorage.ca-toronto-1.oraclecloud.com" }
  #   skip_region_validation      = true
  #   skip_credentials_validation = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}
