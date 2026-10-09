#!/usr/bin/env bash
# Nightly: a consistent copy of arena.db (sqlite .backup) plus the lane folders, tar.gz under /var/backups/arena, 14 days kept.
set -euo pipefail
DATA="${ARENA_DATA_DIR:-/var/lib/arena}"
DB="${ARENA_DB:-$DATA/arena.db}"
OUT=/var/backups/arena
mkdir -p "$OUT"
stamp=$(date -u +%Y-%m-%dT%H%M)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -f "$DB" ]; then sqlite3 "$DB" ".backup '$work/arena.db'"; fi
cp -r "$DATA/lanes" "$work/lanes" 2>/dev/null || true
cp -r "$DATA/ledger" "$work/ledger" 2>/dev/null || true
tar -C "$work" -czf "$OUT/arena-$stamp.tar.gz" .
find "$OUT" -name 'arena-*.tar.gz' -mtime +14 -delete
echo "backup $OUT/arena-$stamp.tar.gz ($(du -h "$OUT/arena-$stamp.tar.gz" | cut -f1))"
