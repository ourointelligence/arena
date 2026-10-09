import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './db.js';
import type { CandidateStage, CycleOutcome, LaneId, Origin, StrategyStatus } from './types.js';

/** The SDK's history.json (packages/sdk/src/population.ts HistoryFile), the parts the rebuild reads. */
export type SdkStrategy = {
  id: string;
  parentIds: string[];
  origin: Origin;
  cycleBorn: number;
  code: string;
  params: Record<string, number>;
  rationale: string;
  status: StrategyStatus;
  trial?: { trainScore: number; holdoutScore: number; trainN: number; holdoutN: number; maxDrawdown: number; ownHoldoutScore?: number };
  ci?: number;
  bounds?: Record<string, { min: number; max: number; step: number }>;
  describe?: string;
  cycleRetired?: number;
  retireReason?: string;
};

export type SdkCycle = {
  cycle: number;
  status: 'promoted' | 'no_change' | 'pending' | 'error';
  promoted: SdkStrategy[];
  retired: SdkStrategy[];
  rejected: Array<{ strategy: SdkStrategy; reason: string }>;
  diagnosis: { patterns: string[]; summary: string };
  populationCI: number;
  bestCI?: number;
  note?: string;
  ts?: number;
  startedAt?: number;
  usage?: { inputTokens: number; outputTokens: number; calls: number; usd?: number };
};

export type SdkHistory = {
  version: number;
  goal: string;
  createdAt: number;
  strategies: SdkStrategy[];
  cycles: SdkCycle[];
  liveByCycle: Record<string, string[]>;
  seedIds: string[];
  cycle: number;
};

export type SdkEpisode = {
  id: string;
  ts: number;
  strategyId: string;
  input: { ts: number; asset: string };
  decision: { side: string; size: number } | null;
  outcome: { pnl: number; fees: number; drawdown: number; holdBars: number; closedTs: number; funding?: number; raw?: any };
  score?: number;
};

export type LaneMeta = { name: string; goal: string; assets: string[]; tf: string; packs: string[]; model: string; sdkVersion: string };

/** Map a rejection reason from the SDK to the stage the candidate reached. */
export function stageForReason(reason: string | null | undefined): CandidateStage {
  if (!reason) return 'promoted';
  if (reason.startsWith('sandbox')) return 'sandbox';
  if (reason === 'train margin' || reason === 'no slot') return 'trial';
  if (reason === 'holdout') return 'holdout';
  if (reason === 'rejected by user') return 'pending';
  return 'guards';
}

export function readEpisodes(ouroDir: string): SdkEpisode[] {
  const dbFile = path.join(ouroDir, 'episodes.db');
  if (fs.existsSync(dbFile)) {
    const src = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const rows = src.prepare('SELECT json FROM episodes ORDER BY ts ASC, rowid ASC').all() as Array<{ json: string }>;
      return rows.map((r) => JSON.parse(r.json) as SdkEpisode);
    } finally {
      src.close();
    }
  }
  const jsonl = path.join(ouroDir, 'episodes.jsonl');
  if (!fs.existsSync(jsonl)) return [];
  const out: SdkEpisode[] = [];
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SdkEpisode);
    } catch {
      // skip corrupt line
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Closed bars from the 0.2.0 episodes store, when the store has them. Empty when the table or file is absent. */
export function readBars(ouroDir: string, asset: string): Array<{ ts: number; c: number }> {
  const dbFile = path.join(ouroDir, 'episodes.db');
  if (fs.existsSync(dbFile)) {
    const src = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const has = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bars'").get();
      if (!has) return [];
      const rows = src.prepare('SELECT json FROM bars WHERE asset = ? ORDER BY ts ASC').all(asset) as Array<{ json: string }>;
      return rows.map((r) => JSON.parse(r.json) as { ts: number; c: number });
    } catch {
      return [];
    } finally {
      src.close();
    }
  }
  const jsonl = path.join(ouroDir, 'bars.jsonl');
  if (!fs.existsSync(jsonl)) return [];
  const out: Array<{ ts: number; c: number; asset?: string }> = [];
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line) as { ts: number; c: number; asset?: string };
      if (b.asset === asset) out.push(b);
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export type RebuildResult = { strategies: number; cycles: number; candidates: number; trades: number; equity: number };

/**
 * Recreate the lane's cycles, strategies, candidates, trades, equity and CI rows from its .ouro folder alone.
 * Spend, control, moments, snapshots and events are not in .ouro and are left untouched.
 */
export function rebuildLane(db: Db, lane: LaneId, ouroDir: string, meta: LaneMeta, population = 8): RebuildResult {
  const historyFile = path.join(ouroDir, 'history.json');
  if (!fs.existsSync(historyFile)) throw new Error(`no history.json in ${ouroDir}`);
  const history = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as SdkHistory;
  const takeoffFile = path.join(ouroDir, 'takeoff.json');
  const takeoff = fs.existsSync(takeoffFile)
    ? (JSON.parse(fs.readFileSync(takeoffFile, 'utf8')) as Array<{ cycle: number; populationCI: number; bestCI: number; velocity: number }>)
    : [];
  const velocityOf = new Map(takeoff.map((r) => [r.cycle, r.velocity]));
  const episodes = readEpisodes(ouroDir);
  const firstAsset = meta.assets[0] ?? '';
  const bars = firstAsset ? readBars(ouroDir, firstAsset) : [];

  const result: RebuildResult = { strategies: 0, cycles: 0, candidates: 0, trades: 0, equity: 0 };
  db.transaction(() => {
    for (const t of ['cycles', 'strategies', 'candidates', 'trades', 'equity', 'cycle_steps', 'strategy_ci']) {
      db.prepare(`DELETE FROM ${t} WHERE lane_id = ?`).run(lane);
    }
    db.prepare(
      `INSERT INTO lanes (id, name, goal, assets, tf, packs, model, sdk_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, goal = excluded.goal, assets = excluded.assets, tf = excluded.tf, packs = excluded.packs, model = excluded.model, sdk_version = excluded.sdk_version`,
    ).run(lane, meta.name, meta.goal, JSON.stringify(meta.assets), meta.tf, JSON.stringify(meta.packs), meta.model, meta.sdkVersion, history.createdAt ?? Date.now());

    // cycles
    const cycleEnd = new Map<number, number>();
    const insCycle = db.prepare(
      'INSERT OR REPLACE INTO cycles (lane_id, n, started_at, ended_at, outcome, diagnosis, patterns, pop_ci, best_ci, velocity, ceiling, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const velocities: number[] = [];
    for (const c of history.cycles) {
      const outcome: CycleOutcome | 'rejected' = c.note === 'rejected by user' ? 'rejected' : c.status;
      const velocity = velocityOf.get(c.cycle) ?? (velocities.length ? c.populationCI - (history.cycles[velocities.length - 1]?.populationCI ?? 0) : 0);
      velocities.push(velocity);
      const ceiling = velocities.length >= 4 && velocities.slice(-3).every((v) => v < 0.01);
      const ended = c.ts ?? null;
      if (ended !== null) cycleEnd.set(c.cycle, ended);
      insCycle.run(
        lane,
        c.cycle,
        c.startedAt ?? ended,
        ended,
        outcome,
        c.diagnosis?.summary ?? '',
        JSON.stringify(c.diagnosis?.patterns ?? []),
        c.populationCI,
        c.bestCI ?? null,
        velocity,
        ceiling ? 1 : 0,
        c.usage?.inputTokens ?? 0,
        c.usage?.outputTokens ?? 0,
        c.usage?.usd ?? 0,
      );
      result.cycles++;
    }

    // strategies
    const insStrategy = db.prepare(
      `INSERT OR REPLACE INTO strategies (lane_id, id, origin, born_cycle, parents, describe, code, params, bounds, status, died_cycle, reject_reason, train_score, holdout_score, ci, trades, forward_score, forward_trades, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)`,
    );
    const rejectedIn = new Map<string, { cycle: number; reason: string }>();
    for (const c of history.cycles) for (const r of c.rejected) rejectedIn.set(r.strategy.id, { cycle: c.cycle, reason: r.reason });
    for (const s of history.strategies) {
      const rej = rejectedIn.get(s.id);
      const died = s.status === 'live' ? null : (s.cycleRetired ?? rej?.cycle ?? (s.status === 'rejected' ? s.cycleBorn : null));
      const reason = s.status === 'rejected' ? (rej?.reason ?? s.retireReason ?? 'rejected') : (s.retireReason ?? (s.status === 'retired' ? 'replaced' : s.status === 'rolled_back' ? 'rolled_back' : null));
      const createdAt = cycleEnd.get(s.cycleBorn) ?? history.createdAt ?? 0;
      insStrategy.run(
        lane,
        s.id,
        s.origin,
        s.cycleBorn,
        JSON.stringify(s.parentIds ?? []),
        s.describe ?? '',
        s.code ?? '',
        JSON.stringify(s.params ?? {}),
        JSON.stringify(s.bounds ?? {}),
        s.status,
        died,
        reason,
        s.trial?.trainScore ?? null,
        s.trial?.holdoutScore ?? null,
        typeof s.ci === 'number' && Number.isFinite(s.ci) ? s.ci : null,
        meta.model,
        createdAt,
      );
      result.strategies++;
      if (typeof s.ci === 'number' && Number.isFinite(s.ci)) {
        db.prepare('INSERT OR REPLACE INTO strategy_ci (lane_id, strategy_id, cycle, ci) VALUES (?, ?, ?, ?)').run(lane, s.id, history.cycle, s.ci);
      }
    }

    // candidates
    const insCandidate = db.prepare(
      'INSERT OR REPLACE INTO candidates (lane_id, cycle, strategy_id, origin, stage, reason, train_score, holdout_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const s of history.strategies) {
      if (s.cycleBorn !== 0) continue;
      const rejected = s.status === 'rejected';
      insCandidate.run(lane, 0, s.id, s.origin, rejected ? stageForReason(s.retireReason ?? 'guards') : 'promoted', rejected ? (s.retireReason ?? 'rejected') : null, s.trial?.trainScore ?? null, finite(s.trial?.holdoutScore));
      result.candidates++;
    }
    for (const c of history.cycles) {
      for (const r of c.rejected) {
        const s = r.strategy;
        insCandidate.run(lane, c.cycle, s.id, s.origin, stageForReason(r.reason), r.reason, s.trial?.trainScore ?? null, finite(s.trial?.holdoutScore));
        result.candidates++;
      }
      for (const s of c.promoted) {
        insCandidate.run(lane, c.cycle, s.id, s.origin, c.status === 'pending' ? 'pending' : 'promoted', null, s.trial?.trainScore ?? null, finite(s.trial?.holdoutScore));
        result.candidates++;
      }
    }

    // trades from episodes, plus trade counts and forward scores
    const insTrade = db.prepare(
      'INSERT OR REPLACE INTO trades (id, lane_id, strategy_id, asset, side, size, opened_at, closed_at, entry, exit, pnl, fees, funding, drawdown, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const born = new Map(history.strategies.map((s) => [s.id, s.cycleBorn]));
    const counts = new Map<string, { trades: number; forward: number; forwardSum: number }>();
    let cum = 0;
    const equityByTs = new Map<number, number>();
    for (const ep of episodes) {
      const raw = (ep.outcome.raw ?? {}) as { asset?: string; side?: string; entry?: number; exit?: number; size?: number; openedTs?: number };
      const asset = raw.asset ?? ep.input?.asset ?? '';
      const closedAt = ep.outcome.closedTs ?? ep.ts;
      const score = typeof ep.score === 'number' ? ep.score : ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown;
      insTrade.run(
        `${lane}:${ep.strategyId}:${asset}:${closedAt}`,
        lane,
        ep.strategyId,
        asset,
        raw.side ?? ep.decision?.side ?? 'long',
        raw.size ?? ep.decision?.size ?? 0,
        raw.openedTs ?? ep.input?.ts ?? closedAt,
        closedAt,
        raw.entry ?? 0,
        raw.exit ?? 0,
        ep.outcome.pnl,
        ep.outcome.fees,
        ep.outcome.funding ?? 0,
        ep.outcome.drawdown,
        score,
      );
      result.trades++;
      cum += ep.outcome.pnl - ep.outcome.fees + (ep.outcome.funding ?? 0);
      equityByTs.set(closedAt, 100 + cum / population);
      const c = counts.get(ep.strategyId) ?? { trades: 0, forward: 0, forwardSum: 0 };
      c.trades++;
      const b = born.get(ep.strategyId) ?? 0;
      const promotedAt = b <= 0 ? 0 : (cycleEnd.get(b) ?? Number.POSITIVE_INFINITY);
      if (closedAt > promotedAt) {
        c.forward++;
        c.forwardSum += score;
      }
      counts.set(ep.strategyId, c);
    }
    const updCounts = db.prepare('UPDATE strategies SET trades = ?, forward_trades = ?, forward_score = ? WHERE lane_id = ? AND id = ?');
    for (const [id, c] of counts) updCounts.run(c.trades, c.forward, c.forward ? c.forwardSum / c.forward : null, lane, id);

    // equity: per bar when bars are stored, otherwise per trade close with a flat benchmark
    const insEquity = db.prepare('INSERT OR REPLACE INTO equity (lane_id, ts, ensemble_equity, benchmark_equity) VALUES (?, ?, ?, ?)');
    if (bars.length) {
      const closes = [...equityByTs.entries()].sort((a, b) => a[0] - b[0]);
      let i = 0;
      let ens = 100;
      const first = bars[0]!.c;
      for (const b of bars) {
        while (i < closes.length && closes[i]![0] <= b.ts) ens = closes[i++]![1];
        insEquity.run(lane, b.ts, ens, (100 * b.c) / first);
        result.equity++;
      }
      db.prepare('INSERT OR REPLACE INTO lane_kv (lane_id, key, value) VALUES (?, ?, ?)').run(lane, 'first_close', String(first));
    } else {
      for (const [ts, v] of [...equityByTs.entries()].sort((a, b) => a[0] - b[0])) {
        insEquity.run(lane, ts, v, 100);
        result.equity++;
      }
    }
    db.prepare('INSERT OR REPLACE INTO lane_kv (lane_id, key, value) VALUES (?, ?, ?)').run(lane, 'first_asset', firstAsset);
  })();
  return result;
}

function finite(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
