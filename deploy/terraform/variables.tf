variable "region" {
  description = "OCI region identifier. Must be the tenancy home region: Always Free resources exist only there (DEPLOYMENT-OCI §9.1)."
  type        = string
  default     = "ca-toronto-1"
}

variable "compartment_ocid" {
  description = <<-EOT
    Where Phase 1 creates things. Defaults to the tenancy root because that is the
    only compartment that exists today (§9.5) and the vault, budget and OCIR
    repositories already live there. Kept a variable rather than hardcoded so
    moving to a dedicated compartment later is a value change, not a rewrite.
  EOT
  type        = string
}

variable "name_prefix" {
  description = "Prefix for every display name, so one tenancy could hold more than one of these."
  type        = string
  default     = "zammy"
}

variable "vcn_cidr" {
  description = "10.0.0.0/16 is free again as of §9.5 — the oci-dev-tools stack that held it was deleted."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidrs" {
  description = <<-EOT
    The three subnets of §3. /24s out of a /16 leaves room to add without
    renumbering, which matters because a subnet's CIDR cannot be changed in place.
  EOT
  type = object({
    public       = string
    private_app  = string
    private_data = string
  })
  default = {
    public       = "10.0.1.0/24"
    private_app  = "10.0.2.0/24"
    private_data = "10.0.3.0/24"
  }
}

variable "api_port" {
  description = "The port the api listens on, and the only port the LB may reach on the app subnet. Matches PORT in .env.example."
  type        = number
  default     = 3000
}

variable "postgres_port" {
  type    = number
  default = 5432
}

variable "redis_port" {
  type    = number
  default = 6379
}

# --- staging VM -------------------------------------------------------------

variable "operator_ssh_cidr" {
  description = <<-EOT
    The single address allowed to SSH to the staging VM, as a /32.

    Required with no default on purpose. A default of 0.0.0.0/0 is exactly the
    posture the oci-dev-tools stack had (§9.5) and that we deleted it for, so an
    apply that forgets this must FAIL rather than quietly open port 22 to the
    internet. Find it with `curl -s https://checkip.amazonaws.com`.
  EOT
  type        = string

  validation {
    condition     = var.operator_ssh_cidr != "0.0.0.0/0"
    error_message = "Refusing 0.0.0.0/0: SSH on a public host must be restricted to a known address."
  }

  validation {
    condition     = can(cidrhost(var.operator_ssh_cidr, 0))
    error_message = "Must be a CIDR block, e.g. 203.0.113.4/32."
  }
}

variable "ssh_public_key" {
  description = <<-EOT
    Public half of the key that may SSH to the staging VM. No default and never
    generated here: the key that reaches a public host should be one you created
    and hold the private half of. `ssh-keygen -t ed25519 -C zammy-staging` if you
    do not have one — there is currently no *.pub in ~/.ssh.
  EOT
  type        = string
}

variable "staging_ocpus" {
  description = "2 OCPU decided in §7, which is 99.2% of the monthly Ampere allowance at 24×7 — see that section before raising it."
  type        = number
  default     = 2
}

variable "staging_memory_gb" {
  description = "12 GB. Not slack: it is Postgres page cache for the seeded corpus (§7)."
  type        = number
  default     = 12
}
