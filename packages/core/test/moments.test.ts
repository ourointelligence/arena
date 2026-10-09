import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createIndexer } from '../src/indexer.js';
import { createMoments } from '../src/moments.js';
import { upsertLane } from '../src/lanes.js';
import { insertControl } from '../src/control.js';

const META = { name: 'Core', goal: 'g', assets: ['BTC'], tf: '15m', packs: ['ta'], model: 'm', sdkVersion: '0.2.0' };
const T0 = Date.UTC(2026, 9, 9, 0, 0, 0);

function setup() {
  const db = openDb(':memory:');
  upsertLane(db, 'core', META, 'running', T0);
  const ix = createIndexer(db, 'core', { population: 8, firstAsset: 'BTC' });
  const mo = createMoments(db, 'core');
  const emit = (type: any, payload: any, ts: number) => {
    ix.handle(type, payload, ts);
    return mo.check(type, payload, ts);
  };
  const cand = (cycle: number, id: string, stage: any, reason: string | null, ts: number, parents: string[] = []) =>
    emit('candidate', { cycle, id, origin: cycle ? 'mutate' : 'seed', parents, describe: `d ${id}`, code: 'c', params: {}, bounds: {}, stage, reason, trainScore: 0.1, holdoutScore: 0.2 }, ts);
  const end = (cycle: number, bestCI: number, ceiling: boolean, ts: number) =>
    emit('cycle:end', { cycle, outcome: 'no_change', popCI: 0.1, bestCI, velocity: 0, ceiling, usage: { inputTokens: 0, outputTokens: 0, calls: 0 } }, ts);
  return { db, emit, cand, end };
}

const kinds = (db: any) => (db.prepare('SELECT kind FROM moments ORDER BY id').all() as any[]).map((r) => r.kind);

describe('moments', () => {
  it('fires each rule once per trigger with short plain text', () => {
    const { db, emit, cand, end } = setup();
    cand(0, 's-0001', 'promoted', null, T0);
    cand(0, 's-0002', 'promoted', null, T0 + 1);
    emit('cycle:start', { cycle: 1 }, T0 + 10);
    expect(end(1, 0.2, false, T0 + 20)).toHaveLength(0); // first cycle: no previous best to beat
    emit('cycle:start', { cycle: 2 }, T0 + 30);
    cand(2, 's-0003', 'holdout', 'holdout', T0 + 31);
    cand(2, 's-0004', 'holdout', 'holdout', T0 + 32);
    const m2 = end(2, 0.5, false, T0 + 40);
    expect(m2.map((m) => m.kind).sort()).toEqual(['all_died_holdout', 'best_ci']);
    expect(end(2, 0.5, false, T0 + 41)).toHaveLength(0); // deduped
    emit('cycle:start', { cycle: 3 }, T0 + 50);
    cand(3, 's-0005', 'promoted', null, T0 + 51, ['s-0001']);
    const promo = emit('promote', { cycle: 3, id: 's-0005', replaces: 's-0002' }, T0 + 52);
    expect(promo.map((m) => m.kind)).toEqual(['first_promotion']);
    expect(emit('promote', { cycle: 3, id: 's-0005', replaces: 's-0002' }, T0 + 53)).toHaveLength(0);
    const m3 = end(3, 0.5, true, T0 + 60);
    expect(m3.map((m) => m.kind)).toEqual(['ceiling_raised']);
    const m4 = end(4, 0.5, false, T0 + 70);
    expect(m4.map((m) => m.kind)).toEqual(['ceiling_cleared']);
    for (let c = 5; c <= 9; c++) expect(end(c, 0.5, false, T0 + 100 + c)).toHaveLength(0);
    // the seed s-0001 has been alive since cycle 0, so its line counts as a lineage at cycle 10; s-0005 descends from it
    const m10 = end(10, 0.5, false, T0 + 200);
    expect(m10.map((m) => m.kind)).toEqual(['lineage_10']);
    expect(m10[0]!.strategy_id).toBe('s-0001');
    expect(end(11, 0.5, false, T0 + 210)).toHaveLength(0);
    // 100th strategy born
    for (let i = 6; i <= 100; i++) {
      const got = cand(12, `s-${String(i).padStart(4, '0')}`, 'holdout', 'holdout', T0 + 300 + i);
      if (i === 100) expect(got.map((m) => m.kind)).toEqual(['born_100']);
      else expect(got).toHaveLength(0);
    }
    // forward beats holdout after 20 forward trades
    for (let i = 0; i < 20; i++) {
      const ts = T0 + 1_000_000 + i;
      const got = emit('trade:close', { strategyId: 's-0005', asset: 'BTC', outcome: { pnl: 1, fees: 0.1, drawdown: 0, holdBars: 1, closedTs: ts, raw: { asset: 'BTC', side: 'long', entry: 1, exit: 2, size: 0.1, reason: 'tp', openedTs: ts - 1 } }, score: 0.9, ts }, ts);
      if (i === 19) expect(got.map((m) => m.kind)).toEqual(['forward_beats_holdout']);
      else expect(got).toHaveLength(0);
    }
    // control actions
    for (const action of ['pause', 'resume', 'approve', 'reject', 'rollback', 'budget_pause'] as const) {
      const row = insertControl(db, 'core', action, 'ouro', null, T0 + 2_000_000);
      const got = emit('control', row, row.ts);
      expect(got.map((m) => m.kind)).toEqual([action]);
    }
    expect(kinds(db)).toEqual([
      'best_ci',
      'all_died_holdout',
      'first_promotion',
      'ceiling_raised',
      'ceiling_cleared',
      'lineage_10',
      'born_100',
      'forward_beats_holdout',
      'pause',
      'resume',
      'approve',
      'reject',
      'rollback',
      'budget_pause',
    ]);
    for (const m of db.prepare('SELECT title, body FROM moments').all() as any[]) {
      expect(m.title.length).toBeLessThan(80);
      expect(m.body.length).toBeLessThan(280);
      expect(m.title + m.body).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('writes a budget pause moment from a budget event once per day', () => {
    const { db, emit } = setup();
    expect(emit('budget', { lane: 'core', action: 'pause', usd: 1.01, budgetUsd: 1 }, T0).map((m) => m.kind)).toEqual(['budget_pause']);
    expect(emit('budget', { lane: 'core', action: 'pause', usd: 1.02, budgetUsd: 1 }, T0 + 1000)).toHaveLength(0);
    expect(kinds(db)).toEqual(['budget_pause']);
  });
});
