/**
 * Read queries that produce exactly the shapes in docs/api-contract.md. Every function takes the open database
 * and never writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJson, readChain, verifyChain, type Db, type LaneId, type LaneStatus } from '@arena/core';

export const OPEN_POSITION_DELAY_MS = 15 * 60_000;
export const STALE_LANE_MS = 120_000;
export const LEDGER_REPO = 'https://github.com/ourointelligence/arena-ledger';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function laneExists(db: Db, lane: string): lane is LaneId {
  return !!db.prepare('SELECT 1 FROM lanes WHERE id = ?').get(lane);
}

export function lanes(db: Db) {
  const rows = db.prepare('SELECT * FROM lanes ORDER BY created_at').all() as any[];
  return rows.map((r) => ({
    id: r.id as LaneId,
    name: r.name as string,
    goal: r.goal as string,
    assets: parseJson<string[]>(r.assets, []),
    tf: r.tf as string,
    packs: parseJson<string[]>(r.packs, []),
    model: r.model as string,
    sdkVersion: r.sdk_version as string,
    status: r.status as LaneStatus,
    createdAt: r.created_at as number,
  }));
}

export function laneState(db: Db, lane: LaneId, now: number) {
  const r = db.prepare('SELECT * FROM lane_state WHERE lane_id = ?').get(lane) as any;
  if (!r) return { state: 'stopped' as LaneStatus, lastBarTs: null, lastCycleTs: null, wsConnected: false, pid: null, startedAt: null, seenAt: null, approvalOn: false, budgetUsd: null, sdkVersion: null, model: null };
  const fresh = typeof r.seen_at === 'number' && now - r.seen_at <= STALE_LANE_MS;
  return {
    state: (fresh ? r.state : 'stopped') as LaneStatus,
    lastBarTs: num(r.last_bar_ts),
    lastCycleTs: num(r.last_cycle_ts),
    wsConnected: fresh && !!r.ws_connected,
    pid: fresh ? num(r.pid) : null,
    startedAt: num(r.started_at),
    seenAt: num(r.seen_at),
    approvalOn: !!r.approval_on,
    budgetUsd: num(r.budget_usd),
    sdkVersion: (r.sdk_version as string | null) ?? null,
    model: (r.model as string | null) ?? null,
  };
}

export function health(db: Db, opts: { now: number; version: string; sdkVersion: string; dataDir: string }) {
  const out: Record<string, unknown> = {};
  for (const l of lanes(db)) {
    const s = laneState(db, l.id, opts.now);
    out[l.id] = { state: s.state, lastBarTs: s.lastBarTs, lastCycleTs: s.lastCycleTs, wsConnected: s.wsConnected, pid: s.pid, startedAt: s.startedAt, seenAt: s.seenAt };
  }
  const sdk = (db.prepare('SELECT sdk_version FROM lanes ORDER BY created_at DESC LIMIT 1').get() as any)?.sdk_version as string | undefined;
  return { ok: true, ts: opts.now, version: opts.version, sdkVersion: sdk || opts.sdkVersion, disk: { percent: diskPercent(opts.dataDir) }, lanes: out };
}

export function diskPercent(dir: string): number | null {
  try {
    const target = fs.existsSync(dir) ? dir : path.parse(path.resolve(dir)).root;
    const s = fs.statfsSync(target);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    return Math.round(((total - free) / total) * 100);
  } catch {
    return null;
  }
}

export function summary(db: Db, lane: LaneId, now: number) {
  const l = lanes(db).find((x) => x.id === lane)!;
  const s = laneState(db, lane, now);
  const last = db.prepare('SELECT n, pop_ci, best_ci, velocity, ceiling FROM cycles WHERE lane_id = ? AND ended_at IS NOT NULL ORDER BY n DESC LIMIT 1').get(lane) as any;
  const cycles = (db.prepare('SELECT COUNT(*) AS n FROM cycles WHERE lane_id = ? AND ended_at IS NOT NULL').get(lane) as any).n as number;
  const born = (db.prepare('SELECT COUNT(*) AS n FROM strategies WHERE lane_id = ?').get(lane) as any).n as number;
  const live = (db.prepare("SELECT COUNT(*) AS n FROM strategies WHERE lane_id = ? AND status = 'live'").get(lane) as any).n as number;
  const day = new Date(now).toISOString().slice(0, 10);
  const spend = (db.prepare('SELECT tokens_in, tokens_out, usd FROM spend WHERE lane_id = ? AND day = ?').get(lane, day) as any) ?? { tokens_in: 0, tokens_out: 0, usd: 0 };
  return {
    lane,
    status: s.state,
    uptimeMs: s.startedAt && s.state !== 'stopped' ? Math.max(0, now - s.startedAt) : 0,
    cycles,
    born,
    live,
    popCI: num(last?.pop_ci),
    bestCI: num(last?.best_ci),
    velocity: num(last?.velocity),
    ceiling: !!last?.ceiling,
    spendTodayUsd: Number(spend.usd) || 0,
    tokensToday: { in: Number(spend.tokens_in) || 0, out: Number(spend.tokens_out) || 0 },
    budgetUsd: s.budgetUsd,
    sdkVersion: s.sdkVersion ?? l.sdkVersion,
    model: s.model ?? l.model,
    lastBarTs: s.lastBarTs,
    lastCycleTs: s.lastCycleTs,
  };
}

function currentCycle(db: Db, lane: LaneId): number {
  return Number((db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM cycles WHERE lane_id = ?').get(lane) as any).n);
}

export function population(db: Db, lane: LaneId) {
  const cur = currentCycle(db, lane);
  const rows = db
    .prepare("SELECT * FROM strategies WHERE lane_id = ? AND status = 'live' ORDER BY (ci IS NULL), ci DESC, id")
    .all(lane) as any[];
  return rows.map((r) => ({
    id: r.id as string,
    origin: r.origin as string,
    bornCycle: r.born_cycle as number,
    ci: num(r.ci),
    holdoutScore: num(r.holdout_score),
    forwardScore: num(r.forward_score),
    trades: r.trades as number,
    forwardTrades: r.forward_trades as number,
    cyclesSurvived: Math.max(0, cur - (r.born_cycle as number)),
    describe: r.describe as string,
    status: r.status as string,
  }));
}

function cycleRow(db: Db, lane: LaneId, r: any) {
  const promoted = (db.prepare("SELECT strategy_id FROM candidates WHERE lane_id = ? AND cycle = ? AND stage IN ('promoted', 'pending') AND reason IS NULL ORDER BY strategy_id").all(lane, r.n) as any[]).map((x) => x.strategy_id as string);
  const retired = (db.prepare("SELECT id FROM strategies WHERE lane_id = ? AND died_cycle = ? AND status IN ('retired', 'rolled_back') ORDER BY id").all(lane, r.n) as any[]).map((x) => x.id as string);
  const candidates = (db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE lane_id = ? AND cycle = ?').get(lane, r.n) as any).n as number;
  return {
    n: r.n as number,
    startedAt: num(r.started_at),
    endedAt: num(r.ended_at),
    outcome: (r.outcome as string | null) ?? 'pending',
    diagnosis: (r.diagnosis as string | null) ?? '',
    patterns: parseJson<string[]>(r.patterns, []),
    popCI: num(r.pop_ci),
    bestCI: num(r.best_ci),
    velocity: num(r.velocity),
    ceiling: !!r.ceiling,
    tokensIn: r.tokens_in as number,
    tokensOut: r.tokens_out as number,
    costUsd: r.cost_usd as number,
    promoted,
    retired,
    candidates,
  };
}

export function cycles(db: Db, lane: LaneId, limit: number, before: number | null) {
  const lim = Math.min(Math.max(1, limit || 20), 100);
  const rows = (before === null
    ? db.prepare('SELECT * FROM cycles WHERE lane_id = ? AND n > 0 ORDER BY n DESC LIMIT ?').all(lane, lim + 1)
    : db.prepare('SELECT * FROM cycles WHERE lane_id = ? AND n > 0 AND n < ? ORDER BY n DESC LIMIT ?').all(lane, before, lim + 1)) as any[];
  const page = rows.slice(0, lim);
  const items = page.map((r) => cycleRow(db, lane, r));
  const nextBefore = rows.length > lim ? (page[page.length - 1]!.n as number) : null;
  return { items, nextBefore };
}

export function cycle(db: Db, lane: LaneId, n: number) {
  const r = db.prepare('SELECT * FROM cycles WHERE lane_id = ? AND n = ?').get(lane, n) as any;
  if (!r) return null;
  const steps = (db.prepare('SELECT ts, step, detail FROM cycle_steps WHERE lane_id = ? AND cycle = ? ORDER BY ts, id').all(lane, n) as any[]).map((s) => ({ ts: s.ts as number, step: s.step as string, detail: s.detail as string }));
  const candidates = (
    db
      .prepare(
        `SELECT c.strategy_id AS id, c.origin, c.stage, c.reason, c.train_score, c.holdout_score, s.parents, s.describe
         FROM candidates c LEFT JOIN strategies s ON s.lane_id = c.lane_id AND s.id = c.strategy_id
         WHERE c.lane_id = ? AND c.cycle = ? ORDER BY c.strategy_id`,
      )
      .all(lane, n) as any[]
  ).map((c) => ({
    id: c.id as string,
    origin: c.origin as string,
    parents: parseJson<string[]>(c.parents, []),
    describe: (c.describe as string | null) ?? '',
    stage: c.stage as string,
    reason: (c.reason as string | null) ?? null,
    trainScore: num(c.train_score),
    holdoutScore: num(c.holdout_score),
  }));
  return { ...cycleRow(db, lane, r), steps, candidates };
}

export function tree(db: Db, lane: LaneId) {
  const rows = db.prepare('SELECT id, parents, born_cycle, died_cycle, status, ci, origin FROM strategies WHERE lane_id = ? ORDER BY born_cycle, id').all(lane) as any[];
  const nodes = rows.map((r) => ({
    id: r.id as string,
    parents: parseJson<string[]>(r.parents, []),
    born: r.born_cycle as number,
    died: num(r.died_cycle),
    status: r.status as string,
    ci: num(r.ci),
    origin: r.origin as string,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const best = nodes.filter((n) => n.status === 'live' && n.ci !== null).sort((a, b) => b.ci! - a.ci!)[0] ?? null;
  const lineage: string[] = [];
  if (best) {
    const seen = new Set<string>();
    let cur: (typeof nodes)[number] | undefined = best;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      lineage.unshift(cur.id);
      cur = cur.parents.length ? byId.get(cur.parents[0]!) : undefined;
    }
  }
  return { nodes, bestId: best?.id ?? null, bestLineage: lineage };
}

export function graveyard(db: Db, lane: LaneId, cursor: number | null, limit = 50) {
  const lim = Math.min(Math.max(1, limit), 200);
  const base = "SELECT rowid AS rid, * FROM strategies WHERE lane_id = ? AND status IN ('retired', 'rejected', 'rolled_back')";
  const rows = (cursor === null
    ? db.prepare(`${base} ORDER BY rowid DESC LIMIT ?`).all(lane, lim + 1)
    : db.prepare(`${base} AND rowid < ? ORDER BY rowid DESC LIMIT ?`).all(lane, cursor, lim + 1)) as any[];
  const page = rows.slice(0, lim);
  const items = page.map((r) => ({
    id: r.id as string,
    origin: r.origin as string,
    born: r.born_cycle as number,
    died: num(r.died_cycle),
    lifespan: r.status === 'rejected' ? 0 : Math.max(0, (num(r.died_cycle) ?? r.born_cycle) - r.born_cycle),
    describe: r.describe as string,
    reason: (r.reject_reason as string | null) ?? (r.status as string),
    holdoutScore: num(r.holdout_score),
    ci: num(r.ci),
  }));
  return { items, nextCursor: rows.length > lim ? (page[page.length - 1]!.rid as number) : null };
}

export function openPositions(db: Db, lane: LaneId, strategyId: string, now: number) {
  const rows = db
    .prepare("SELECT ts, payload FROM events WHERE lane_id = ? AND type = 'trade:open' AND ts <= ? ORDER BY id ASC")
    .all(lane, now - OPEN_POSITION_DELAY_MS) as Array<{ ts: number; payload: string }>;
  const open = new Map<string, { asset: string; side: string; size: number; openedAt: number; entry: number }>();
  for (const r of rows) {
    const p = parseJson<any>(r.payload, null);
    if (!p || p.strategyId !== strategyId) continue;
    open.set(p.asset, { asset: p.asset, side: p.side, size: p.size, openedAt: p.ts ?? r.ts, entry: p.price });
  }
  for (const [asset, p] of open) {
    const closed = db.prepare('SELECT 1 FROM trades WHERE lane_id = ? AND strategy_id = ? AND asset = ? AND closed_at >= ? LIMIT 1').get(lane, strategyId, asset, p.openedAt);
    if (closed) open.delete(asset);
  }
  return [...open.values()];
}

export function strategy(db: Db, lane: LaneId, id: string, now: number) {
  const r = db.prepare('SELECT * FROM strategies WHERE lane_id = ? AND id = ?').get(lane, id) as any;
  if (!r) return null;
  const parents = parseJson<string[]>(r.parents, []);
  const children = (db.prepare("SELECT id FROM strategies WHERE lane_id = ? AND parents LIKE ? ORDER BY id").all(lane, `%"${id}"%`) as any[]).map((x) => x.id as string);
  const born = db.prepare('SELECT diagnosis FROM cycles WHERE lane_id = ? AND n = ?').get(lane, r.born_cycle) as any;
  const ciHistory = (db.prepare('SELECT cycle, ci FROM strategy_ci WHERE lane_id = ? AND strategy_id = ? ORDER BY cycle').all(lane, id) as any[]).map((x) => ({ cycle: x.cycle as number, ci: x.ci as number }));
  const trades = db.prepare('SELECT closed_at, score FROM trades WHERE lane_id = ? AND strategy_id = ? ORDER BY closed_at').all(lane, id) as any[];
  let eq = 100;
  const equity = trades.map((t) => ({ ts: t.closed_at as number, equity: (eq += Number(t.score)) }));
  const originText =
    r.origin === 'seed'
      ? 'It was written by the Generator in the first generation from the goal alone.'
      : r.origin === 'user'
        ? 'It was supplied as a starting strategy.'
        : r.origin === 'mutate'
          ? `It is a mutation of ${parents.join(', ') || 'an earlier strategy'}, born in cycle ${r.born_cycle}.`
          : r.origin === 'crossbreed'
            ? `It crosses ${parents[0] ?? 'one parent'} with ${parents[1] ?? 'another'}, born in cycle ${r.born_cycle}.`
            : `It was written fresh by the Generator in cycle ${r.born_cycle} to differ from every live strategy.`;
  const lines = [`${r.id} is ${r.status}. ${r.describe}`.trim(), originText];
  if (born?.diagnosis) lines.push(`The Critic's diagnosis that cycle: ${born.diagnosis}`);
  if (r.train_score !== null || r.holdout_score !== null) lines.push(`On its trial it scored ${fmt(r.train_score)} on training episodes and ${fmt(r.holdout_score)} on unseen holdout episodes.`);
  if (r.ci !== null) lines.push(`Capability Index ${fmt(r.ci, 2, true)} against the seed generation.`);
  if (r.forward_trades > 0) lines.push(`Since promotion it has closed ${r.forward_trades} trades with a mean score of ${fmt(r.forward_score)}.`);
  if (r.reject_reason) lines.push(`It left the population: ${r.reject_reason}.`);
  return {
    id: r.id as string,
    lane,
    origin: r.origin as string,
    bornCycle: r.born_cycle as number,
    diedCycle: num(r.died_cycle),
    status: r.status as string,
    parents,
    children,
    describe: r.describe as string,
    code: r.code as string,
    params: parseJson<Record<string, number>>(r.params, {}),
    bounds: parseJson<Record<string, unknown>>(r.bounds, {}),
    rejectReason: (r.reject_reason as string | null) ?? null,
    trainScore: num(r.train_score),
    holdoutScore: num(r.holdout_score),
    ci: num(r.ci),
    trades: r.trades as number,
    forwardScore: num(r.forward_score),
    forwardTrades: r.forward_trades as number,
    model: (r.model as string | null) ?? null,
    createdAt: r.created_at as number,
    explanation: lines.join(' '),
    ciHistory,
    equity,
    openPositions: openPositions(db, lane, id, now),
  };
}

function fmt(v: unknown, digits = 4, signed = false): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  return (signed && v >= 0 ? '+' : '') + v.toFixed(digits);
}

export function strategyTrades(db: Db, lane: LaneId, id: string) {
  const rows = db.prepare('SELECT * FROM trades WHERE lane_id = ? AND strategy_id = ? ORDER BY closed_at DESC, id DESC').all(lane, id) as any[];
  return rows.map((t) => ({
    id: t.id as string,
    asset: t.asset as string,
    side: t.side as string,
    size: t.size as number,
    openedAt: t.opened_at as number,
    closedAt: t.closed_at as number,
    entry: t.entry as number,
    exit: t.exit as number,
    pnl: t.pnl as number,
    fees: t.fees as number,
    funding: t.funding as number,
    drawdown: t.drawdown as number,
    score: t.score as number,
  }));
}

export const RANGES: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export function equity(db: Db, lane: LaneId, range: string, now: number) {
  const r = RANGES[range] ? range : range === 'all' ? 'all' : '24h';
  const since = r === 'all' ? 0 : now - RANGES[r]!;
  const rows = db.prepare('SELECT ts, ensemble_equity, benchmark_equity FROM equity WHERE lane_id = ? AND ts >= ? ORDER BY ts').all(lane, since) as any[];
  return { range: r, points: rows.map((x) => ({ ts: x.ts as number, ensemble: x.ensemble_equity as number, benchmark: x.benchmark_equity as number })) };
}

export function moments(db: Db, lane: LaneId | null, cursor: number | null, limit = 50) {
  const lim = Math.min(Math.max(1, limit), 200);
  const where = [lane ? 'lane_id = ?' : null, cursor !== null ? 'id < ?' : null].filter(Boolean).join(' AND ');
  const args: unknown[] = [];
  if (lane) args.push(lane);
  if (cursor !== null) args.push(cursor);
  const rows = db.prepare(`SELECT * FROM moments${where ? ` WHERE ${where}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, lim + 1) as any[];
  const page = rows.slice(0, lim);
  return {
    items: page.map((m) => ({ id: m.id as number, lane: m.lane_id as LaneId, ts: m.ts as number, kind: m.kind as string, title: m.title as string, body: m.body as string, strategyId: (m.strategy_id as string | null) ?? null })),
    nextCursor: rows.length > lim ? (page[page.length - 1]!.id as number) : null,
  };
}

export function control(db: Db, lane: LaneId | null) {
  const rows = (lane
    ? db.prepare('SELECT * FROM control WHERE lane_id = ? ORDER BY id DESC LIMIT 200').all(lane)
    : db.prepare('SELECT * FROM control ORDER BY id DESC LIMIT 200').all()) as any[];
  return rows.map((c) => ({ id: c.id as number, lane: c.lane_id as LaneId, ts: c.ts as number, action: c.action as string, actor: c.actor as string, note: (c.note as string | null) ?? null }));
}

export function ledger(db: Db, lane: LaneId | null, ledgerDir: string) {
  const out: Record<string, unknown> = {};
  for (const l of lanes(db)) {
    if (lane && l.id !== lane) continue;
    const latest = db.prepare('SELECT ts, sha256, prev_sha256, file FROM snapshots WHERE lane_id = ? ORDER BY id DESC LIMIT 1').get(l.id) as any;
    const count = (db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE lane_id = ?').get(l.id) as any).n as number;
    out[l.id] = {
      latest: latest ? { ts: latest.ts, sha256: latest.sha256, prevSha256: latest.prev_sha256 ?? null, file: latest.file } : null,
      count,
      chainOk: chainOk(db, l.id, ledgerDir),
    };
  }
  return { repo: LEDGER_REPO, lanes: out };
}

function chainOk(db: Db, lane: LaneId, ledgerDir: string): boolean {
  const dir = path.join(ledgerDir, lane);
  const chain = path.join(dir, 'chain.jsonl');
  if (fs.existsSync(chain)) {
    if (readChain(chain).length === 0) return true;
    return verifyChain(chain, dir).ok;
  }
  // no files on disk (fixture or fresh install): check the prev links in the snapshots table
  const rows = db.prepare('SELECT sha256, prev_sha256 FROM snapshots WHERE lane_id = ? ORDER BY id').all(lane) as any[];
  let prev: string | null = null;
  for (const r of rows) {
    if ((r.prev_sha256 ?? null) !== prev) return false;
    prev = r.sha256;
  }
  return true;
}

export type EventRowOut = { id: number; lane: LaneId; ts: number; type: string; payload: unknown };

export function eventsAfter(db: Db, lane: LaneId | null, afterId: number, limit = 500): EventRowOut[] {
  const rows = (lane
    ? db.prepare('SELECT * FROM events WHERE lane_id = ? AND id > ? ORDER BY id LIMIT ?').all(lane, afterId, limit)
    : db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit)) as any[];
  return rows.map((r) => ({ id: r.id as number, lane: r.lane_id as LaneId, ts: r.ts as number, type: r.type as string, payload: parseJson<unknown>(r.payload, null) }));
}

export function maxEventId(db: Db): number {
  return Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get() as any).n);
}
