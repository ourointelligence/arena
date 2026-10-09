import { describe, expect, it } from 'vitest';
import { isStale, laneSource, sourceHealth, LANE_WEIGHT_PER_MINUTE } from '../src/index.js';

describe('@arena/hl', () => {
  it('builds a lane source with the shared budget and reports health from stats()', () => {
    const src = laneSource({ wsUrl: 'ws://127.0.0.1:1', infoUrl: 'http://127.0.0.1:1' });
    expect(src.name).toBe('hyperliquid');
    const h = sourceHealth(src);
    expect(h).toEqual({ connected: false, lastBarTs: null, reconnects: 0, gapsFilled: 0, weightUsedLastMinute: 0, requests: 0 });
    expect(LANE_WEIGHT_PER_MINUTE * 3).toBeLessThanOrEqual(1200 / 2);
  });

  it('health of a plain source has safe defaults', () => {
    const h = sourceHealth({ name: 'x', async *subscribe() {}, async history() { return []; } });
    expect(h.connected).toBe(false);
  });

  it('isStale uses two intervals after the bar close', () => {
    const iv = 900_000;
    const t = 1_000_000_000_000;
    expect(isStale(null, iv)).toBe(true);
    expect(isStale(t, iv, t + iv + 2 * iv)).toBe(false);
    expect(isStale(t, iv, t + iv + 2 * iv + 1)).toBe(true);
  });
});
