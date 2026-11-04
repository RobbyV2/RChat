# Stage 1: Prepare dependency recipe
FROM rust:1.99.1-slim-trixie@sha256:1a939748a7cbab172de91a014e3804a97af1394a8c844faa67fce9401c4e40fb AS chef
RUN cargo install cargo-chef --version 0.1.78 --locked
RUN cargo install wasm-pack --version 0.15.0 --locked
RUN cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /app

# Stage 2: Generate recipe from workspace
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3: Build dependencies + server + WASM
FROM chef AS rust-builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json --bin server

COPY . .
RUN cargo build --release --bin server
# no-install: the wasm-bindgen above, and no unchecked wasm-opt download (the module is ~6% larger).
RUN wasm-pack build crates/wasm --mode no-install --target web --out-dir ../../apps/web/public/wasm --release

# Stage 4: Build Next.js
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS js-builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

COPY . ./
COPY --from=rust-builder /app/apps/web/public/wasm ./apps/web/public/wasm

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_PEERJS_HOST
ARG NEXT_PUBLIC_PEERJS_PORT
RUN bun run build
COPY deploy/peer/package.json deploy/peer/bun.lock deploy/peer/server.mjs /peer/
RUN cd /peer && bun install --frozen-lockfile --production

# Stage 5: Runtime
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOST=0.0.0.0
ENV SERVER_PORT=3000
ENV PORT=3001
ENV APP_MODE=full
ENV DATABASE_URL=/data/rchat.db

RUN useradd --system --uid 10001 --user-group --home-dir /app --no-create-home rchat \
    && mkdir -p /data /app/.next/cache \
    && chown rchat:rchat /data /app/.next/cache
VOLUME /data

COPY --from=js-builder /app/apps/web/.next/standalone/node_modules ./node_modules
COPY --from=js-builder /app/apps/web/.next/standalone/apps/web ./
COPY --from=js-builder /app/apps/web/.next/static ./.next/static
COPY --from=js-builder /app/apps/web/public ./public
COPY --from=js-builder /peer /app/peer
COPY --from=rust-builder /app/target/release/server /app/server
COPY --chmod=755 deploy/start.sh /app/start.sh

USER rchat

EXPOSE 3000 9001 3478/udp 49160-49415/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fs "http://localhost:${SERVER_PORT:-3000}/api/health" > /dev/null || exit 1

CMD ["/app/start.sh"]
