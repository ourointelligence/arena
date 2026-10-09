# SDK findings

Running log of every gap Arena found in the OURO SDK, checked against the real code, with what was done about it. Newest entries at the bottom of each section.

## Audit of the expected findings (2026-10-09, against @ourointelligence/sdk 0.1.0)

| ID | Finding | Real? | Evidence in 0.1.0 | Fixed in |
| --- | --- | --- | --- | --- |
| F1 | Typed event API | Real | `loop.events` is a plain Node `EventEmitter<LoopEvents>` with seven events (`log`, `seed`, `bar`, `decision`, `episode`, `cycle`, `error`). No `loop.on` or `loop.off`, no cycle step, candidate, promote, retire, critique, llm or pending events, and a throwing handler propagates out of `emit` into the loop. | 0.2.0 |
| F2 | Bar-level replay | Real | `trial.ts` `replay()` re-runs `decide` on each stored episode input and credits the stored outcome only when the side matches, otherwise a zero outcome. Comment in the file calls it "a documented simplification". No bars are stored anywhere. | 0.2.0 |
| F3 | Max wait between cycles | Real | `ready()` in `loop.ts` returns true only when every live strategy has `cycleEvery` episodes since the last cycle. No time-based trigger exists apart from the `--every` timer, which also fails with "not enough data" when the pooled count is short. | 0.2.0 |
| F4 | Minimum activity | Real | Ranking uses the pooled holdout replay score only (`pop.rank(holdoutScores)`); a strategy with zero trades scores 0 and ranks above every losing strategy. No activity rule. | 0.2.0 |
| F5 | LLM usage | Real | `LLM.complete` returns `Promise<string>`; the four adapters discard the usage fields of their responses. Nothing counts tokens. | 0.2.0 |
| F6 | Extra bar fields | Real | `Bar` is `{ ts, asset, tf, o, h, l, c, v }` with no room for extra data. | 0.2.0 |
| F7 | Funding in paper | Real | `executors/paper.ts` computes pnl, fees and drawdown only. | 0.2.0 |
| F8 | Export schema | Real | `ouro export` writes `{ name, goal, createdAt, population, history, takeoff }` with no schema version and no documented shape; there is no programmatic export. | 0.2.0 |
| F9 | Wrappable adapters | Half real | `anthropic`, `openai`, `gemini`, `ollama` and `resolveLLM` are already exported from the package index, so wrapping was possible. Missing: a `wrapLLM` helper, and any retry when an adapter throws (a network error in `diagnose` or a generator call propagates out of `cycle()`; only `LLMOutputError` is caught). | 0.2.0 |
| F10 | Lifecycle and isolation | Real | `start`, `stop`, `approve`, `reject`, `rollback` exist; `pause`, `resume`, `setApproval`, `export`, `status` do not. `stop()` does not wait for a running cycle. No two-loop or crash test exists. | 0.2.0 |

## Differences between the documentation names and the real code

- The docs say `requireApproval` is a top-level loop option; in the code it lives under `guards.requireApproval`. Arena uses the real location.
- `loop.events` stays in 0.2.0 for backward compatibility. The new `loop.on` / `loop.off` API is the one Arena uses.
- Episodes are stored in `episodes.db` (SQLite) with an `episodes.jsonl` fallback; 0.2.0 adds a `bars` table (or `bars.jsonl`) in the same store.

## Found while building Arena against 0.2.0 (2026-10-10)

| Finding | Status | What Arena does |
| --- | --- | --- |
| A forced `cycle()` that finds too few episodes emits `cycle:start`, the `collect` step and `cycle:end` (reason `not enough data`) but the SDK does not persist that cycle, so the next real cycle reuses the number. | Logged, not changed in the SDK | The indexer deletes the cycle row it opened when `cycle:end` carries reason `not enough data`, so arena.db matches history.json. |
| `cycle:end` for a pending cycle fires before `approved` or `rejected`; after either the lane state must be re-derived (a paused lane would otherwise read as running). | Logged | The runner re-asserts `pause()` after approve and reject when it was paused. |
| `LoopStatus.lastCycleTs` is `pop.lastCycleTs || null`, so a first cycle whose newest episode had ts 0 reports null. | Logged, harmless | The runner keeps its own wall-clock last cycle time from `cycle:end`. |
| Three loops in one process with a mock exchange starve the event loop and make reconnects look stuck; the SDK is fine, the test design was not. | Not an SDK bug | Lane tests run one process per lane, as production does. |
| The Hyperliquid source polls `metaAndAssetCtxs` (weight 20) once per bar close; in fast mode that exhausts a 200 per minute budget in seconds. | Not an SDK bug | Fast mode raises the lane budget through `ARENA_WEIGHT_PER_MINUTE`; production stays at 200. |
| `readBars` in the rebuild assumed `bars(asset, ts, json)`; the 0.2.0 store is `bars(asset, tf, ts, json)` in episodes.db or `bars.jsonl` beside it. The query still works because it selects by asset and orders by ts. | Confirmed working | No change needed. |

