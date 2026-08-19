# The bucket that will hold this configuration's own state (see versions.tf for
# why the backend is commented out until after the first apply).
data "oci_objectstorage_namespace" "this" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "tfstate" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = "${var.name_prefix}-tfstate"

  # NoPublicAccess is the default, but state contains secrets (§4: they transit
  # Terraform state, which is why state access IS secret access) so it is stated
  # rather than inherited.
  access_type = "NoPublicAccess"

  # Every version of state, not just the newest. The failure this protects
  # against is a corrupt or truncated state write, which is unrecoverable if the
  # only copy has been overwritten.
  versioning = "Enabled"

  # Oracle-managed encryption at rest. Naming the vault key here instead would
  # make the vault a hard dependency of reading state — including the state that
  # describes the vault, which is a bootstrap knot not worth tying.
  freeform_tags = {
    project = var.name_prefix
    purpose = "terraform-state"
  }
}
