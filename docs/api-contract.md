# Arena API contract

Every endpoint is GET, returns JSON, is served under `/arena/api` on the same origin as the page, and never changes state. Timestamps are milliseconds since the epoch. Lane ids are `core`, `alts` and `flow`. Every string that came from a model (`describe`, `diagnosis`, `patterns`, `reason`, `explanation`, moment titles and bodies) is plain text; the page escapes it. Cursors are numeric row ids; `cursor=<id>` returns rows older than that id, newest first, and `nextCursor` is null at the end.

Cache-Control is `max-age=5` on everything except `/stream` and `/health` (`no-store`). Responses are gzipped by nginx.

## /health (no-store)

```json
{
  "ok": true,
  "ts": 1760000000000,
  "version": "0.1.0",
  "sdkVersion": "0.2.0",
  "disk": { "percent": 12 },
  "lanes": {
    "core": { "state": "running", "lastBarTs": 1760000000000, "lastCycleTs": 1759990000000, "wsConnected": true, "pid": 1234, "startedAt": 1759900000000, "seenAt": 1760000000000 }
  }
}
```

`state` is one of `running`, `paused`, `pending`, `error`, `stopped`. A lane whose runner has not written its state row for more than 120 s is reported as `stopped` with `wsConnected: false`.

## /lanes

Array of `{ id, name, goal, assets: string[], tf, packs: string[], model, sdkVersion, status, createdAt }`.

## /lanes/:lane/summary

```json
{
  "lane": "core", "status": "running", "uptimeMs": 86400000,
  "cycles": 12, "born": 61, "live": 8,
  "popCI": 0.41, "bestCI": 1.2, "velocity": 0.03, "ceiling": false,
  "spendTodayUsd": 0.42, "tokensToday": { "in": 120000, "out": 30000 }, "budgetUsd": 1,
  "sdkVersion": "0.2.0", "model": "claude-sonnet-5-5",
  "lastBarTs": 1760000000000, "lastCycleTs": 1759990000000
}
```

## /lanes/:lane/population

Array of `{ id, origin, bornCycle, ci, holdoutScore, forwardScore, trades, forwardTrades, cyclesSurvived, describe, status }`. `ci`, `holdoutScore` and `forwardScore` are numbers or null.

## /lanes/:lane/cycles?limit=&before=

`{ items: Cycle[], nextBefore: number | null }` where `before` is a cycle number (rows with `n < before`), `limit` defaults to 20 and caps at 100, newest first.

Cycle: `{ n, startedAt, endedAt, outcome, diagnosis, patterns: string[], popCI, bestCI, velocity, ceiling, tokensIn, tokensOut, costUsd, promoted: string[], retired: string[], candidates: number }`. `outcome` is `promoted`, `no_change`, `pending`, `rejected` or `error`.

## /lanes/:lane/cycles/:n

The Cycle plus `steps: [{ ts, step, detail }]` (step is `collect`, `rank`, `diagnose`, `generate`, `trial`, `validate` or `promote`; detail is a short plain string) and `candidates: [{ id, origin, parents: string[], describe, stage, reason, trainScore, holdoutScore }]` (stage is `sandbox`, `guards`, `trial`, `holdout`, `promoted` or `pending`; reason is null when the candidate was promoted).

## /lanes/:lane/tree

`{ nodes: [{ id, parents: string[], born, died: number | null, status, ci: number | null, origin }], bestId: string | null, bestLineage: string[] }`. `bestLineage` is the chain of ids from the seed ancestor to the current best live strategy, root first.

## /lanes/:lane/graveyard?cursor=

`{ items: [{ id, origin, born, died, lifespan, describe, reason, holdoutScore, ci }], nextCursor }`. `lifespan` is cycles alive (0 for rejected candidates). Rows are retired, rejected and rolled back strategies, newest death first; `cursor` is the row id.

## /lanes/:lane/strategies/:id

```json
{
  "id": "s-0012", "lane": "core", "origin": "mutate", "bornCycle": 3, "diedCycle": null, "status": "live",
  "parents": ["s-0004"], "children": ["s-0031"],
  "describe": "...", "code": "...", "params": { "k": 1 }, "bounds": { "k": { "min": 0, "max": 2, "step": 1 } },
  "rejectReason": null, "trainScore": 0.1, "holdoutScore": 0.2, "ci": 0.5,
  "trades": 40, "forwardScore": 0.15, "forwardTrades": 12, "model": "claude-sonnet-5-5", "createdAt": 1760000000000,
  "explanation": "plain text",
  "ciHistory": [{ "cycle": 3, "ci": 0.1 }],
  "equity": [{ "ts": 1760000000000, "equity": 100.2 }],
  "openPositions": [{ "asset": "BTC", "side": "long", "size": 0.05, "openedAt": 1760000000000, "entry": 60000 }]
}
```

`openPositions` only lists positions opened at least 15 minutes before the request. `equity` is the cumulative score of the strategy's own closed trades, starting at 100.

## /lanes/:lane/strategies/:id/trades

Array of `{ id, asset, side, size, openedAt, closedAt, entry, exit, pnl, fees, funding, drawdown, score }`, newest first, closed trades only.

## /lanes/:lane/equity?range=24h|7d|30d|all

`{ range, points: [{ ts, ensemble, benchmark }] }`. Both lines start at 100 at lane start; `benchmark` is buy and hold of the lane's first asset.

## /moments?lane=&cursor=

`{ items: [{ id, lane, ts, kind, title, body, strategyId }], nextCursor }`. Without `lane`, every lane.

## /control?lane=

Array of `{ id, lane, ts, action, actor, note }`, newest first, 200 rows at most. `action` is `pause`, `resume`, `approval_on`, `approval_off`, `approve`, `reject`, `rollback`, `budget`, `budget_pause`, `budget_resume` or `drill`.

## /ledger?lane=

`{ repo: "https://github.com/ourointelligence/arena-ledger", lanes: { core: { latest: { ts, sha256, prevSha256, file } | null, count, chainOk } } }`.

## /stream?lane= (no-store)

Server-sent events. Each message: `id: <event row id>`, `event: <type>`, `data: {"id":..,"lane":..,"ts":..,"type":..,"payload":{..}}`. Honours `Last-Event-ID` (replays rows after it, at most 500). Heartbeat comment line every 20 s. Over 500 open connections the server answers 503 and the page polls `/lanes/:lane/cycles` and `/moments` every 10 s instead.

Event types: the SDK events (`bar`, `decision`, `trade:open`, `trade:close`, `cycle:start`, `cycle:step`, `critique`, `candidate`, `promote`, `retire`, `cycle:end`, `pending`, `approved`, `rejected`, `rollback`, `llm`, `error`) with the SDK payloads, plus Arena's `control` (a control row), `budget` and `moment` (a moment row). `bar` and `decision` events are not stored in the events table (too many); they are streamed live only when `?live=1` is set.

## /og/:lane/:id.png

A 1200x630 PNG share card for the strategy: lane, id, describe, CI, holdout and forward scores, born cycle. Cached on disk after the first render. 404 for unknown ids.
