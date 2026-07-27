# Universal Memory Hub — Bun container
#
# Base: oven/bun (official Bun image).
# Requires Bun ≥1.3.10 — gbrain depends on PGLite WASM which is Bun-specific.
# Does NOT use Node.js runtime (see tech-spec D2).
#
# Build context: repo root (universal-memory/)
#   docker compose build memory-hub    # context set in docker-compose.yml
#
# Layout inside /app mirrors the repo structure so workspace path
# "../../vendors/gbrain" from packages/memory-hub resolves correctly:
#
#   /app/
#     packages/memory-hub/     ← main package
#     vendors/gbrain/          ← workspace dependency

FROM oven/bun:1.3.10-slim

WORKDIR /app

# ─── Install OS-level deps ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Install dependencies ─────────────────────────────────────────────────────
# Copy manifest files first — changes to src won't invalidate this layer.
COPY packages/memory-hub/package.json packages/memory-hub/package.json
COPY packages/memory-hub/bun.lock     packages/memory-hub/bun.lock
COPY vendors/gbrain/package.json      vendors/gbrain/package.json

# Install from the memory-hub package directory.
# Bun resolves the workspace dep "gbrain": "workspace:../../vendors/gbrain" relative
# to packages/memory-hub/, which maps to /app/vendors/gbrain — correct.
WORKDIR /app/packages/memory-hub
RUN bun install --frozen-lockfile

# ─── Copy source ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY packages/memory-hub/src /app/packages/memory-hub/src
COPY vendors/gbrain           /app/vendors/gbrain

# ─── Runtime ──────────────────────────────────────────────────────────────────
WORKDIR /app/packages/memory-hub

# Internal port: 3456 (cloud/HTTP mode). nginx proxies externally.
EXPOSE 3456

# Health probe — /health has no auth (see http.ts)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:3456/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# D2: Bun runtime required. D3: cloud mode starts HTTP server on 3456.
CMD ["bun", "run", "src/mcp/server.ts"]
