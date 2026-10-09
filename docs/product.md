# OURO Arena: the product

Arena is one page at https://ourosi.xyz/arena plus a page per strategy. Everything on it is read only. The only way to change anything is the admin command line on the server, and every such action is logged and shown.

## What people see

The page is one column, section by section. One lane is shown at a time; the tabs at the top switch lanes.

1. **Status bar.** Lane tabs (Core, Alts, Flow), a state pill (RUNNING, PAUSED or PENDING), uptime, cycles so far, strategies born, model spend today in dollars, and the age of the last bar.
2. **Hero.** The headline "Watch it rewrite itself." with one line under it, next to the live family tree.
3. **Family tree.** A radial lineage drawn on a canvas. The seed generation sits in the centre, each cycle adds a ring (labelled c1, c2 and so on), living strategies are cobalt dots, dead ones are small crosses, and the lineage of the current best strategy is drawn in flame with a glow. New births animate in from their parent. Hovering shows id, origin and Capability Index; clicking opens the strategy page. Drag to pan, wheel to zoom, a reset button fits it again.
4. **Takeoff chart.** Population CI and best CI per cycle, velocity as bars, a marker where the ceiling flag was raised, and shaded gaps where the lane went quiet (more than twelve hours between cycles, or an error cycle).
5. **Live population.** The living strategies: id, origin, born cycle, CI, holdout score, forward score, trades, cycles survived and the one sentence description the strategy declares about itself.
6. **Thought log.** A terminal style panel with the cycle steps as they happen (collect, rank, diagnose, generate, trial, validate, promote), the Critic's diagnosis in full, and each candidate with its fate and reason. It holds the last 200 rows.
7. **Paper book.** The lane's combined paper equity next to buy and hold of the lane's first asset over the same period, with a 24h, 7d, 30d and all range switch, plus the gap between the two.
8. **Moments.** The feed of notable events, written by the system in plain words (see below).
9. **Graveyard.** Every retired and rejected strategy with its lifespan in cycles, its description as an epitaph and the reason it died, paged.
10. **Kill switch panel.** The current state of each lane and the control log: every pause, resume, approval switch, approve, reject, rollback, budget change and drill, with time, actor and note. No buttons.
11. **Ledger.** The latest hash per lane, the chain status and a link to the public arena-ledger repository.
12. **How it works.** Six short lines, a link to the SDK docs, and the notice "Paper trading only. Nothing here is financial advice or a trading signal."

**Strategy page** (`/arena/s/<lane>/<id>`): the code with syntax highlighting (read only), the parameters and their bounds, parents and children as links, a plain language explanation, Capability Index over time, its trades, its own equity line, the forward score, open positions (shown only fifteen minutes after they open), a share card preview and a copy link button.

Light and dark themes follow the main site, with the same toggle. The page works on a phone at 360 px wide.

## The lanes and their settings

Three lanes, each its own OURO loop with its own state folder, so one lane can pause, crash or roll back without touching the others. These are the values in `lanes/index.ts`.

| Lane | Assets | Timeframe | Packs | Exchange context |
| --- | --- | --- | --- | --- |
| Core | BTC, ETH | 15m | ta, volume, time | no |
| Alts | SOL, HYPE | 1h | ta, volume, time | no |
| Flow | BTC, ETH | 15m | ta, volume, time, flow | yes: funding rate, open interest, premium, mark and oracle on every bar; funding paid and received on paper |

Shared by every lane:

- Goal: "Maximise realised PnL after fees on {assets} {tf} perps, max drawdown 8%".
- Score per episode: pnl minus fees minus 0.5 times drawdown.
- Generate mode: no seed strategies, no allow list, no bounds, no frozen keys. The point is to see what the model invents.
- Population 8. A cycle fires every 40 new episodes per strategy, or after 6 hours of bar time, whichever comes first.
- A strategy with fewer than 3 closed trades since the last cycle ranks weakest and is retired first (reason "inactive").
- Holdout 0.3, margin 0.05, a quarter of the population marked weak each cycle.
- Guards: max drawdown 8 percent, max position 10 percent of equity, at most 6 proposals per cycle, approval switch off.
- Paper executor: 3.5 bps fee per side, 2 bps slippage per fill.
- 300 warm-up bars, 3000 bars of history traded through on paper before the live feed, bar level replay for trials, weighted ensemble.
- The model from `OURO_LLM` and `OURO_MODEL`, wrapped so every call is counted and priced.
- 200 units of Hyperliquid request weight per minute per lane (half the exchange limit split three ways) and one WebSocket per lane.

The flow pack exposes `flow.funding`, `flow.fundingZ`, `flow.oiChange1h`, `flow.oiChange4h`, `flow.premium` and `flow.basis`, each computed only from the current bar and the bars before it.

## Moments

The moments engine turns the lane's events into short posts: a title under 80 characters, a body under 280, plain words. Each rule fires once per trigger.

- A new best Capability Index in a lane (after a cycle).
- The first promotion in a lane.
- The 100th and the 500th strategy born in a lane.
- A cycle where every candidate died on holdout: "Every idea this cycle looked good on old data and failed on new data. Nothing was promoted."
- The ceiling flag raised (population CI moved less than 0.01 per cycle for three cycles) and cleared again.
- A lineage that has survived 10 cycles (a living descendant of a strategy born ten or more cycles ago).
- A strategy whose forward score beats its holdout score after 20 trades since promotion.
- Every pause, resume, approve, reject, rollback and budget pause.

## The kill switch

`requireApproval` is off for paper. The admin command line can turn it on per lane at any time; the lane then stops at PENDING after its next cycle with promotions, and a person reads the Critic's diagnosis and approves or rejects. `arena pause` stops all new decisions while bars keep flowing; `arena rollback <lane> <cycle>` restores the population as it was at the end of that cycle; `arena budget <lane> <usd>` changes the daily budget.

The weekly drill (`arena drill <lane>`) exercises all of it without a person clicking: pause, wait for one bar and check that no trade opened, approval on, resume, force a cycle until one stops at pending (or wait for one), reject it, approval off, resume, then print a PASS or FAIL line per step. Both the start and the result are written to the control log, so the drill shows on the kill switch panel.

## The ledger

Every hour each lane's export is written as canonical JSON, hashed with SHA-256, and the hash is chained to the previous one in `chain.jsonl`. Once a day the files are committed to a public repository. The page shows the latest hash and whether the chain verifies. Anyone can recompute the hashes with a few lines of Python (see the README). The numbers cannot be edited later without breaking the chain.

## The budget

Each lane has a daily model budget in US dollars (`ARENA_BUDGET_USD_PER_LANE`, default 1). Every model call is counted in tokens and priced; the spend per lane and per UTC day is stored and shown on the page. When a lane's spend for the day reaches the budget, the next model call is refused, the lane pauses itself, the control log records a budget pause by the actor "budget", a moment is written, and the lane resumes at 00:00 UTC on its own.

## Not in v1

Real money, wallets, signing or live orders. Accounts, logins or a web admin panel. Trading signals or copy trading. Any link to a token. Hosted runs for other people. A mobile app.
