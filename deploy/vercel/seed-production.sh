#!/usr/bin/env bash
#
# Seed a fresh production Supabase project from the development corpus.
#
# VERCEL-ALL-IN-SCOPE §9 Phase 5: "seed production from the dev corpus". Phase 0
# measured it (findings §4) — a 24 MB custom-format dump, 1.9 s out and 1.1 s
# in — so this is a small operation whose risks are all in the details rather
# than in the size.
#
# ONE-TIME. This is the initial setup of the production database, not a
# repeatable sync: it refuses a target that already has tables. After it, the
# `migrate (production)` CI job carries the schema forward.
#
#   ./deploy/vercel/seed-production.sh 'postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
#
# The URL must be the SESSION pooler (port 5432). pg_restore opens a session and
# uses features the transaction pooler does not carry.
#
# WHY A FULL DUMP RATHER THAN MIGRATIONS-THEN-DATA. The tempting order is "run
# the 18 migrations, then restore --data-only", since the migrations are already
# proven against a Supabase session pooler on the preview project. It does not
# work: a data-only restore into a schema whose foreign keys already exist needs
# `--disable-triggers`, which issues `ALTER TABLE ... DISABLE TRIGGER ALL`, and
# disabling a table's INTERNAL (foreign-key) triggers is superuser-only. Supabase
# does not give you superuser. A full custom-format restore sidesteps the whole
# question by pg_dump's own ordering: tables, then data, then constraints and
# indexes. The dump also carries `kysely_migration`, so the migration ledger
# arrives with the schema it describes — and `pnpm db:migrate` afterwards
# printing "Nothing to migrate" is this script's last verification step rather
# than a separate chore.
set -euo pipefail

SOURCE_CONTAINER="${SOURCE_CONTAINER:-zammy-postgres-1}"
SOURCE_DB="${SOURCE_DB:-zammy}"
SOURCE_USER="${SOURCE_USER:-zammy}"
DUMP_PATH="/tmp/zammy-seed.dump"

# Tables in the dev database that NO migration creates, and which must not
# become permanent fixtures of the production schema.
#
# `mine` (id uuid, label text) is scratch left over from the storyline pile
# cleanup. It is real working data on this laptop and worth keeping there — this
# list excludes it from the seed, it does not delete it. The reason to care
# about 413 rows is not the size: a table the migration ledger has never heard
# of would sit in production forever, unowned, and every later `\d` would raise
# the same question this comment answers.
#
# Space-separated. If the dev database grows another scratch table before
# cutover, add it here rather than discovering it in production.
SEED_EXCLUDE_TABLES="${SEED_EXCLUDE_TABLES:-mine}"

TARGET_URL="${1:-${DATABASE_SESSION_URL:-}}"
if [ -z "$TARGET_URL" ]; then
  echo "usage: $0 <production DATABASE_SESSION_URL>" >&2
  echo "       (the SESSION pooler, port 5432 — not 6543)" >&2
  exit 1
fi

case "$TARGET_URL" in
  *:6543/*)
    echo "error: that is the TRANSACTION pooler (6543). pg_restore needs the session pooler (5432)." >&2
    exit 1
    ;;
esac

# @zammy/config refuses a Postgres URL carrying ?sslmode= (node-postgres silently
# ignores DATABASE_SSL when the URL sets it), so the copy that lands in Vercel
# must not have one. libpq here does not care, but a URL pasted from the Supabase
# dashboard usually carries it and the same string is about to be pasted into
# `vercel env add` — catching it here is cheaper than catching it at /readyz.
case "$TARGET_URL" in
  *sslmode=*)
    echo "error: strip the ?sslmode= parameter from the URL. @zammy/config refuses one that carries it," >&2
    echo "       and this is the same string you will set as DATABASE_SESSION_URL on Vercel." >&2
    exit 1
    ;;
esac

if ! docker inspect "$SOURCE_CONTAINER" >/dev/null 2>&1; then
  echo "error: container '$SOURCE_CONTAINER' not found. Start it with \`pnpm infra:up\`," >&2
  echo "       or set SOURCE_CONTAINER to the one holding the dev corpus." >&2
  exit 1
fi

# Everything below runs INSIDE the compose Postgres container: it has pg_dump,
# pg_restore and psql at exactly the source server's version, and the host has
# none of the three. The script is fed over stdin so the target URL — which
# carries a password — never appears in the host's process list. It is visible
# in the container's own `ps` for the seconds the restore runs; that is the
# residue, and the container is the one this corpus already lives in.
docker exec -i "$SOURCE_CONTAINER" bash -s <<EOF
set -euo pipefail

TARGET_URL='${TARGET_URL}'
SOURCE_DB='${SOURCE_DB}'
SOURCE_USER='${SOURCE_USER}'
DUMP_PATH='${DUMP_PATH}'
SEED_EXCLUDE_TABLES='${SEED_EXCLUDE_TABLES}'

echo "==> target"
# A dump is restored FORWARD, never backward: pg_restore reads a newer server's
# dump into an older server at your peril. Supabase's Postgres major must be at
# least the source's.
source_major=\$(psql -U "\$SOURCE_USER" -d "\$SOURCE_DB" -tAc "show server_version_num" | cut -c1-2)
target_major=\$(psql "\$TARGET_URL" -tAc "show server_version_num" | cut -c1-2)
echo "    source Postgres major \$source_major, target major \$target_major"
if [ "\$target_major" -lt "\$source_major" ]; then
  echo "error: target Postgres (\$target_major) is older than the source (\$source_major)." >&2
  echo "       Recreate the Supabase project on a matching major, or dump with the older client." >&2
  exit 1
fi

# One-time means one-time. A target with tables is either a project that was
# already seeded or the wrong project, and both want a human rather than a
# restore that half-succeeds on top of existing rows.
existing=\$(psql "\$TARGET_URL" -tAc "select count(*) from pg_tables where schemaname = 'public'")
if [ "\$existing" != "0" ]; then
  echo "error: the target's public schema already has \$existing tables." >&2
  echo "       This script seeds an EMPTY project. If this is a retry, reset the" >&2
  echo "       database from the Supabase dashboard first." >&2
  exit 1
fi

echo "==> dumping \$SOURCE_DB"
exclude_args=()
for t in \$SEED_EXCLUDE_TABLES; do
  if psql -U "\$SOURCE_USER" -d "\$SOURCE_DB" -tAc \
       "select to_regclass('public.' || quote_ident('\$t')) is not null" | grep -q t; then
    echo "    excluding scratch table '\$t' (no migration creates it)"
    exclude_args+=(--exclude-table="public.\$t")
  fi
done
start=\$SECONDS
pg_dump -U "\$SOURCE_USER" -d "\$SOURCE_DB" -Fc "\${exclude_args[@]}" -f "\$DUMP_PATH"
echo "    \$(du -h "\$DUMP_PATH" | cut -f1) in \$((SECONDS - start))s"

echo "==> restoring"
start=\$SECONDS
# --no-owner / --no-acl: the source's objects belong to the local 'zammy' role,
# which does not exist on Supabase; without these every GRANT and every ALTER
# OWNER is an error. --exit-on-error is deliberately NOT set — a restore into a
# managed Postgres always reports a handful of benign failures (the extension
# and the public schema both already exist there), and the row-count check below
# is the real verdict.
pg_restore --no-owner --no-acl --dbname="\$TARGET_URL" "\$DUMP_PATH" || true
echo "    restored in \$((SECONDS - start))s"

echo "==> verifying row counts"
counts_sql="select relname, n_live_tup from pg_stat_user_tables order by relname"
# n_live_tup is an estimate on a live table, so the source side is counted for
# real. Sixteen exact counts against a 32k-article corpus is a second's work.
tables=\$(psql -U "\$SOURCE_USER" -d "\$SOURCE_DB" -tAc \
  "select tablename from pg_tables where schemaname='public' order by tablename")
failed=0
for t in \$tables; do
  case " \$SEED_EXCLUDE_TABLES " in
    *" \$t "*)
      printf '    %-32s skipped (excluded)\\n' "\$t"
      continue
      ;;
  esac
  a=\$(psql -U "\$SOURCE_USER" -d "\$SOURCE_DB" -tAc "select count(*) from \\"\$t\\"")
  b=\$(psql "\$TARGET_URL" -tAc "select count(*) from \\"\$t\\"" 2>/dev/null || echo "MISSING")
  if [ "\$a" = "\$b" ]; then
    printf '    %-32s %s\n' "\$t" "\$a"
  else
    printf '    %-32s source %s, target %s  <-- MISMATCH\n' "\$t" "\$a" "\$b"
    failed=1
  fi
done

rm -f "\$DUMP_PATH"

if [ "\$failed" != "0" ]; then
  echo >&2
  echo "error: the restore did not reproduce the corpus. Reset the Supabase database and retry." >&2
  exit 1
fi
EOF

cat <<'NEXT'

==> seeded.

Next, and it is a verification rather than a step: run the migrations against the
same URL. The dump carried `kysely_migration`, so a correct restore leaves
nothing to apply.

  DATABASE_SESSION_URL='<the same URL>' \
  DATABASE_SSL=verify-full \
  DATABASE_CA_CERT="$(cat prod-ca.crt)" \
    pnpm db:migrate

  # expected: "Nothing to migrate — database is up to date."

Anything other than that line means the restore and the migration ledger
disagree, and the schema this corpus was dumped from is not the schema the code
expects. Stop there rather than deploying over it.
NEXT
