#!/usr/bin/env bash
#
# Deploy to Vercel, from a copy of the tree with `.git` excluded.
#
#   ./deploy/vercel/deploy.sh          # preview
#   ./deploy/vercel/deploy.sh --prod   # production
#
# WHY THE COPY. Vercel stamps a deployment with the COMMIT AUTHOR rather than
# the account that owns the project. The commit author here is not the Vercel
# account, so a deploy run from the repository lands `readyState: BLOCKED`
# (`TEAM_ACCESS_REQUIRED`) — which `vercel ls` renders as `UNKNOWN` and
# `vercel inspect --logs` prints nothing for. A tree with no `.git` has no
# commit author to stamp, and deploys normally. This is the whole workaround,
# and it is the reason the deploy is a script rather than two commands in a
# README.
#
# WHY `dist/` IS COPIED. It is tempting to exclude build output as well. Do not,
# unless you also delete every `*.tsbuildinfo` — those sit beside each
# `tsconfig.json`, not inside `dist`, so a copy that drops the output and keeps
# them leaves `tsc -b` believing all nine projects are current: it prints `Done`,
# emits nothing, and `vercel build` reports `status: ok` having produced
# functions with no code in them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="preview"
[ "${1:-}" = "--prod" ] && TARGET="production"

command -v vercel >/dev/null 2>&1 || { echo "error: the vercel CLI is not installed." >&2; exit 1; }
command -v rsync  >/dev/null 2>&1 || { echo "error: rsync is not installed." >&2; exit 1; }

if [ ! -f "$REPO_ROOT/.vercel/project.json" ]; then
  echo "error: $REPO_ROOT/.vercel/project.json is missing — run \`vercel link\` first." >&2
  exit 1
fi

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/zammy-deploy.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

echo "==> copying the tree to $STAGING"
rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude .vercel \
  "$REPO_ROOT/" "$STAGING/"

# project.json is what tells the CLI which project this is; .vercel is excluded
# above only because a stale build output inside it confuses `vercel build`.
mkdir -p "$STAGING/.vercel"
cp "$REPO_ROOT/.vercel/project.json" "$STAGING/.vercel/project.json"

cd "$STAGING"

build_args=()
deploy_args=(--prebuilt)
if [ "$TARGET" = "production" ]; then
  build_args+=(--prod)
  deploy_args+=(--prod)
fi

echo "==> vercel build ($TARGET)"
vercel build "${build_args[@]}"

echo "==> vercel deploy ($TARGET)"
# Grep the URL out of the whole output rather than taking the last line. On CLI
# 59 the last stdout line is a JSON `}`, so `tail -n1` captured a brace and the
# `vercel inspect` below went looking for a deployment called "dpl_}". The
# pattern is stable in a way the output shape is not. `tee /dev/stderr` keeps
# the progress visible while it is captured.
deploy_output="$(vercel deploy "${deploy_args[@]}" 2>&1 | tee /dev/stderr)"
url="$(printf '%s\n' "$deploy_output" |
  grep -oE 'https://[a-zA-Z0-9._-]+\.vercel\.app' | tail -n1)"

if [ -z "$url" ]; then
  echo "error: could not find a deployment URL in the CLI output." >&2
  echo "       The deploy may still have succeeded — check \`vercel ls --prod\`." >&2
  exit 1
fi

echo "==> $url"

# The CLI's exit code is not a signal — a BLOCKED deployment exits 0. `● Ready`
# in `vercel inspect` is the one that means the deployment exists and serves.
echo "==> vercel inspect"
vercel inspect "$url" 2>&1 | sed -n '1,20p'

cat <<NEXT

==> deployed to $TARGET: $url

Probe /readyz TWICE. The first request after a deploy is a cold start and the
Redis client connects lazily — Upstash handshakes in ~800 ms, which the health
check can beat, so a cold read answers "degraded" on a URL that is correct. It
is the SECOND read that means something.

  curl -s $url/readyz | jq .
  curl -s $url/readyz | jq .

  ready     — Postgres and Redis both reachable
  degraded  — Redis is not
  unready   — Postgres is not
NEXT
