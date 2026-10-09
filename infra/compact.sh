#!/usr/bin/env bash
# Nightly: equity rows older than 30 days are downsampled to one per hour (the last point of each hour).
set -euo pipefail
DB="${ARENA_DB:-${ARENA_DATA_DIR:-/var/lib/arena}/arena.db}"
cutoff=$(( ( $(date +%s) - 30 * 86400 ) * 1000 ))
sqlite3 "$DB" <<SQL
PRAGMA busy_timeout = 5000;
DELETE FROM equity
WHERE ts < $cutoff
  AND rowid NOT IN (
    SELECT MAX(rowid) FROM equity WHERE ts < $cutoff GROUP BY lane_id, ts / 3600000
  );
SQL
echo "equity compacted below $(date -u -d @$(( cutoff / 1000 )) +%F)"
