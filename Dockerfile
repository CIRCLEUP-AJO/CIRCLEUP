# ── CircleUp development image ────────────────────────────────────────────────
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
