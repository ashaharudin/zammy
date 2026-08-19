# §3: "LB → app on the api port; app → 5432 and the cache port; nothing else."
#
# Rules reference the peer NSG by id rather than by CIDR wherever the peer is
# inside the VCN. A CIDR rule keeps allowing whatever later moves into that range;
# an NSG rule follows the membership, so "the load balancer" stays the meaning
# rather than "anything in 10.0.1.0/24".

resource "oci_core_network_security_group" "lb" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-nsg-lb"
}

resource "oci_core_network_security_group" "app" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-nsg-app"
}

resource "oci_core_network_security_group" "data" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-nsg-data"
}

# --- load balancer ----------------------------------------------------------

resource "oci_core_network_security_group_security_rule" "lb_ingress_https" {
  network_security_group_id = oci_core_network_security_group.lb.id
  direction                 = "INGRESS"
  protocol                  = "6" # TCP
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTPS from the internet. TLS terminates here (§9.2)."

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

# Port 80 exists only to redirect to 443. Without it a bare `zammy.info` in a
# browser address bar fails to connect rather than upgrading.
resource "oci_core_network_security_group_security_rule" "lb_ingress_http" {
  network_security_group_id = oci_core_network_security_group.lb.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTP, for the redirect to HTTPS only."

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

resource "oci_core_network_security_group_security_rule" "lb_egress_app" {
  network_security_group_id = oci_core_network_security_group.lb.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = oci_core_network_security_group.app.id
  destination_type          = "NETWORK_SECURITY_GROUP"
  description               = "To the api, on the api port and nothing else."

  tcp_options {
    destination_port_range {
      min = var.api_port
      max = var.api_port
    }
  }
}

# --- app --------------------------------------------------------------------

resource "oci_core_network_security_group_security_rule" "app_ingress_lb" {
  network_security_group_id = oci_core_network_security_group.app.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = oci_core_network_security_group.lb.id
  source_type               = "NETWORK_SECURITY_GROUP"
  description               = "The only way in. Health checks arrive this way too."

  tcp_options {
    destination_port_range {
      min = var.api_port
      max = var.api_port
    }
  }
}

resource "oci_core_network_security_group_security_rule" "app_egress_postgres" {
  network_security_group_id = oci_core_network_security_group.app.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = oci_core_network_security_group.data.id
  destination_type          = "NETWORK_SECURITY_GROUP"

  tcp_options {
    destination_port_range {
      min = var.postgres_port
      max = var.postgres_port
    }
  }
}

resource "oci_core_network_security_group_security_rule" "app_egress_redis" {
  network_security_group_id = oci_core_network_security_group.app.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = oci_core_network_security_group.data.id
  destination_type          = "NETWORK_SECURITY_GROUP"

  tcp_options {
    destination_port_range {
      min = var.redis_port
      max = var.redis_port
    }
  }
}

# Currents and Gemini, over the NAT gateway. Restricted to 443 rather than opened
# wholesale: an unbounded egress rule is how a compromised container reaches
# anything at all, and both upstreams are HTTPS.
resource "oci_core_network_security_group_security_rule" "app_egress_internet_https" {
  network_security_group_id = oci_core_network_security_group.app.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "Currents and Gemini (§9.4), HTTPS only."

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

# OCIR image pulls, Vault reads, Logging writes — over the service gateway, so
# this traffic never touches the NAT gateway or the public internet.
resource "oci_core_network_security_group_security_rule" "app_egress_oracle_services" {
  network_security_group_id = oci_core_network_security_group.app.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = local.oracle_services_gateway_target.cidr_block
  destination_type          = "SERVICE_CIDR_BLOCK"
  description               = "OCIR, Vault, Logging via the service gateway."
}

# --- data -------------------------------------------------------------------

resource "oci_core_network_security_group_security_rule" "data_ingress_postgres" {
  network_security_group_id = oci_core_network_security_group.data.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = oci_core_network_security_group.app.id
  source_type               = "NETWORK_SECURITY_GROUP"
  description               = "Postgres, from the app subnet only."

  tcp_options {
    destination_port_range {
      min = var.postgres_port
      max = var.postgres_port
    }
  }
}

resource "oci_core_network_security_group_security_rule" "data_ingress_redis" {
  network_security_group_id = oci_core_network_security_group.data.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = oci_core_network_security_group.app.id
  source_type               = "NETWORK_SECURITY_GROUP"
  description               = "Redis, from the app subnet only. No LB backend, no public IP (§3)."

  tcp_options {
    destination_port_range {
      min = var.redis_port
      max = var.redis_port
    }
  }
}

# The Redis container's image pull, and nothing else. There is no egress rule to
# 0.0.0.0/0 here on purpose — see the route table note in network.tf about why
# that makes OCIR the only possible image source for it.
resource "oci_core_network_security_group_security_rule" "data_egress_oracle_services" {
  network_security_group_id = oci_core_network_security_group.data.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = local.oracle_services_gateway_target.cidr_block
  destination_type          = "SERVICE_CIDR_BLOCK"
  description               = "OCIR pull for the Redis container, via the service gateway."
}
