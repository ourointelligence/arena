# OURO Arena

OURO Arena is a public, always-on page where the [OURO SDK](https://github.com/ourointelligence/ouro) invents, tests, kills and promotes its own trading strategies on live Hyperliquid market data, in paper mode, and shows every step in the open. Three independent loops (lanes) run around the clock. The page shows a living family tree of strategies, the takeoff curve, the Critic's notes, every candidate with its fate, a graveyard, a paper book next to buy and hold, and the state of the kill switch. Arena is also the SDK's first real customer: it installs the SDK from its GitHub release files the way an outside developer would, and every gap it finds becomes an SDK fix (see [docs/sdk-findings.md](docs/sdk-findings.md)).

Live page: https://ourosi.xyz/arena

Paper trading only. Nothing here is financial advice or a trading signal. No real money moves, there are no wallets, no logins and no token.

## The lanes

| Lane | Assets and timeframe | Primitive packs | What it tests |
| --- | --- | --- | --- |
| Core | BTC, ETH on 15m | ta, volume, time | The reference setup, generate mode, nothing hand written |
| Alts | SOL, HYPE on 1h | ta, volume, time | A different market and a slower clock |
| Flow | BTC, ETH on 15m | ta, volume, time, flow | Arena's own flow pack (funding, open interest, premium, basis) on bars that carry exchange context, with funding paid and received in the paper book |

Every lane shares the same goal wording, scorer (pnl minus fees minus half the drawdown), population of 8, a cycle every 40 episodes per strategy or every 6 hours, a 30 percent holdout, a 5 percent margin, the guards (8 percent max drawdown, 10 percent max position, 6 proposals per cycle) and a paper executor at 3.5 bps fee and 2 bps slippage. The exact settings live in `lanes/index.ts`.

## How Arena gets the SDK

The packages are not on npm yet. Each one is pinned to a GitHub release file:

```
"@ourointelligence/sdk": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-sdk-0.2.0.tgz"
```

The root `package.json` carries matching `pnpm.overrides`, so the plugins' own dependency on the SDK resolves to the same file and never to the registry. `sdk-version.json` holds the one version number. To move to another release:

```bash
pnpm sdk:use 0.3.0     # rewrites every dependency and override, then runs pnpm install
pnpm sdk:npm           # for the day npm is live: plain versions, overrides removed (do not run yet)
```

Arena only imports the packages' public entry points. An ESLint rule fails the build on any deep import into `dist` or `src`.

## Run it locally

You need Node 22, pnpm 9 and an LLM key.

```bash
cp .env.example .env            # set OURO_LLM, OURO_MODEL and the provider key (ANTHROPIC_API_KEY for anthropic)
pnpm install
pnpm build

export ARENA_DATA_DIR=$PWD/.arena-data     # lanes/<lane>/.ouro, arena.db, ledger, og land here
export ARENA_RUN_DIR=$PWD/.arena-data      # control sockets (a named pipe on Windows)
node apps/runner/dist/main.js core          # one lane; alts and flow are the other two
node apps/api/dist/main.js                  # the read-only API on 127.0.0.1:8787
pnpm dev:web                                # the page on http://localhost:5173/arena/ (set ARENA_API_PROXY=http://127.0.0.1:8787 to use the real API instead of the mock)
```

A lane pulls 300 warm-up bars plus 3000 bars of history, trades through the history on paper so the first cycles land within the first hour, then follows the live candle feed. The daily model budget is `ARENA_BUDGET_USD_PER_LANE` (default 1 USD) priced with `ARENA_PRICE_IN_PER_MTOK` and `ARENA_PRICE_OUT_PER_MTOK`; when it is reached the lane pauses itself until 00:00 UTC.

Admin actions go through the `arena` command (on a server it is installed as `/usr/local/bin/arena`; locally run `node apps/cli/dist/main.js` with the same environment):

```
arena status
arena pause <lane|all> [note]      arena resume <lane|all>
arena approval <lane> on|off       arena approve <lane> <cycle>      arena reject <lane> <cycle>
arena rollback <lane> <cycle>      arena budget <lane> <usd>         arena cycle <lane>
arena rebuild                      arena export <lane> [file]        arena drill <lane>
arena ledger [lane]                arena verify-ledger <lane>
```

## Tests

```bash
pnpm test                                   # every package: core, api, hl, flow, runner (lanes in fast mode), web unit tests
pnpm --filter @arena/runner test            # three lanes for 10 cycles each against a mock exchange and a scripted model,
                                            # gap refill, pause, approval, reject, budget, rebuild, SIGKILL at every cycle step
pnpm test:e2e                               # Playwright: the page at 1440, 1366, 1024 and 390 px in both themes, strategy page, stream
pnpm --filter @arena/web test:soak          # 10 minutes at 10 events per second: main thread and memory stay flat
pnpm lint                                   # eslint plus a check that no em dash or en dash is in any tracked file
```

## Verifying the ledger

Every hour each running lane's export (the SDK's `schemaVersion: 1` document) is written as canonical JSON, hashed, and chained to the previous hash. Once a day the files are committed to https://github.com/ourointelligence/arena-ledger. Layout in that repo and on the server:

```
core/2026-10-10T14.json      the export of that hour, canonical JSON (keys sorted at every level, no whitespace)
core/chain.jsonl             one line per hour: {"ts":..., "sha256":"...", "prev_sha256":"..." | null, "file":"2026-10-10T14.json"}
alts/..., flow/...
```

Anyone can recompute it:

```bash
cd core
python3 - <<'EOF'
import hashlib, json
prev = None
for line in open('chain.jsonl'):
    e = json.loads(line)
    h = hashlib.sha256(open(e['file'], 'rb').read()).hexdigest()
    assert h == e['sha256'], f"hash mismatch in {e['file']}"
    assert e['prev_sha256'] == prev, f"broken link at {e['file']}"
    prev = h
print('chain ok')
EOF
```

If a file had been edited after the fact its hash would no longer match, and every later line links to the hash before it. On the server `arena verify-ledger core` runs the same check.

## More

- [docs/product.md](docs/product.md): what the page shows, the lanes, moments, the kill switch, the ledger, the budget rule.
- [docs/tech.md](docs/tech.md): architecture, database, indexer, control socket, API, stream, tests.
- [docs/ops.md](docs/ops.md): server layout, systemd units, deploy, upgrades, alerts, backups, troubleshooting.
- [docs/sdk-findings.md](docs/sdk-findings.md): every SDK gap Arena found and what happened to it.
- [docs/api-contract.md](docs/api-contract.md): the JSON the page consumes.

MIT licensed.
