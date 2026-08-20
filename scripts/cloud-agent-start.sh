#!/usr/bin/env bash
# Per-boot startup for a containerized / Cloud Agent dev environment.
# Starts the Docker daemon, ensures a local .env, brings up Postgres, applies
# migrations, and then runs the Rakazo dev stack (api, worker, web, sandbox
# supervisor) in the foreground so it stays attached for the lifetime of the box.
set -euo pipefail

# Prefer the pinned Node 22 (>= 22.19) over any older default on PATH.
export PATH="/usr/local/bin:${PATH}"

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo /workspace)"

COMPOSE=(sudo docker compose --env-file .env -f infra/compose/docker-compose.yml)

# 1. Start the Docker daemon if it is not already running (no systemd in the VM).
if ! sudo docker info >/dev/null 2>&1; then
  echo "starting dockerd..."
  sudo bash -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 30); do
    sudo docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
sudo docker info >/dev/null 2>&1 && echo "docker: ready" || { echo "docker failed to start"; exit 1; }

# 2. Ensure a local .env with independent random secrets (created once, then reused).
if [ ! -f .env ]; then
  echo "creating .env from .env.example with generated local secrets..."
  cp .env.example .env
  sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
fi

# 3. Bring up local Postgres and wait until it is healthy.
"${COMPOSE[@]}" up postgres -d
for _ in $(seq 1 40); do
  cid="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
  status="$(sudo docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 2
done
echo "postgres: ${status:-unknown}"

# 4. Apply database migrations.
set -a; . ./.env; set +a
pnpm db:migrate

# 5. Run the dev stack in the foreground (stays attached).
exec pnpm dev
