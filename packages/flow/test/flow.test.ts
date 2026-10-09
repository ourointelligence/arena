import { describe, expect, it } from 'vitest';
import type { Bar } from '@ourointelligence/sdk';
import { flow, FUNDING_Z_WINDOW } from '../src/index.js';

function bars(n: number, f: (i: number) => Partial<Bar['ext']> | undefined): Bar[] {
  const t0 = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => ({ ts: t0 + i * 900_000, asset: 'BTC', tf: '15m', o: 1, h: 1, l: 1, c: 1, v: 1, ext: f(i) as Record<string, number> | undefined }));
}

describe('flow pack', () => {
  it('describes six keys and computes each from bar.ext', () => {
    expect(flow.describe().map((d) => d.key)).toEqual(['funding', 'fundingZ', 'oiChange1h', 'oiChange4h', 'premium', 'basis']);
    const xs = bars(20, (i) => ({ 'funding.rate': 0.0001 * (i % 3), oi: 1000 + i * 10, premium: 0.001, mark: 101, oracle: 100 }));
    const f = flow.compute(xs, 19);
    expect(f['funding']).toBeCloseTo(0.0001 * (19 % 3), 12);
    expect(f['oiChange1h']).toBeCloseTo((1000 + 190) / (1000 + 150) - 1, 12);
    expect(f['oiChange4h']).toBeCloseTo((1000 + 190) / (1000 + 30) - 1, 12);
    expect(f['premium']).toBe(0.001);
    expect(f['basis']).toBeCloseTo(0.01, 12);
    expect(typeof f['fundingZ']).toBe('number');
  });

  it('returns null without ext data or without enough history', () => {
    const plain = bars(10, () => undefined);
    expect(flow.compute(plain, 9)).toEqual({ funding: null, fundingZ: null, oiChange1h: null, oiChange4h: null, premium: null, basis: null });
    const few = bars(3, () => ({ 'funding.rate': 0.0001, oi: 5 }));
    const f = flow.compute(few, 2);
    expect(f['fundingZ']).toBeNull();
    expect(f['oiChange1h']).toBeNull();
  });

  it('never looks ahead: changing later bars leaves every feature at i unchanged', () => {
    const xs = bars(FUNDING_Z_WINDOW + 30, (i) => ({ 'funding.rate': Math.sin(i) * 0.0002, oi: 1000 + (i % 7) * 5, premium: i / 1000, mark: 100 + (i % 5), oracle: 100 }));
    const i = FUNDING_Z_WINDOW + 10;
    const before = flow.compute(xs, i);
    const tampered = xs.map((b, k) => (k > i ? { ...b, ext: { 'funding.rate': 9, oi: 1, premium: 9, mark: 1, oracle: 1 } } : b));
    expect(flow.compute(tampered, i)).toEqual(before);
    // and a change strictly inside the window does move the z-score, so the test has teeth
    const moved = xs.map((b, k) => (k === i - 1 ? { ...b, ext: { ...b.ext!, 'funding.rate': 0.5 } } : b));
    expect(flow.compute(moved, i)['fundingZ']).not.toEqual(before['fundingZ']);
  });
});
