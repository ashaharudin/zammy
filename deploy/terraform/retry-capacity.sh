#!/usr/bin/env bash
# Wait for free-tier Ampere capacity, then finish the Phase 1 apply.
#
# Why this exists: on 2026-08-19 the staging instance could not be created —
# `500-InternalError, Out of host capacity` on 20 attempts across three shapes.
# OCI's capacity report showed every free shape in ca-toronto-1's single AD out of
# capacity, including VM.Standard.E2.1.Micro. So the blocker is time, not
# configuration (DEPLOYMENT-OCI §9.1), and this polls until it clears.
#
# It ASKS before it acts: the capacity report is free and read-only, so the common
# case costs one cheap API call and creates nothing. `terraform apply` runs only
# when capacity is actually reported available.
#
# Runs locally by necessity — Terraform state and ~/.oci both live on this
# machine, so a cloud runner could not do this without moving both.
set -uo pipefail

TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${TF_DIR}/retry-capacity.log"
LOCK="${TF_DIR}/.retry-capacity.lock"
NOT_BEFORE="${NOT_BEFORE:-2026-08-20}"

TERRAFORM=/opt/homebrew/bin/terraform
OCI=/opt/homebrew/bin/oci
export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True

AD="PFaU:CA-TORONTO-1-AD-1"
SHAPE_CONFIG='{"ocpus":1,"memoryInGBs":12}'
COMPARTMENT="$(grep -E '^compartment_ocid' "${TF_DIR}/terraform.tfvars" | cut -d'"' -f2)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Do nothing until the start date, so the schedule can be installed today and
# begin tomorrow without a second visit.
if [[ "$(date -u +%Y-%m-%d)" < "$NOT_BEFORE" ]]; then exit 0; fi

# Two applies at once would fight over the state lock. mkdir is atomic.
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Nothing to do once the instance exists — this is what makes the job
# self-retiring rather than something to remember to turn off.
if "$TERRAFORM" -chdir="$TF_DIR" state list 2>/dev/null | grep -q '^oci_core_instance.staging$'; then
  log "instance exists; nothing to do — remove the cron entry"
  exit 0
fi

status="$("$OCI" compute compute-capacity-report create \
  --compartment-id "$COMPARTMENT" --availability-domain "$AD" \
  --shape-availabilities "[{\"instanceShape\":\"VM.Standard.A1.Flex\",\"instanceShapeConfig\":${SHAPE_CONFIG}}]" \
  --query 'data."shape-availabilities"[0]."availability-status"' --raw-output 2>/dev/null)"

if [[ "$status" != "AVAILABLE" ]]; then
  log "capacity ${status:-unknown} — not attempting"
  exit 0
fi

log "capacity AVAILABLE — applying"
if out="$("$TERRAFORM" -chdir="$TF_DIR" apply -auto-approve -input=false 2>&1)"; then
  log "APPLY COMPLETE — staging instance created. Remove the cron entry."
else
  log "apply failed despite AVAILABLE:"
  printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^│ Error:' | head -3 >> "$LOG"
fi
