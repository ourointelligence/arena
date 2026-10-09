# OURO Arena: how it is built

## Architecture

Four small services on the server that already hosts ourosi.xyz:

- Three lane runners (`apps/runner`, one process per lane, `arena-lane@core`, `arena-lane@alts`, `arena-lane@flow`). Each builds one OURO loop from `lanes/index.ts`, subscribes to every SDK event, writes `arena.db` through the indexer, heartbeats its state, and answers a local control socket.
- One API (`apps/api`, `arena-api`): Hono on `@hono/node-server`, read only, on 127.0.0.1:8787.
- The page (`apps/web`): a static Vite build in `/var/www/arena`, served by nginx with an SPA fallback for `/arena/s/*`. nginx proxies `/arena/api/` to the API.
- Timers for the hourly ledger, the daily ledger push, health checks, backups and equity compaction.

The lanes never talk to each other. The page can only read. Every change goes through the `arena` command on the server.

Workspace packages: `packages/core` (types, schema, indexer, moments, ledger, rebuild, helpers), `packages/hl` (the lane source on top of `@ourointelligence/source-hyperliquid`, rate budget, health), `packages/flow` (the flow primitive pack), `lanes` (the three lane definitions and the shared settings), `apps/runner`, `apps/api`, `apps/web`, `apps/cli`.

## SDK delivery

The SDK packages come from GitHub release files, never from the npm registry. Each `package.json` that needs one points at the release URL, and the root `pnpm.overrides` map all three names to the same URLs so the plugins' own dependency on `@ourointelligence/sdk` resolves to the release file. `pnpm-lock.yaml` is committed and shows every `@ourointelligence` package resolved to `github.com/ourointelligence/ouro/releases/download`. `sdk-version.json` holds the version; `scripts/sdk-use.mjs` rewrites the manifests for a tag and runs `pnpm install`; `scripts/sdk-npm.mjs` switches to plain versions and removes the overrides for the day npm is live.

No `file:`, `link:` or `workspace:` reference to the SDK exists in committed files. The root ESLint config has a `no-restricted-imports` rule on the pattern `@ourointelligence/*/*`, so a deep import into `dist` or `src` fails lint.

## Database

`/var/lib/arena/arena.db`, SQLite through better-sqlite3, WAL mode, `busy_timeout` 5000, foreign keys on. `openDb` applies the migrations in `packages/core/src/db.ts` and records them in a `migrations` table. The SDK's own files in each lane's `.ouro` folder stay the source of truth; `arena rebuild` recreates the tables below from them.

| Table | One row per | Columns |
| --- | --- | --- |
| lanes | lane | id, name, goal, assets, tf, packs, model, sdk_version, status, created_at |
| cycles | cycle in a lane | lane_id, n, started_at, ended_at, outcome, diagnosis, patterns, pop_ci, best_ci, velocity, ceiling, tokens_in, tokens_out, cost_usd; PK (lane_id, n) |
| strategies | strategy ever generated | lane_id, id, origin, born_cycle, parents, describe, code, params, bounds, status, died_cycle, reject_reason, train_score, holdout_score, ci, trades, forward_score, forward_trades, model, created_at; PK (lane_id, id) |
| candidates | candidate inside a cycle | lane_id, cycle, strategy_id, origin, stage, reason, train_score, holdout_score |
| trades | closed paper trade | id, lane_id, strategy_id, asset, side, size, opened_at, closed_at, entry, exit, pnl, fees, funding, drawdown, score |
| equity | lane snapshot per bar of the first asset | lane_id, ts, ensemble_equity, benchmark_equity |
| events | stored event | id, lane_id, ts, type, payload (JSON) |
| moments | notable event | id, lane_id, ts, kind, title, body, strategy_id, key (unique per lane) |
| snapshots | hourly ledger entry | id, lane_id, ts, sha256, prev_sha256, file |
| spend | lane and UTC day | day, lane_id, tokens_in, tokens_out, usd; PK (day, lane_id) |
| control | admin action | id, lane_id, ts, action, actor, note |
| lane_state | lane heartbeat | lane_id, state, last_bar_ts, last_cycle_ts, ws_connected, pid, started_at, seen_at, sdk_version, model, budget_usd, approval_on |
| cycle_steps | cycle step | id, lane_id, cycle, ts, step, detail |
| strategy_ci | strategy CI at the end of a cycle | lane_id, strategy_id, cycle, ci |
| lane_kv | small per lane values | lane_id, key, value (the first asset and its first close for the benchmark) |

Every lane_id plus ts column has an index.

## The indexer

`createIndexer(db, lane, { population, pricing, firstAsset, model })` turns SDK events into rows. The runner calls `handle(type, payload, ts)` for every event, then `moments.check` with the same arguments.

- `bar`: updates `lane_state.last_bar_ts`; for the lane's first asset appends an equity row. Not stored in `events`.
- `decision`: ignored, not stored.
- `trade:open`: kept in memory per strategy and asset, and stored, so open positions can be served with a delay and recovered after a restart.
- `trade:close`: inserts a trades row with id `<lane>:<strategy>:<asset>:<closedAt>` (idempotent), bumps the strategy's trade count, and when the trade closed after the end of the strategy's born cycle updates the forward trade count and the forward score.
- `cycle:start`, `cycle:step`, `critique`: the cycle row, a cycle_steps row, and the diagnosis and patterns.
- `candidate`: upserts the strategies row with the full record (code, params, bounds, describe, parents, origin, born cycle, model) and a candidates row with stage and reason. Stage `promoted` or `pending` means live or pending; any other stage means rejected with `died_cycle` and `reject_reason`.
- `promote`: the candidate goes live, the replaced strategy is retired with `died_cycle`.
- `retire`: reasons `inactive`, `replaced`, `rolled_back` and `compile` mean retired; anything else means rejected.
- `cycle:end`: outcome, end time, pop CI, best CI, velocity, ceiling, tokens and cost; a `pending` outcome sets the lane state to pending.
- `pending`, `approved`, `rejected`, `rollback`: the cycle outcome, the statuses of the pending strategies, the lane state. Rollback marks strategies born after the target cycle as rolled back and restores the ones retired after it.
- `llm`: adds to `spend` for the UTC day and to the running cycle's tokens and cost; updates the lane's model name.
- `error`, `control`, `budget`, `moment`: stored only.

After every `cycle:end` the runner also writes one `strategy_ci` row per live strategy from `loop.population()`, because no event carries per strategy CI.

**Equity and benchmark.** On every bar of the lane's first asset: `ensemble_equity = 100 + (sum over every closed trade of pnl - fees + funding) / population` and `benchmark_equity = 100 * close / first close`. pnl, fees, funding and drawdown are in percent of equity as the paper executor reports them.

**Forward score.** The mean score of the trades a strategy closed after the cycle that promoted it ended. It is the out of sample test after the holdout trial.

**Moments dedupe.** Every moment carries a `key` (for example `best_ci:12`, `lineage_10:s-0004`, `first_promotion`, `budget_pause:<day>`); a unique index on (lane_id, key) makes each rule fire once per trigger.

## The runner

`apps/runner/src/lane-runner.ts`:

- Reads its environment (`apps/runner/src/env.ts`): `ARENA_DATA_DIR` (default /var/lib/arena), `ARENA_RUN_DIR` (/run/arena), `ARENA_DB`, `OURO_LLM`, `OURO_MODEL`, `ARENA_BUDGET_USD_PER_LANE` (1), `ARENA_PRICE_IN_PER_MTOK` (3), `ARENA_PRICE_OUT_PER_MTOK` (15), `ARENA_HEARTBEAT_MS` (15000), and for tests `ARENA_FAST`, `ARENA_FAKE_LLM`, `ARENA_HL_WS_URL`, `ARENA_HL_INFO_URL`, `ARENA_STALE_INTERVALS`, `ARENA_TEST_KILL_STEP`.
- Builds the loop config from the shared settings (`buildLoopConfig`): paper executor with funding on when the lane carries exchange context, `replay: 'bars'`, `llmPricing` from the env, two retries with a 2 s base backoff when the adapter fails, seeding retried every 60 s when the model is down.
- The lane source (`packages/hl`): `hyperliquid()` with a 200 weight per minute budget, optional `withAssetCtx` for the flow lane, and an `onEvent` hook; gap, reconnect, stale, rate limit and error notices are logged and stored as `error` events with scope `source:<type>`.
- The model: `resolveLLM(OURO_LLM)` wrapped by `budgetLLM` (`apps/runner/src/budget.ts`, built on the SDK's `wrapLLM`). Before every call it compares today's spend with the budget and throws `BudgetExceeded` (which the SDK does not retry); after every call it records tokens and dollars. On the first refusal the runner pauses the loop, writes a `budget_pause` control row (actor `budget`), a budget event and a moment, and sets a timer to resume at the next 00:00 UTC.
- Heartbeat: `lane_state` is upserted every 15 s and on every state change with state (running, paused, pending), last bar, last cycle, socket connected, pid, start time, SDK version, model, budget and the approval switch. The API reports a lane as stopped when the row is older than 120 s.
- Shutdown on SIGTERM or SIGINT: `loop.stop()` (waits for a running cycle, closes the subscription, flushes the store, closes paper positions), the state row set to stopped, sockets closed.

## The control socket

One socket per lane at `<ARENA_RUN_DIR>/<lane>.sock` (on Windows a named pipe `\\.\pipe\arena-<lane>`), owner the service user, mode 600. Newline delimited JSON: the client sends `{ id, cmd, args, actor }`, the runner answers `{ id, ok: true, result }` or `{ id, ok: false, error }`.

| Command | Args | Effect |
| --- | --- | --- |
| status | | loop status, source health, spend today, budget, pid, SDK version, model |
| health | | state, last bar, last cycle, source health |
| pause | note | `loop.pause()`, control row |
| resume | | `loop.resume()`, control row |
| approval | on | `loop.setApproval(on)`, control row approval_on or approval_off |
| approve, reject | cycle | the SDK call, control row; a paused lane stays paused |
| rollback | cycle | `loop.rollback(cycle)`, control row |
| budget | usd | changes the daily budget, control row |
| cycle | | forces `loop.cycle()` now (no control row) |
| export | | `loop.export()` (schemaVersion 1) |
| population | | the live strategies |

Every control row is also indexed as a `control` event and checked by the moments engine. The `arena` command (`apps/cli`) passes the Unix user as the actor (`ARENA_ACTOR` when run through the sudo wrapper).

## Fast mode and the mock exchange

With `ARENA_FAST=1` the runner uses cycleEvery 5, cycleMaxWait 3h of bar time, minTradesPerWindow 1, margin 0, backfill 400, a 50 ms retry base and a 500 ms seed retry, so cycles happen within seconds. With `ARENA_FAKE_LLM=1` it uses the scripted model in `apps/runner/src/fake-llm.ts`: valid RSI strategies with different bands, one broken JSON reply, three timeouts in a row (longer than the loop's two retries, so one cycle ends as `llm_error`), and one strategy that tries to `import` (the sandbox rejects it). `ARENA_HL_WS_URL` and `ARENA_HL_INFO_URL` point the source at `apps/runner/test/mock-hl.ts`, a mock Hyperliquid with `candleSnapshot`, `metaAndAssetCtxs`, `fundingHistory` and a WebSocket candle feed. Its clock is a cursor that starts 3000 bars before the real time and advances one bar per tick, so every candle it emits is already closed; a `/control` endpoint can drop the sockets, skip bars (to force a gap), pause and resume.

## The API

Every route is documented in [api-contract.md](api-contract.md). `createApp(deps)` mounts them under `/arena/api`; `main.ts` opens the database read only and listens on `ARENA_API_HOST:ARENA_API_PORT`. Other env: `ARENA_LEDGER_DIR`, `ARENA_OG_CACHE`, `ARENA_DATA_DIR` (disk percent), `ARENA_SDK_VERSION`. Responses carry `Cache-Control: public, max-age=5` except `/health` and `/stream` (`no-store`), `X-Content-Type-Options: nosniff`, no CORS header at all (same origin only), and JSON errors with 404 for unknown lanes, strategies and cycles. Open positions are served from stored `trade:open` events only after fifteen minutes. The strategy explanation is built from the describe sentence, origin, parents, the born cycle's diagnosis, trial scores, CI and forward trades.

**The stream.** `/arena/api/stream?lane=` polls the events table every second for rows after the last id sent, writes each as an SSE message with `id`, `event` (the type) and `data`, sends an initial `ready` frame, honours `Last-Event-ID` (replays at most 500 rows), writes a heartbeat comment every 20 s, and answers 503 with `Retry-After: 10` above 500 open connections. The page then polls every 10 s and tries the stream again every minute. `bar` and `decision` are never stored, so they are not streamed.

**Share cards.** `/arena/api/og/<lane>/<id>.png`: satori renders an element tree (Archivo Black headline, Geist Mono numbers, fonts committed under `apps/api/fonts` with their OFL licence) to SVG, resvg rasterises it to a 1200x630 PNG, cached on disk under `ARENA_OG_CACHE`.

**Fixture.** `pnpm --filter @arena/api run fixture [port]` builds a deterministic `arena.db` with three lanes and serves it on 8788, for page tests and demos.

## The page

Vite plus vanilla TypeScript, base `/arena/`, no framework, no inline scripts or styles (it runs under the nginx Content-Security-Policy with `script-src 'self'`). Rules the code follows:

- Every string from the API becomes a text node (`src/dom.ts`); there is no `innerHTML`; highlight.js output is rebuilt as DOM nodes from a whitelist.
- One `requestAnimationFrame` loop for the tree (`src/tree.ts`), guarded so it cannot start twice, throttled to 30 fps, paused when the canvas is off screen (IntersectionObserver) or the tab is hidden, redrawing only when something changed or a birth is animating.
- The thought log holds at most 200 rows (`src/store.ts`).
- The stream (`src/stream.ts`) reconnects with exponential backoff from 1 s to 30 s, probes the status with a fetch because EventSource hides status codes, and on 503 polls every 10 s while retrying the stream every minute.
- Charts are inline SVG drawn by `src/charts.ts`; no chart library.
- At 360 px wide tables scroll inside their own container and the page never scrolls sideways.

## The ledger

`arena ledger` (hourly timer) asks each running lane for its export through the control socket, writes it as canonical JSON (keys sorted at every level, no whitespace) to `<ledger dir>/<lane>/<YYYY-MM-DDTHH>.json`, computes SHA-256, appends `{ ts, sha256, prev_sha256, file }` to `<lane>/chain.jsonl` with the previous line's hash, and inserts a snapshots row. `verifyChain` recomputes every file hash and every link; `arena verify-ledger <lane>` prints the result. `infra/ledger-daily.sh` commits and pushes the ledger folder (a clone of ourointelligence/arena-ledger) once a day with a deploy key.

## Rebuild

`arena rebuild` calls `rebuildLane` for each lane: it deletes the lane's cycles, strategies, candidates, trades, equity, cycle_steps and strategy_ci rows and recreates them from `.ouro/history.json` (strategies, cycles, promoted and rejected candidates), `takeoff.json` (velocity) and the episodes store (`episodes.db` with its `episodes` and `bars` tables, or `episodes.jsonl` and `bars.jsonl`). Spend, control, moments, snapshots and events are not derivable from `.ouro` and are kept.

## Tests

| Where | What it proves |
| --- | --- |
| packages/core/test | The indexer turns a scripted event sequence into the expected rows, is idempotent on repeated closes and recovers after a restart; pending, rejected and rollback are mapped; every moments rule fires once with short text; canonical JSON and the hash chain, including tamper detection; rebuild from a `.ouro` folder matches live indexing; the fixture is deterministic. |
| apps/api/test | Every route against the fixture database: shapes, cache headers, no CORS, 404s, cursor paging, the fifteen minute open position delay, the share card and its cache, stream replay after `Last-Event-ID`, heartbeats and the 503 cap. |
| packages/hl/test, packages/flow/test | The lane source and health helpers; the flow pack's six features, nulls without data, and that no feature at bar i changes when later bars change. |
| apps/runner/test/lanes.test.ts | Three lanes in fast mode against the mock exchange and the scripted model for at least 10 cycles each: promotions, holdout rejections, an `llm_error` cycle that did not crash the lane, a sandbox rejection, events, moments, spend, funding on the flow lane; two ledger snapshots per lane that chain and verify, with a tampered file detected; a dropped socket plus skipped bars refilled with the stored bars contiguous; pause with no new trades, approval producing a pending cycle, reject, resume, budget pause and resume with the control rows; `arena rebuild` matching the live tables. |
| apps/runner/test/resilience.test.ts | A lane process killed with SIGKILL at every cycle step and restarted: cycles stay contiguous, none lost, none doubled; a stale bar is recorded but never traded on. |
| apps/web/test and apps/web/e2e | Escaping, log rows and the tree layout; Playwright at 1440, 1366, 1024 and 390 px in both themes with no horizontal overflow and no overlapping headings, the tree above the fold at 1366x768, the strategy page, the stream; a ten minute soak at 10 events per second with no main thread block over 200 ms and flat memory. |
| scripts/check-emdash.mjs | No em dash or en dash in any tracked file (part of `pnpm lint`). |
