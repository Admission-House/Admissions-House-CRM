#!/usr/bin/env bash
# Backs up the database and the uploaded files. Run from cron, for example every night:
#   15 2 * * *  /opt/admission-house/ops/backup.sh >> /var/log/ah-backup.log 2>&1
# Needs: PGHOST, PGUSER, PGPASSWORD (an account that can read the database), BACKUP_DIR, and
# optionally STORAGE_DIR (the uploads folder) and KEEP_DAYS (default 14).
set -euo pipefail
: "${BACKUP_DIR:?set BACKUP_DIR}"
: "${PGDATABASE:=admission_house}"
KEEP_DAYS="${KEEP_DAYS:-14}"
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Custom format: compressed, and lets a single table be restored.
pg_dump --format=custom --no-owner --file="$BACKUP_DIR/db-$stamp.dump" "$PGDATABASE"
if [ -n "${STORAGE_DIR:-}" ] && [ -d "$STORAGE_DIR" ]; then
  tar -C "$STORAGE_DIR" -czf "$BACKUP_DIR/files-$stamp.tar.gz" .
fi

# A backup that cannot be read is not a backup.
pg_restore --list "$BACKUP_DIR/db-$stamp.dump" > /dev/null
echo "$(date -Is) backup $stamp ok"

find "$BACKUP_DIR" -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
