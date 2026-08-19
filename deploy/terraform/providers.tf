# Authenticates from ~/.oci/config, the same profile the CLI uses, so there is one
# set of credentials to reason about rather than two. CI supplies the same values
# through OCI_CLI_* / TF_VAR_* environment variables instead of a file.
provider "oci" {
  region = var.region
}
