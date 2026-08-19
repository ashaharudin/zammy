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
  description = <<-EOT
    Reduced from §7's 2 to 1 on 2026-08-19, after ten create attempts over ~50
    minutes all returned `Out of host capacity`. Free-tier Ampere scarcity is
    usually OCPU-bound, so asking for fewer cores is the lever §9.1 names.

    It does NOT relieve the allowance pressure §7 worried about: memory is the
    binding constraint, so 12 GB × 744h is still 8,928 of 9,000 GB-hours (99.2%).
    What it does buy is OCPU-hours — 744 of 1,500 rather than 1,488 — and it keeps
    the 12 GB that §7 chose for Postgres page cache, which was the actual reason
    for the size. So this trades a core for a chance of being scheduled, and gives
    up nothing §7 was protecting.

    Valid ratio: A1.Flex permits up to 64 GB per OCPU (checked against the shape).
  EOT
  type        = number
  default     = 1
}

variable "staging_memory_gb" {
  description = <<-EOT
    12 GB, as §7 chose. Briefly reduced to 6 on 2026-08-19 to try to get scheduled
    past `Out of host capacity`, then restored: OCI's capacity report showed EVERY
    free shape in this AD out of capacity, including `VM.Standard.E2.1.Micro`, so
    sizing was never the lever and the reduction cost the reason for the size
    without buying anything.

    The reason is Postgres page cache against the seeded ~163 MB corpus, so
    staging's read paths behave like production's rather than like a cold disk.

    Paired with 1 OCPU rather than §7's 2, this sits at 99.2% of the monthly
    GB-hour allowance (unchanged — memory is the binding constraint, which §7
    accepted) and 49.6% of OCPU-hours. That makes it strictly better than 2 OCPU /
    12 GB: identical cache, half the core-hours, and the second core buys nothing
    while capacity is the blocker.
  EOT
  type        = number
  default     = 12
}
