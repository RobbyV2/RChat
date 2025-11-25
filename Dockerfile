# Multi-stage Dockerfile for RChat
# Builds both Rust backend and Next.js frontend

# =============================================================================
# Stage 1: Build Next.js frontend
# =============================================================================
FROM oven/bun:1 AS frontend-builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source files
COPY app/ ./app/
COPY public/ ./public/
COPY next.config.js ./
COPY tsconfig.json ./
COPY tailwind.config.js ./
COPY postcss.config.js ./

# Build Next.js
RUN bun run build

# Copy static files for standalone
RUN cp -r public .next/standalone/ && \
    cp -r .next/static .next/standalone/.next/

# =============================================================================
# Stage 2: Build Rust backend
# =============================================================================
FROM rustlang/rust:nightly-slim AS rust-builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Cargo files first for dependency caching
COPY Cargo.toml Cargo.lock ./

# Create dummy source to build dependencies
RUN mkdir -p src/bin && \
    echo "fn main() {}" > src/bin/server.rs && \
    echo "pub fn dummy() {}" > src/lib.rs

# Build dependencies (cached layer)
RUN cargo build --release --bin server 2>/dev/null || true

# Copy actual source code
COPY src/ ./src/
COPY migrations/ ./migrations/

# Build the actual binary
RUN cargo build --release --bin server

# =============================================================================
# Stage 3: Runtime image
# =============================================================================
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Install runtime dependencies (curl for healthcheck)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Rust binary
COPY --from=rust-builder /app/target/release/server /app/server

# Copy Next.js standalone build
COPY --from=frontend-builder /app/.next/standalone /app/frontend

# Copy migrations and data directory
COPY migrations/ /app/migrations/

# Create uploads directory
RUN mkdir -p /app/uploads /app/data

# Create startup script
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
# Start Next.js standalone server in background (using bun)\n\
cd /app/frontend\n\
PORT=3001 HOSTNAME=0.0.0.0 bun run server.js &\n\
NEXT_PID=$!\n\
\n\
# Wait for Next.js to start\n\
sleep 2\n\
\n\
# Start Rust server (main entry point)\n\
cd /app\n\
SERVER_PROXY_URL=http://127.0.0.1:3001 \\\n\
SERVER_HOST=0.0.0.0 \\\n\
SERVER_PORT=${SERVER_PORT:-3000} \\\n\
DATABASE_URL=${DATABASE_URL:-sqlite:///app/data/rchat.db?mode=rwc} \\\n\
./server &\n\
RUST_PID=$!\n\
\n\
# Handle shutdown\n\
trap "kill $NEXT_PID $RUST_PID 2>/dev/null; exit 0" SIGTERM SIGINT\n\
\n\
# Wait for either process to exit\n\
wait -n\n\
exit $?\n\
' > /app/start.sh && chmod +x /app/start.sh

# Environment variables with defaults
ENV SERVER_PORT=3000
ENV SERVER_HOST=0.0.0.0
ENV RUST_LOG=info
ENV DATABASE_URL=sqlite:///app/data/rchat.db?mode=rwc

# Expose the main port (Rust server)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/auth/health || exit 1

# Volume for persistent data
VOLUME ["/app/data", "/app/uploads"]

# Run the startup script
CMD ["/app/start.sh"]
