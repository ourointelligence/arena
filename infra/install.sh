#!/usr/bin/env bash
# Install or update OURO Arena on the server. Run as root (sudo). Idempotent.
#   bash infra/install.sh [git ref]
# Pulls the repo to /opt/arena, installs with the frozen lockfile, builds, copies the web build to /var/www/arena,
# installs the systemd units, timers and the nginx snippet, and restarts the services.
set -euo pipefail

REPO_URL="${ARENA_REPO_URL:-https://github.com/ourointelligence/arena.git}"
REF="${1:-main}"
APP=/opt/arena
DATA=/var/lib/arena
WWW=/var/www/arena
BACKUPS=/var/backups/arena
ENVFILE=/etc/arena/arena.env

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q sqlite3 git rsync >/dev/null

echo "== user and directories"
id arena >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin --user-group arena
install -d -o arena -g arena -m 750 "$DATA" "$DATA/lanes" "$DATA/ledger" "$DATA/og" "$BACKUPS"
install -d -o root -g root -m 755 "$WWW" "$APP" /etc/arena
install -d -o arena -g arena -m 750 /run/arena
if [ ! -f "$ENVFILE" ]; then
  echo "no $ENVFILE yet: copy .env.example there, fill in OURO_LLM, OURO_MODEL and the provider key, chmod 640 root:arena" >&2
  exit 1
fi
chown root:arena "$ENVFILE" && chmod 640 "$ENVFILE"

echo "== ledger deploy key and clone"
install -d -o arena -g arena -m 700 "$DATA/.ssh"
if [ ! -f "$DATA/.ssh/arena-ledger" ]; then
  sudo -u arena ssh-keygen -q -t ed25519 -N "" -C "arena-ledger deploy key" -f "$DATA/.ssh/arena-ledger"
  echo "new deploy key; add it to github.com/ourointelligence/arena-ledger (Settings, Deploy keys, write access):"
  cat "$DATA/.ssh/arena-ledger.pub"
fi
if [ ! -d "$DATA/ledger/.git" ]; then
  sudo -u arena env GIT_SSH_COMMAND="ssh -i $DATA/.ssh/arena-ledger -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"     git clone -q git@github.com:ourointelligence/arena-ledger.git "$DATA/ledger" || echo "ledger clone failed (register the deploy key first); the hourly ledger still writes locally"
fi

echo "== code"
if [ ! -d "$APP/.git" ]; then
  git clone "$REPO_URL" "$APP"
fi
git -C "$APP" fetch --tags origin
git -C "$APP" checkout -q "$REF"
if git -C "$APP" show-ref --verify --quiet "refs/remotes/origin/$REF"; then git -C "$APP" reset -q --hard "origin/$REF"; fi
echo "at $(git -C "$APP" rev-parse --short HEAD)"

echo "== build"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
command -v pnpm >/dev/null 2>&1 || corepack enable
( cd "$APP" && pnpm install --frozen-lockfile && pnpm -r --filter @arena/core --filter @arena/hl --filter @arena/flow --filter @arena/runner --filter @arena/api --filter @arena/cli --filter @arena/web run build )

echo "== static site"
rm -rf "$WWW"/*
cp -r "$APP/apps/web/dist/." "$WWW/"
chown -R root:root "$WWW"

echo "== admin command"
install -m 755 "$APP/infra/arena.sh" /usr/local/bin/arena

echo "== systemd"
install -m 644 "$APP/infra/arena-lane@.service" /etc/systemd/system/arena-lane@.service
install -m 644 "$APP/infra/arena-api.service" /etc/systemd/system/arena-api.service
for job in ledger ledger-daily health backup compact; do
  case $job in
    ledger) cal="*-*-* *:05:00"; cmd="/usr/local/bin/arena ledger";;
    ledger-daily) cal="*-*-* 00:10:00 UTC"; cmd="/bin/bash $APP/infra/ledger-daily.sh";;
    health) cal="*:0/5"; cmd="/bin/bash $APP/infra/health.sh";;
    backup) cal="*-*-* 03:30:00 UTC"; cmd="/bin/bash $APP/infra/backup.sh";;
    compact) cal="*-*-* 04:00:00 UTC"; cmd="/bin/bash $APP/infra/compact.sh";;
  esac
  user=arena
  [ "$job" = backup ] && user=root
  cat > "/etc/systemd/system/arena-$job.service" <<EOF
[Unit]
Description=OURO Arena $job job
After=network-online.target

[Service]
Type=oneshot
User=$user
Group=arena
WorkingDirectory=$APP
EnvironmentFile=$ENVFILE
ExecStart=$cmd
EOF
  cat > "/etc/systemd/system/arena-$job.timer" <<EOF
[Unit]
Description=OURO Arena $job timer

[Timer]
OnCalendar=$cal
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
EOF
done
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/arena.conf
systemctl restart systemd-journald || true
systemctl daemon-reload

echo "== nginx"
install -m 644 "$APP/infra/nginx-arena.conf" /etc/nginx/snippets/arena.conf
SITE=/etc/nginx/sites-available/ourosi.xyz
if ! grep -q "limit_req_zone \$binary_remote_addr zone=arena_api" /etc/nginx/conf.d/arena-limits.conf 2>/dev/null; then
  echo 'limit_req_zone $binary_remote_addr zone=arena_api:10m rate=120r/m;' > /etc/nginx/conf.d/arena-limits.conf
fi
if ! grep -q "snippets/arena.conf" "$SITE"; then
  # add the include to the https server block for the bare domain (the block whose server_name is exactly ourosi.xyz)
  python3 - "$SITE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
marker = "    server_name ourosi.xyz;\n"
i = s.index(marker)
s = s[: i + len(marker)] + "    include snippets/arena.conf;\n" + s[i + len(marker):]
open(p, "w").write(s)
PY
fi
nginx -t && systemctl reload nginx

echo "== services"
systemctl enable --now arena-api.service
for lane in core alts flow; do systemctl enable --now "arena-lane@$lane.service"; done
for job in ledger ledger-daily health backup compact; do systemctl enable --now "arena-$job.timer"; done
sleep 3
systemctl --no-pager --plain status arena-api arena-lane@core arena-lane@alts arena-lane@flow | grep -E "Active:|●" || true
echo "== done"
