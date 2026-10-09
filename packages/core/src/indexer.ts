import type { Db } from './db.js';
import { parseJson } from './db.js';
import { addSpend } from './spend.js';
import { upsertLaneState } from './control.js';
import type { ArenaEventMap, ArenaEventType, CandidateStage, LaneId, PaperOutcomeRaw, Pricing, StrategyStatus } from './types.js';
import { UNSTORED_EVENT_TYPES, usdFor } from './types.js';

export type IndexerOptions = {
  /** Strategies alive at once; divides the pooled paper pnl into the ensemble equity line. */
  population: number;
  pricing?: Pricing;
  now?: () => number;
  /** The lane's first asset, used for the equity and benchmark lines. Defaults to the first bar's asset. */
  firstAsset?: string;
  /** Model name until the first llm event says otherwise. */
  model?: string;
};

export type OpenPosition = { strategyId: string; asset: string; side: 'long' | 'short'; size: number; price: number; ts: number };

export type Indexer = {
  /** Index one event. Returns the events table row id when the event was stored. */
  handle<K extends ArenaEventType>(type: K, payload: ArenaEventMap[K], ts?: number): number | undefined;
  openPositions(): OpenPosition[];
  currentCycle(): number;
  model(): string | null;
};

/** Reasons that mean a strategy left the live set in good standing, as opposed to a guard or trial rejection. */
export const RETIRE_REASONS: ReadonlySet<string> = new Set(['inactive', 'replaced', 'rolled_back', 'compile']);

export function statusForCandidate(stage: CandidateStage, reason: string | null): StrategyStatus {
  if (stage === 'promoted') return 'live';
  if (stage === 'pending') return 'pending';
  if (reason) return 'rejected';
  return 'pending';
}

/**
 * Turns SDK events into arena.db rows. One indexer per lane. The only in-memory state is the open positions, the
 * benchmark's first close, the pooled pnl total and the current cycle number, all of which are recovered from the
 * database on construction, so a restart loses nothing.
 */
export function createIndexer(db: Db, lane: LaneId, opts: IndexerOptions): Indexer {
  const now = opts.now ?? (() => Date.now());
  const population = Math.max(1, opts.population);
  const open = new Map<string, OpenPosition>();
  let firstAsset = opts.firstAsset ?? kvGet(db, lane, 'first_asset');
  let firstClose = Number(kvGet(db, lane, 'first_close') ?? NaN);
  let cumPnl = Number(
    (db.prepare('SELECT COALESCE(SUM(pnl - fees + funding), 0) AS v FROM trades WHERE lane_id = ?').get(lane) as { v: number }).v,
  );
  let cycle = Number((db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM cycles WHERE lane_id = ?').get(lane) as { n: number }).n);
  let model: string | null = opts.model ?? ((db.prepare('SELECT model FROM lane_state WHERE lane_id = ?').get(lane) as { model: string | null } | undefined)?.model ?? null);

  const stmts = {
    event: db.prepare('INSERT INTO events (lane_id, ts, type, payload) VALUES (?, ?, ?, ?)'),
    equity: db.prepare('INSERT OR REPLACE INTO equity (lane_id, ts, ensemble_equity, benchmark_equity) VALUES (?, ?, ?, ?)'),
    cycleStart: db.prepare('INSERT INTO cycles (lane_id, n, started_at) VALUES (?, ?, ?) ON CONFLICT(lane_id, n) DO UPDATE SET started_at = COALESCE(cycles.started_at, excluded.started_at)'),
    cycleStep: db.prepare('INSERT INTO cycle_steps (lane_id, cycle, ts, step, detail) VALUES (?, ?, ?, ?, ?)'),
    critique: db.prepare('UPDATE cycles SET diagnosis = ?, patterns = ? WHERE lane_id = ? AND n = ?'),
    cycleEnd: db.prepare(
      'UPDATE cycles SET ended_at = ?, outcome = ?, pop_ci = ?, best_ci = ?, velocity = ?, ceiling = ?, tokens_in = ?, tokens_out = ?, cost_usd = ? WHERE lane_id = ? AND n = ?',
    ),
    cycleOutcome: db.prepare('UPDATE cycles SET outcome = ? WHERE lane_id = ? AND n = ?'),
    cycleTokens: db.prepare('UPDATE cycles SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE lane_id = ? AND n = ?'),
    strategyUpsert: db.prepare(
      `INSERT INTO strategies (lane_id, id, origin, born_cycle, parents, describe, code, params, bounds, status, died_cycle, reject_reason, train_score, holdout_score, model, created_at)
       VALUES (@lane, @id, @origin, @born, @parents, @describe, @code, @params, @bounds, @status, @died, @reason, @train, @holdout, @model, @created)
       ON CONFLICT(lane_id, id) DO UPDATE SET describe = excluded.describe, code = excluded.code, params = excluded.params, bounds = excluded.bounds,
         status = excluded.status, died_cycle = excluded.died_cycle, reject_reason = excluded.reject_reason, train_score = excluded.train_score,
         holdout_score = excluded.holdout_score, parents = excluded.parents, origin = excluded.origin`,
    ),
    candidateUpsert: db.prepare(
      `INSERT INTO candidates (lane_id, cycle, strategy_id, origin, stage, reason, train_score, holdout_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lane_id, cycle, strategy_id) DO UPDATE SET stage = excluded.stage, reason = excluded.reason, train_score = excluded.train_score, holdout_score = excluded.holdout_score`,
    ),
    setStatus: db.prepare('UPDATE strategies SET status = ?, died_cycle = ?, reject_reason = ? WHERE lane_id = ? AND id = ?'),
    retireLive: db.prepare("UPDATE strategies SET status = 'retired', died_cycle = ?, reject_reason = 'replaced' WHERE lane_id = ? AND id = ? AND status = 'live'"),
    setLive: db.prepare("UPDATE strategies SET status = 'live', died_cycle = NULL, reject_reason = NULL WHERE lane_id = ? AND id = ?"),
    pendingOfCycle: db.prepare("SELECT id FROM strategies WHERE lane_id = ? AND born_cycle = ? AND status = 'pending'"),
    rollbackNewer: db.prepare(
      "UPDATE strategies SET status = 'rolled_back', died_cycle = ? WHERE lane_id = ? AND born_cycle > ? AND status IN ('live', 'retired', 'pending')",
    ),
    rollbackRestore: db.prepare("UPDATE strategies SET status = 'live', died_cycle = NULL WHERE lane_id = ? AND born_cycle <= ? AND status = 'retired' AND died_cycle > ?"),
    tradeInsert: db.prepare(
      `INSERT OR IGNORE INTO trades (id, lane_id, strategy_id, asset, side, size, opened_at, closed_at, entry, exit, pnl, fees, funding, drawdown, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    strategyTrade: db.prepare('SELECT born_cycle, forward_score, forward_trades FROM strategies WHERE lane_id = ? AND id = ?'),
    bumpTrades: db.prepare('UPDATE strategies SET trades = trades + 1 WHERE lane_id = ? AND id = ?'),
    bumpForward: db.prepare('UPDATE strategies SET forward_trades = ?, forward_score = ? WHERE lane_id = ? AND id = ?'),
    cycleEnded: db.prepare('SELECT ended_at FROM cycles WHERE lane_id = ? AND n = ?'),
    laneModel: db.prepare('UPDATE lanes SET model = ? WHERE id = ?'),
  };

  const storeEvent = (type: string, payload: unknown, ts: number): number | undefined => {
    if (UNSTORED_EVENT_TYPES.has(type)) return undefined;
    const r = stmts.event.run(lane, ts, type, JSON.stringify(payload));
    return Number(r.lastInsertRowid);
  };

  const promotedAt = (bornCycle: number): number => {
    if (bornCycle <= 0) return 0;
    const r = stmts.cycleEnded.get(lane, bornCycle) as { ended_at: number | null } | undefined;
    return r?.ended_at ?? Number.POSITIVE_INFINITY;
  };

  function handle<K extends ArenaEventType>(type: K, payload: ArenaEventMap[K], ts = now()): number | undefined {
    const p = payload as any;
    switch (type) {
      case 'bar': {
        const bar = p.bar as { asset: string; ts: number; c: number };
        upsertLaneState(db, lane, { last_bar_ts: bar.ts });
        if (!firstAsset) {
          firstAsset = bar.asset;
          kvSet(db, lane, 'first_asset', firstAsset);
        }
        if (bar.asset === firstAsset) {
          if (!Number.isFinite(firstClose)) {
            firstClose = bar.c;
            kvSet(db, lane, 'first_close', String(firstClose));
          }
          stmts.equity.run(lane, bar.ts, 100 + cumPnl / population, (100 * bar.c) / firstClose);
        }
        return undefined;
      }
      case 'decision':
        return undefined;
      case 'trade:open': {
        open.set(`${p.strategyId}\u0000${p.asset}`, { strategyId: p.strategyId, asset: p.asset, side: p.side, size: p.size, price: p.price, ts: p.ts });
        break;
      }
      case 'trade:close': {
        const key = `${p.strategyId}\u0000${p.asset}`;
        const o = open.get(key);
        open.delete(key);
        const raw = (p.outcome?.raw ?? {}) as Partial<PaperOutcomeRaw>;
        const outcome = p.outcome as { pnl: number; fees: number; drawdown: number; funding?: number };
        const closedAt = Number(p.ts ?? p.outcome?.closedTs ?? ts);
        const id = `${lane}:${p.strategyId}:${p.asset}:${closedAt}`;
        const side = raw.side ?? o?.side ?? 'long';
        const r = stmts.tradeInsert.run(
          id,
          lane,
          p.strategyId,
          p.asset,
          side,
          raw.size ?? o?.size ?? 0,
          raw.openedTs ?? o?.ts ?? closedAt,
          closedAt,
          raw.entry ?? o?.price ?? 0,
          raw.exit ?? 0,
          outcome.pnl,
          outcome.fees,
          outcome.funding ?? 0,
          outcome.drawdown,
          p.score,
        );
        if (r.changes > 0) {
          cumPnl += outcome.pnl - outcome.fees + (outcome.funding ?? 0);
          stmts.bumpTrades.run(lane, p.strategyId);
          const s = stmts.strategyTrade.get(lane, p.strategyId) as { born_cycle: number; forward_score: number | null; forward_trades: number } | undefined;
          if (s && closedAt > promotedAt(s.born_cycle)) {
            const n = s.forward_trades + 1;
            const mean = ((s.forward_score ?? 0) * s.forward_trades + Number(p.score)) / n;
            stmts.bumpForward.run(n, mean, lane, p.strategyId);
          }
        }
        break;
      }
      case 'cycle:start': {
        cycle = p.cycle;
        stmts.cycleStart.run(lane, p.cycle, ts);
        break;
      }
      case 'cycle:step': {
        stmts.cycleStart.run(lane, p.cycle, ts);
        stmts.cycleStep.run(lane, p.cycle, ts, p.step, String(p.detail ?? ''));
        break;
      }
      case 'critique': {
        stmts.cycleStart.run(lane, p.cycle, ts);
        stmts.critique.run(String(p.summary ?? ''), JSON.stringify(p.patterns ?? []), lane, p.cycle);
        break;
      }
      case 'candidate': {
        const status = statusForCandidate(p.stage, p.reason ?? null);
        stmts.strategyUpsert.run({
          lane,
          id: p.id,
          origin: p.origin,
          born: p.cycle,
          parents: JSON.stringify(p.parents ?? []),
          describe: String(p.describe ?? ''),
          code: String(p.code ?? ''),
          params: JSON.stringify(p.params ?? {}),
          bounds: JSON.stringify(p.bounds ?? {}),
          status,
          died: status === 'rejected' ? p.cycle : null,
          reason: status === 'rejected' ? p.reason : null,
          train: p.trainScore ?? null,
          holdout: p.holdoutScore ?? null,
          model,
          created: ts,
        });
        stmts.candidateUpsert.run(lane, p.cycle, p.id, p.origin, p.stage, p.reason ?? null, p.trainScore ?? null, p.holdoutScore ?? null);
        break;
      }
      case 'promote': {
        stmts.setLive.run(lane, p.id);
        stmts.candidateUpsert.run(lane, p.cycle, p.id, originOf(db, lane, p.id), 'promoted', null, null, null);
        if (p.replaces) stmts.retireLive.run(p.cycle, lane, p.replaces);
        break;
      }
      case 'retire': {
        const retired = RETIRE_REASONS.has(p.reason);
        stmts.setStatus.run(retired ? 'retired' : 'rejected', p.cycle, p.reason, lane, p.id);
        break;
      }
      case 'cycle:end': {
        if (p.reason === 'not enough data') {
          // the SDK does not persist a cycle that found nothing to work on; drop the row it opened at cycle:start
          db.prepare('DELETE FROM cycle_steps WHERE lane_id = ? AND cycle = ?').run(lane, p.cycle);
          db.prepare('DELETE FROM cycles WHERE lane_id = ? AND n = ? AND outcome IS NULL').run(lane, p.cycle);
          break;
        }
        const usage = p.usage ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
        const usd = typeof usage.usd === 'number' ? usage.usd : usdFor(usage, opts.pricing);
        stmts.cycleStart.run(lane, p.cycle, ts);
        stmts.cycleEnd.run(ts, p.outcome, p.popCI, p.bestCI, p.velocity, p.ceiling ? 1 : 0, usage.inputTokens, usage.outputTokens, usd, lane, p.cycle);
        upsertLaneState(db, lane, { last_cycle_ts: ts, ...(p.outcome === 'pending' ? { state: 'pending' as const } : {}) });
        if (p.cycle > cycle) cycle = p.cycle;
        break;
      }
      case 'pending': {
        stmts.cycleOutcome.run('pending', lane, p.cycle);
        upsertLaneState(db, lane, { state: 'pending' });
        break;
      }
      case 'approved': {
        stmts.cycleOutcome.run('promoted', lane, p.cycle);
        for (const row of stmts.pendingOfCycle.all(lane, p.cycle) as Array<{ id: string }>) stmts.setLive.run(lane, row.id);
        upsertLaneState(db, lane, { state: 'running' });
        break;
      }
      case 'rejected': {
        stmts.cycleOutcome.run('rejected', lane, p.cycle);
        for (const row of stmts.pendingOfCycle.all(lane, p.cycle) as Array<{ id: string }>) stmts.setStatus.run('rejected', p.cycle, 'rejected by user', lane, row.id);
        upsertLaneState(db, lane, { state: 'running' });
        break;
      }
      case 'rollback': {
        stmts.rollbackNewer.run(cycle, lane, p.toCycle);
        stmts.rollbackRestore.run(lane, p.toCycle, p.toCycle);
        upsertLaneState(db, lane, { state: 'running' });
        break;
      }
      case 'llm': {
        const usage = { inputTokens: Number(p.inputTokens ?? 0), outputTokens: Number(p.outputTokens ?? 0) };
        addSpend(db, lane, usage, opts.pricing, ts);
        if (p.cycle > 0) {
          stmts.cycleStart.run(lane, p.cycle, ts);
          stmts.cycleTokens.run(usage.inputTokens, usage.outputTokens, usdFor(usage, opts.pricing), lane, p.cycle);
        }
        if (p.model && p.model !== model) {
          model = p.model;
          upsertLaneState(db, lane, { model });
          stmts.laneModel.run(model, lane);
        }
        break;
      }
      case 'error':
      case 'control':
      case 'budget':
      case 'moment':
        break;
    }
    return storeEvent(type, payload, ts);
  }

  return {
    handle,
    openPositions: () => [...open.values()],
    currentCycle: () => cycle,
    model: () => model,
  };
}

function originOf(db: Db, lane: LaneId, id: string): string {
  const r = db.prepare('SELECT origin FROM strategies WHERE lane_id = ? AND id = ?').get(lane, id) as { origin: string } | undefined;
  return r?.origin ?? 'fresh';
}

export function kvGet(db: Db, lane: LaneId, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM lane_kv WHERE lane_id = ? AND key = ?').get(lane, key) as { value: string } | undefined;
  return r?.value;
}

export function kvSet(db: Db, lane: LaneId, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO lane_kv (lane_id, key, value) VALUES (?, ?, ?)').run(lane, key, value);
}

/** Open positions reconstructed from the stored trade:open events without a matching trade row (used after a restart). */
export function openPositionsFromEvents(db: Db, lane: LaneId, sinceTs = 0): OpenPosition[] {
  const rows = db
    .prepare("SELECT ts, payload FROM events WHERE lane_id = ? AND type = 'trade:open' AND ts >= ? ORDER BY id ASC")
    .all(lane, sinceTs) as Array<{ ts: number; payload: string }>;
  const out = new Map<string, OpenPosition>();
  for (const r of rows) {
    const p = parseJson<OpenPosition | null>(r.payload, null);
    if (!p) continue;
    out.set(`${p.strategyId}\u0000${p.asset}`, p);
  }
  for (const [key, p] of out) {
    const closed = db
      .prepare('SELECT 1 FROM trades WHERE lane_id = ? AND strategy_id = ? AND asset = ? AND closed_at >= ? LIMIT 1')
      .get(lane, p.strategyId, p.asset, p.ts);
    if (closed) out.delete(key);
  }
  return [...out.values()];
}
