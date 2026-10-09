#!/usr/bin/env bash
# /usr/local/bin/arena: the admin command. Runs the CLI as the arena user so the control sockets (mode 600) are reachable.
set -euo pipefail
ENVFILE=/etc/arena/arena.env
if [ "$(id -un)" = "arena" ]; then
  set -a; . "$ENVFILE"; set +a
  exec /usr/bin/node /opt/arena/apps/cli/dist/main.js "$@"
fi
# any sudoer runs it as arena, keeping their own name as the actor
exec sudo -u arena env ARENA_ACTOR="${SUDO_USER:-$(id -un)}" bash -c 'set -a; . /etc/arena/arena.env; set +a; exec /usr/bin/node /opt/arena/apps/cli/dist/main.js "$@"' -- "$@"
