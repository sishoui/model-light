#!/usr/bin/env bash
# Log retention: docker logs kept 7 days, json-file driver caps size.
# Applied via logging section in docker-compose services (see compose).
# This script is only needed for host-side container log rotation if the
# driver is not used; cron:  0 4 * * * /srv/model-light/deploy/logrotate.sh
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${LOG_KEEP_DAYS:-7}"
CUTOFF=$(( $(date +%s) - KEEP_DAYS * 86400 ))

for f in /var/lib/docker/containers/*/*-json.log; do
  [ -e "$f" ] || continue
  if [ "$(stat -c %Y "$f")" -lt "$CUTOFF" ]; then
    : > "$f"   # truncate, do not delete: the container still holds the fd
    echo "truncated $f"
  fi
done
