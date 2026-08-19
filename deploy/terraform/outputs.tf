output "vcn_id" {
  value = oci_core_vcn.main.id
}

# Phase 2 and 3 consume these: the data stores land in private_data, the api in
# private_app, the load balancer in public.
output "subnet_ids" {
  value = {
    public       = oci_core_subnet.public.id
    private_app  = oci_core_subnet.private_app.id
    private_data = oci_core_subnet.private_data.id
  }
}

output "nsg_ids" {
  value = {
    lb   = oci_core_network_security_group.lb.id
    app  = oci_core_network_security_group.app.id
    data = oci_core_network_security_group.data.id
  }
}

output "tfstate_bucket" {
  description = "Feed the namespace into the s3 backend endpoint in versions.tf when migrating state."
  value = {
    name      = oci_objectstorage_bucket.tfstate.name
    namespace = data.oci_objectstorage_namespace.this.namespace
  }
}

output "vault_management_endpoint" {
  description = "Vault-specific; the kms management CLI and provider calls need it."
  value       = oci_kms_vault.main.management_endpoint
}
