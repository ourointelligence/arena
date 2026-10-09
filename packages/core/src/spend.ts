import type { Db } from './db.js';
import type { LaneId, LLMUsage, Pricing, SpendRow } from './types.js';
import { dayOf, usdFor } from './types.js';

/** Add one call's usage to the lane's spend row for the UTC day of `ts`. Returns the day's totals after the add. */
export function addSpend(db: Db, lane: LaneId, usage: LLMUsage, pricing: Pricing | undefined, ts = Date.now()): SpendRow {
  const day = dayOf(ts);
  const usd = usdFor(usage, pricing);
  db.prepare(
    `INSERT INTO spend (day, lane_id, tokens_in, tokens_out, usd) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, lane_id) DO UPDATE SET tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, usd = usd + excluded.usd`,
  ).run(day, lane, usage.inputTokens, usage.outputTokens, usd);
  return spendForDay(db, lane, day);
}

export function spendForDay(db: Db, lane: LaneId, day: string): SpendRow {
  const r = db.prepare('SELECT * FROM spend WHERE day = ? AND lane_id = ?').get(day, lane) as SpendRow | undefined;
  return r ?? { day, lane_id: lane, tokens_in: 0, tokens_out: 0, usd: 0 };
}

/** Today's (UTC) spend for a lane. */
export function spendToday(db: Db, lane: LaneId, now = Date.now()): SpendRow {
  return spendForDay(db, lane, dayOf(now));
}

export function spendTotal(db: Db, lane: LaneId): { tokens_in: number; tokens_out: number; usd: number } {
  const r = db
    .prepare('SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(usd), 0) AS usd FROM spend WHERE lane_id = ?')
    .get(lane) as { tokens_in: number; tokens_out: number; usd: number };
  return r;
}
