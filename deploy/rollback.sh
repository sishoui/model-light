#!/usr/bin/env bash
# Deploy order (spec §10): mysqldump snapshot -> prisma migrate deploy ->
# swap api container -> health check. Rollback = revert image to previous tag
# (+ restore snapshot if needed), see docs/deploy.md.
set -euo pipefail
cd "$(dirname "$0")/.."

API_TAG="${API_TAG:-latest}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8082/v1/health}"

echo "== 0. ensure db up (idempotent; first deploy has no db yet) =="
docker compose up -d db
for i in $(seq 1 30); do
  if docker compose exec -T db mysqladmin ping -h 127.0.0.1 --silent 2>/dev/null; then
    echo "db healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "db did not become healthy" >&2
    exit 1
  fi
  sleep 2
done

echo "== 1. mysqldump snapshot =="
./deploy/backup.sh

echo "== 2. pull image + prisma migrate deploy =="
export API_TAG
docker compose pull api
docker compose run --rm api npx prisma migrate deploy

echo "== 3. swap api container =="
docker compose up -d --no-deps api

echo "== 4. health check =="
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" > /dev/null; then
    echo "deploy ok: api tag=$API_TAG healthy"
    exit 0
  fi
  sleep 2
done

echo "health check failed after swap; ROLL BACK to previous image tag and restore snapshot if needed" >&2
exit 1
