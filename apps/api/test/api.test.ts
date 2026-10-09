import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixtureDb, FIXTURE_NOW } from '@arena/core/fixture';
import { insertControl, type Db } from '@arena/core';
import { createApp, type ArenaApp } from '../src/app.js';

let db: Db;
let app: ArenaApp;
let dir: string;
const NOW = FIXTURE_NOW;

const get = (p: string, init?: RequestInit) => app.fetch(new Request(`http://arena.test/arena/api${p}`, init));
const json = async (p: string) => {
  const res = await get(p);
  expect(res.status, p).toBe(200);
  return res.json() as Promise<any>;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-api-'));
  ({ db } = createFixtureDb(':memory:', { now: NOW, ledgerDir: path.join(dir, 'ledger') }));
  app = createApp({ db, ledgerDir: path.join(dir, 'ledger'), ogCache: path.join(dir, 'og'), dataDir: dir, now: () => NOW, stream: { pollMs: 20, heartbeatMs: 60, replayLimit: 500, maxConnections: 2 } });
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('headers and errors', () => {
  it('caches for 5 seconds except health and stream, sets nosniff and no CORS header', async () => {
    const lanes = await get('/lanes');
    expect(lanes.headers.get('cache-control')).toBe('public, max-age=5');
    expect(lanes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(lanes.headers.get('access-control-allow-origin')).toBeNull();
    const health = await get('/health');
    expect(health.headers.get('cache-control')).toBe('no-store');
  });
  it('answers 404 with a JSON error for unknown lanes, strategies and cycles', async () => {
    for (const p of ['/lanes/nope/summary', '/lanes/core/strategies/s-9999', '/lanes/core/cycles/999', '/moments?lane=nope', '/nothing']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toHaveProperty('error');
    }
  });
});

describe('routes', () => {
  it('health', async () => {
    const h = await json('/health');
    expect(h.ok).toBe(true);
    expect(h.ts).toBe(NOW);
    expect(h.sdkVersion).toBe('0.2.0');
    expect(typeof h.disk.percent === 'number' || h.disk.percent === null).toBe(true);
    expect(Object.keys(h.lanes).sort()).toEqual(['alts', 'core', 'flow']);
    expect(h.lanes.core).toMatchObject({ state: 'running', wsConnected: true });
    expect(h.lanes.alts.state).toBe('paused');
    expect(typeof h.lanes.core.lastBarTs).toBe('number');
    // a lane whose runner stopped heartbeating reads as stopped
    const stale = createApp({ db, ledgerDir: dir, ogCache: dir, dataDir: dir, now: () => NOW + 10 * 60_000 });
    const h2 = await (await stale.fetch(new Request('http://x/arena/api/health'))).json();
    expect(h2.lanes.core).toMatchObject({ state: 'stopped', wsConnected: false, pid: null });
  });
  it('lanes', async () => {
    const lanes = await json('/lanes');
    expect(lanes.map((l: any) => l.id)).toEqual(['core', 'alts', 'flow']);
    expect(lanes[0]).toMatchObject({ name: 'Core', assets: ['BTC', 'ETH'], tf: '15m', packs: ['ta', 'volume', 'time'], model: 'claude-sonnet-5-5', sdkVersion: '0.2.0', status: 'running' });
    expect(typeof lanes[0].createdAt).toBe('number');
  });
  it('summary', async () => {
    const s = await json('/lanes/core/summary');
    expect(s).toMatchObject({ lane: 'core', status: 'running', cycles: 12, live: 8, model: 'claude-sonnet-5-5', sdkVersion: '0.2.0', budgetUsd: 1 });
    expect(s.born).toBeGreaterThan(40);
    expect(s.uptimeMs).toBeGreaterThan(0);
    expect(typeof s.popCI).toBe('number');
    expect(typeof s.bestCI).toBe('number');
    expect(typeof s.velocity).toBe('number');
    expect(typeof s.ceiling).toBe('boolean');
    expect(s.spendTodayUsd).toBeGreaterThan(0);
    expect(s.tokensToday.in).toBeGreaterThan(0);
  });
  it('population', async () => {
    const p = await json('/lanes/core/population');
    expect(p).toHaveLength(8);
    for (const s of p) {
      expect(s).toMatchObject({ status: 'live' });
      for (const k of ['id', 'origin', 'bornCycle', 'ci', 'holdoutScore', 'forwardScore', 'trades', 'forwardTrades', 'cyclesSurvived', 'describe']) expect(s).toHaveProperty(k);
    }
    expect(p[0].ci).toBeGreaterThanOrEqual(p[1].ci);
  });
  it('cycles list pages with before', async () => {
    const page1 = await json('/lanes/core/cycles?limit=5');
    expect(page1.items).toHaveLength(5);
    expect(page1.items[0].n).toBe(12);
    expect(page1.nextBefore).toBe(8);
    const page2 = await json(`/lanes/core/cycles?limit=5&before=${page1.nextBefore}`);
    expect(page2.items[0].n).toBe(7);
    const page3 = await json(`/lanes/core/cycles?limit=5&before=${page2.nextBefore}`);
    expect(page3.items.map((c: any) => c.n)).toEqual([2, 1]);
    expect(page3.nextBefore).toBeNull();
    const c = page1.items[0];
    for (const k of ['n', 'startedAt', 'endedAt', 'outcome', 'diagnosis', 'patterns', 'popCI', 'bestCI', 'velocity', 'ceiling', 'tokensIn', 'tokensOut', 'costUsd', 'promoted', 'retired', 'candidates']) expect(c).toHaveProperty(k);
    expect(Array.isArray(c.patterns)).toBe(true);
    expect(c.candidates).toBeGreaterThan(0);
  });
  it('cycle detail has steps and candidates', async () => {
    const c = await json('/lanes/core/cycles/5');
    expect(c.n).toBe(5);
    expect(c.steps.map((s: any) => s.step)).toContain('diagnose');
    expect(c.candidates.length).toBeGreaterThan(0);
    expect(c.candidates.every((x: any) => x.stage === 'holdout' && x.reason === 'holdout')).toBe(true);
    for (const k of ['id', 'origin', 'parents', 'describe', 'stage', 'reason', 'trainScore', 'holdoutScore']) expect(c.candidates[0]).toHaveProperty(k);
  });
  it('tree', async () => {
    const t = await json('/lanes/core/tree');
    expect(t.nodes.length).toBeGreaterThan(40);
    expect(t.nodes[0]).toMatchObject({ born: 0, origin: 'seed', parents: [] });
    expect(typeof t.bestId).toBe('string');
    expect(t.bestLineage[t.bestLineage.length - 1]).toBe(t.bestId);
    const root = t.nodes.find((n: any) => n.id === t.bestLineage[0]);
    expect(root.parents).toEqual([]);
  });
  it('graveyard pages with a cursor', async () => {
    const g1 = await json('/lanes/core/graveyard?limit=10');
    expect(g1.items).toHaveLength(10);
    expect(typeof g1.nextCursor).toBe('number');
    const g2 = await json(`/lanes/core/graveyard?limit=10&cursor=${g1.nextCursor}`);
    expect(g2.items[0].id).not.toBe(g1.items[0].id);
    for (const k of ['id', 'origin', 'born', 'died', 'lifespan', 'describe', 'reason', 'holdoutScore', 'ci']) expect(g1.items[0]).toHaveProperty(k);
    expect(g1.items.every((x: any) => typeof x.reason === 'string')).toBe(true);
  });
  it('strategy detail with children, explanation, ci history and the 15 minute open position delay', async () => {
    const pop = await json('/lanes/core/population');
    const s = await json(`/lanes/core/strategies/${pop[0].id}`);
    for (const k of ['id', 'lane', 'origin', 'bornCycle', 'diedCycle', 'status', 'parents', 'children', 'describe', 'code', 'params', 'bounds', 'rejectReason', 'trainScore', 'holdoutScore', 'ci', 'trades', 'forwardScore', 'forwardTrades', 'model', 'createdAt', 'explanation', 'ciHistory', 'equity', 'openPositions']) expect(s).toHaveProperty(k);
    expect(s.code).toContain('export function decide');
    expect(s.explanation).toContain(s.id);
    expect(s.ciHistory.length).toBeGreaterThan(0);
    expect(s.equity.length).toBe(s.trades);
    // the fixture opens one BTC position 20 minutes before now (visible) and one ETH position 5 minutes before (hidden)
    expect(s.openPositions.every((p: any) => p.openedAt <= NOW - 15 * 60_000)).toBe(true);
    const opened = (ts: number) => JSON.parse((db.prepare("SELECT payload FROM events WHERE lane_id = 'core' AND type = 'trade:open' AND ts = ?").get(ts) as any).payload);
    const older = opened(NOW - 20 * 60_000);
    const newer = opened(NOW - 5 * 60_000);
    const sOld = await json(`/lanes/core/strategies/${older.strategyId}`);
    expect(sOld.openPositions.find((p: any) => p.asset === older.asset)).toMatchObject({ asset: 'BTC', side: 'long', openedAt: NOW - 20 * 60_000 });
    const sNew = await json(`/lanes/core/strategies/${newer.strategyId}`);
    expect(sNew.openPositions.find((p: any) => p.asset === newer.asset && p.openedAt === newer.ts)).toBeUndefined();
    const later = createApp({ db, ledgerDir: dir, ogCache: dir, dataDir: dir, now: () => NOW + 11 * 60_000 });
    const s3 = await (await later.fetch(new Request(`http://x/arena/api/lanes/core/strategies/${newer.strategyId}`))).json();
    expect(s3.openPositions.find((p: any) => p.asset === newer.asset && p.openedAt === newer.ts)).toMatchObject({ side: 'short' });
    const child = await json(`/lanes/core/strategies/${s.children[0] ?? pop[1].id}`);
    expect(child.id).toBeTruthy();
  });
  it('strategy trades', async () => {
    const pop = (await json('/lanes/core/population')).filter((s: any) => s.trades > 0);
    const t = await json(`/lanes/core/strategies/${pop[0].id}/trades`);
    expect(t.length).toBe(pop[0].trades);
    for (const k of ['id', 'asset', 'side', 'size', 'openedAt', 'closedAt', 'entry', 'exit', 'pnl', 'fees', 'funding', 'drawdown', 'score']) expect(t[0]).toHaveProperty(k);
    expect(t[0].closedAt).toBeGreaterThanOrEqual(t[t.length - 1].closedAt);
  });
  it('equity ranges', async () => {
    const d = await json('/lanes/core/equity?range=24h');
    expect(d.range).toBe('24h');
    expect(d.points.length).toBeGreaterThan(50);
    expect(d.points[0]).toHaveProperty('ensemble');
    expect(d.points[0]).toHaveProperty('benchmark');
    const all = await json('/lanes/core/equity?range=all');
    expect(all.points.length).toBeGreaterThan(d.points.length);
    expect(all.points[0].benchmark).toBeCloseTo(100, 5);
    const bad = await json('/lanes/core/equity?range=weird');
    expect(bad.range).toBe('24h');
  });
  it('moments with and without a lane, cursor paging', async () => {
    const all = await json('/moments?limit=5');
    expect(all.items).toHaveLength(5);
    expect(new Set(all.items.map((m: any) => m.lane)).size).toBeGreaterThanOrEqual(1);
    const next = await json(`/moments?limit=5&cursor=${all.nextCursor}`);
    expect(next.items[0].id).toBeLessThan(all.items[4].id);
    const core = await json('/moments?lane=core');
    expect(core.items.every((m: any) => m.lane === 'core')).toBe(true);
    for (const k of ['id', 'lane', 'ts', 'kind', 'title', 'body', 'strategyId']) expect(core.items[0]).toHaveProperty(k);
  });
  it('control log', async () => {
    const c = await json('/control?lane=core');
    expect(c.map((x: any) => x.action)).toEqual(['approval_off', 'resume', 'approval_on', 'pause']);
    expect(c[0]).toMatchObject({ lane: 'core', actor: 'ouro' });
    const all = await json('/control');
    expect(all.length).toBeGreaterThan(c.length);
  });
  it('ledger', async () => {
    const l = await json('/ledger');
    expect(l.repo).toContain('arena-ledger');
    expect(l.lanes.core.count).toBe(24);
    expect(l.lanes.core.latest).toMatchObject({ file: expect.stringMatching(/\.json$/) });
    expect(l.lanes.core.chainOk).toBe(true);
    const one = await json('/ledger?lane=alts');
    expect(Object.keys(one.lanes)).toEqual(['alts']);
    // tamper with a snapshot file on disk and the chain reads as broken
    const file = path.join(dir, 'ledger', 'core', l.lanes.core.latest.file);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, original + ' ');
    expect((await json('/ledger?lane=core')).lanes.core.chainOk).toBe(false);
    fs.writeFileSync(file, original);
    expect((await json('/ledger?lane=core')).lanes.core.chainOk).toBe(true);
  });
  it('renders and caches a share card', async () => {
    const pop = await json('/lanes/core/population');
    const res = await get(`/og/core/${pop[0].id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    expect(buf.length).toBeGreaterThan(10_000);
    expect(fs.existsSync(path.join(dir, 'og', `core-${pop[0].id}.png`))).toBe(true);
    expect((await get('/og/core/s-9999.png')).status).toBe(404);
    expect((await get('/og/core/s-0001.txt')).status).toBe(404);
  }, 30_000);
});

async function readEvents(res: Response, count: number, timeoutMs = 3000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      frames.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  await reader.cancel();
  return frames;
}

describe('stream', () => {
  it('replays after Last-Event-ID, tags ids and types, and heartbeats', async () => {
    const ac = new AbortController();
    const res = await get('/stream?lane=core', { headers: { 'Last-Event-ID': '0' }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const frames = await readEvents(res, 6);
    ac.abort();
    expect(frames[0]).toContain('event: ready');
    const first = frames[1]!;
    expect(first).toMatch(/^id: \d+/m);
    expect(first).toMatch(/^event: (llm|candidate|cycle:start)/m);
    const data = JSON.parse(first.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    expect(data).toMatchObject({ lane: 'core', type: expect.any(String) });
    expect(typeof data.payload).toBe('object');
  });
  it('starts from the newest event without Last-Event-ID and emits new rows and heartbeats', async () => {
    const ac = new AbortController();
    const res = await get('/stream?lane=core', { signal: ac.signal });
    const pending = readEvents(res, 3, 2000);
    await new Promise((r) => setTimeout(r, 30));
    const row = insertControl(db, 'core', 'pause', 'test', 'stream test', NOW);
    db.prepare('INSERT INTO events (lane_id, ts, type, payload) VALUES (?, ?, ?, ?)').run('core', NOW, 'control', JSON.stringify(row));
    const frames = await pending;
    ac.abort();
    expect(frames[0]).toContain('event: ready');
    expect(frames.some((f) => f.includes('event: control') && f.includes('stream test'))).toBe(true);
    expect(frames.some((f) => f.startsWith(': heartbeat'))).toBe(true);
  });
  it('answers 503 above the connection cap', async () => {
    const a1 = new AbortController();
    const a2 = new AbortController();
    const r1 = await get('/stream', { signal: a1.signal });
    const r2 = await get('/stream', { signal: a2.signal });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const r3 = await get('/stream');
    expect(r3.status).toBe(503);
    expect(r3.headers.get('retry-after')).toBe('10');
    expect(await r3.json()).toHaveProperty('error');
    await r1.body!.cancel();
    await r2.body!.cancel();
    a1.abort();
    a2.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(app.connections()).toBe(0);
  });
});
