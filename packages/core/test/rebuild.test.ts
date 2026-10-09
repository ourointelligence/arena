import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createIndexer } from '../src/indexer.js';
import { upsertLane } from '../src/lanes.js';
import { rebuildLane, stageForReason, type SdkHistory, type SdkStrategy } from '../src/rebuild.js';

const META = { name: 'Core', goal: 'g', assets: ['BTC'], tf: '15m', packs: ['ta'], model: 'm', sdkVersion: '0.2.0' };
const T0 = Date.UTC(2026, 9, 9, 0, 0, 0);

function strategy(id: string, origin: SdkStrategy['origin'], cycleBorn: number, status: SdkStrategy['status'], parents: string[] = [], extra: Partial<SdkStrategy> = {}): SdkStrategy {
  return { id, parentIds: parents, origin, cycleBorn, code: `code ${id}`, params: { k: 1 }, rationale: 'r', status, describe: `d ${id}`, bounds: { k: { min: 0, max: 2, step: 1 } }, trial: { trainScore: 0.1, holdoutScore: 0.2, trainN: 10, holdoutN: 4, maxDrawdown: 0.1 }, ...extra };
}

describe('rebuild', () => {
  it('maps rejection reasons to stages', () => {
    expect(stageForReason('sandbox: import')).toBe('sandbox');
    expect(stageForReason('bounds: k=3 outside')).toBe('guards');
    expect(stageForReason('train margin')).toBe('trial');
    expect(stageForReason('holdout')).toBe('holdout');
    expect(stageForReason('rejected by user')).toBe('pending');
    expect(stageForReason(null)).toBe('promoted');
  });

  it('recreates the same cycles, strategies and trades from a .ouro folder as live indexing produced', () => {
    // 1. the live run, through the indexer
    const live = openDb(':memory:');
    upsertLane(live, 'core', META, 'running', T0);
    const ix = createIndexer(live, 'core', { population: 2, firstAsset: 'BTC' });
    const bar = (ts: number, c: number) => ix.handle('bar', { asset: 'BTC', tf: '15m', bar: { ts, asset: 'BTC', tf: '15m', o: c, h: c, l: c, c, v: 1 } }, ts);
    const cand = (cycle: number, id: string, origin: any, stage: any, reason: string | null, ts: number, parents: string[] = []) =>
      ix.handle('candidate', { cycle, id, origin, parents, describe: `d ${id}`, code: `code ${id}`, params: { k: 1 }, bounds: { k: { min: 0, max: 2, step: 1 } }, stage, reason, trainScore: 0.1, holdoutScore: 0.2 }, ts);
    cand(0, 's-0001', 'seed', 'promoted', null, T0);
    cand(0, 's-0002', 'seed', 'promoted', null, T0 + 1);
    bar(T0 + 900_000, 100);
    const close = (id: string, ts: number, pnl: number) =>
      ix.handle('trade:close', { strategyId: id, asset: 'BTC', outcome: { pnl, fees: 0.07, drawdown: 0.1, holdBars: 1, closedTs: ts, raw: { asset: 'BTC', side: 'long', entry: 100, exit: 101, size: 0.1, reason: 'flat', openedTs: ts - 900_000 } }, score: pnl - 0.07 - 0.05, ts }, ts);
    close('s-0001', T0 + 1_800_000, 0.5);
    close('s-0002', T0 + 2_700_000, -0.2);
    ix.handle('cycle:start', { cycle: 1 }, T0 + 3_600_000);
    ix.handle('critique', { cycle: 1, patterns: ['p'], summary: 's' }, T0 + 3_600_100);
    cand(1, 's-0003', 'mutate', 'trial', 'train margin', T0 + 3_600_200, ['s-0002']);
    ix.handle('retire', { cycle: 1, id: 's-0003', reason: 'train margin' }, T0 + 3_600_201);
    cand(1, 's-0004', 'mutate', 'promoted', null, T0 + 3_600_300, ['s-0001']);
    ix.handle('retire', { cycle: 1, id: 's-0002', reason: 'replaced' }, T0 + 3_600_400);
    ix.handle('promote', { cycle: 1, id: 's-0004', replaces: 's-0002' }, T0 + 3_600_500);
    ix.handle('cycle:end', { cycle: 1, outcome: 'promoted', popCI: 0.1, bestCI: 0.3, velocity: 0.1, ceiling: false, usage: { inputTokens: 100, outputTokens: 10, calls: 1, usd: 0.001 } }, T0 + 3_601_000);
    close('s-0004', T0 + 7_200_000, 0.3);

    // 2. the equivalent .ouro folder
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ouro-'));
    const s1 = strategy('s-0001', 'seed', 0, 'live');
    const s2 = strategy('s-0002', 'seed', 0, 'retired', [], { cycleRetired: 1, retireReason: 'replaced' });
    const s3 = strategy('s-0003', 'mutate', 1, 'rejected', ['s-0002']);
    const s4 = strategy('s-0004', 'mutate', 1, 'live', ['s-0001'], { ci: 0.3 });
    const history: SdkHistory = {
      version: 1,
      goal: META.goal,
      createdAt: T0,
      strategies: [s1, s2, s3, s4],
      cycles: [
        { cycle: 1, status: 'promoted', promoted: [s4], retired: [s2], rejected: [{ strategy: s3, reason: 'train margin' }], diagnosis: { patterns: ['p'], summary: 's' }, populationCI: 0.1, bestCI: 0.3, ts: T0 + 3_601_000, startedAt: T0 + 3_600_000, usage: { inputTokens: 100, outputTokens: 10, calls: 1, usd: 0.001 } },
      ],
      liveByCycle: { '0': ['s-0001', 's-0002'], '1': ['s-0001', 's-0004'] },
      seedIds: ['s-0001', 's-0002'],
      cycle: 1,
    };
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
    fs.writeFileSync(path.join(dir, 'takeoff.json'), JSON.stringify([{ cycle: 1, populationCI: 0.1, bestCI: 0.3, velocity: 0.1 }]));
    const ep = (id: string, ts: number, pnl: number) =>
      JSON.stringify({ id: `${id}-${ts}`, ts, strategyId: id, input: { ts: ts - 900_000, asset: 'BTC' }, decision: { side: 'long', size: 0.1 }, outcome: { pnl, fees: 0.07, drawdown: 0.1, holdBars: 1, closedTs: ts, raw: { asset: 'BTC', side: 'long', entry: 100, exit: 101, size: 0.1, reason: 'flat', openedTs: ts - 900_000 } }, score: pnl - 0.07 - 0.05 });
    fs.writeFileSync(path.join(dir, 'episodes.jsonl'), [ep('s-0001', T0 + 1_800_000, 0.5), ep('s-0002', T0 + 2_700_000, -0.2), ep('s-0004', T0 + 7_200_000, 0.3)].join('\n') + '\n');

    // 3. rebuild into a second db and compare
    const rebuilt = openDb(':memory:');
    const r = rebuildLane(rebuilt, 'core', dir, META, 2);
    expect(r).toMatchObject({ strategies: 4, cycles: 1, candidates: 4, trades: 3 });
    const pick = (db: any, sql: string) => db.prepare(sql).all();
    const sCols = 'id, origin, born_cycle, parents, describe, code, status, died_cycle, reject_reason, trades, forward_trades';
    expect(pick(rebuilt, `SELECT ${sCols} FROM strategies ORDER BY id`)).toEqual(pick(live, `SELECT ${sCols} FROM strategies ORDER BY id`));
    const cCols = 'n, started_at, ended_at, outcome, diagnosis, patterns, pop_ci, best_ci, velocity, ceiling, tokens_in, tokens_out';
    expect(pick(rebuilt, `SELECT ${cCols} FROM cycles`)).toEqual(pick(live, `SELECT ${cCols} FROM cycles`));
    const tCols = 'id, strategy_id, asset, side, size, opened_at, closed_at, entry, exit, pnl, fees, funding, drawdown';
    expect(pick(rebuilt, `SELECT ${tCols} FROM trades ORDER BY closed_at`)).toEqual(pick(live, `SELECT ${tCols} FROM trades ORDER BY closed_at`));
    expect(pick(rebuilt, 'SELECT cycle, strategy_id, stage, reason FROM candidates ORDER BY strategy_id')).toEqual(pick(live, 'SELECT cycle, strategy_id, stage, reason FROM candidates ORDER BY strategy_id'));
    expect(pick(rebuilt, 'SELECT strategy_id, ci FROM strategy_ci')).toEqual([{ strategy_id: 's-0004', ci: 0.3 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
