import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoop, primitives } from '@ourointelligence/sdk';
import type { Bar, Source } from '@ourointelligence/sdk';
import { openDb } from '@arena/core';
import { startMockHL, type MockHL } from './mock-hl.js';
import { sleep, buildRunner, childEnv, makeDirs, startLane, waitExit, type TestDirs } from './children.js';

let mock: MockHL;
let dirs: TestDirs;

beforeAll(async () => {
  buildRunner();
  mock = await startMockHL({ tickMs: 25, behindIntervals: 3000, seed: 3 });
  dirs = makeDirs('arena-res-');
}, 300_000);

afterAll(async () => {
  await mock.close();
});

const cyclesDone = () => {
  if (!fs.existsSync(dirs.dbPath)) return [] as Array<{ n: number; outcome: string | null; ended_at: number | null }>;
  const db = openDb(dirs.dbPath, { readonly: true });
  const rows = db.prepare("SELECT n, outcome, ended_at FROM cycles WHERE lane_id = 'core' ORDER BY n").all() as Array<{ n: number; outcome: string | null; ended_at: number | null }>;
  db.close();
  return rows;
};

function startChild(extra: Record<string, string> = {}): ChildProcess {
  return startLane('core', childEnv(dirs, mock, extra)).proc;
}

describe('resilience', () => {
  it('SIGKILL during every cycle step, then a clean resume with no duplicate or lost cycle', async () => {
    const steps = ['collect', 'rank', 'diagnose', 'generate', 'trial', 'validate', 'promote'];
    let completedBefore = 0;
    for (const step of steps) {
      const killed = startChild({ ARENA_TEST_KILL_STEP: step });
      const exit = await waitExit(killed, 180_000);
      // the child killed itself at the step (it may also exit normally if that step never happened: counted below)
      expect(exit.signal === 'SIGKILL' || exit.code !== 0 || exit.code === null, `step ${step}: exit ${JSON.stringify(exit)}`).toBe(true);
      const rows = cyclesDone();
      const ns = rows.map((r) => r.n);
      expect(new Set(ns).size, `duplicate cycle rows after kill at ${step}: ${ns.join(',')}`).toBe(ns.length);
      // resume without the hook: the lane continues, the unfinished cycle (if any) completes exactly once
      const resumed = startChild();
      const target = (rows.filter((r) => r.ended_at !== null).length || completedBefore) + 1;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && cyclesDone().filter((r) => r.ended_at !== null).length < target) await sleep(1000);
      resumed.kill('SIGTERM');
      await waitExit(resumed, 60_000);
      const after = cyclesDone();
      const finished = after.filter((r) => r.ended_at !== null);
      expect(finished.length, `after resume from ${step}: ${JSON.stringify(after)}`).toBeGreaterThanOrEqual(target);
      const seq = after.map((r) => r.n);
      expect(seq).toEqual(seq.map((_, i) => i + 1)); // contiguous 1..n, nothing lost, nothing doubled
      expect(after.filter((r) => r.ended_at === null).length).toBeLessThanOrEqual(1);
      completedBefore = finished.length;
    }
  }, 900_000);

  it('a stale bar is recorded but never traded on', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bars: Bar[] = [];
    let price = 100;
    for (let i = 0; i < 320; i++) {
      const c = price * (1 + Math.sin(i / 7) * 0.01);
      bars.push({ ts: t0 + i * 900_000, asset: 'BTC', tf: '15m', o: price, h: Math.max(price, c) * 1.002, l: Math.min(price, c) * 0.998, c, v: 10 });
      price = c;
    }
    const live: Bar[] = [
      { ...bars[319]!, ts: t0 + 320 * 900_000, stale: true },
      { ...bars[319]!, ts: t0 + 321 * 900_000 },
    ];
    const source: Source = {
      name: 'fake',
      async history() {
        return bars;
      },
      async *subscribe() {
        for (const b of live) yield b;
      },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stale-'));
    const seedFile = path.join(dir, 'always.ts');
    fs.writeFileSync(
      seedFile,
      `export const params = { size: 0.05 };
export const bounds = { size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision { return { side: 'long', size: p.size }; }
export const describe = 'always long';`,
    );
    const loop = createLoop({
      goal: 'test',
      primitives: [primitives.ta],
      source,
      executor: 'paper',
      score: (ep) => ep.outcome.pnl,
      llm: { name: 'none', async complete() { throw new Error('no model needed'); } },
      seed: [seedFile],
      population: 1,
      assets: ['BTC'],
      tf: '15m',
      dir: path.join(dir, '.ouro'),
      warmupBars: 300,
      backfill: 0,
      autoCycle: false,
      log: { backend: 'jsonl' },
    });
    const decided: number[] = [];
    const seen: number[] = [];
    loop.on('decision', () => decided.push(0));
    loop.on('bar', (b) => seen.push(b.bar.ts));
    loop.on('decision', () => undefined);
    const decisionsByBar = new Map<number, number>();
    loop.on('bar', (b) => decisionsByBar.set(b.bar.ts, 0));
    loop.on('decision', () => {
      const last = seen[seen.length - 1]!;
      decisionsByBar.set(last, (decisionsByBar.get(last) ?? 0) + 1);
    });
    await loop.start();
    await loop.close();
    expect(seen).toContain(live[0]!.ts);
    expect(decisionsByBar.get(live[0]!.ts)).toBe(0); // stale: recorded, not traded
    expect(decisionsByBar.get(live[1]!.ts)).toBe(1); // fresh: traded
    expect(decided.length).toBeGreaterThan(0);
  }, 60_000);
});
