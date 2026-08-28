#!/usr/bin/env bash
#
# Answer two questions about production, in this order:
#
#   1. Did last night's chores run?
#   2. If they did, were they effective?
#
# The first is not answerable from Vercel — Hobby's runtime logs are gone within
# the hour, and `vercel logs` has returned nothing at all for deployments minutes
# old. `chore_runs` is the record that outlives the night, which is why Phase 4
# built it. The second question is the one that needs judgement, so this script
# states a verdict per pass rather than dumping JSON and leaving it to the reader.
#
#   ./deploy/vercel/check-chores.sh
#
# Exit 0 = both questions answered well. Exit 1 = something wants a human.
# Designed to be run from cron, so the output is plain and the exit code means
# something.
#
# WHY `source = 'route'` IS THE FILTER. `chore_runs` records laptop runs too
# (`chores-cli.ts` and the route share `chore-runner.ts` deliberately, so the
# table does not lie by omission about the other half of the system). A run this
# script counts as "last night's" must be one the SCHEDULER made, or a `pnpm
# chores` from a laptop at midnight would answer the question falsely.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ZAMMY_PROD_ENV_FILE:-$REPO_ROOT/deploy/vercel/.env.production}"
CONTAINER="${SOURCE_CONTAINER:-zammy-postgres-1}"
# Where the previous run's backlog figure is kept, so "the label pass moved the
# backlog" can be answered as a delta rather than as an absolute nobody can read.
STATE_FILE="${ZAMMY_CHECK_STATE:-$HOME/.zammy-chore-check.state}"
# Chores fire at 03:00 and 04:00 UTC. Eighteen hours reaches back past both
# without reaching the night before them.
WINDOW_HOURS="${WINDOW_HOURS:-18}"

problems=0
say() { printf '%s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; problems=$((problems + 1)); }
ok()  { printf '  ✓ %s\n' "$*"; }
warn(){ printf '  ! %s\n' "$*"; }

if [ ! -f "$ENV_FILE" ]; then
  say "FAIL: $ENV_FILE not found — cannot reach production."
  exit 1
fi
URL="$(grep '^DATABASE_SESSION_URL=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$URL" ]; then
  say "FAIL: no DATABASE_SESSION_URL in $ENV_FILE."
  exit 1
fi
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  say "FAIL: container '$CONTAINER' is not running — it provides psql. \`pnpm infra:up\`."
  exit 1
fi

# One psql call per question rather than one per field: each is a round trip to
# a pooler in another region, and this runs unattended.
q() {
  docker exec -i "$CONTAINER" bash -s <<EOF 2>/dev/null
psql '$URL' -tAc "\$(cat <<'SQL'
$1
SQL
)"
EOF
}

say "=== zammy production — chores check, $(date -u '+%Y-%m-%d %H:%M UTC') ==="
say ""

# ── Question 1: did they run? ────────────────────────────────────────────────
say "1. Did last night's chores run?"

rows="$(q "select pass || '|' || coalesce(outcome,'?') || '|' || started_at || '|' ||
             coalesce(finished_at::text,'NULL') || '|' || coalesce(model_calls::text,'-')
           from chore_runs
           where source = 'route' and started_at > now() - interval '$WINDOW_HOURS hours'
           order by started_at")"

if [ -z "$rows" ]; then
  bad "NO scheduled run in the last ${WINDOW_HOURS}h. Nothing fired, or every fire failed before"
  warn "  the route could open a row. Check the HTTP results below — a pg_cron job reads"
  warn "  'succeeded' even when the request it made returned 500."
else
  while IFS='|' read -r pass outcome started finished calls; do
    [ -z "$pass" ] && continue
    if [ "$finished" = "NULL" ]; then
      # The state the row exists to make visible: opened before the pass,
      # never updated after it, because the function was killed at maxDuration.
      bad "$pass — started $started and NEVER FINISHED (killed at maxDuration, most likely the label pass)"
    elif [ "$outcome" = "ok" ]; then
      ok "$pass — ok, $started, model calls: $calls"
    elif [ "$outcome" = "skipped" ]; then
      warn "$pass — SKIPPED at $started (lost the advisory lock; a laptop run or a duplicate fire)"
    else
      bad "$pass — outcome '$outcome' at $started"
    fi
  done <<< "$rows"

  for expected in retention storylines; do
    grep -q "^$expected|" <<< "$rows" || bad "no scheduled '$expected' pass in the window"
  done
fi

say ""
say "   The HTTP results behind those fires (cron.job_run_details says 'succeeded'"
say "   for a request that returned 500 — this is the column that does not):"
http="$(q "select coalesce(string_agg(status_code || ' x' || n, ', ' order by status_code), 'none')
           from (select status_code, count(*) n from net._http_response
                 where created > now() - interval '$WINDOW_HOURS hours'
                 group by status_code) s")"
say "     $http"
non200="$(q "select count(*) from net._http_response
             where created > now() - interval '$WINDOW_HOURS hours' and status_code <> 200")"
[ "${non200:-0}" != "0" ] && bad "$non200 non-200 responses in the window" || ok "every scheduled request answered 200"

say ""
# ── Question 2: was it effective? ────────────────────────────────────────────
say "2. Was it effective?"

# -- retention: the reindex tripwire first, because nothing else reports it --
ret="$(q "select coalesce(jsonb_array_length(report->'reindex'->'invalidIndexes'),-1) || '|' ||
                 coalesce((report->'reindex'->>'failed'),'-') || '|' ||
                 coalesce((report->'reindex'->>'ms'),'-') || '|' ||
                 coalesce((report->>'prunedStoryDf'),'-')
          from chore_runs
          where source='route' and pass='retention' and finished_at is not null
                and started_at > now() - interval '$WINDOW_HOURS hours'
          order by started_at desc limit 1")"
if [ -z "$ret" ]; then
  warn "retention — no completed scheduled run to judge"
else
  IFS='|' read -r invalid failed ms pruned <<< "$ret"
  if [ "$invalid" = "-1" ]; then
    warn "retention — no reindex section in the report"
  elif [ "$invalid" = "0" ]; then
    ok "reindex — clean, ${ms}ms, invalidIndexes empty, ${failed} table failures"
  else
    # An interrupted REGINDEX CONCURRENTLY leaves a *_ccnew twin that is never
    # read and still maintained on every write. Nothing in Postgres complains.
    bad "reindex — $invalid INVALID INDEX(es) left behind. These are never read and still"
    warn "    maintained on every write. They want a DROP INDEX by hand — a nightly chore"
    warn "    does not get to make that call. Find them with:"
    warn "      select indexrelid::regclass from pg_index where not indisvalid;"
  fi
  [ "${failed:-0}" != "0" ] && [ "${failed:-0}" != "-" ] && warn "reindex — $failed table(s) lost a lock race (recorded, next one attempted)"
  say "     trailing-corpus prune: ${pruned} story_token_days rows"
fi

# -- storylines: did the label pass actually label anything --
lab="$(q "select coalesce((report->'labels'->>'model'),'-') || '|' ||
                 coalesce((report->'labels'->>'bigram'),'-') || '|' ||
                 coalesce((report->'labels'->>'none'),'-') || '|' ||
                 coalesce((report->'labels'->>'skipped'),'-') || '|' ||
                 coalesce((report->'graph'->>'largestArc'),'-') || '|' ||
                 coalesce((report->'graph'->>'singletons'),'-') || '|' ||
                 coalesce((report->'lateCandidates'->>'skipped'),'false') || '|' ||
                 coalesce((report->'labels'->>'stoppedBy'),'')
          from chore_runs
          where source='route' and pass='storylines' and finished_at is not null
                and started_at > now() - interval '$WINDOW_HOURS hours'
          order by started_at desc limit 1")"
if [ -z "$lab" ]; then
  warn "storylines — no completed scheduled run to judge"
else
  IFS='|' read -r model bigram none skipped largest singles lateskip stopped <<< "$lab"
  # A missing field comes back as '-' from the coalesce above, which is not a
  # number; the comparisons below are arithmetic, so normalise first.
  [ "${model:-}" -eq "${model:-}" ] 2>/dev/null || model=0
  [ "${bigram:-}" -eq "${bigram:-}" ] 2>/dev/null || bigram=0
  applied=$(( model + bigram ))
  if [ "$applied" -eq 0 ]; then
    bad "labels — NOTHING was labelled ($none none, $skipped skipped). Either the backlog is"
    warn "    empty, the Gemini key is exhausted, or the pass never reached the model."
  elif [ "$model" -eq 0 ]; then
    # THE FAILURE A GREEN TICK USED TO HIDE. Falling back is the labeler's
    # designed behaviour for a model that will not answer, so a night where the
    # model answered NOTHING and the bigram extractor named everything reports
    # the same "applied > 0" as a healthy night. That is exactly what happened
    # on 2026-08-28: the API had begun returning its reasoning as a separate
    # response part, the client was joining it to the answer, and every label
    # failed the 2-5 word contract. Zero model labels beside a non-zero fallback
    # is the signature, and it is worth a red mark on its own.
    bad "labels — $applied applied but NONE from the model ($bigram bigram fallback)."
    warn "    The fallback is working, which is why this is not an outage — but the model"
    warn "    answered nothing usable all night. Check the response shape and the key."
  else
    ok "labels — $applied applied ($model from the model, $bigram bigram fallback); $none returned nothing, $skipped skipped"
  fi
  # Why the pass ended. `exhausted` is the healthy one — it walked every
  # candidate; anything else means the tally above is a floor.
  case "${stopped:-}" in
    ""|exhausted) ;;
    budget)
      warn "    the pass stopped on its wall-clock budget (CHORE_LABEL_BUDGET_MS), not on"
      warn "    CHORE_MAX_LABELS — a label is costing more than the count was sized for." ;;
    max-labels)
      say "     the pass stopped on CHORE_MAX_LABELS; the rest defers to the next night" ;;
    *)
      warn "    the pass stopped early ($stopped) — the tally above is a floor" ;;
  esac
  say "     graph shape: largest arc $largest, singletons $singles"
  [ "$lateskip" = "true" ] && say "     late-candidate sweep: gated off (expected — STORYLINE_LATE_CANDIDATE_SWEEP)"
fi

# -- the backlog, as a delta: the label pass's whole job is to shrink this --
#
# `merged_into is null` is NOT optional, and leaving it off is what made this
# number lie. A storyline merged into another keeps whatever status it had, so a
# promoted arc absorbed before anything named it stays `status='active'` with
# `label_at` null for ever — and the labeler is RIGHT to skip it: it holds no
# groups and renders nowhere (`readLabelCandidates` filters on the same two
# columns this does). Measured 2026-08-28: production held 552 such rows, 546 of
# them merged-away aliases with zero groups, so the honest backlog was 6 and the
# check reported 535 and blamed the label pass.
#
# The filter is copied from `readLabelCandidates` on purpose — this must count
# exactly what the pass would offer, or the delta measures something no chore is
# trying to move.
backlog="$(q "select count(*) from storylines
              where merged_into is null and status <> 'provisional' and label_at is null")"
say ""
say "   Label backlog (live promoted storylines never offered to a model):"
if [ -n "$backlog" ]; then
  prev="$(cat "$STATE_FILE" 2>/dev/null || echo "")"
  if [ -n "$prev" ] && [ "$prev" -eq "$prev" ] 2>/dev/null; then
    delta=$(( prev - backlog ))
    if [ "$delta" -gt 0 ]; then
      ok "$backlog, down $delta since the last check"
    elif [ "$delta" -eq 0 ]; then
      bad "$backlog — UNCHANGED since the last check. The label pass is not draining it."
    else
      warn "$backlog — UP by $(( -delta )). New storylines are being promoted faster than labelling."
    fi
  else
    say "     $backlog (no previous figure — this is the baseline)"
  fi
  printf '%s' "$backlog" > "$STATE_FILE"
fi

# -- storage, because the reindex sweep exists for exactly this budget --
size="$(q "select pg_size_pretty(pg_database_size(current_database())) || '|' ||
                  (pg_database_size(current_database()) / 1024 / 1024)")"
IFS='|' read -r pretty mb <<< "$size"
say ""
say "   Storage against Supabase Free's 500 MB: $pretty"
if [ -n "${mb:-}" ] && [ "$mb" -gt 400 ] 2>/dev/null; then
  bad "over 400 MB — the 500 MB tripwire is close. See VERCEL-PHASE-0-FINDINGS §4."
elif [ -n "${mb:-}" ] && [ "$mb" -gt 300 ] 2>/dev/null; then
  warn "over 300 MB — worth watching."
else
  ok "comfortable"
fi

say ""
if [ "$problems" -eq 0 ]; then
  say "=== VERDICT: chores ran and were effective. ==="
  exit 0
fi
say "=== VERDICT: $problems problem(s) above want a human. ==="
say ""
say "The re-run is a curl, not an SSH — any pass runs on demand:"
say "  curl -X POST -H \"Authorization: Bearer \$CRON_SECRET\" \"\$URL/api/chores?pass=retention\""
say "Passes: retention, storylines, dormancy, bridges, late-candidates, labels, label-merge, graph"
exit 1
