// Pure state helpers for the page: the thought log, derived refresh needs, and caps. No DOM in this file.
import type { ArenaEvent, Candidate, CycleDetail } from './types.ts';

export const LOG_CAP = 200;

export type LogTone = 'dim' | 'co' | 'fl' | 'good' | 'bad' | 'plain';
export type LogRow = { ts: number; text: string; tone: LogTone; key?: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : JSON.stringify(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Push with a hard cap, dropping the oldest rows. Returns the same array. */
export function capPush<T>(arr: T[], row: T, cap = LOG_CAP): T[] {
  arr.push(row);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}

/** Turn a live event into thought log rows (zero, one or several). */
export function logRowsFromEvent(ev: ArenaEvent): LogRow[] {
  const p = ev.payload ?? {};
  const ts = ev.ts;
  switch (ev.type) {
    case 'cycle:start':
      return [{ ts, text: `cycle ${str(p['cycle'])} starts`, tone: 'co' }];
    case 'cycle:step':
      return [{ ts, text: `${str(p['step'])}: ${str(p['detail'])}`, tone: 'plain' }];
    case 'critique': {
      const rows: LogRow[] = [{ ts, text: `critic: ${str(p['summary'])}`, tone: 'fl' }];
      const patterns = Array.isArray(p['patterns']) ? (p['patterns'] as unknown[]) : [];
      for (const pat of patterns) rows.push({ ts, text: `  pattern: ${str(pat)}`, tone: 'dim' });
      return rows;
    }
    case 'candidate': {
      const stage = str(p['stage']);
      const reason = p['reason'] ? `: ${str(p['reason'])}` : '';
      const fate = stage === 'promoted' ? 'promoted' : stage === 'pending' ? 'pending approval' : `died at ${stage}${reason}`;
      const scores = [num(p['trainScore']) !== null ? `train ${str(p['trainScore'])}` : '', num(p['holdoutScore']) !== null ? `holdout ${str(p['holdoutScore'])}` : ''].filter(Boolean).join(', ');
      return [{ ts, text: `${str(p['id'])} (${str(p['origin'])}) ${fate}${scores ? ` [${scores}]` : ''}`, tone: stage === 'promoted' ? 'good' : stage === 'pending' ? 'co' : 'bad' }];
    }
    case 'promote':
      return [{ ts, text: `promote ${str(p['id'])}, replaces ${str(p['replaces'])}`, tone: 'good' }];
    case 'retire':
      return [{ ts, text: `retire ${str(p['id'])} (${str(p['reason'])})`, tone: 'bad' }];
    case 'cycle:end': {
      const usage = (p['usage'] ?? {}) as Record<string, unknown>;
      const usd = num(usage['usd']);
      return [{ ts, text: `cycle ${str(p['cycle'])} ends: ${str(p['outcome'])}, population CI ${str(p['popCI'])}, best ${str(p['bestCI'])}, velocity ${str(p['velocity'])}${p['ceiling'] ? ', ceiling' : ''}${usd !== null ? `, $${usd.toFixed(3)}` : ''}`, tone: 'co' }];
    }
    case 'pending':
      return [{ ts, text: `cycle ${str(p['cycle'])} is waiting for approval`, tone: 'fl' }];
    case 'approved':
      return [{ ts, text: `cycle ${str(p['cycle'])} approved`, tone: 'good' }];
    case 'rejected':
      return [{ ts, text: `cycle ${str(p['cycle'])} rejected`, tone: 'bad' }];
    case 'rollback':
      return [{ ts, text: `rolled back to cycle ${str(p['toCycle'])}`, tone: 'fl' }];
    case 'llm':
      return [{ ts, text: `llm ${str(p['purpose'])} ${str(p['model'])}: ${str(p['inputTokens'])} in, ${str(p['outputTokens'])} out, ${str(p['ms'])} ms`, tone: 'dim' }];
    case 'error':
      return [{ ts, text: `error (${str(p['scope'])}): ${str(p['message'])}`, tone: 'bad' }];
    case 'control':
      return [{ ts, text: `control: ${str(p['action'])} by ${str(p['actor'])}${p['note'] ? `, ${str(p['note'])}` : ''}`, tone: 'fl' }];
    case 'budget':
      return [{ ts, text: `budget: ${str(p['note'] ?? p['action'] ?? 'paused')}`, tone: 'fl' }];
    case 'trade:close': {
      const o = (p['outcome'] ?? {}) as Record<string, unknown>;
      return [{ ts, text: `${str(p['strategyId'])} closed ${str(p['asset'])} pnl ${str(o['pnl'])} score ${str(p['score'])}`, tone: 'dim' }];
    }
    case 'trade:open':
      return [{ ts, text: `${str(p['strategyId'])} opens ${str(p['side'])} ${str(p['asset'])} size ${str(p['size'])}`, tone: 'dim' }];
    default:
      return [];
  }
}

/** The rows a finished cycle contributes when the log is first filled from the API. */
export function logRowsFromCycle(c: CycleDetail): LogRow[] {
  const rows: LogRow[] = [{ ts: c.startedAt, text: `cycle ${c.n} starts`, tone: 'co' }];
  for (const s of c.steps) {
    rows.push({ ts: s.ts, text: `${s.step}: ${s.detail}`, tone: 'plain' });
    if (s.step === 'diagnose' && c.diagnosis) {
      rows.push({ ts: s.ts, text: `critic: ${c.diagnosis}`, tone: 'fl' });
      for (const p of c.patterns) rows.push({ ts: s.ts, text: `  pattern: ${p}`, tone: 'dim' });
    }
  }
  for (const cand of c.candidates) rows.push(candidateRow(cand, c.endedAt ?? c.startedAt));
  rows.push({ ts: c.endedAt ?? c.startedAt, text: `cycle ${c.n} ends: ${c.outcome}, population CI ${str(c.popCI)}, best ${str(c.bestCI)}, velocity ${str(c.velocity)}${c.ceiling ? ', ceiling' : ''}, $${c.costUsd.toFixed(3)}`, tone: 'co' });
  return rows;
}

export function candidateRow(c: Candidate, ts: number): LogRow {
  const fate = c.stage === 'promoted' ? 'promoted' : c.stage === 'pending' ? 'pending approval' : `died at ${c.stage}${c.reason ? `: ${c.reason}` : ''}`;
  const scores = [c.trainScore !== null ? `train ${str(c.trainScore)}` : '', c.holdoutScore !== null ? `holdout ${str(c.holdoutScore)}` : ''].filter(Boolean).join(', ');
  return { ts, text: `${c.id} (${c.origin}) ${fate}${scores ? ` [${scores}]` : ''}`, tone: c.stage === 'promoted' ? 'good' : c.stage === 'pending' ? 'co' : 'bad' };
}

/** Which parts of the page an event makes stale. */
export type Refresh = 'summary' | 'population' | 'tree' | 'cycles' | 'moments' | 'control' | 'equity';

export function refreshFor(type: string): Refresh[] {
  switch (type) {
    case 'cycle:end':
      return ['summary', 'population', 'tree', 'cycles', 'equity'];
    case 'promote':
    case 'retire':
    case 'rollback':
    case 'approved':
    case 'rejected':
      return ['population', 'tree', 'summary'];
    case 'pending':
      return ['summary'];
    case 'moment':
      return ['moments'];
    case 'control':
    case 'budget':
      return ['control', 'summary'];
    case 'trade:close':
      return ['equity'];
    default:
      return [];
  }
}

/** Age label for the last bar: fresh under two intervals, stale beyond that. */
export function barAgeState(lastBarTs: number | null, tfMs: number, now = Date.now()): 'fresh' | 'late' | 'stale' | 'none' {
  if (lastBarTs === null) return 'none';
  const age = now - lastBarTs;
  if (age < tfMs * 2) return 'fresh';
  if (age < tfMs * 4) return 'late';
  return 'stale';
}

export const TF_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
