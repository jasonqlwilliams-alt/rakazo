#!/usr/bin/env bash
# Idempotent repository bootstrap for a containerized / Cloud Agent dev environment.
# Runs after the repository is checked out. Installs JS dependencies and generates
# the Prisma client. It must terminate and must not start long-running services.
#
# Prerequisites baked into the base image / snapshot:
#   - Node.js >= 22.19 on PATH at /usr/local/bin (the repo requires it via undici's
#     engines field with .npmrc engine-strict=true; the default 22.14 is too old).
#   - pnpm 9.15.0 available through Corepack.
#   - Docker engine configured with the fuse-overlayfs storage driver (used at boot).
set -euo pipefail

# Prefer the pinned Node 22 (>= 22.19) over any older default on PATH.
export PATH="/usr/local/bin:${PATH}"

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo /workspace)"

echo "node: $(node --version)"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@9.15.0 --activate >/dev/null 2>&1 || true
echo "pnpm: $(pnpm --version)"

pnpm install --frozen-lockfile
pnpm db:generate
