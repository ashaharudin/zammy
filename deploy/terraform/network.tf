# §3: one VCN, three subnets. NSGs rather than security lists carry the rules
# (nsg.tf); the security lists OCI creates by default are left empty and unused.

resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.name_prefix}-vcn"
  dns_label      = var.name_prefix
}

# --- gateways ---------------------------------------------------------------

resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-igw"
  enabled        = true
}

# Egress only, and only for the app subnet: the api has to reach the Currents API
# and the Gemini endpoint (§9.4). Nothing routes IN through a NAT gateway, which
# is what makes it safe for a subnet with no public IPs.
resource "oci_core_nat_gateway" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-nat"
}

# OCIR pulls, Vault reads and Logging writes go over Oracle's own network instead
# of hairpinning through NAT (§3). It also means the data subnet can reach OCIR
# with no internet path at all — see the route table below.
data "oci_core_services" "all" {}

locals {
  # The "All <region> Services In Oracle Services Network" entry. Filtered by
  # name rather than taken by index, because the order of that list is not a
  # contract and an index would silently pick the wrong service one day.
  oracle_services = [
    for svc in data.oci_core_services.all.services : svc
    if can(regex("^All .* Services In Oracle Services Network$", svc.name))
  ]
  oracle_services_gateway_target = one(local.oracle_services)
}

resource "oci_core_service_gateway" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-sgw"

  services {
    service_id = local.oracle_services_gateway_target.id
  }
}

# --- route tables -----------------------------------------------------------

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-rt-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_route_table" "private_app" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-rt-app"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_nat_gateway.main.id
  }

  # More specific than the default route, so Oracle-network traffic prefers the
  # service gateway even though 0.0.0.0/0 would also match.
  route_rules {
    destination       = local.oracle_services_gateway_target.cidr_block
    destination_type  = "SERVICE_CIDR_BLOCK"
    network_entity_id = oci_core_service_gateway.main.id
  }
}

# NO default route, deliberately. The data subnet reaches Oracle services and
# nothing else, so "no public path to the data stores" (§3) is a property of the
# route table rather than a promise about configuration.
#
# ⚠️ This has a consequence §3 does not spell out: the Redis Container Instance
# lives here (§4) and still has to pull an image. Over a service gateway that
# means the image must come from OCIR — `docker.io/redis:7` is unreachable from
# this subnet. Mirroring redis into OCIR is the intended answer and it also fits
# the deploy-by-digest rule; the alternative, adding a NAT route here, would give
# the data subnet outbound internet access purely to fetch a public image.
resource "oci_core_route_table" "private_data" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-rt-data"

  route_rules {
    destination       = local.oracle_services_gateway_target.cidr_block
    destination_type  = "SERVICE_CIDR_BLOCK"
    network_entity_id = oci_core_service_gateway.main.id
  }
}

# --- subnets ----------------------------------------------------------------
# Regional, not AD-scoped: ca-toronto-1 has a single availability domain (§9.1),
# so an AD-scoped subnet would add a constraint without buying anything.

resource "oci_core_subnet" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  cidr_block     = var.subnet_cidrs.public
  display_name   = "${var.name_prefix}-public"
  dns_label      = "public"
  route_table_id = oci_core_route_table.public.id

  # The load balancer only. It is the one thing here that needs a public address.
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_subnet" "private_app" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = var.subnet_cidrs.private_app
  display_name               = "${var.name_prefix}-app"
  dns_label                  = "app"
  route_table_id             = oci_core_route_table.private_app.id
  prohibit_public_ip_on_vnic = true
}

resource "oci_core_subnet" "private_data" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = var.subnet_cidrs.private_data
  display_name               = "${var.name_prefix}-data"
  dns_label                  = "data"
  route_table_id             = oci_core_route_table.private_data.id
  prohibit_public_ip_on_vnic = true
}
