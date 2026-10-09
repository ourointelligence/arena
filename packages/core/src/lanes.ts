import type { Db } from './db.js';
import type { LaneId, LaneStatus } from './types.js';
import type { LaneMeta } from './rebuild.js';

export const ARENA_VERSION = '0.1.0';

/** Insert or refresh the lanes row the runner describes itself with at start. */
export function upsertLane(db: Db, lane: LaneId, meta: LaneMeta, status: LaneStatus = 'running', now = Date.now()): void {
  db.prepare(
    `INSERT INTO lanes (id, name, goal, assets, tf, packs, model, sdk_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, goal = excluded.goal, assets = excluded.assets, tf = excluded.tf, packs = excluded.packs,
       model = excluded.model, sdk_version = excluded.sdk_version, status = excluded.status`,
  ).run(lane, meta.name, meta.goal, JSON.stringify(meta.assets), meta.tf, JSON.stringify(meta.packs), meta.model, meta.sdkVersion, status, now);
}

/**
 * Record each live strategy's Capability Index after a cycle (the SDK exposes CI on the population, not in an
 * event). The runner calls this after cycle:end; the API serves it as ciHistory.
 */
export function recordPopulationCI(db: Db, lane: LaneId, cycle: number, rows: Array<{ id: string; ci: number | null | undefined }>): void {
  const ins = db.prepare('INSERT OR REPLACE INTO strategy_ci (lane_id, strategy_id, cycle, ci) VALUES (?, ?, ?, ?)');
  const upd = db.prepare('UPDATE strategies SET ci = ? WHERE lane_id = ? AND id = ?');
  db.transaction(() => {
    for (const r of rows) {
      if (typeof r.ci !== 'number' || !Number.isFinite(r.ci)) continue;
      ins.run(lane, r.id, cycle, r.ci);
      upd.run(r.ci, lane, r.id);
    }
  })();
}
