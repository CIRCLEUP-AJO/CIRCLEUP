# ── CircleUp container images ─────────────────────────────────────────────────
#
# This file defines three targets:
#
#   dev          Full development toolchain (Node 22, Rust, stellar-cli).
#   app-prod     Production image for the Next.js app (standalone output).
#   indexer-prod Production image for the indexer API.
#
# ── Development image ─────────────────────────────────────────────────────────
#
# Installs the full toolchain needed to build and test CircleUp:
#   - Node.js 22 (LTS) + npm 11
#   - Rust stable + wasm32-unknown-unknown target
#   - stellar-cli (latest)
#
# Usage:
#   docker build -t circleup-dev .
#   docker run --rm -it -v $(pwd):/workspace circleup-dev
#
# Or use docker compose (wires the Postgres service automatically):
#   docker compose up
#
# After the container starts, run:
#   npm ci          # install Node dependencies
#   npm test        # build SDK + run 900+ unit tests (no external services)
#   cd contracts && cargo test   # run Rust contract tests

FROM node:22-bookworm-slim AS base

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# ── Rust toolchain ────────────────────────────────────────────────────────────
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH="${CARGO_HOME}/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal && \
    rustup target add wasm32-unknown-unknown && \
    cargo --version && \
    rustc --version

# ── stellar-cli ───────────────────────────────────────────────────────────────
RUN cargo install --locked stellar-cli --features opt && \
    stellar --version

# ── Node.js dependencies ──────────────────────────────────────────────────────
WORKDIR /workspace
COPY package*.json ./
COPY sdk/package.json ./sdk/
COPY indexer/package.json ./indexer/
COPY app/package.json ./app/
COPY scripts/package.json ./scripts/

RUN npm ci

# ── Source code ───────────────────────────────────────────────────────────────
# .dockerignore excludes .env*, node_modules, and test artifacts so no
# credentials or development dependencies land in any image.
COPY . .

# ── Pre-build SDK so the image is immediately usable ─────────────────────────
RUN npm run build:sdk

# ── Default command: print available commands ─────────────────────────────────
CMD ["sh", "-c", "\
  echo '' && \
  echo '✅  CircleUp dev container ready.' && \
  echo '' && \
  echo '  npm test                    # SDK unit tests (no external services)' && \
  echo '  npm run test:all            # Full suite (requires Postgres)' && \
  echo '  npm run dev:indexer         # Start indexer API on :3001' && \
  echo '  npm run dev:app             # Start Next.js app on :3000' && \
  echo '  cd contracts && cargo test  # Run Rust contract tests' && \
  echo '' \
"]

# ══════════════════════════════════════════════════════════════════════════════
# Production images
# ══════════════════════════════════════════════════════════════════════════════
#
# Runtime environment contract (no secrets are baked into any image):
#
#   app-prod
#     PORT=3000                     Listen port (EXPOSE 3000)
#     HOSTNAME=0.0.0.0              Bind address for the standalone server
#     NODE_ENV=production           Set in the image
#     NEXT_PUBLIC_*                 Public build/runtime config (non-secret)
#     DATABASE_URL, RPC URLs, etc.  Injected at runtime by the platform
#     Health: GET / (HTTP 200) via HEALTHCHECK
#
#   indexer-prod
#     PORT=3001                     Listen port (EXPOSE 3001)
#     NODE_ENV=production           Set in the image
#     DATABASE_URL, RPC URLs, etc.  Injected at runtime by the platform
#     Health: GET /health (HTTP 200) via HEALTHCHECK
#
# Both images run as the unprivileged `node` user (uid 1000) and write only to
# /tmp. Build them with:
#   docker build --target app-prod -t circleup-app .
#   docker build --target indexer-prod -t circleup-indexer .

# ── Shared production build stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS prod-build

WORKDIR /workspace
COPY package*.json ./
COPY sdk/package.json ./sdk/
COPY indexer/package.json ./indexer/
COPY app/package.json ./app/
COPY scripts/package.json ./scripts/

# Install all deps (needed to compile), then build the SDK and indexer.
RUN npm ci
COPY . .
RUN npm run build:sdk && npm run build:indexer

# ── App production image (Next.js standalone) ─────────────────────────────────
FROM node:22-bookworm-slim AS app-prod

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build the Next.js app with standalone output, then install only production
# dependencies for the standalone server.
COPY --from=prod-build /workspace /workspace
RUN cd /workspace/app && npm run build

# Copy the standalone server bundle and static assets.
COPY --from=prod-build /workspace/app/.next/standalone ./
COPY --from=prod-build /workspace/app/.next/static ./app/.next/static
COPY --from=prod-build /workspace/app/public ./app/public

# Ensure the runtime user owns nothing writable outside /tmp.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/" || exit 1

CMD ["node", "app/server.js"]

# ── Indexer production image ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS indexer-prod

ENV NODE_ENV=production \
    PORT=3001

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only production dependencies for the indexer.
COPY package*.json ./
COPY sdk/package.json ./sdk/
COPY indexer/package.json ./indexer/
COPY scripts/package.json ./scripts/
RUN npm ci --omit=dev

# Copy the compiled SDK and indexer artifacts from the build stage.
COPY --from=prod-build /workspace/sdk/dist ./sdk/dist
COPY --from=prod-build /workspace/indexer/dist ./indexer/dist

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "indexer/dist/index.js"]
