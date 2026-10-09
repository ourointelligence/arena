#!/usr/bin/env bash
# Every 5 minutes: check the lanes, disk and restarts; send a Telegram message when something needs a human.
# Without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID it only logs (journald).
set -uo pipefail
API="http://127.0.0.1:${ARENA_API_PORT:-8787}/arena/api/health"
STATE_DIR="${ARENA_DATA_DIR:-/var/lib/arena}/health"
mkdir -p "$STATE_DIR"
now=$(date +%s)
problems=()

health=$(curl -fsS --max-time 10 "$API" 2>/dev/null) || { problems+=("api: /arena/api/health unreachable"); health=""; }

if [ -n "$health" ]; then
  while IFS=$'\t' read -r lane state lastBar lastCycle; do
    [ -z "$lane" ] && continue
    case "$lane" in core|flow) interval=900;; alts) interval=3600;; *) interval=900;; esac
    if [ "$state" = "error" ] || [ "$state" = "stopped" ]; then problems+=("$lane: state $state"); fi
    if [ "$lastBar" != "null" ] && [ -n "$lastBar" ]; then
      age=$(( now - lastBar / 1000 ))
      [ "$age" -gt $(( 2 * interval + interval )) ] && problems+=("$lane: no new bar for $(( age / 60 )) min")
    fi
    if [ "$lastCycle" != "null" ] && [ -n "$lastCycle" ]; then
      cage=$(( now - lastCycle / 1000 ))
      [ "$cage" -gt 43200 ] && problems+=("$lane: no cycle for $(( cage / 3600 )) h")
    fi
  done < <(printf '%s' "$health" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for k,v in d.get("lanes",{}).items():
    print("\t".join([k, str(v.get("state")), str(v.get("lastBarTs")), str(v.get("lastCycleTs"))]))')
  disk=$(printf '%s' "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("disk",{}).get("percent") or 0)')
  [ "${disk%.*}" -gt 80 ] 2>/dev/null && problems+=("disk at ${disk}%")
fi

# budget pauses in the last 5 minutes
if [ -f "${ARENA_DB:-/var/lib/arena/arena.db}" ]; then
  since=$(( (now - 300) * 1000 ))
  bp=$(sqlite3 -readonly "${ARENA_DB:-/var/lib/arena/arena.db}" "SELECT lane_id FROM control WHERE action='budget_pause' AND ts > $since" 2>/dev/null || true)
  for l in $bp; do problems+=("$l: paused by budget"); done
fi

# a service restarted 3 times in 10 minutes
for unit in arena-api arena-lane@core arena-lane@alts arena-lane@flow; do
  n=$(journalctl -u "$unit" --since "10 min ago" --no-pager -q 2>/dev/null | grep -c "Scheduled restart job" || true)
  [ "${n:-0}" -ge 3 ] && problems+=("$unit restarted $n times in 10 min")
done

if [ ${#problems[@]} -eq 0 ]; then
  echo "health ok"
  exit 0
fi
msg="OURO Arena: $(printf '%s; ' "${problems[@]}")"
echo "$msg"
# do not repeat the same alert more often than every 30 minutes
key=$(printf '%s' "$msg" | sha256sum | cut -c1-16)
stamp="$STATE_DIR/$key"
if [ -f "$stamp" ] && [ $(( now - $(cat "$stamp") )) -lt 1800 ]; then exit 0; fi
echo "$now" > "$stamp"
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null && echo "telegram sent" || echo "telegram failed"
fi
