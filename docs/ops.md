# OURO Arena: operations

## Server layout

| Path | What |
| --- | --- |
| /opt/arena | the repository checkout, built; owned by root |
| /var/lib/arena | data, owned by arena: `lanes/<lane>/.ouro` (the SDK state of each lane), `arena.db`, `ledger/` (a clone of ourointelligence/arena-ledger), `og/` (share card cache), `health/` (alert stamps), `.ssh/arena-ledger` (the deploy key) |
| /var/www/arena | the static page build, served by nginx |
| /var/backups/arena | nightly tar.gz archives, 14 days kept |
| /run/arena | the control sockets `<lane>.sock`, mode 600, owner arena |
| /etc/arena/arena.env | the environment: `OURO_LLM`, `OURO_MODEL`, the provider key, `ARENA_BUDGET_USD_PER_LANE`, `ARENA_PRICE_IN_PER_MTOK`, `ARENA_PRICE_OUT_PER_MTOK`, optional `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; root:arena, mode 640 |
| /etc/nginx/snippets/arena.conf | the Arena locations, included in the ourosi.xyz https server block; the rate limit zone is in /etc/nginx/conf.d/arena-limits.conf |
| /usr/local/bin/arena | the admin command (`infra/arena.sh`) |

The system user `arena` runs everything. The lane units are hardened (NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, writable only under /var/lib/arena and /run/arena, MemoryMax=1G).

## Units and timers

| Unit | Schedule | Runs |
| --- | --- | --- |
| arena-lane@core, arena-lane@alts, arena-lane@flow | always on; Restart=on-failure after 10 s, at most 3 starts in 600 s | `node /opt/arena/apps/runner/dist/main.js <lane>` |
| arena-api | always on, same restart rule | `node /opt/arena/apps/api/dist/main.js` on 127.0.0.1:8787 |
| arena-ledger.timer | hourly at :05 | `arena ledger` |
| arena-ledger-daily.timer | daily 00:10 UTC | `infra/ledger-daily.sh` |
| arena-health.timer | every 5 minutes | `infra/health.sh` |
| arena-backup.timer | daily 03:30 UTC, as root | `infra/backup.sh` |
| arena-compact.timer | daily 04:00 UTC | `infra/compact.sh` |

journald keeps at most 500 MB for the system (`/etc/systemd/journald.conf.d/arena.conf`).

```bash
systemctl status arena-lane@core arena-api
journalctl -u arena-lane@core -f            # a lane's log
journalctl -u arena-api --since "1 hour ago"
systemctl list-timers 'arena-*'
```

## Deploy and redeploy

First time: create `/etc/arena/arena.env` from `.env.example` (root:arena, mode 640), then as root:

```bash
git clone https://github.com/ourointelligence/arena.git /opt/arena
bash /opt/arena/infra/install.sh
```

`install.sh <ref>` is idempotent: it fetches the ref (default `main`), runs `pnpm install --frozen-lockfile`, builds every package, copies the web build to /var/www/arena, installs `/usr/local/bin/arena`, the units, the timers, the journald cap and the nginx snippet (adding the `include snippets/arena.conf;` line to the ourosi.xyz server block and the `limit_req_zone`), tests and reloads nginx, enables and starts everything.

To ship a new version: tag it in git, push, then `bash /opt/arena/infra/install.sh v0.1.1` on the server. The lanes restart; they resume from their `.ouro` folders with no lost cycle.

To upgrade the SDK: on a workstation run `pnpm sdk:use <version>` (it rewrites the dependencies and overrides and runs `pnpm install`), run the tests, commit the manifests and `pnpm-lock.yaml`, tag, and redeploy. A lane upgraded to a new SDK keeps its history.

Node 22 comes from NodeSource and pnpm from corepack (`corepack enable`). The install needs network access to github.com for the SDK release files.

## The admin command

`arena` runs the CLI as the arena user through sudo and keeps your user name as the actor in the control log.

```bash
arena status                        # one line per lane: state, cycle, live, episodes, last bar age, ws, spend today, approval, pending, pid
arena pause core "market open"      # no new decisions; bars keep flowing
arena pause all
arena resume core
arena approval core on              # the next cycle with promotions stops at PENDING
arena approve core 42
arena reject core 42
arena approval core off
arena rollback core 40              # the population as it was at the end of cycle 40
arena budget alts 2                 # 2 USD per day for that lane
arena cycle flow                    # force a cycle now
arena export core /tmp/core.json    # the lane's export (schemaVersion 1)
arena ledger                        # what the hourly timer does
arena verify-ledger core            # recompute the chain; exit 1 when it breaks
arena rebuild                       # recreate arena.db tables from the .ouro folders (stop the lanes first for an exact copy)
arena drill core                    # the weekly kill switch drill
```

## The weekly drill

`arena drill <lane>` runs the kill switch end to end and prints one line per step. A pass looks like:

```
PASS  pause: state is paused
PASS  a bar arrived while paused
PASS  no new trade opened while paused (0 opened)
PASS  approval switch is on
PASS  cycle 57 stopped at pending
PASS  rejected cycle 57: no_change
PASS  resumed: state running, approval off
PASS  population intact (8 live)

DRILL PASS for lane core at 2026-10-12T09:15:04.120Z
```

The drill waits up to one bar interval plus 90 s for a bar to arrive while paused (15 minutes on Core and Flow, an hour on Alts), forces up to three cycles to reach a pending one, and writes a `drill` control row at the start and at the end with the full report, so the kill switch panel shows it. A FAIL line means a step did not behave; the lane is always resumed with the approval switch off at the end.

## Alerts

`infra/health.sh` runs every 5 minutes against `/arena/api/health` and reports when:

- the API is unreachable;
- a lane's state is `error` or `stopped` (a lane is `stopped` when its heartbeat row is older than 120 s);
- a lane's last bar is more than two intervals late (three interval lengths since the bar's open time);
- a lane has had no cycle for 12 hours;
- a lane paused itself for budget in the last 5 minutes;
- disk use is above 80 percent;
- a service restarted 3 times in 10 minutes.

With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set in arena.env the message goes to Telegram; otherwise it is only logged (`journalctl -u arena-health`). The same message is not repeated more often than every 30 minutes.

## Backups and restore

`infra/backup.sh` (03:30 UTC) takes a consistent copy of arena.db with `sqlite3 .backup`, copies the lane folders and the ledger, and writes `/var/backups/arena/arena-<timestamp>.tar.gz`; archives older than 14 days are deleted. The daily ledger push doubles as an offsite copy of the numbers.

Restore: stop the lanes and the API, unpack the archive into /var/lib/arena (keep ownership arena:arena), start the API, then the lanes. If only arena.db is lost, `arena rebuild` recreates its tables from the lane folders.

## Equity compaction

`infra/compact.sh` (04:00 UTC) keeps one equity row per hour for anything older than 30 days (the last row of each hour). Trades and events are kept forever.

## The ledger push

`/var/lib/arena/ledger` is a clone of github.com/ourointelligence/arena-ledger. Every hour `arena ledger` adds files and chain lines; at 00:10 UTC `infra/ledger-daily.sh` commits them as `OURO <340016144+ourointelligence@users.noreply.github.com>` and pushes with the deploy key at `/var/lib/arena/.ssh/arena-ledger` (an ed25519 key added to the repository with write access; `ARENA_LEDGER_KEY` overrides the path). Nothing to do unless the push fails: check `journalctl -u arena-ledger-daily`.

## Common problems

- **A lane shows stopped on the page or in `arena status`.** The runner is down or its heartbeat is older than 120 s. `systemctl status arena-lane@<lane>` and `journalctl -u arena-lane@<lane> -n 200`. After three failures in ten minutes systemd stops retrying: fix the cause, then `systemctl reset-failed arena-lane@<lane>` and `systemctl start arena-lane@<lane>`.
- **A lane is paused by budget.** It resumes at 00:00 UTC. To continue today: `arena budget <lane> <higher usd>` then `arena resume <lane>`.
- **No bars.** The source reconnects with backoff and refills gaps on its own; `arena status` shows `ws down` while it does. If it stays down, check outbound connectivity to api.hyperliquid.xyz and the lane log for `rateLimit` notices.
- **Rate limit notices.** Each lane budgets 200 weight per minute; the source waits rather than exceeding it. Many notices in a row mean the backfill or a gap refill is large; they stop once it has caught up.
- **The page shows old data.** nginx caches API responses for 5 s and the page polls every 10 s when the stream is capped; if the API itself is down (`systemctl status arena-api`), nginx answers 502 for `/arena/api/`.
- **DNS or certificate.** The page lives inside the ourosi.xyz server block; certbot renews the certificate for ourosi.xyz and www.ourosi.xyz on its own (`systemctl status certbot.timer`). If the site is unreachable at the domain, check DNS first (`dig +short ourosi.xyz`).
- **Control socket errors from `arena`.** `cannot reach /run/arena/<lane>.sock` means that runner is not running. Permission denied means you ran the CLI as a user other than arena without the wrapper; use `/usr/local/bin/arena`.
