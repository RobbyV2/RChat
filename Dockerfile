# Stage 1: Prepare dependency recipe
FROM rust:slim-trixie AS chef
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
WORKDIR /app

# Stage 2: Generate recipe from workspace
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3: Build dependencies + server + WASM
FROM chef AS rust-builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

COPY . .
RUN cargo build --release --bin server
RUN wasm-pack build wasm --target web --out-dir ../public/wasm --release

# Stage 4: Build Next.js
FROM oven/bun:latest AS js-builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . ./
COPY --from=rust-builder /app/public/wasm ./public/wasm

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_PEERJS_HOST
ARG NEXT_PUBLIC_PEERJS_PORT
RUN bun run build
RUN mkdir -p /peer && cd /peer && echo '{"name":"peer-runtime","dependencies":{"peer":"^1.0.2"}}' > package.json && bun install

# Stage 5: Runtime
FROM debian:trixie-slim
WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:latest /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOST=0.0.0.0
ENV SERVER_PORT=3000
ENV PORT=3001
ENV APP_MODE=full
ENV DATABASE_URL=/data/rchat.db

RUN mkdir -p /data
VOLUME /data

COPY --from=js-builder /app/.next/standalone ./
COPY --from=js-builder /app/.next/static ./.next/static
COPY --from=js-builder /app/public ./public
COPY --from=js-builder /peer /app/peer
COPY --from=rust-builder /app/target/release/server /app/server
COPY --chmod=755 deploy/start.sh /app/start.sh

EXPOSE 3000 9001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fs "http://localhost:${SERVER_PORT:-3000}/api/health" > /dev/null || exit 1

CMD ["/app/start.sh"]
