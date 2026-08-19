# The staging VM: one Ampere box running api, Postgres and Redis as containers
# (deploy/staging/cloud-init.yaml). Staging is the first environment and serves
# zammy.info itself for now (§7).

data "oci_identity_availability_domains" "this" {
  compartment_id = var.compartment_ocid
}

# Resolved rather than pinned to an OCID, because image OCIDs are region-specific
# and rotate as Canonical publishes builds. `arm64` matters: the A1 shapes are
# arm64-only and the api image is built for it (§2.2).
data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# Its OWN NSG, not the shared app one. The SSH exposure below belongs to this
# box specifically, so it disappears when staging does rather than lingering as a
# rule on a group that production Container Instances will also join.
resource "oci_core_network_security_group" "staging_vm" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-nsg-staging-vm"
}

# ⚠️ The one inbound rule that is not machine-to-machine. §3 wants no public SSH
# anywhere, and this is a deliberate exception for staging: the .env that
# cloud-init writes as a template has required variables, so somebody must reach
# the box once to fill it. Narrowed three ways — a single source address, this
# NSG only, and a VM that is temporary by design. The upgrade that removes it
# entirely is an instance principal reading the vault at boot, which cloud-init
# already names as the intended replacement.
resource "oci_core_network_security_group_security_rule" "staging_vm_ssh" {
  network_security_group_id = oci_core_network_security_group.staging_vm.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = var.operator_ssh_cidr
  source_type               = "CIDR_BLOCK"
  description               = "SSH for the one-time .env fill. Single operator address only."

  tcp_options {
    destination_port_range {
      min = 22
      max = 22
    }
  }
}

# Egress for image pulls (Docker Hub, over 443) and the upstreams the api calls.
# Staging pulls postgres/redis from Docker Hub rather than the OCIR mirror, which
# is why this box does not need the mirror that Phase 2's Redis will (§4).
resource "oci_core_network_security_group_security_rule" "staging_vm_egress" {
  network_security_group_id = oci_core_network_security_group.staging_vm.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "HTTPS out: image pulls, Currents, Gemini."

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

# In the PUBLIC subnet, deliberately, though §3 reserves that for the load
# balancer. The alternative was allowing public IPs in the app subnet, which
# would weaken it for every future Container Instance rather than for this one
# temporary box. Confining the compromise to the subnet that is already public
# keeps the private subnets' invariant intact.
resource "oci_core_instance" "staging" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[0].name
  display_name        = "${var.name_prefix}-staging"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.staging_ocpus
    memory_in_gbs = var.staging_memory_gb
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu_arm.images[0].id
  }

  create_vnic_details {
    subnet_id                 = oci_core_subnet.public.id
    assign_public_ip          = true
    nsg_ids                   = [oci_core_network_security_group.staging_vm.id]
    assign_private_dns_record = true
    hostname_label            = "staging"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    # base64gzip, not base64encode: instance metadata is capped at 32000 bytes and
    # the plain base64 of this cloud-init is 35740
    # (the API reported 35886 for the whole metadata map, of which this is the bulk). cloud-init detects the gzip
    # magic bytes and decompresses, so nothing on the box changes. A plan cannot
    # catch this — the limit is enforced server-side at create time.
    #
    # user_data is readable from the metadata service and via the API, which is
    # why cloud-init writes a .env TEMPLATE and no values (see its header).
    user_data = base64gzip(file("${path.module}/../staging/cloud-init.yaml"))
  }

  # A2 capacity in a single-AD region is a routine transient failure (§9.1), and
  # §7 forbids two of these existing at once: 2 OCPU × 744h is 99.2% of the
  # monthly allowance, leaving about six hours of overlap for the whole month.
  # So replacement is destroy-then-create, the opposite of §6's production
  # rolling deploy.
  lifecycle {
    create_before_destroy = false
  }
}
