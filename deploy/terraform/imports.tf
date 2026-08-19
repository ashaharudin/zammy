# The vault, its key and the budget already exist — created by hand ahead of this
# configuration (§4, §9.6). Terraform must ADOPT them: a plain resource block
# would create a second vault and a second billed key version, and a vault cannot
# be deleted promptly (7-day minimum) if that mistake is made.
#
# `import` blocks rather than `terraform import` commands, so adoption is part of
# the plan and reviewable in a diff rather than a step someone has to remember.
# After the first successful apply these blocks can stay: they are idempotent.

import {
  to = oci_kms_vault.main
  id = "ocid1.vault.oc1.ca-toronto-1.evvij2j7aaemg.ab2g6ljrocken2bfqla5mn4xxenlvsilkkccl6iovt4k2wk3a4anlziovtnq"
}

resource "oci_kms_vault" "main" {
  compartment_id = var.compartment_ocid
  display_name   = var.name_prefix
  vault_type     = "DEFAULT"

  freeform_tags = {
    project    = var.name_prefix
    managed-by = "terraform"
  }

  lifecycle {
    # Deletion is scheduled, not immediate, and this vault holds the TLS private
    # key and every credential staging needs (§4). Destroying it is never a thing
    # a plan should be able to do incidentally.
    prevent_destroy = true
  }
}

# Not a bare OCID: the provider addresses a key through its vault's own
# management endpoint rather than regionally, so the import id is composite. The
# plan says so explicitly when you get it wrong, which is how this was found.
import {
  to = oci_kms_key.secrets
  id = "managementEndpoint/https://evvij2j7aaemg-management.kms.ca-toronto-1.oraclecloud.com/keys/ocid1.key.oc1.ca-toronto-1.evvij2j7aaemg.ab2g6ljrsqognh3zn7khhzolsytn4bn7orkpohou77s4uty3u7hbcfbws4ra"
}

resource "oci_kms_key" "secrets" {
  compartment_id      = var.compartment_ocid
  display_name        = "${var.name_prefix}-secrets"
  management_endpoint = oci_kms_vault.main.management_endpoint

  # SOFTWARE, matching what exists. §4 records that HSM would be the choice today
  # — it is explicitly free to 20 versions — but that a switch means recreating
  # every secret by hand, since a secret's key is fixed at creation. Changing this
  # value alone would replace the key and orphan the secrets encrypted under it.
  protection_mode = "SOFTWARE"

  key_shape {
    algorithm = "AES"
    length    = 32
  }

  freeform_tags = {
    project    = var.name_prefix
    purpose    = "vault-secret-encryption"
    managed-by = "terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

import {
  to = oci_budget_budget.any_spend
  id = "ocid1.budget.oc1.ca-toronto-1.amaaaaaahy65lfiaiyqw7hcj5bg737dxyyo56ouzwwx237zukw3iqlqpesda"
}

resource "oci_budget_budget" "any_spend" {
  compartment_id = var.compartment_ocid
  amount         = 1
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.compartment_ocid]
  display_name   = "tenancy-any-spend"

  # `purpose` is carried over rather than dropped: the first plan showed it being
  # deleted simply because this block had not mentioned it, which is how adopting
  # a resource quietly discards what someone set by hand.
  freeform_tags = {
    project    = var.name_prefix
    purpose    = "any-spend-guardrail"
    managed-by = "terraform"
  }
}
