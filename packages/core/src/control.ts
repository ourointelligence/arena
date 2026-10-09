import type { Db } from './db.js';
import type { ControlAction, ControlRow, LaneId, LaneStateRow, LaneStatus } from './types.js';

export function insertControl(db: Db, lane: LaneId, action: ControlAction, actor: string, note: string | null = null, ts = Date.now()): ControlRow {
  const r = db.prepare('INSERT INTO control (lane_id, ts, action, actor, note) VALUES (?, ?, ?, ?, ?)').run(lane, ts, action, actor, note);
  return { id: Number(r.lastInsertRowid), lane_id: lane, ts, action, actor, note };
}

export function listControl(db: Db, lane?: LaneId, limit = 200): ControlRow[] {
  const rows = lane
    ? db.prepare('SELECT * FROM control WHERE lane_id = ? ORDER BY id DESC LIMIT ?').all(lane, limit)
    : db.prepare('SELECT * FROM control ORDER BY id DESC LIMIT ?').all(limit);
  return rows as ControlRow[];
}

const STATE_COLUMNS = [
  'state',
  'last_bar_ts',
  'last_cycle_ts',
  'ws_connected',
  'pid',
  'started_at',
  'seen_at',
  'sdk_version',
  'model',
  'budget_usd',
  'approval_on',
] as const;

export type LaneStatePatch = Partial<Omit<LaneStateRow, 'lane_id'>>;

/** Insert or update the lane's state row with only the fields given. */
export function upsertLaneState(db: Db, lane: LaneId, patch: LaneStatePatch): void {
  const existing = db.prepare('SELECT lane_id FROM lane_state WHERE lane_id = ?').get(lane);
  const cols = STATE_COLUMNS.filter((c) => patch[c] !== undefined);
  const value = (c: (typeof STATE_COLUMNS)[number]) => {
    const v = patch[c];
    return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null);
  };
  if (!existing) {
    db.prepare(`INSERT INTO lane_state (lane_id${cols.map((c) => `, ${c}`).join('')}) VALUES (?${cols.map(() => ', ?').join('')})`).run(
      lane,
      ...cols.map(value),
    );
    return;
  }
  if (!cols.length) return;
  db.prepare(`UPDATE lane_state SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE lane_id = ?`).run(...cols.map(value), lane);
}

export function readLaneState(db: Db, lane: LaneId): LaneStateRow | null {
  const r = db.prepare('SELECT * FROM lane_state WHERE lane_id = ?').get(lane) as (Omit<LaneStateRow, 'ws_connected' | 'approval_on'> & { ws_connected: number; approval_on: number }) | undefined;
  if (!r) return null;
  return { ...r, ws_connected: !!r.ws_connected, approval_on: !!r.approval_on };
}

export function setLaneStatus(db: Db, lane: LaneId, state: LaneStatus): void {
  upsertLaneState(db, lane, { state });
  db.prepare('UPDATE lanes SET status = ? WHERE id = ?').run(state, lane);
}
