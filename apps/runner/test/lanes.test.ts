import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, readLaneState, rebuildLane, type Db, type LaneId } from '@arena/core';
import { lanes, SHARED } from '@arena/lanes';
import { openLog } from '@ourointelligence/sdk';
import { controlCall, socketPath } from '../src/control.js';
import { ledgerSnapshot, verifyLane } from '../../cli/src/ledger.js';
import { startMockHL, type MockHL } from './mock-hl.js';
import { buildRunner, childEnv, makeDirs, sleep, startLane, stopLane, type Child, type TestDirs } from './children.js';

const LANES: LaneId[] = ['core', 'alts', 'flow'];
const TARGET_CYCLES = 10;

let mock: MockHL;
let dirs: TestDirs;
const children: Child[] = [];
const count = (db: Db, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const sock = (lane: LaneId) => socketPath(dirs.runDir, lane);

beforeAll(async () => {
  buildRunner();
  mock = await startMockHL({ tickMs: 25, behindIntervals: 3000 });
  dirs = makeDirs('arena-lanes-');
  for (const lane of LANES) children.push(startLane(lane, childEnv(dirs, mock)));
}, 300_000);

afterAll(async () => {
  for (const c of children) await stopLane(c);
  await mock.close();
});

describe('three lanes in fast mode, one process each, against the mock exchange and the scripted model', () => {
  it(`runs ${TARGET_CYCLES} cycles per lane with promotions, holdout rejections, an llm_error cycle, a sandbox rejection, events, moments, spend and a valid ledger`, async () => {
    const deadline = Date.now() + 540_000;
    while (!fs.existsSync(dirs.dbPath) && Date.now() < deadline) await sleep(1000);
    const db = openDb(dirs.dbPath, { readonly: true });
    const finished = (l: LaneId) => count(db, 'SELECT COUNT(*) AS n FROM cycles WHERE lane_id = ? AND ended_at IS NOT NULL', l);
    const done = () => LANES.every((l) => finished(l) >= TARGET_CYCLES);
    while (!done() && Date.now() < deadline) {
      for (const c of children) if (c.proc.exitCode !== null) throw new Error(`${c.lane} exited early:\n${c.log.slice(-20).join('\n')}`);
      await sleep(2000);
    }
    expect(done(), LANES.map((l) => `${l}: ${finished(l)} cycles`).join(', ') + '\n' + children.map((c) => c.log.slice(-5).join('\n')).join('\n')).toBe(true);

    for (const lane of LANES) {
      const cycles = finished(lane);
      const promoted = count(db, "SELECT COUNT(*) AS n FROM cycles WHERE lane_id = ? AND outcome = 'promoted'", lane);
      const holdout = count(db, "SELECT COUNT(*) AS n FROM candidates WHERE lane_id = ? AND stage = 'holdout'", lane);
      const llmError = count(db, "SELECT COUNT(*) AS n FROM cycles WHERE lane_id = ? AND outcome = 'error'", lane);
      const sandboxed = count(db, "SELECT COUNT(*) AS n FROM candidates WHERE lane_id = ? AND stage = 'sandbox'", lane);
      const born = count(db, 'SELECT COUNT(*) AS n FROM strategies WHERE lane_id = ?', lane);
      const trades = count(db, 'SELECT COUNT(*) AS n FROM trades WHERE lane_id = ?', lane);
      const events = count(db, 'SELECT COUNT(*) AS n FROM events WHERE lane_id = ?', lane);
      const moments = count(db, 'SELECT COUNT(*) AS n FROM moments WHERE lane_id = ?', lane);
      const spend = (db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE lane_id = ?').get(lane) as { usd: number }).usd;
      const summary = `${lane}: cycles ${cycles} promoted ${promoted} holdout-rejections ${holdout} llm_error ${llmError} sandbox-rejections ${sandboxed} born ${born} trades ${trades} events ${events} moments ${moments} spend ${spend.toFixed(4)}`;
      console.log(summary);
      expect(cycles, summary).toBeGreaterThanOrEqual(TARGET_CYCLES);
      expect(promoted, summary).toBeGreaterThanOrEqual(1);
      expect(holdout, summary).toBeGreaterThanOrEqual(1);
      expect(llmError, summary).toBeGreaterThanOrEqual(1);
      expect(sandboxed, summary).toBeGreaterThanOrEqual(1);
      expect(born, summary).toBeGreaterThan(8);
      expect(trades, summary).toBeGreaterThan(0);
      expect(events, summary).toBeGreaterThan(cycles * 5);
      expect(moments, summary).toBeGreaterThanOrEqual(1);
      expect(spend, summary).toBeGreaterThan(0);
      const state = readLaneState(db, lane)!;
      expect(state.state).toBe('running');
      expect(state.ws_connected).toBe(true);
      const st = (await controlCall(sock(lane), 'status')) as { status: { live: number } };
      expect(st.status.live).toBe(8);
      if (lane === 'flow') expect(count(db, 'SELECT COUNT(*) AS n FROM trades WHERE lane_id = ? AND funding IS NOT NULL AND funding != 0', lane), 'flow lane funding').toBeGreaterThan(0);
    }

    const ledgerDir = path.join(dirs.dataDir, 'ledger');
    const deps = { ledgerDir, dbPath: dirs.dbPath, exportLane: (lane: LaneId) => controlCall(sock(lane), 'export') };
    for (const lane of LANES) {
      const a = await ledgerSnapshot(lane, deps, Date.now() - 3_600_000);
      const b = await ledgerSnapshot(lane, deps, Date.now());
      expect(a).not.toBeNull();
      expect(b!.prevSha256).toBe(a!.sha256);
      const v = verifyLane(ledgerDir, lane);
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(v.checked).toBe(2);
      const file = path.join(ledgerDir, lane, a!.file);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"cycle"', '"cycle "'));
      expect(verifyLane(ledgerDir, lane).ok).toBe(false);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"cycle "', '"cycle"'));
      expect(verifyLane(ledgerDir, lane).ok).toBe(true);
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM snapshots')).toBe(LANES.length * 2);
    db.close();
  }, 600_000);

  it('refills a gap after the socket drops and keeps the stored bars contiguous', async () => {
    const lane: LaneId = 'core';
    type S = { source: { gapsFilled: number; reconnects: number; connected: boolean } };
    const before = (await controlCall(sock(lane), 'status')) as S;
    expect(before.source.connected).toBe(true);
    mock.control('drop');
    mock.control('skip', 3);
    const deadline = Date.now() + 90_000;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(1000);
      after = (await controlCall(sock(lane), 'status')) as S;
      if (after.source.gapsFilled > before.source.gapsFilled) break;
    }
    expect(after.source.reconnects, JSON.stringify(after.source)).toBeGreaterThan(before.source.reconnects);
    expect(after.source.gapsFilled, JSON.stringify(after.source)).toBeGreaterThan(before.source.gapsFilled);
    await sleep(2000);
    const log = await openLog(path.join(dirs.dataDir, 'lanes', lane, '.ouro'));
    const bars = log.bars('BTC', '15m');
    log.close();
    expect(bars.length).toBeGreaterThan(400);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.ts - bars[i - 1]!.ts, `gap at ${i}`).toBe(900_000);
  }, 150_000);

  it('pause stops new trades, approval produces a pending cycle, reject and resume restore the lane, the budget pauses and resumes', async () => {
    const lane: LaneId = 'alts';
    const db = openDb(dirs.dbPath, { readonly: true });
    await controlCall(sock(lane), 'pause', { note: 'test' }, 'tester');
    const opens = count(db, "SELECT COUNT(*) AS n FROM events WHERE lane_id = ? AND type = 'trade:open'", lane);
    await sleep(3000);
    expect(count(db, "SELECT COUNT(*) AS n FROM events WHERE lane_id = ? AND type = 'trade:open'", lane)).toBe(opens);
    expect(readLaneState(db, lane)!.state).toBe('paused');
    await controlCall(sock(lane), 'approval', { on: true }, 'tester');
    await controlCall(sock(lane), 'resume', {}, 'tester');
    let pending: number | null = null;
    for (let i = 0; i < 20 && pending === null; i++) {
      const r = (await controlCall(sock(lane), 'cycle')) as { cycle: number; status: string };
      if (r.status === 'pending') pending = r.cycle;
      else await sleep(1500);
    }
    expect(pending).not.toBeNull();
    expect(readLaneState(db, lane)!.state).toBe('pending');
    const rj = (await controlCall(sock(lane), 'reject', { cycle: pending }, 'tester')) as { status: string };
    expect(rj.status).toBe('no_change');
    await controlCall(sock(lane), 'approval', { on: false }, 'tester');
    expect(readLaneState(db, lane)!.state).toBe('running');
    const actions = db.prepare('SELECT action, actor FROM control WHERE lane_id = ? ORDER BY id').all(lane) as Array<{ action: string; actor: string }>;
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['pause', 'approval_on', 'resume', 'reject', 'approval_off']));
    expect(actions.every((a) => a.actor === 'tester')).toBe(true);
    await controlCall(sock(lane), 'budget', { usd: 0.0001 }, 'tester');
    await controlCall(sock(lane), 'cycle').catch(() => undefined);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && readLaneState(db, lane)!.state !== 'paused') {
      await controlCall(sock(lane), 'cycle').catch(() => undefined);
      await sleep(1000);
    }
    expect(readLaneState(db, lane)!.state).toBe('paused');
    expect(count(db, "SELECT COUNT(*) AS n FROM control WHERE lane_id = ? AND action = 'budget_pause' AND actor = 'budget'", lane)).toBeGreaterThanOrEqual(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM moments WHERE lane_id = ? AND kind LIKE '%budget%'", lane)).toBeGreaterThanOrEqual(1);
    await controlCall(sock(lane), 'budget', { usd: 100 }, 'tester');
    await controlCall(sock(lane), 'resume', {}, 'tester');
    expect(readLaneState(db, lane)!.state).toBe('running');
    db.close();
  }, 180_000);

  it('arena rebuild recreates the same cycles, strategies and trades from the .ouro folders', async () => {
    for (const c of children) await stopLane(c);
    const live = openDb(dirs.dbPath, { readonly: true });
    const rebuilt = openDb(path.join(dirs.dataDir, 'rebuilt.db'));
    for (const lane of LANES) {
      const def = lanes[lane];
      const state = readLaneState(live, lane)!;
      rebuildLane(rebuilt, lane, path.join(dirs.dataDir, 'lanes', lane, '.ouro'), { name: def.name, goal: SHARED.goal(def.assets, def.tf), assets: def.assets, tf: def.tf, packs: def.packNames, model: state.model ?? 'fake-model', sdkVersion: state.sdk_version ?? '0.2.0' }, SHARED.population);
      const q = (db: Db, sql: string) => db.prepare(sql).all(lane) as Array<Record<string, unknown>>;
      const sl = q(live, 'SELECT id FROM strategies WHERE lane_id = ? ORDER BY id');
      const sr = q(rebuilt, 'SELECT id FROM strategies WHERE lane_id = ? ORDER BY id');
      expect(sr.map((s) => s['id'])).toEqual(sl.map((s) => s['id']));
      const cl = q(live, 'SELECT n FROM cycles WHERE lane_id = ? AND ended_at IS NOT NULL ORDER BY n');
      const cr = q(rebuilt, 'SELECT n FROM cycles WHERE lane_id = ? ORDER BY n');
      expect(cr.map((c) => c['n'])).toEqual(cl.map((c) => c['n']));
      const tl = count(live, 'SELECT COUNT(*) AS n FROM trades WHERE lane_id = ?', lane);
      const tr = count(rebuilt, 'SELECT COUNT(*) AS n FROM trades WHERE lane_id = ?', lane);
      expect(Math.abs(tr - tl), `${lane}: trades live ${tl} rebuilt ${tr}`).toBeLessThanOrEqual(2);
    }
    live.close();
    rebuilt.close();
  }, 180_000);
});
