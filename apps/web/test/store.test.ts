import { describe, expect, it } from 'vitest';
import { barAgeState, capPush, candidateRow, logRowsFromCycle, logRowsFromEvent, LOG_CAP, refreshFor } from '../src/store.ts';
import { backoffMs } from '../src/stream.ts';
import type { ArenaEvent, CycleDetail } from '../src/types.ts';

const ev = (type: string, payload: Record<string, unknown>): ArenaEvent => ({ id: 1, lane: 'core', ts: 1_700_000_000_000, type, payload });

describe('capPush', () => {
  it('keeps the newest rows and never grows past the cap', () => {
    const arr: number[] = [];
    for (let i = 0; i < LOG_CAP + 50; i++) capPush(arr, i);
    expect(arr).toHaveLength(LOG_CAP);
    expect(arr[0]).toBe(50);
    expect(arr[arr.length - 1]).toBe(LOG_CAP + 49);
  });
});

describe('logRowsFromEvent', () => {
  it('writes the critic diagnosis in full with its patterns', () => {
    const rows = logRowsFromEvent(ev('critique', { cycle: 3, summary: 'Weak ones trade the quiet hours.', patterns: ['a', 'b'] }));
    expect(rows.map((r) => r.text)).toEqual(['critic: Weak ones trade the quiet hours.', '  pattern: a', '  pattern: b']);
    expect(rows[0]!.tone).toBe('fl');
  });
  it('gives every candidate a fate and a reason', () => {
    const dead = logRowsFromEvent(ev('candidate', { id: 's-0009', origin: 'fresh', stage: 'holdout', reason: 'holdout', trainScore: 0.1, holdoutScore: -0.2 }))[0]!;
    expect(dead.text).toBe('s-0009 (fresh) died at holdout: holdout [train 0.1, holdout -0.2]');
    expect(dead.tone).toBe('bad');
    const won = logRowsFromEvent(ev('candidate', { id: 's-0010', origin: 'mutate', stage: 'promoted', reason: null }))[0]!;
    expect(won.text).toBe('s-0010 (mutate) promoted');
    expect(won.tone).toBe('good');
  });
  it('ignores events the log does not show', () => {
    expect(logRowsFromEvent(ev('bar', { asset: 'BTC' }))).toEqual([]);
    expect(logRowsFromEvent(ev('decision', {}))).toEqual([]);
  });
  it('never throws on a payload it does not understand', () => {
    expect(() => logRowsFromEvent(ev('cycle:end', { usage: 'nope', popCI: { a: 1 } }))).not.toThrow();
    expect(() => logRowsFromEvent({ id: 1, lane: 'core', ts: 0, type: 'critique', payload: null as never })).not.toThrow();
  });
});

describe('logRowsFromCycle', () => {
  it('replays a finished cycle as start, steps, critic, candidates and end', () => {
    const c: CycleDetail = {
      n: 4,
      startedAt: 1,
      endedAt: 9,
      outcome: 'promoted',
      diagnosis: 'diag',
      patterns: ['p1'],
      popCI: 0.2,
      bestCI: 0.5,
      velocity: 0.1,
      ceiling: false,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.01,
      promoted: ['s-0020'],
      retired: ['s-0003'],
      candidates: [{ id: 's-0020', origin: 'mutate', parents: ['s-0003'], describe: '', stage: 'promoted', reason: null, trainScore: 0.3, holdoutScore: 0.4 }],
      steps: [
        { ts: 2, step: 'collect', detail: 'c' },
        { ts: 3, step: 'diagnose', detail: 'd' },
      ],
    };
    const rows = logRowsFromCycle(c);
    expect(rows[0]!.text).toBe('cycle 4 starts');
    expect(rows.some((r) => r.text === 'critic: diag')).toBe(true);
    expect(rows.some((r) => r.text === '  pattern: p1')).toBe(true);
    expect(rows[rows.length - 1]!.text).toContain('cycle 4 ends: promoted');
    expect(candidateRow(c.candidates[0]!, 9).text).toBe('s-0020 (mutate) promoted [train 0.3, holdout 0.4]');
  });
});

describe('refreshFor and helpers', () => {
  it('maps events to the sections they make stale', () => {
    expect(refreshFor('cycle:end')).toContain('tree');
    expect(refreshFor('moment')).toEqual(['moments']);
    expect(refreshFor('bar')).toEqual([]);
  });
  it('flags bar age', () => {
    const now = 1_000_000_000;
    expect(barAgeState(now - 60_000, 900_000, now)).toBe('fresh');
    expect(barAgeState(now - 2_000_000, 900_000, now)).toBe('late');
    expect(barAgeState(now - 4_000_000, 900_000, now)).toBe('stale');
    expect(barAgeState(null, 900_000, now)).toBe('none');
  });
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
