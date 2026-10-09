import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createLoop, resolveLLM } from '@ourointelligence/sdk';
import type { EventMap, LLM, Loop, LoopConfig, Strategy } from '@ourointelligence/sdk';
import { paper } from '@ourointelligence/executor-paper';
import { laneSource, sourceHealth, type LaneSource } from '@arena/hl';
import {
  addSpend,
  createIndexer,
  createMoments,
  insertControl,
  openDb,
  recordPopulationCI,
  spendToday,
  upsertLane,
  upsertLaneState,
  type ControlAction,
  type Db,
  type LaneId,
  type LaneStatus,
} from '@arena/core';
import { laneById, SHARED, type LaneDefinition } from '@arena/lanes';
import { budgetLLM, msUntilUtcMidnight, type BudgetExceeded } from './budget.js';
import { scriptedFakeLLM } from './fake-llm.js';
import { socketPath, startControlServer } from './control.js';
import type { RunnerEnv } from './env.js';

const require = createRequire(import.meta.url);

/** Version of the SDK package the runner was installed with. */
export function sdkVersion(): string {
  try {
    return (require('@ourointelligence/sdk/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** SDK events the runner forwards to the indexer, in the order they are documented. */
export const FORWARDED_EVENTS = [
  'bar',
  'decision',
  'trade:open',
  'trade:close',
  'cycle:start',
  'cycle:step',
  'critique',
  'candidate',
  'promote',
  'retire',
  'cycle:end',
  'pending',
  'approved',
  'rejected',
  'rollback',
  'llm',
  'error',
] as const;

export type RunLaneOptions = {
  env: RunnerEnv;
  lane: LaneDefinition | LaneId | string;
  /** Overrides for tests. */
  llm?: LLM;
  source?: LaneSource;
  log?: (line: string) => void;
};

export type LaneRuntime = {
  lane: LaneDefinition;
  loop: Loop;
  db: Db;
  /** Resolves when the loop has stopped. */
  done: Promise<void>;
  stop: () => Promise<void>;
  budgetUsd: () => number;
};

/** Build the loop config for a lane from the shared settings, the lane definition and the runtime environment. */
export function buildLoopConfig(lane: LaneDefinition, env: RunnerEnv, deps: { source: LaneSource; llm: LLM; dir: string }): LoopConfig {
  const fast = env.fast;
  return {
    goal: SHARED.goal(lane.assets, lane.tf),
    primitives: lane.packs,
    source: deps.source,
    executor: paper({ ...SHARED.paper, funding: lane.assetCtx }),
    score: SHARED.score,
    llm: deps.llm,
    assets: lane.assets,
    tf: lane.tf,
    dir: deps.dir,
    population: SHARED.population,
    cycleEvery: fast ? 5 : SHARED.cycleEvery,
    cycleMaxWait: fast ? '6h' : SHARED.cycleMaxWait,
    minTradesPerWindow: fast ? 1 : SHARED.minTradesPerWindow,
    holdout: SHARED.holdout,
    margin: fast ? 0 : SHARED.margin,
    retireShare: SHARED.retireShare,
    guards: { ...SHARED.guards },
    backfill: fast ? 400 : SHARED.backfill,
    warmupBars: SHARED.warmupBars,
    replay: SHARED.replay,
    replayPaper: { ...SHARED.paper, funding: lane.assetCtx },
    ensemble: SHARED.ensemble,
    llmPricing: env.pricing,
    llmRetry: fast ? { retries: 2, baseMs: 50 } : { retries: 2, baseMs: 2000 },
    seedRetryMs: fast ? 500 : 60_000,
    autoCycle: true,
  };
}

function lazyLLM(choice: string): LLM {
  let inner: LLM | null = null;
  return {
    name: choice,
    complete(req) {
      inner ??= resolveLLM(choice);
      return inner.complete(req);
    },
  };
}

function laneDir(env: RunnerEnv, lane: LaneId): string {
  return path.join(env.dataDir, 'lanes', lane, '.ouro');
}

/** Start one lane: open the database, build the loop, wire every event, answer the control socket. */
export async function runLane(opts: RunLaneOptions): Promise<LaneRuntime> {
  const env = opts.env;
  const lane = typeof opts.lane === 'string' ? laneById(opts.lane) : opts.lane;
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${lane.id}: ${line}`));
  const dir = laneDir(env, lane.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
  const db = openDb(env.dbPath);
  const sdk = sdkVersion();
  const model = env.model || (env.fakeLlm ? 'fake-model' : env.llm);
  const startedAt = Date.now();

  let budgetUsd = env.budgetUsd;
  let paused = false;
  let pausedByBudget = false;
  let stopping = false;
  let resumeTimer: NodeJS.Timeout | null = null;

  const source =
    opts.source ??
    laneSource({
      assetCtx: lane.assetCtx,
      wsUrl: env.hlWsUrl,
      infoUrl: env.hlInfoUrl,
      staleAfterIntervals: env.staleAfterIntervals,
      weightPerMinute: env.weightPerMinute,
      onEvent: (e) => {
        if (e.type === 'gap' || e.type === 'reconnect' || e.type === 'stale' || e.type === 'rateLimit' || e.type === 'error') {
          log(`source ${e.type}: ${JSON.stringify(e)}`);
          indexer.handle('error', { scope: `source:${e.type}`, message: JSON.stringify(e) });
        }
      },
    });

  const indexer = createIndexer(db, lane.id, { population: SHARED.population, pricing: env.pricing, firstAsset: lane.assets[0], model });
  const moments = createMoments(db, lane.id);
  upsertLane(db, lane.id, { name: lane.name, goal: SHARED.goal(lane.assets, lane.tf), assets: lane.assets, tf: lane.tf, packs: lane.packNames, model, sdkVersion: sdk }, 'running');

  const control = (action: ControlAction, actor: string, note: string | null = null) => {
    const row = insertControl(db, lane.id, action, actor, note);
    indexer.handle('control', row);
    moments.check('control', row);
    return row;
  };

  // the provider adapter is resolved on first use, so a lane without a key starts, heartbeats and reports the
  // problem in its state instead of crashing before the control socket exists
  const baseLLM: LLM = opts.llm ?? (env.fakeLlm ? scriptedFakeLLM() : lazyLLM(env.llm));
  let loopRef: Loop | null = null;
  const llm = budgetLLM(baseLLM, {
    lane: lane.id,
    budgetUsd: () => budgetUsd,
    pricing: env.pricing,
    spentToday: () => spendToday(db, lane.id).usd,
    record: (u) => {
      addSpend(db, lane.id, { inputTokens: u.inputTokens, outputTokens: u.outputTokens }, env.pricing);
    },
    onExceeded: (err: BudgetExceeded) => {
      log(err.message);
      if (!loopRef) return;
      pausedByBudget = true;
      paused = true;
      loopRef.pause('budget');
      control('budget_pause', 'budget', `spent ${err.spentUsd.toFixed(4)} of ${err.budgetUsd.toFixed(2)} USD`);
      const payload = { lane: lane.id, action: 'pause' as const, usd: err.spentUsd, budgetUsd: err.budgetUsd };
      indexer.handle('budget', payload);
      moments.check('budget', payload);
      heartbeat();
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (!pausedByBudget || stopping) return;
        pausedByBudget = false;
        paused = false;
        loopRef?.resume();
        control('budget_resume', 'budget', 'new UTC day');
        const p2 = { lane: lane.id, action: 'resume' as const, usd: 0, budgetUsd };
        indexer.handle('budget', p2);
        moments.check('budget', p2);
        heartbeat();
      }, msUntilUtcMidnight());
      resumeTimer.unref?.();
    },
  });

  const loop = createLoop(buildLoopConfig(lane, env, { source, llm, dir }));
  loopRef = loop;

  let lastBarTs: number | null = null;
  let lastCycleTs: number | null = null;
  let pendingCycle: number | null = null;
  let lastError: string | null = null;
  const state = (): LaneStatus => (lastError ? 'error' : paused ? 'paused' : pendingCycle !== null ? 'pending' : 'running');
  const heartbeat = () => {
    if (stopping) return;
    try {
      upsertLaneState(db, lane.id, {
        state: state(),
        last_bar_ts: lastBarTs,
        last_cycle_ts: lastCycleTs,
        ws_connected: sourceHealth(source).connected,
        pid: process.pid,
        started_at: startedAt,
        seen_at: Date.now(),
        sdk_version: sdk,
        model,
        budget_usd: budgetUsd,
        approval_on: approvalOn,
      });
    } catch (err) {
      log(`heartbeat failed: ${(err as Error).message}`);
    }
  };
  let approvalOn = false;

  // every SDK event goes to the indexer and the moments engine
  for (const name of FORWARDED_EVENTS) {
    loop.on(name, (payload) => {
      const ts = Date.now();
      try {
        indexer.handle(name, payload as never, ts);
        moments.check(name, payload as never, ts);
      } catch (err) {
        log(`indexer failed on ${name}: ${(err as Error).message}`);
      }
    });
  }
  loop.on('log', (m) => log(m.message));
  if (env.killAtStep) {
    loop.on('cycle:step', (s) => {
      if (s.step === env.killAtStep) process.kill(process.pid, 'SIGKILL');
    });
  }
  loop.on('error', (e) => {
    log(`error ${e.scope}: ${e.message}`);
    if (e.scope === 'seed' || e.scope === 'run') {
      lastError = e.message;
      heartbeat();
    }
  });
  loop.on('seed', () => {
    lastError = null;
    heartbeat();
  });
  loop.on('bar', (b) => {
    if (lastBarTs === null || b.bar.ts > lastBarTs) lastBarTs = b.bar.ts;
  });
  loop.on('cycle:end', (e: EventMap['cycle:end']) => {
    lastCycleTs = Date.now();
    pendingCycle = e.outcome === 'pending' ? e.cycle : null;
    void loop.population().then((pop: Strategy[]) => recordPopulationCI(db, lane.id, e.cycle, pop.map((s) => ({ id: s.id, ci: s.ci })))).catch(() => undefined);
    heartbeat();
  });
  loop.on('pending', (p) => {
    pendingCycle = p.cycle;
    heartbeat();
  });
  loop.on('approved', () => {
    pendingCycle = null;
    heartbeat();
  });
  loop.on('rejected', () => {
    pendingCycle = null;
    heartbeat();
  });
  loop.on('pause', () => heartbeat());
  loop.on('resume', () => heartbeat());

  const timer = setInterval(heartbeat, env.heartbeatMs);
  timer.unref?.();

  // the control socket
  const sock = socketPath(env.runDir, lane.id);
  const server = await startControlServer(sock, async (cmd, args, actor) => {
    const n = (k: string) => {
      const v = Number(args[k]);
      if (!Number.isFinite(v)) throw new Error(`${cmd}: ${k} must be a number`);
      return v;
    };
    switch (cmd) {
      case 'status': {
        const st = await loop.status();
        return { lane: lane.id, state: state(), status: st, source: sourceHealth(source), spendTodayUsd: spendToday(db, lane.id).usd, budgetUsd, pid: process.pid, sdkVersion: sdk, model, pausedByBudget, lastError };
      }
      case 'health':
        return { lane: lane.id, state: state(), lastBarTs, lastCycleTs, source: sourceHealth(source), pid: process.pid };
      case 'pause':
        paused = true;
        pausedByBudget = false;
        loop.pause(typeof args['note'] === 'string' ? args['note'] : undefined);
        control('pause', actor, typeof args['note'] === 'string' ? args['note'] : null);
        heartbeat();
        return { state: state() };
      case 'resume':
        paused = false;
        pausedByBudget = false;
        loop.resume();
        control('resume', actor, null);
        heartbeat();
        return { state: state() };
      case 'approval': {
        const on = args['on'] === true || args['on'] === 'on' || args['on'] === 'true';
        approvalOn = on;
        loop.setApproval(on);
        control(on ? 'approval_on' : 'approval_off', actor, null);
        heartbeat();
        return { approval: on };
      }
      case 'approve': {
        const c = n('cycle');
        const r = await loop.approve(c);
        control('approve', actor, `cycle ${c}`);
        if (paused) loop.pause('still paused');
        heartbeat();
        return { cycle: r.cycle, status: r.status, promoted: r.promoted.map((s) => s.id) };
      }
      case 'reject': {
        const c = n('cycle');
        const r = await loop.reject(c);
        control('reject', actor, `cycle ${c}`);
        if (paused) loop.pause('still paused');
        heartbeat();
        return { cycle: r.cycle, status: r.status };
      }
      case 'rollback': {
        const c = n('cycle');
        const r = await loop.rollback(c);
        control('rollback', actor, `to cycle ${c}`);
        heartbeat();
        return r;
      }
      case 'budget': {
        const usd = n('usd');
        budgetUsd = usd;
        control('budget', actor, `${usd} USD per day`);
        heartbeat();
        return { budgetUsd };
      }
      case 'cycle': {
        const r = await loop.cycle();
        return { cycle: r.cycle, status: r.status, note: r.note ?? null };
      }
      case 'export':
        return loop.export();
      case 'population':
        return loop.population();
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  });
  log(`control socket ${sock}`);

  heartbeat();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (resumeTimer) clearTimeout(resumeTimer);
    try {
      await loop.stop();
    } catch (err) {
      log(`stop failed: ${(err as Error).message}`);
    }
    try {
      upsertLaneState(db, lane.id, { state: 'stopped', seen_at: Date.now(), ws_connected: false });
    } catch {
      // db may be gone
    }
    server.close();
    await loop.close();
    db.close();
    resolveDone();
  };

  log(`starting lane ${lane.name} (${lane.assets.join(', ')} ${lane.tf}; packs ${lane.packNames.join(', ')}; sdk ${sdk}; model ${model}; fast ${env.fast})`);
  void loop
    .start()
    .then(() => {
      if (!stopping) log('the source ended; stopping');
    })
    .catch((err) => log(`loop failed: ${(err as Error).message}`))
    .finally(() => {
      if (!stopping) void stop();
    });

  return { lane, loop, db, done, stop, budgetUsd: () => budgetUsd };
}
