/**
 * Deterministic fixture: three lanes with about twelve cycles each, built by feeding scripted SDK events through
 * the real indexer and moments engine, so tests and the page see the same rows a live runner would produce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from './db.js';
import { createIndexer } from './indexer.js';
import { createMoments } from './moments.js';
import { insertControl, upsertLaneState } from './control.js';
import { recordPopulationCI, upsertLane } from './lanes.js';
import { appendChain, canonicalJson, sha256Hex, snapshotFileName } from './ledger.js';
import type { Bounds, CandidateStage, LaneId, Origin, Pricing } from './types.js';
import type { LaneMeta } from './rebuild.js';
import { LANE_IDS } from './types.js';

export type FixtureOptions = {
  /** Wall clock the fixture ends at. Default: a fixed instant so output is reproducible. */
  now?: number;
  cycles?: number;
  seed?: number;
  /** Directory for ledger snapshot files; omitted = no files, only the snapshots rows. */
  ledgerDir?: string;
};

export const FIXTURE_NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
export const FIXTURE_PRICING: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

export const LANE_META: Record<LaneId, LaneMeta> = {
  core: { name: 'Core', goal: 'Maximise realised PnL after fees on BTC, ETH 15m perps, max drawdown 8%', assets: ['BTC', 'ETH'], tf: '15m', packs: ['ta', 'volume', 'time'], model: 'claude-sonnet-5-5', sdkVersion: '0.2.0' },
  alts: { name: 'Alts', goal: 'Maximise realised PnL after fees on SOL, HYPE 1h perps, max drawdown 8%', assets: ['SOL', 'HYPE'], tf: '1h', packs: ['ta', 'volume', 'time'], model: 'claude-sonnet-5-5', sdkVersion: '0.2.0' },
  flow: { name: 'Flow', goal: 'Maximise realised PnL after fees on BTC, ETH 15m perps, max drawdown 8%', assets: ['BTC', 'ETH'], tf: '15m', packs: ['ta', 'volume', 'time', 'flow'], model: 'claude-sonnet-5-5', sdkVersion: '0.2.0' },
};

const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000 };
const START_PRICE: Record<string, number> = { BTC: 62_000, ETH: 2_400, SOL: 150, HYPE: 28 };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FEATURES = ['ta.hull21.crossUp', 'ta.rsi14', 'ta.atr14', 'ta.adx14', 'volume.volRatio', 'time.hour', 'ta.ema50', 'ta.bbWidth20'];
const DESCRIBES = [
  'Hull 21 cross up with an ATR stop, skipping the quiet hours.',
  'RSI 14 mean reversion when volume is above its 20 bar average.',
  'ADX trend filter with EMA 50 pullback entries and a two ATR stop.',
  'Short when RSI is over 70 and the hour is in the US session.',
  'Bollinger squeeze breakout with a fixed take profit.',
  'Long on a Hull cross up only when ADX shows a trend.',
  'Fade the open: short the first hour after a large up bar.',
  'Volume ratio spike with a tight stop and a trailing target.',
];

function code(describe: string, params: Record<string, number>, feature: string): string {
  const keys = Object.keys(params);
  return `export const params = ${JSON.stringify(params)};
export const bounds = { ${keys.map((k) => `${k}: { min: 0, max: ${Math.max(1, params[k]! * 4)}, step: ${params[k]! >= 10 ? 1 : 0.01} }`).join(', ')} };
export function decide(x: Input, p: typeof params): Decision {
  const v = x.features['${feature}'];
  const atr = x.features['ta.atr14'];
  if (typeof atr !== 'number' || v === null) return null;
  if (v === true || (typeof v === 'number' && v > p.${keys[0]})) return { side: 'long', size: p.size, stop: p.atrStop * atr };
  return null;
}
export const describe = ${JSON.stringify(describe)};
`;
}

function bounds(params: Record<string, number>): Bounds {
  const out: Bounds = {};
  for (const [k, v] of Object.entries(params)) out[k] = { min: 0, max: Math.max(1, v * 4), step: v >= 10 ? 1 : 0.01 };
  return out;
}

export type FixtureSummary = { lanes: LaneId[]; cycles: Record<LaneId, number>; strategies: Record<LaneId, number>; trades: Record<LaneId, number> };

/** Build the fixture into `file` (a path or ':memory:') and return the open handle plus a summary. */
export function createFixtureDb(file: string, opts: FixtureOptions = {}): { db: Db; summary: FixtureSummary } {
  if (file !== ':memory:' && fs.existsSync(file)) fs.rmSync(file);
  const db = openDb(file);
  const summary = fillFixture(db, opts);
  return { db, summary };
}

export function fillFixture(db: Db, opts: FixtureOptions = {}): FixtureSummary {
  const now = opts.now ?? FIXTURE_NOW;
  const cyclesWanted = opts.cycles ?? 12;
  const rand = rng(opts.seed ?? 42);
  const summary: FixtureSummary = { lanes: [...LANE_IDS], cycles: { core: 0, alts: 0, flow: 0 }, strategies: { core: 0, alts: 0, flow: 0 }, trades: { core: 0, alts: 0, flow: 0 } };

  for (const lane of LANE_IDS) {
    const meta = LANE_META[lane];
    const tfMs = TF_MS[meta.tf]!;
    const cycleMs = 6 * 3_600_000;
    const start = now - cyclesWanted * cycleMs - 2 * 3_600_000;
    upsertLane(db, lane, meta, 'running', start);
    const ix = createIndexer(db, lane, { population: 8, pricing: FIXTURE_PRICING, firstAsset: meta.assets[0], model: meta.model });
    const mo = createMoments(db, lane);
    const emit = <K extends Parameters<typeof ix.handle>[0]>(type: K, payload: Parameters<typeof ix.handle>[1], ts: number) => {
      ix.handle(type, payload as any, ts);
      mo.check(type, payload as any, ts);
    };

    let nextId = 1;
    const newId = () => `s-${String(nextId++).padStart(4, '0')}`;
    const live: Array<{ id: string; born: number; holdout: number; describe: string }> = [];
    const describeOf = (i: number) => DESCRIBES[i % DESCRIBES.length]!;
    const makeParams = () => ({ threshold: Math.round(rand() * 60) / 100 + 0.2, atrStop: Math.round(rand() * 30) / 10 + 0.5, size: Math.round(rand() * 8) / 100 + 0.01 });
    const candidate = (cycle: number, origin: Origin, parents: string[], stage: CandidateStage, reason: string | null, ts: number, train: number | null, holdout: number | null) => {
      const id = newId();
      const describe = describeOf(nextId + cycle);
      const params = makeParams();
      emit('candidate', { cycle, id, origin, parents, describe, code: code(describe, params, FEATURES[nextId % FEATURES.length]!), params, bounds: bounds(params), stage, reason, trainScore: train, holdoutScore: holdout }, ts);
      return { id, describe };
    };

    // seeds: cycle 0
    const seedTs = start + 60_000;
    emit('llm', { cycle: 0, purpose: 'seed', model: meta.model, inputTokens: 5200, outputTokens: 6100, ms: 14000 }, seedTs);
    for (let i = 0; i < 8; i++) {
      const c = candidate(0, 'seed', [], 'promoted', null, seedTs + i * 1000, null, null);
      live.push({ id: c.id, born: 0, holdout: 0, describe: c.describe });
    }

    // bars and trades up to the end, cycles every 6 hours
    const prices: Record<string, number> = {};
    for (const a of meta.assets) prices[a] = START_PRICE[a] ?? 100;
    let nextCycleAt = start + cycleMs;
    let cycle = 0;
    let popCI = 0;
    let bestCI = 0;
    let ceiling = false;
    const openUntil = new Map<string, number>();
    for (let ts = start + tfMs; ts <= now; ts += tfMs) {
      for (const asset of meta.assets) {
        const p0 = prices[asset]!;
        const drift = (rand() - 0.5) * 0.006;
        const c = p0 * (1 + drift);
        prices[asset] = c;
        const bar = { ts, asset, tf: meta.tf, o: p0, h: Math.max(p0, c) * (1 + rand() * 0.002), l: Math.min(p0, c) * (1 - rand() * 0.002), c, v: 1000 + rand() * 500 };
        emit('bar', { asset, tf: meta.tf, bar }, ts);
        for (const s of live) {
          const key = `${s.id}:${asset}`;
          const closeAt = openUntil.get(key);
          if (closeAt !== undefined && ts >= closeAt) {
            openUntil.delete(key);
            const entry = p0 * (1 - 0.01 * rand());
            const dir = rand() < 0.55 ? 1 : -1;
            const move = (bar.c / entry - 1) * dir;
            const size = 0.05;
            const pnl = size * move * 100 + (rand() - 0.45) * 0.1;
            const fees = size * 0.0007 * 100;
            const drawdown = Math.abs(Math.min(0, pnl)) * 0.6;
            const funding = lane === 'flow' ? -0.002 * rand() : 0;
            const score = pnl - fees - 0.5 * drawdown;
            emit('trade:close', { strategyId: s.id, asset, outcome: { pnl, fees, drawdown, holdBars: 3, closedTs: ts, funding, raw: { asset, side: dir > 0 ? 'long' : 'short', entry, exit: bar.c, size, reason: rand() < 0.3 ? 'stop' : 'flat', openedTs: ts - 3 * tfMs } }, score, ts }, ts);
            summary.trades[lane]++;
          } else if (closeAt === undefined && rand() < 0.08) {
            emit('trade:open', { strategyId: s.id, asset, side: rand() < 0.6 ? 'long' : 'short', size: 0.05, price: bar.c, ts }, ts);
            openUntil.set(key, ts + 3 * tfMs);
          }
        }
      }
      if (ts >= nextCycleAt && cycle < cyclesWanted) {
        cycle++;
        nextCycleAt += cycleMs;
        const t0 = ts + 1000;
        emit('cycle:start', { cycle }, t0);
        emit('cycle:step', { cycle, step: 'collect', detail: `${160 + Math.floor(rand() * 60)} episodes across ${live.length} strategies` }, t0 + 100);
        emit('cycle:step', { cycle, step: 'rank', detail: 'ranked on the pooled holdout slice' }, t0 + 200);
        emit('cycle:step', { cycle, step: 'diagnose', detail: 'critic reads the worst and best episodes' }, t0 + 300);
        emit('llm', { cycle, purpose: 'critic', model: meta.model, inputTokens: 3800, outputTokens: 400, ms: 6000 }, t0 + 2000);
        emit('critique', { cycle, patterns: ['Losses cluster in the first hour of the US session.', 'Wins need the volume ratio above 1.2.', 'Stops under one ATR get hit by noise.'], summary: `Weak strategies trade the open without a volume filter and use stops that are too tight; strong ones wait for volume above 1.2 and give the trade two ATR of room. Cycle ${cycle}.` }, t0 + 2100);
        emit('cycle:step', { cycle, step: 'generate', detail: 'two mutations, one crossbreed, one fresh' }, t0 + 2200);
        const n = 4 + Math.floor(rand() * 3);
        const fates: Array<[CandidateStage, string | null]> = [];
        for (let i = 0; i < n; i++) {
          const r = rand();
          if (r < 0.08) fates.push(['sandbox', 'sandbox: import is not allowed']);
          else if (r < 0.18) fates.push(['guards', 'size: position size 0.15 exceeds 10% cap']);
          else if (r < 0.45) fates.push(['trial', 'train margin']);
          else if (r < 0.75) fates.push(['holdout', 'holdout']);
          else fates.push(['promoted', null]);
        }
        if (cycle === 5) for (let i = 0; i < fates.length; i++) fates[i] = ['holdout', 'holdout'];
        if (cycle === 1 && !fates.some((f) => f[0] === 'promoted')) fates[0] = ['promoted', null];
        const origins: Origin[] = ['mutate', 'mutate', 'crossbreed', 'fresh', 'mutate', 'fresh'];
        let promotedCount = 0;
        for (let i = 0; i < fates.length; i++) {
          emit('llm', { cycle, purpose: 'generator', model: meta.model, inputTokens: 2600, outputTokens: 900, ms: 9000 }, t0 + 3000 + i * 500);
          const origin = origins[i]!;
          const parents = origin === 'crossbreed' ? [live[0]!.id, live[1]!.id] : origin === 'mutate' ? [live[live.length - 1 - (i % live.length)]!.id] : [];
          const [stage, reason] = fates[i]!;
          const train = stage === 'sandbox' || stage === 'guards' ? null : 0.02 + rand() * 0.2;
          const holdout = stage === 'holdout' || stage === 'promoted' ? -0.05 + rand() * 0.25 : null;
          if (i === 0) emit('cycle:step', { cycle, step: 'trial', detail: 'candidates replayed on the train slice' }, t0 + 3100);
          const c = candidate(cycle, origin, parents, stage, reason, t0 + 3200 + i * 500, train, holdout);
          summary.strategies[lane]++;
          if (stage === 'promoted') {
            emit('cycle:step', { cycle, step: 'validate', detail: `${c.id} beat the weakest strategy on holdout` }, t0 + 3300 + i * 500);
            const victim = live.sort((a, b) => a.holdout - b.holdout)[0]!;
            emit('cycle:step', { cycle, step: 'promote', detail: `${c.id} replaces ${victim.id}` }, t0 + 3400 + i * 500);
            emit('retire', { cycle, id: victim.id, reason: promotedCount === 0 && rand() < 0.3 ? 'inactive' : 'replaced' }, t0 + 3450 + i * 500);
            emit('promote', { cycle, id: c.id, replaces: victim.id }, t0 + 3500 + i * 500);
            live.splice(live.indexOf(victim), 1, { id: c.id, born: cycle, holdout: holdout ?? 0, describe: c.describe });
            promotedCount++;
          } else {
            emit('retire', { cycle, id: c.id, reason: reason ?? 'holdout' }, t0 + 3500 + i * 500);
          }
        }
        for (const s of live) s.holdout += (rand() - 0.45) * 0.05;
        const prevPop = popCI;
        popCI = Math.max(-0.5, popCI + (cycle < 9 ? 0.05 + rand() * 0.15 : (rand() - 0.5) * 0.01));
        bestCI = Math.max(bestCI, popCI + 0.3 + rand() * 0.4);
        const velocity = popCI - prevPop;
        ceiling = cycle >= 11;
        const outcome = promotedCount ? 'promoted' : 'no_change';
        emit('cycle:end', { cycle, outcome, popCI, bestCI, velocity, ceiling, usage: { inputTokens: 3800 + n * 2600, outputTokens: 400 + n * 900, calls: 1 + n } }, t0 + 9000);
        recordPopulationCI(db, lane, cycle, live.map((s, i) => ({ id: s.id, ci: popCI + (i === 0 ? bestCI - popCI : (rand() - 0.5) * 0.3) })));
        summary.cycles[lane] = cycle;
        if (lane === 'core' && cycle === 7) {
          const c1 = insertControl(db, lane, 'pause', 'ouro', 'weekly drill', t0 + 10_000);
          emit('control', c1, c1.ts);
          const c2 = insertControl(db, lane, 'approval_on', 'ouro', null, t0 + 11_000);
          emit('control', c2, c2.ts);
          const c3 = insertControl(db, lane, 'resume', 'ouro', 'drill done', t0 + 12_000);
          emit('control', c3, c3.ts);
          const c4 = insertControl(db, lane, 'approval_off', 'ouro', null, t0 + 13_000);
          emit('control', c4, c4.ts);
        }
        if (lane === 'alts' && cycle === 9) {
          const c = insertControl(db, lane, 'budget_pause', 'budget', 'spent 1.00 of 1.00 USD', t0 + 10_000);
          emit('budget', { lane, action: 'pause', usd: 1.0, budgetUsd: 1 }, c.ts);
          emit('control', c, c.ts);
          const r = insertControl(db, lane, 'budget_resume', 'budget', 'new UTC day', t0 + 14_400_000);
          emit('control', r, r.ts);
        }
      }
    }
    // two positions still open at the end: one older than 15 minutes (visible), one younger (hidden)
    emit('trade:open', { strategyId: live[0]!.id, asset: meta.assets[0]!, side: 'long', size: 0.05, price: prices[meta.assets[0]!]!, ts: now - 20 * 60_000 }, now - 20 * 60_000);
    emit('trade:open', { strategyId: live[1]!.id, asset: meta.assets[1]!, side: 'short', size: 0.03, price: prices[meta.assets[1]!]!, ts: now - 5 * 60_000 }, now - 5 * 60_000);

    // ledger snapshots, hourly for the last day
    let prev: string | null = null;
    for (let h = 24; h >= 1; h--) {
      const ts = now - h * 3_600_000;
      const body = canonicalJson({ schemaVersion: 1, name: 'OURO', goal: meta.goal, lane, cycle: summary.cycles[lane], ts });
      const hash = sha256Hex(body);
      const file = snapshotFileName(ts);
      if (opts.ledgerDir) {
        const dir = path.join(opts.ledgerDir, lane);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), body);
        appendChain(path.join(dir, 'chain.jsonl'), { ts, sha256: hash, file });
      }
      db.prepare('INSERT INTO snapshots (lane_id, ts, sha256, prev_sha256, file) VALUES (?, ?, ?, ?, ?)').run(lane, ts, hash, prev, file);
      prev = hash;
    }

    upsertLaneState(db, lane, {
      state: lane === 'alts' ? 'paused' : 'running',
      ws_connected: true,
      pid: 4000 + LANE_IDS.indexOf(lane),
      started_at: start,
      seen_at: now,
      sdk_version: meta.sdkVersion,
      model: meta.model,
      budget_usd: 1,
      approval_on: false,
      last_bar_ts: now - (now % tfMs),
    });
    db.prepare('UPDATE lanes SET status = ? WHERE id = ?').run(lane === 'alts' ? 'paused' : 'running', lane);
  }
  return summary;
}
