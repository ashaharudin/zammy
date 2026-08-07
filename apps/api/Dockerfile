# Multi-stage build. The final image carries production dependencies and compiled
# output only — no source, no toolchain, no dev dependencies (ARCHITECTURE 4.1).

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# --- dependencies -------------------------------------------------------------
# Manifests are copied before sources so the install layer caches across code
# changes; only a manifest edit invalidates it.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json           packages/shared/
COPY packages/config/package.json           packages/config/
COPY packages/currents-client/package.json  packages/currents-client/
COPY apps/api/package.json                  apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build --------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter "@zammy/api^..." build && pnpm --filter @zammy/api build
# Fail loudly here rather than shipping an image whose entrypoint does not exist.
RUN test -f apps/api/dist/index.js || (echo "BUILD PRODUCED NO OUTPUT" && exit 1)
# `pnpm deploy` prunes to production dependencies and materialises the workspace
# packages, producing a node_modules that stands alone in the runtime stage.
#
# NOT --legacy: that symlinks @zammy/* back to /app/packages and, worse, leaves
# their transitive dependencies (zod) out of the tree entirely — an image that
# builds clean and then dies on its first import. Enabled by
# injectWorkspacePackages in pnpm-workspace.yaml, which measurably does not
# affect the local dev loop (workspace edits stay visible without a reinstall).
RUN pnpm deploy --filter=@zammy/api --prod /deploy
# Guard: actually resolve a workspace package and its transitive dependency from
# inside the deploy tree. Checking for paths guesses at pnpm's layout; importing
# proves the thing we care about. This is the check that would have caught both
# earlier failures — the empty dist and the missing zod.
RUN cd /deploy \
    && node --input-type=module -e 'await import("@zammy/config"); await import("@zammy/currents-client"); await import("@zammy/shared");' \
    || (echo "deploy tree is not self-contained — workspace imports fail" && exit 1)

# --- runtime ------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root. The process needs no write access to its own filesystem.
RUN addgroup -g 10001 -S zammy && adduser -u 10001 -S zammy -G zammy

# Pruned, self-contained production dependencies (workspace packages included).
COPY --from=build --chown=zammy:zammy /deploy/node_modules ./node_modules

# Application code. Copied explicitly rather than relying on pnpm deploy's file
# selection — an empty dist must fail the build, not ship silently.
COPY --from=build --chown=zammy:zammy /app/apps/api/dist ./dist
# Fixture mode reads these at boot; harmless and small in production images.
COPY --chown=zammy:zammy fixtures/ ./fixtures/

USER zammy
EXPOSE 3000

# Liveness only — /readyz checks dependencies, and a failing dependency must not
# get the container restarted, since restarting fixes nothing (see health.ts).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Direct exec, no init shim: the app installs its own SIGTERM handler and must
# receive the signal as PID 1 to drain properly.
CMD ["node", "dist/index.js"]
