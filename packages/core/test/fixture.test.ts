import { describe, expect, it } from 'vitest';
import { createFixtureDb, FIXTURE_NOW } from '../src/fixture.js';

describe('fixture', () => {
  it('builds three believable lanes deterministically', () => {
    const { db, summary } = createFixtureDb(':memory:');
    const { db: db2, summary: summary2 } = createFixtureDb(':memory:');
    expect(summary).toEqual(summary2);
    expect(summary.lanes).toEqual(['core', 'alts', 'flow']);
    for (const lane of summary.lanes) {
      expect(summary.cycles[lane]).toBe(12);
      expect(summary.strategies[lane]).toBeGreaterThan(40);
      expect(summary.trades[lane]).toBeGreaterThan(50);
      const live = db.prepare("SELECT COUNT(*) AS n FROM strategies WHERE lane_id = ? AND status = 'live'").get(lane) as { n: number };
      expect(live.n).toBe(8);
      const moments = db.prepare('SELECT COUNT(*) AS n FROM moments WHERE lane_id = ?').get(lane) as { n: number };
      expect(moments.n).toBeGreaterThan(2);
      const equity = db.prepare('SELECT COUNT(*) AS n FROM equity WHERE lane_id = ?').get(lane) as { n: number };
      expect(equity.n).toBeGreaterThan(50);
      const snaps = db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE lane_id = ?').get(lane) as { n: number };
      expect(snaps.n).toBe(24);
      const state = db.prepare('SELECT state, seen_at FROM lane_state WHERE lane_id = ?').get(lane) as { state: string; seen_at: number };
      expect(state.seen_at).toBe(FIXTURE_NOW);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM control WHERE lane_id = 'core'").get() as any).n).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM moments WHERE kind = 'all_died_holdout'").get() as any).n).toBeGreaterThanOrEqual(3);
    const a = db.prepare("SELECT id FROM strategies WHERE lane_id = 'core' ORDER BY id").all();
    const b = db2.prepare("SELECT id FROM strategies WHERE lane_id = 'core' ORDER BY id").all();
    expect(a).toEqual(b);
  });
});
