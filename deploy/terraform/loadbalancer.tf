# The one free Flexible LB (§7), terminating TLS with the SSL.com certificate and
# forwarding to the staging VM's api port.

# Read the certificate material straight from the vault rather than from files or
# variables. Two reasons: the private key never passes through a human's
# clipboard or an agent's context, and §4 already accepts that secrets transit
# Terraform state — which is why state lives in a private, versioned bucket.
data "oci_vault_secrets" "tls" {
  compartment_id = var.compartment_ocid
  vault_id       = oci_kms_vault.main.id
}

locals {
  tls_secret_ids = {
    for s in data.oci_vault_secrets.tls.secrets : s.secret_name => s.id
    if startswith(s.secret_name, "zammy-info-tls-")
  }
}

data "oci_secrets_secretbundle" "tls_cert" {
  secret_id = local.tls_secret_ids["zammy-info-tls-cert"]
}

data "oci_secrets_secretbundle" "tls_key" {
  secret_id = local.tls_secret_ids["zammy-info-tls-key"]
}

data "oci_secrets_secretbundle" "tls_chain" {
  secret_id = local.tls_secret_ids["zammy-info-tls-chain"]
}

resource "oci_load_balancer_load_balancer" "main" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-lb"
  shape          = "flexible"
  subnet_ids     = [oci_core_subnet.public.id]

  network_security_group_ids = [oci_core_network_security_group.lb.id]

  # The free allowance is one LB at a fixed 10 Mbps (§7). Min and max are equal
  # because anything above 10 bills, and this is the tenancy's only free one.
  shape_details {
    minimum_bandwidth_in_mbps = 10
    maximum_bandwidth_in_mbps = 10
  }

  is_private = false
}

resource "oci_load_balancer_certificate" "zammy_info" {
  load_balancer_id = oci_load_balancer_load_balancer.main.id
  certificate_name = "zammy-info"

  public_certificate = base64decode(data.oci_secrets_secretbundle.tls_cert.secret_bundle_content[0].content)
  private_key        = base64decode(data.oci_secrets_secretbundle.tls_key.secret_bundle_content[0].content)

  # SSL.com's intermediates, separately. Omitting them is the classic split
  # failure §9.2 describes: fine in a browser that cached the issuer, broken for
  # curl, Android and anything verifying strictly.
  ca_certificate = base64decode(data.oci_secrets_secretbundle.tls_chain.secret_bundle_content[0].content)

  lifecycle {
    # A certificate cannot be updated in place on an OCI LB; renewal (first due
    # 2027-03-05, then roughly twice a year at a 197-day lifetime) means creating
    # the replacement before the listener stops referencing the old one.
    create_before_destroy = true
  }
}

resource "oci_load_balancer_backend_set" "api" {
  load_balancer_id = oci_load_balancer_load_balancer.main.id
  name             = "api"
  policy           = "ROUND_ROBIN"

  health_checker {
    protocol = "HTTP"
    port     = var.api_port
    url_path = "/readyz"

    # 200 only, and deliberately NOT a body match on `"status":"ready"`.
    # /readyz answers 200 with status "degraded" when only Redis is down, which is
    # survivable by design (§2.4) — matching on "ready" would pull the single
    # staging instance out of rotation and turn a degradation into an outage.
    # Asserting "ready" is the DEPLOY gate's job, where zammy-deploy already does
    # it, not the load balancer's.
    return_code       = 200
    interval_ms       = 10000
    timeout_in_millis = 3000
    retries           = 3
  }
}

resource "oci_load_balancer_backend" "staging" {
  load_balancer_id = oci_load_balancer_load_balancer.main.id
  backendset_name  = oci_load_balancer_backend_set.api.name
  ip_address       = oci_core_instance.staging.private_ip
  port             = var.api_port
}

resource "oci_load_balancer_listener" "https" {
  load_balancer_id         = oci_load_balancer_load_balancer.main.id
  name                     = "https"
  default_backend_set_name = oci_load_balancer_backend_set.api.name
  port                     = 443
  protocol                 = "HTTP"

  ssl_configuration {
    certificate_name        = oci_load_balancer_certificate.zammy_info.certificate_name
    verify_peer_certificate = false

    # TLS 1.2 as the floor. 1.0 and 1.1 are long deprecated and nothing this
    # serves needs them.
    protocols = ["TLSv1.2", "TLSv1.3"]
  }
}

# Port 80 exists only to send people to 443. Without it, typing `zammy.info`
# fails to connect rather than upgrading.
resource "oci_load_balancer_rule_set" "redirect_to_https" {
  load_balancer_id = oci_load_balancer_load_balancer.main.id
  name             = "redirect-to-https"

  items {
    action = "REDIRECT"

    conditions {
      attribute_name  = "PATH"
      attribute_value = "/"
      operator        = "PREFIX_MATCH"
    }

    redirect_uri {
      protocol = "HTTPS"
      host     = "{host}"
      port     = 443
      path     = "{path}"
      query    = "{query}"
    }

    response_code = 301
  }
}

resource "oci_load_balancer_listener" "http_redirect" {
  load_balancer_id         = oci_load_balancer_load_balancer.main.id
  name                     = "http"
  default_backend_set_name = oci_load_balancer_backend_set.api.name
  port                     = 80
  protocol                 = "HTTP"
  rule_set_names           = [oci_load_balancer_rule_set.redirect_to_https.name]
}
