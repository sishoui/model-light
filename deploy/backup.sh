#!/usr/bin/env bash
# Daily MySQL dump + retention. Run from host cron, e.g.:
#   30 3 * * * /srv/model-light/deploy/backup.sh >> /var/log/ml-backup.log 2>&1
# Keeps 14 days of dumps (spec §10); retention.js removes expired files.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d)"
OUT="$BACKUP_DIR/ml-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

docker compose exec -T db sh -c 'exec mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  | gzip > "$OUT"

# Refuse an empty dump: a failed mysqldump must not overwrite a good snapshot chain.
if [ ! -s "$OUT" ]; then
  rm -f "$OUT"
  echo "backup failed: empty dump" >&2
  exit 1
fi

node deploy/retention.js "$BACKUP_DIR" "$KEEP_DAYS"
echo "backup ok: $OUT"
