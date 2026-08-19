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
