# ---- Build stage: compile the TypeScript vault tool -------------------------
FROM node:22-slim AS build

WORKDIR /build

COPY docker/package.json docker/tsconfig.json ./
RUN npm install

COPY docker/src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage -----------------------------------------------------------
FROM node:22-slim

LABEL maintainer="NorkzYT richard@pcscorp.dev"

# curl fetches the supported-import-format list at runtime.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    npm install -g @bitwarden/cli@2025.12.0 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /bitwardensync

COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["/bitwardensync/entrypoint.sh"]
