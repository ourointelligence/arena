import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlCall, socketPath, readEnv } from '@arena/runner';
import { insertControl, openDb, readLaneState, rebuildLane, type LaneId } from '@arena/core';
import { lanes, SHARED, type LaneDefinition } from '@arena/lanes';
import { ledgerSnapshot, verifyLane } from './ledger.js';

const LANE_IDS = Object.keys(lanes) as LaneId[];
const env = readEnv();
const actor = process.env['ARENA_ACTOR'] || (() => {
  try {
    return os.userInfo().username;
  } catch {
    return process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }
})();

function usage(): never {
  console.error(`usage:
  arena status
  arena pause <lane|all> [note]
  arena resume <lane|all>
  arena approval <lane> on|off
  arena approve <lane> <cycle>
  arena reject <lane> <cycle>
  arena rollback <lane> <cycle>
  arena budget <lane> <usd>
  arena cycle <lane>                 force a cycle now
  arena rebuild                      recreate arena.db from the .ouro folders
  arena export <lane> [file]         the lane's versioned export (schemaVersion 1)
  arena drill <lane>                 the weekly kill switch drill
  arena ledger [lane]                hourly snapshot: export, hash, chain, snapshots row
  arena verify-ledger <lane>         recompute the lane's hash chain`);
  process.exit(2);
}

function laneArg(v: string | undefined): LaneId {
  if (!v || !LANE_IDS.includes(v as LaneId)) usage();
  return v as LaneId;
}

function lanesArg(v: string | undefined): LaneId[] {
  if (v === 'all') return LANE_IDS;
  return [laneArg(v)];
}

async function call(lane: LaneId, cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return controlCall(socketPath(env.runDir, lane), cmd, args, actor);
}

type LaneStatus = { lane: string; state: string; status: { cycle: number; live: number; episodes: number; pendingCycle: number | null; approval: boolean; lastBarTs: number | null; backfilling: boolean }; source: { connected: boolean }; spendTodayUsd: number; budgetUsd: number; pid: number; pausedByBudget: boolean };

async function status(): Promise<void> {
  for (const lane of LANE_IDS) {
    try {
      const s = (await call(lane, 'status')) as LaneStatus;
      const age = s.status.lastBarTs ? `${Math.round((Date.now() - s.status.lastBarTs) / 60_000)} min ago` : 'none';
      console.log(
        `${lane.padEnd(5)} ${s.state.padEnd(8)} cycle ${String(s.status.cycle).padEnd(4)} live ${s.status.live} episodes ${String(s.status.episodes).padEnd(6)} last bar ${age.padEnd(12)} ws ${s.source.connected ? 'up' : 'down'}  spend today ${s.spendTodayUsd.toFixed(4)} / ${s.budgetUsd.toFixed(2)} USD  approval ${s.status.approval ? 'on' : 'off'}${s.status.pendingCycle !== null ? `  PENDING cycle ${s.status.pendingCycle}` : ''}${s.status.backfilling ? '  backfilling' : ''}  pid ${s.pid}`,
      );
    } catch (err) {
      let fromDb = '';
      try {
        const db = openDb(env.dbPath, { readonly: true });
        const row = readLaneState(db, lane);
        db.close();
        if (row) fromDb = ` (last seen ${row.seen_at ? new Date(row.seen_at).toISOString() : 'never'}, state ${row.state})`;
      } catch {
        // no db yet
      }
      console.log(`${lane.padEnd(5)} not running: ${(err as Error).message}${fromDb}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The weekly kill switch drill, fully automatic, with a pass or fail report. */
async function drill(lane: LaneId): Promise<boolean> {
  const report: string[] = [];
  const step = (ok: boolean, text: string) => {
    report.push(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
    console.log(report[report.length - 1]);
    return ok;
  };
  const db = openDb(env.dbPath);
  const openCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE lane_id = ? AND type = 'trade:open'`).get(lane) as { n: number }).n;
  let ok = true;
  try {
    const before = (await call(lane, 'status')) as LaneStatus;
    insertControl(db, lane, 'drill', actor, 'drill started');
    // 1. pause and check no new trade opens for one bar
    await call(lane, 'pause', { note: 'kill switch drill' });
    const paused = (await call(lane, 'status')) as LaneStatus;
    ok = step(paused.state === 'paused', `pause: state is ${paused.state}`) && ok;
    const opensAtPause = openCount();
    const lastBar = paused.status.lastBarTs;
    const intervalMs = laneInterval(lanes[lane]);
    const deadline = Date.now() + intervalMs + 90_000;
    let sawBar = false;
    while (Date.now() < deadline) {
      await sleep(Math.min(5000, intervalMs));
      const s = (await call(lane, 'status')) as LaneStatus;
      if (s.status.lastBarTs !== null && s.status.lastBarTs !== lastBar) {
        sawBar = true;
        break;
      }
    }
    ok = step(sawBar, sawBar ? 'a bar arrived while paused' : 'no bar arrived within one interval (cannot judge the pause)') && ok;
    ok = step(openCount() === opensAtPause, `no new trade opened while paused (${openCount() - opensAtPause} opened)`) && ok;
    // 2. approval on, wait for a pending cycle (force one), reject it
    await call(lane, 'approval', { on: true });
    const a = (await call(lane, 'status')) as LaneStatus;
    ok = step(a.status.approval === true, 'approval switch is on') && ok;
    await call(lane, 'resume');
    let pending: number | null = null;
    for (let i = 0; i < 3 && pending === null; i++) {
      const r = (await call(lane, 'cycle')) as { cycle: number; status: string; note: string | null };
      if (r.status === 'pending') pending = r.cycle;
      else if (r.status === 'no_change' && r.note === 'not enough data') {
        const waitUntil = Date.now() + intervalMs + 90_000;
        while (Date.now() < waitUntil) {
          await sleep(5000);
          const s = (await call(lane, 'status')) as LaneStatus;
          if (s.status.pendingCycle !== null) {
            pending = s.status.pendingCycle;
            break;
          }
        }
      } else if (r.status === 'no_change') {
        report.push(`NOTE  cycle ${r.cycle} promoted nothing (${r.note ?? 'no candidate survived'}), trying again`);
      }
    }
    ok = step(pending !== null, pending !== null ? `cycle ${pending} stopped at pending` : 'no cycle reached pending (no promotion to approve); the switch itself was exercised') && ok;
    if (pending !== null) {
      const rj = (await call(lane, 'reject', { cycle: pending })) as { status: string };
      ok = step(rj.status === 'no_change', `rejected cycle ${pending}: ${rj.status}`) && ok;
    }
    await call(lane, 'approval', { on: false });
    await call(lane, 'resume');
    const after = (await call(lane, 'status')) as LaneStatus;
    ok = step(after.state === 'running' && after.status.approval === false, `resumed: state ${after.state}, approval ${after.status.approval ? 'on' : 'off'}`) && ok;
    ok = step(after.status.live === before.status.live, `population intact (${after.status.live} live)`) && ok;
  } catch (err) {
    ok = step(false, `drill aborted: ${(err as Error).message}`);
  }
  insertControl(db, lane, 'drill', actor, `${ok ? 'pass' : 'fail'}: ${report.join(' | ')}`);
  db.close();
  console.log(`\nDRILL ${ok ? 'PASS' : 'FAIL'} for lane ${lane} at ${new Date().toISOString()}`);
  return ok;
}

function laneInterval(def: LaneDefinition): number {
  const m = /^(\d+)(m|h|d)$/.exec(def.tf);
  const n = m ? Number(m[1]) : 15;
  const unit = m?.[2] === 'h' ? 3_600_000 : m?.[2] === 'd' ? 86_400_000 : 60_000;
  return n * unit;
}

const ledgerDir = () => process.env['ARENA_LEDGER_DIR'] ?? path.join(env.dataDir, 'ledger');
const ledgerDeps = { ledgerDir: ledgerDir(), dbPath: env.dbPath, exportLane: (lane: LaneId) => call(lane, 'export'), log: (line: string) => console.log(line) };

const [cmd, a1, a2] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'status':
      await status();
      break;
    case 'pause':
      for (const lane of lanesArg(a1)) console.log(lane, JSON.stringify(await call(lane, 'pause', { note: a2 ?? null })));
      break;
    case 'resume':
      for (const lane of lanesArg(a1)) console.log(lane, JSON.stringify(await call(lane, 'resume')));
      break;
    case 'approval': {
      if (a2 !== 'on' && a2 !== 'off') usage();
      console.log(JSON.stringify(await call(laneArg(a1), 'approval', { on: a2 === 'on' })));
      break;
    }
    case 'approve':
    case 'reject':
    case 'rollback': {
      const cycle = Number(a2);
      if (!Number.isFinite(cycle)) usage();
      console.log(JSON.stringify(await call(laneArg(a1), cmd, { cycle })));
      break;
    }
    case 'budget': {
      const usd = Number(a2);
      if (!Number.isFinite(usd) || usd < 0) usage();
      console.log(JSON.stringify(await call(laneArg(a1), 'budget', { usd })));
      break;
    }
    case 'cycle':
      console.log(JSON.stringify(await call(laneArg(a1), 'cycle')));
      break;
    case 'rebuild': {
      const db = openDb(env.dbPath);
      for (const lane of LANE_IDS) {
        const def = lanes[lane];
        const ouroDir = path.join(env.dataDir, 'lanes', lane, '.ouro');
        if (!fs.existsSync(path.join(ouroDir, 'history.json'))) {
          console.log(`${lane}: no history.json in ${ouroDir}, skipped`);
          continue;
        }
        const state = readLaneState(db, lane);
        const r = rebuildLane(db, lane, ouroDir, { name: def.name, goal: SHARED.goal(def.assets, def.tf), assets: def.assets, tf: def.tf, packs: def.packNames, model: state?.model ?? env.model, sdkVersion: state?.sdk_version ?? 'unknown' }, SHARED.population);
        console.log(`${lane}: ${JSON.stringify(r)}`);
      }
      db.close();
      break;
    }
    case 'export': {
      const out = await call(laneArg(a1), 'export');
      const text = JSON.stringify(out, null, 2);
      if (a2) {
        fs.writeFileSync(a2, text);
        console.log(`wrote ${a2}`);
      } else console.log(text);
      break;
    }
    case 'drill': {
      const ok = await drill(laneArg(a1));
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'ledger': {
      const now = Date.now();
      for (const lane of a1 ? [laneArg(a1)] : LANE_IDS) await ledgerSnapshot(lane, ledgerDeps, now);
      break;
    }
    case 'verify-ledger': {
      const r = verifyLane(ledgerDir(), laneArg(a1));
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    default:
      usage();
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
