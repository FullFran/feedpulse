# Base image is pinned by digest so a rebuild resolves the exact same bits even
# after the `24-bookworm-slim` tag is republished. Refresh the digest with:
#   docker pull node:24-bookworm-slim
#   docker inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

# ---------------------------------------------------------------------------
# deps: full dependency tree (including devDependencies) used only to compile.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# package-lock.json is committed; `npm ci` (not `npm install`) is what makes the
# build reproducible. `--ignore-scripts` keeps transitive install hooks from
# executing unsandboxed during the build.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# build: compile TypeScript to dist/.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runtime: production dependencies plus compiled output, running unprivileged.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Consumed by the API runtime and by the HEALTHCHECK below. compose.dokploy.yml
# may override it, and the probe follows whatever value is set.
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY db ./db
COPY public ./public

# All three runtimes (api, scheduler, worker) share this image. None of them
# writes to the filesystem or binds a privileged port, so drop root.
#
# /app is deliberately left owned by root:root and world-readable rather than
# chowned to node: uid 1000 must be able to READ dist/, node_modules/, public/
# and db/migrations/*.sql (the api service runs `node dist/scripts/migrate.js`
# before starting), but it must not be able to rewrite its own code. A recursive
# chown would also duplicate the whole node_modules tree into an extra layer.
USER node

EXPOSE 3000

# Default probe targets the API liveness endpoint, which is public. Services
# built from this image that expose a different surface (worker metrics) or no
# HTTP surface at all (scheduler) override or disable this in compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "const port = process.env.HEALTHCHECK_PORT || process.env.PORT || 3000; fetch('http://127.0.0.1:' + port + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));"]

CMD ["node", "dist/main/api.js"]
