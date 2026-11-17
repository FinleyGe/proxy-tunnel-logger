FROM --platform=$BUILDPLATFORM oven/bun:1-slim AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui

ARG TARGETARCH
RUN ARCH="${TARGETARCH:-$(uname -m)}" && \
    case "$ARCH" in \
      arm64|aarch64) BUN_TARGET="bun-linux-arm64" ;; \
      *) BUN_TARGET="bun-linux-x64" ;; \
    esac && \
    bun build --compile --target="$BUN_TARGET" src/index.ts --outfile /app/proxy-tunnel-logger && \
    mkdir -p /app/empty-data

FROM oven/bun:1-slim AS runtime

WORKDIR /app

COPY --from=builder /app/proxy-tunnel-logger /app/proxy-tunnel-logger
COPY --from=builder /app/empty-data /data

ENV PROXY_HOST=0.0.0.0 \
    PROXY_PORT=8080 \
    UI_HOST=0.0.0.0 \
    UI_PORT=3000 \
    DATA_DIR=/data \
    MAX_BODY_BYTES=10485760

EXPOSE 8080 3000
VOLUME ["/data"]

ENTRYPOINT ["/app/proxy-tunnel-logger"]
