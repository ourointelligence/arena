#!/usr/bin/env bash
# Daily at 00:10 UTC: commit the day's ledger files and each lane's chain.jsonl to github.com/ourointelligence/arena-ledger.
# /var/lib/arena/ledger is a clone of that repo; the deploy key lives in /var/lib/arena/.ssh/arena-ledger (install step).
set -euo pipefail
LEDGER="${ARENA_LEDGER_DIR:-${ARENA_DATA_DIR:-/var/lib/arena}/ledger}"
KEY="${ARENA_LEDGER_KEY:-${ARENA_DATA_DIR:-/var/lib/arena}/.ssh/arena-ledger}"
cd "$LEDGER"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git config user.name "OURO"
git config user.email "340016144+ourointelligence@users.noreply.github.com"
git add -A core alts flow 2>/dev/null || true
if git diff --cached --quiet; then
  echo "nothing new to commit"
  exit 0
fi
day=$(date -u -d yesterday +%F)
git commit -q -m "ledger $day"
git push -q origin HEAD:main
echo "pushed ledger $day ($(git rev-parse --short HEAD))"
