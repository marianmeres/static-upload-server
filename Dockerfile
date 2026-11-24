# syntax=docker/dockerfile:1
#
# Two stages on node:26-slim. Node runs the TypeScript in `src/` as is (its types
# are stripped at load), so nothing is compiled: the image is the production
# dependencies plus the source.

# ---- production dependencies ------------------------------------------------
FROM node:26-slim AS deps

WORKDIR /app

# pnpm at the version the repo pins, read out of `packageManager`. Through npm,
# not corepack: Node 25+ no longer bundles corepack and the node:26 images do not
# add it back. `pnpm-workspace.yaml` carries the release-age exemption for our own
# scope, without which a frozen install refuses a dependency published today.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g \
        "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
        --no-audit --no-fund \
    && pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------
FROM node:26-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
# The manifest, for its `version` (reported by `GET /`) and `"type": "module"`.
COPY package.json ./
COPY src/ src/

RUN useradd -r -s /bin/false appuser \
    && mkdir -p /data /config \
    && chown appuser:appuser /data /config

USER appuser

EXPOSE 8000

# Exec form, one process, no init wrapper: the stop signal reaches the server
# directly, and `src/cli.ts` shuts down on it.
CMD ["node", "src/cli.ts"]
