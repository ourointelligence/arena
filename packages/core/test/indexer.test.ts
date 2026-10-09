import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createIndexer, openPositionsFromEvents } from '../src/indexer.js';
import { upsertLane } from '../src/lanes.js';
import { readLaneState } from '../src/control.js';
import { spendToday } from '../src/spend.js';

const META = { name: 'Core', goal: 'g', assets: ['BTC', 'ETH'], tf: '15m', packs: ['ta'], model: 'm', sdkVersion: '0.2.0' };
const T0 = Date.UTC(2026, 9, 9, 0, 0, 0);

function scriptedRun() {
  const db = openDb(':memory:');
  upsertLane(db, 'core', META, 'running', T0);
  const ix = createIndexer(db, 'core', { population: 2, pricing: { inputPerMTok: 3, outputPerMTok: 15 }, firstAsset: 'BTC' });
  const cand = (cycle: number, id: string, stage: any, reason: string | null, ts: number, parents: string[] = []) =>
    ix.handle('candidate', { cycle, id, origin: cycle ? 'mutate' : 'seed', parents, describe: `d ${id}`, code: 'code', params: { k: 1 }, bounds: { k: { min: 0, max: 2, step: 1 } }, stage, reason, trainScore: 0.1, holdoutScore: stage === 'holdout' || stage === 'promoted' ? 0.2 : null }, ts);
  ix.handle('llm', { cycle: 0, purpose: 'seed', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 2000, ms: 10 }, T0);
  cand(0, 's-0001', 'promoted', null, T0 + 1);
  cand(0, 's-0002', 'promoted', null, T0 + 2);
  ix.handle('bar', { asset: 'BTC', tf: '15m', bar: { ts: T0 + 900_000, asset: 'BTC', tf: '15m', o: 100, h: 101, l: 99, c: 100, v: 1 } }, T0 + 900_000);
  ix.handle('trade:open', { strategyId: 's-0001', asset: 'BTC', side: 'long', size: 0.1, price: 100, ts: T0 + 900_000 }, T0 + 900_000);
  ix.handle('trade:close', { strategyId: 's-0001', asset: 'BTC', outcome: { pnl: 1, fees: 0.07, drawdown: 0.2, holdBars: 2, closedTs: T0 + 2_700_000, funding: 0.01, raw: { asset: 'BTC', side: 'long', entry: 100, exit: 110, size: 0.1, reason: 'tp', openedTs: T0 + 900_000 } }, score: 0.83, ts: T0 + 2_700_000 }, T0 + 2_700_000);
  ix.handle('bar', { asset: 'BTC', tf: '15m', bar: { ts: T0 + 2_700_000, asset: 'BTC', tf: '15m', o: 100, h: 111, l: 99, c: 110, v: 1 } }, T0 + 2_700_000);
  ix.handle('cycle:start', { cycle: 1 }, T0 + 3_600_000);
  ix.handle('cycle:step', { cycle: 1, step: 'collect', detail: '2 episodes' }, T0 + 3_600_100);
  ix.handle('llm', { cycle: 1, purpose: 'critic', model: 'claude-sonnet-5-5', inputTokens: 4000, outputTokens: 500, ms: 10 }, T0 + 3_600_200);
  ix.handle('critique', { cycle: 1, patterns: ['p1'], summary: 'sum' }, T0 + 3_600_300);
  cand(1, 's-0003', 'holdout', 'holdout', T0 + 3_600_400, ['s-0002']);
  ix.handle('retire', { cycle: 1, id: 's-0003', reason: 'holdout' }, T0 + 3_600_401);
  cand(1, 's-0004', 'promoted', null, T0 + 3_600_500, ['s-0001']);
  ix.handle('retire', { cycle: 1, id: 's-0002', reason: 'inactive' }, T0 + 3_600_600);
  ix.handle('promote', { cycle: 1, id: 's-0004', replaces: 's-0002' }, T0 + 3_600_700);
  ix.handle('cycle:end', { cycle: 1, outcome: 'promoted', popCI: 0.1, bestCI: 0.3, velocity: 0.1, ceiling: false, usage: { inputTokens: 4000, outputTokens: 500, calls: 1 } }, T0 + 3_601_000);
  ix.handle('trade:close', { strategyId: 's-0004', asset: 'ETH', outcome: { pnl: -0.5, fees: 0.07, drawdown: 0.5, holdBars: 1, closedTs: T0 + 7_200_000, raw: { asset: 'ETH', side: 'short', entry: 10, exit: 11, size: 0.1, reason: 'stop', openedTs: T0 + 6_300_000 } }, score: -0.82, ts: T0 + 7_200_000 }, T0 + 7_200_000);
  return { db, ix };
}

describe('indexer', () => {
  it('turns a scripted run into the expected rows', () => {
    const { db, ix } = scriptedRun();
    const strategies = db.prepare('SELECT id, status, died_cycle, reject_reason, trades, forward_trades, forward_score, model FROM strategies ORDER BY id').all() as any[];
    expect(strategies.map((s) => [s.id, s.status, s.died_cycle, s.reject_reason])).toEqual([
      ['s-0001', 'live', null, null],
      ['s-0002', 'retired', 1, 'inactive'],
      ['s-0003', 'rejected', 1, 'holdout'],
      ['s-0004', 'live', null, null],
    ]);
    expect(strategies[0].trades).toBe(1);
    expect(strategies[0].forward_trades).toBe(1);
    expect(strategies[0].model).toBe('claude-sonnet-5-5');
    expect(strategies[3].forward_trades).toBe(1);
    expect(strategies[3].forward_score).toBeCloseTo(-0.82);
    const cycle = db.prepare('SELECT * FROM cycles WHERE n = 1').get() as any;
    expect(cycle.outcome).toBe('promoted');
    expect(cycle.diagnosis).toBe('sum');
    expect(JSON.parse(cycle.patterns)).toEqual(['p1']);
    expect(cycle.tokens_in).toBe(4000);
    expect(cycle.cost_usd).toBeCloseTo((4000 * 3 + 500 * 15) / 1e6);
    expect(cycle.ended_at).toBe(T0 + 3_601_000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cycle_steps').get()).toEqual({ n: 1 });
    const cands = db.prepare('SELECT strategy_id, stage, reason FROM candidates WHERE cycle = 1 ORDER BY strategy_id').all();
    expect(cands).toEqual([
      { strategy_id: 's-0003', stage: 'holdout', reason: 'holdout' },
      { strategy_id: 's-0004', stage: 'promoted', reason: null },
    ]);
    const trades = db.prepare('SELECT id, side, entry, exit, funding FROM trades ORDER BY closed_at').all();
    expect(trades).toEqual([
      { id: `core:s-0001:BTC:${T0 + 2_700_000}`, side: 'long', entry: 100, exit: 110, funding: 0.01 },
      { id: `core:s-0004:ETH:${T0 + 7_200_000}`, side: 'short', entry: 10, exit: 11, funding: 0 },
    ]);
    const equity = db.prepare('SELECT ts, ensemble_equity, benchmark_equity FROM equity ORDER BY ts').all() as any[];
    expect(equity).toHaveLength(2);
    expect(equity[0].ensemble_equity).toBe(100);
    expect(equity[1].ensemble_equity).toBeCloseTo(100 + (1 - 0.07 + 0.01) / 2);
    expect(equity[1].benchmark_equity).toBeCloseTo(110);
    const types = (db.prepare('SELECT type FROM events ORDER BY id').all() as any[]).map((r) => r.type);
    expect(types).not.toContain('bar');
    expect(types).toContain('trade:open');
    expect(types).toContain('cycle:end');
    expect(spendToday(db, 'core', T0).tokens_in).toBe(5000);
    expect(readLaneState(db, 'core')?.last_cycle_ts).toBe(T0 + 3_601_000);
    expect(ix.openPositions()).toEqual([]);
    expect(ix.currentCycle()).toBe(1);
  });

  it('is idempotent on repeated trade closes and recovers state on construction', () => {
    const { db } = scriptedRun();
    const ix2 = createIndexer(db, 'core', { population: 2 });
    ix2.handle('trade:close', { strategyId: 's-0001', asset: 'BTC', outcome: { pnl: 1, fees: 0.07, drawdown: 0.2, holdBars: 2, closedTs: T0 + 2_700_000, raw: { asset: 'BTC', side: 'long', entry: 100, exit: 110, size: 0.1, reason: 'tp', openedTs: T0 + 900_000 } }, score: 0.83, ts: T0 + 2_700_000 });
    expect((db.prepare('SELECT trades FROM strategies WHERE id = ?').get('s-0001') as any).trades).toBe(1);
    expect(ix2.currentCycle()).toBe(1);
    ix2.handle('bar', { asset: 'BTC', tf: '15m', bar: { ts: T0 + 9_000_000, asset: 'BTC', tf: '15m', o: 100, h: 101, l: 99, c: 120, v: 1 } }, T0 + 9_000_000);
    const last = db.prepare('SELECT ensemble_equity, benchmark_equity FROM equity ORDER BY ts DESC LIMIT 1').get() as any;
    expect(last.benchmark_equity).toBeCloseTo(120);
    expect(last.ensemble_equity).toBeCloseTo(100 + (1 - 0.07 + 0.01 - 0.5 - 0.07) / 2);
  });

  it('serves open positions from stored events after a restart', () => {
    const { db } = scriptedRun();
    const ix = createIndexer(db, 'core', { population: 2 });
    ix.handle('trade:open', { strategyId: 's-0004', asset: 'BTC', side: 'long', size: 0.1, price: 100, ts: T0 + 9_000_000 }, T0 + 9_000_000);
    const open = openPositionsFromEvents(db, 'core');
    expect(open.map((o) => o.strategyId)).toEqual(['s-0004']);
  });

  it('handles pending, rejected and rollback', () => {
    const { db, ix } = scriptedRun();
    ix.handle('cycle:start', { cycle: 2 }, T0 + 10_000_000);
    ix.handle('candidate', { cycle: 2, id: 's-0005', origin: 'fresh', parents: [], describe: 'x', code: 'c', params: {}, bounds: {}, stage: 'pending', reason: null, trainScore: 0.3, holdoutScore: 0.4 }, T0 + 10_000_100);
    ix.handle('cycle:end', { cycle: 2, outcome: 'pending', popCI: 0.1, bestCI: 0.3, velocity: 0, ceiling: false, usage: { inputTokens: 0, outputTokens: 0, calls: 0 } }, T0 + 10_000_200);
    ix.handle('pending', { cycle: 2 }, T0 + 10_000_300);
    expect(readLaneState(db, 'core')?.state).toBe('pending');
    ix.handle('rejected', { cycle: 2 }, T0 + 10_000_400);
    expect((db.prepare('SELECT outcome FROM cycles WHERE n = 2').get() as any).outcome).toBe('rejected');
    expect((db.prepare('SELECT status, reject_reason FROM strategies WHERE id = ?').get('s-0005') as any)).toEqual({ status: 'rejected', reject_reason: 'rejected by user' });
    expect(readLaneState(db, 'core')?.state).toBe('running');
    ix.handle('rollback', { toCycle: 0 }, T0 + 10_000_500);
    const after = db.prepare('SELECT id, status FROM strategies ORDER BY id').all();
    expect(after).toEqual([
      { id: 's-0001', status: 'live' },
      { id: 's-0002', status: 'live' },
      { id: 's-0003', status: 'rejected' },
      { id: 's-0004', status: 'rolled_back' },
      { id: 's-0005', status: 'rejected' },
    ]);
  });
});
