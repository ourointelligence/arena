// A dependency-free mock of the Arena API (docs/api-contract.md) with deterministic data.
// Used by the Vite dev server (in-process) and by the Playwright tests. Start on its own with `pnpm mock`.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import zlib from 'node:zlib';

type LaneId = 'core' | 'alts' | 'flow';

const LANES: Array<{ id: LaneId; name: string; assets: string[]; tf: string; packs: string[]; tfMs: number }> = [
  { id: 'core', name: 'Core', assets: ['BTC', 'ETH'], tf: '15m', packs: ['ta', 'volume', 'time'], tfMs: 900_000 },
  { id: 'alts', name: 'Alts', assets: ['SOL', 'HYPE'], tf: '1h', packs: ['ta', 'volume', 'time'], tfMs: 3_600_000 },
  { id: 'flow', name: 'Flow', assets: ['BTC', 'ETH'], tf: '15m', packs: ['ta', 'volume', 'time', 'flow'], tfMs: 900_000 },
];

const MODEL = 'claude-sonnet-5-5';
const SDK = '0.2.0';
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const LANE_START = NOW - 14 * 86_400_000;

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

type Strategy = {
  id: string;
  lane: LaneId;
  origin: string;
  bornCycle: number;
  diedCycle: number | null;
  status: string;
  parents: string[];
  children: string[];
  describe: string;
  code: string;
  params: Record<string, number>;
  bounds: Record<string, { min: number; max: number; step: number }>;
  rejectReason: string | null;
  trainScore: number | null;
  holdoutScore: number | null;
  ci: number | null;
  trades: number;
  forwardScore: number | null;
  forwardTrades: number;
  model: string;
  createdAt: number;
  explanation: string;
  ciHistory: Array<{ cycle: number; ci: number }>;
  equity: Array<{ ts: number; equity: number }>;
  openPositions: Array<{ asset: string; side: string; size: number; openedAt: number; entry: number }>;
  rowId: number;
};

type Candidate = { id: string; origin: string; parents: string[]; describe: string; stage: string; reason: string | null; trainScore: number | null; holdoutScore: number | null };
type Cycle = {
  n: number;
  startedAt: number;
  endedAt: number | null;
  outcome: string;
  diagnosis: string;
  patterns: string[];
  popCI: number | null;
  bestCI: number | null;
  velocity: number | null;
  ceiling: boolean;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  promoted: string[];
  retired: string[];
  candidates: number;
  steps: Array<{ ts: number; step: string; detail: string }>;
  candidateRows: Candidate[];
};
type Trade = { id: number; strategyId: string; asset: string; side: string; size: number; openedAt: number; closedAt: number; entry: number; exit: number; pnl: number; fees: number; funding: number; drawdown: number; score: number };
type Moment = { id: number; lane: LaneId; ts: number; kind: string; title: string; body: string; strategyId: string | null };
type Control = { id: number; lane: LaneId; ts: number; action: string; actor: string; note: string };

type LaneData = {
  strategies: Map<string, Strategy>;
  cycles: Cycle[];
  trades: Trade[];
  equity: Array<{ ts: number; ensemble: number; benchmark: number }>;
  ledger: Array<{ ts: number; sha256: string; prevSha256: string | null; file: string }>;
  state: 'running' | 'paused' | 'pending';
};

const DESCRIBES = [
  'Long when the Hull 21 crosses up with volume above its 20 bar average, ATR stop.',
  'Short after a QQE flip during the London session, take profit at two ATR.',
  'Fade RSI extremes outside weekend hours with a tight stop.',
  'Trend follow on EMA 20 over EMA 50, exit on a Hull 9 cross down.',
  'Mean revert on Bollinger width squeeze with a time stop of eight bars.',
  'Long only when ADX is above 25 and the hour is between 8 and 16 UTC.',
  'Short the first red bar after a volume climax, half size.',
  'Follow the 4 hour trend proxy with an ATR trailing stop.',
  'Breakout above the 55 bar Hull with funding below zero.',
  'Trade only when open interest rose over the last four hours.',
];

const REASONS = ['train margin', 'holdout', 'sandbox: forbidden token "fetch"', 'drawdown: replay max drawdown 9.4 exceeds 8', 'unknown feature: "ta.rsi7" is not produced by any registered primitive pack', 'size: position size 0.15 exceeds 10% cap'];

const PATTERNS = [
  'Losses cluster in the first two hours of the UTC day when volume is thin.',
  'Winning entries have volume above 1.4 times the 20 bar average.',
  'Stops under one ATR are hit by noise before the move happens.',
  'Shorts after a volume climax work better with a two bar wait.',
  'Every loss on ETH came while funding was positive.',
];

function sha(seed: number): string {
  const r = rng(seed);
  let s = '';
  for (let i = 0; i < 64; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

function strategyCode(p: Record<string, number>): string {
  return `export const params = ${JSON.stringify(p)};
export const bounds = {
  hullLen: { min: 9, max: 55, step: 1 },
  atrStop: { min: 0.5, max: 4, step: 0.5 },
  size: { min: 0.01, max: 0.1, step: 0.01 },
};
export function decide(x: Input, p: typeof params): Decision {
  const hour = x.features['time.hour'];
  const up = x.features['ta.hull21.crossUp'];
  const atr = x.features['ta.atr14'];
  if (typeof hour !== 'number' || typeof atr !== 'number') return null;
  if (hour >= 0 && hour < 4) return null;
  if (up === true) return { side: 'long', size: p.size, stop: p.atrStop * atr };
  return null;
}
export const describe = 'Hull cross up with an ATR stop, skipping the dead hours.';
`;
}

function buildLane(lane: (typeof LANES)[number], seed: number): LaneData {
  const r = rng(seed);
  const strategies = new Map<string, Strategy>();
  const cycles: Cycle[] = [];
  const trades: Trade[] = [];
  let nextId = 1;
  let rowId = 1;
  let tradeId = 1;
  const cycleMs = 86_400_000;
  const makeStrategy = (origin: string, parents: string[], born: number, ts: number): Strategy => {
    const id = `s-${String(nextId++).padStart(4, '0')}`;
    const params = { hullLen: 9 + Math.floor(r() * 46), atrStop: 0.5 + Math.floor(r() * 7) * 0.5, size: Math.round((0.01 + r() * 0.09) * 100) / 100 };
    const s: Strategy = {
      id,
      lane: lane.id,
      origin,
      bornCycle: born,
      diedCycle: null,
      status: 'live',
      parents,
      children: [],
      describe: DESCRIBES[Math.floor(r() * DESCRIBES.length)]!,
      code: strategyCode(params),
      params,
      bounds: { hullLen: { min: 9, max: 55, step: 1 }, atrStop: { min: 0.5, max: 4, step: 0.5 }, size: { min: 0.01, max: 0.1, step: 0.01 } },
      rejectReason: null,
      trainScore: Math.round((r() * 0.4 - 0.1) * 1000) / 1000,
      holdoutScore: Math.round((r() * 0.4 - 0.15) * 1000) / 1000,
      ci: null,
      trades: 0,
      forwardScore: null,
      forwardTrades: 0,
      model: MODEL,
      createdAt: ts,
      explanation: '',
      ciHistory: [],
      equity: [],
      openPositions: [],
      rowId: rowId++,
    };
    for (const p of parents) strategies.get(p)?.children.push(id);
    strategies.set(id, s);
    return s;
  };
  const live: string[] = [];
  for (let i = 0; i < 8; i++) live.push(makeStrategy('seed', [], 0, LANE_START + i * 1000).id);
  let popCI = 0;
  let prevPop = 0;
  const nCycles = 12;
  for (let n = 1; n <= nCycles; n++) {
    const startedAt = LANE_START + n * cycleMs;
    const endedAt = startedAt + 90_000;
    const steps = ['collect', 'rank', 'diagnose', 'generate', 'trial', 'validate', 'promote'].map((step, i) => ({ ts: startedAt + i * 12_000, step, detail: `${step} done` }));
    const ranked = [...live].sort(() => r() - 0.5);
    const weak = ranked.slice(-2);
    const strong = ranked.slice(0, 2);
    const candidates: Candidate[] = [];
    const promoted: string[] = [];
    const retired: string[] = [];
    const nCand = 4 + Math.floor(r() * 3);
    const allDie = n === 7;
    for (let c = 0; c < nCand; c++) {
      const origin = c < 2 ? 'mutate' : c === 2 ? 'crossbreed' : 'fresh';
      const parents = origin === 'mutate' ? [weak[c] ?? weak[0]!] : origin === 'crossbreed' ? strong : [];
      const s = makeStrategy(origin, parents, n, startedAt + 40_000 + c * 1000);
      const roll = r();
      let stage = 'promoted';
      let reason: string | null = null;
      if (allDie || roll < 0.55 || promoted.length >= 2 || weak.length === 0) {
        stage = roll < 0.12 ? 'sandbox' : roll < 0.2 ? 'guards' : roll < 0.6 ? 'trial' : 'holdout';
        reason = allDie ? 'holdout' : stage === 'sandbox' ? REASONS[2]! : stage === 'guards' ? REASONS[3 + Math.floor(r() * 3)]! : stage === 'trial' ? 'train margin' : 'holdout';
        s.status = 'rejected';
        s.rejectReason = reason;
        s.diedCycle = n;
      } else {
        const target = weak.shift()!;
        const t = strategies.get(target)!;
        t.status = 'retired';
        t.diedCycle = n;
        t.rejectReason = 'replaced';
        live.splice(live.indexOf(target), 1, s.id);
        promoted.push(s.id);
        retired.push(target);
      }
      candidates.push({ id: s.id, origin, parents, describe: s.describe, stage, reason, trainScore: s.trainScore, holdoutScore: stage === 'holdout' || stage === 'promoted' ? s.holdoutScore : null });
    }
    for (const id of live) {
      const s = strategies.get(id)!;
      s.ci = Math.round(((s.holdoutScore ?? 0) / 0.12 - 1 + (n - s.bornCycle) * 0.04) * 100) / 100;
      s.ciHistory.push({ cycle: n, ci: s.ci });
    }
    prevPop = popCI;
    const cis = live.map((id) => strategies.get(id)!.ci ?? 0);
    popCI = Math.round((cis.reduce((a, b) => a + b, 0) / cis.length) * 100) / 100;
    const bestCI = Math.max(...cis);
    const velocity = n === 1 ? 0 : Math.round((popCI - prevPop) * 100) / 100;
    const tokensIn = 30_000 + Math.floor(r() * 20_000);
    const tokensOut = 6_000 + Math.floor(r() * 4_000);
    cycles.push({
      n,
      startedAt,
      endedAt,
      outcome: n === 11 ? 'error' : promoted.length ? 'promoted' : 'no_change',
      diagnosis: `Cycle ${n}: ${PATTERNS[n % PATTERNS.length]} The weak strategies trade the quiet hours; the strong ones wait for volume.`,
      patterns: [PATTERNS[n % PATTERNS.length]!, PATTERNS[(n + 2) % PATTERNS.length]!],
      popCI,
      bestCI: Math.round(bestCI * 100) / 100,
      velocity,
      ceiling: n >= 10,
      tokensIn,
      tokensOut,
      costUsd: Math.round((tokensIn * 3 + tokensOut * 15) / 1e6 * 1000) / 1000,
      promoted,
      retired,
      candidates: candidates.length,
      steps,
      candidateRows: candidates,
    });
  }
  // trades for every strategy that was ever live
  for (const s of strategies.values()) {
    if (s.status === 'rejected') continue;
    const n = 20 + Math.floor(r() * 30);
    let eq = 100;
    const start = LANE_START + s.bornCycle * cycleMs;
    const end = s.diedCycle ? LANE_START + s.diedCycle * cycleMs : NOW;
    for (let i = 0; i < n; i++) {
      const openedAt = start + Math.floor(((end - start) * i) / n);
      const closedAt = openedAt + lane.tfMs * (1 + Math.floor(r() * 12));
      const entry = lane.assets[i % 2] === 'BTC' ? 60_000 + r() * 4000 : 2500 + r() * 200;
      const move = (r() - 0.46) * 0.03;
      const size = s.params['size']!;
      const pnl = Math.round(size * move * 100 * 1000) / 1000;
      const fees = Math.round(size * 0.0007 * 100 * 1000) / 1000;
      const funding = lane.id === 'flow' ? Math.round((r() - 0.5) * 0.004 * 1000) / 1000 : 0;
      const drawdown = Math.round(size * Math.max(0, -move + r() * 0.01) * 100 * 1000) / 1000;
      const score = Math.round((pnl - fees - 0.5 * drawdown) * 1000) / 1000;
      trades.push({ id: tradeId++, strategyId: s.id, asset: lane.assets[i % 2]!, side: r() < 0.6 ? 'long' : 'short', size, openedAt, closedAt, entry: Math.round(entry * 100) / 100, exit: Math.round(entry * (1 + move) * 100) / 100, pnl, fees, funding, drawdown, score });
      eq += score;
      s.equity.push({ ts: closedAt, equity: Math.round(eq * 1000) / 1000 });
    }
    s.trades = n;
    const forward = trades.filter((t) => t.strategyId === s.id && t.closedAt > start + 2 * cycleMs);
    s.forwardTrades = forward.length;
    s.forwardScore = forward.length ? Math.round((forward.reduce((a, t) => a + t.score, 0) / forward.length) * 1000) / 1000 : null;
    if (s.status === 'live' && r() < 0.5) s.openPositions.push({ asset: lane.assets[0]!, side: 'long', size: s.params['size']!, openedAt: NOW - 40 * 60_000, entry: 61_000 });
    s.explanation = `${s.id} is ${s.status}. ${s.describe} ${s.origin === 'seed' ? 'It was written by the Generator in the first generation from the goal alone.' : `It was born in cycle ${s.bornCycle} as a ${s.origin} of ${s.parents.join(', ') || 'nothing'}.`} On its last trial it scored ${s.trainScore} on training episodes and ${s.holdoutScore} on unseen holdout episodes.`;
  }
  // equity per hour since lane start
  const equity: LaneData['equity'] = [];
  let ens = 100;
  let bench = 100;
  for (let ts = LANE_START; ts <= NOW; ts += 3_600_000) {
    ens += (r() - 0.48) * 0.3;
    bench += (r() - 0.49) * 0.5;
    equity.push({ ts, ensemble: Math.round(ens * 100) / 100, benchmark: Math.round(bench * 100) / 100 });
  }
  const ledger: LaneData['ledger'] = [];
  let prev: string | null = null;
  for (let i = 0; i < 24 * 14; i++) {
    const ts = LANE_START + i * 3_600_000;
    const h = sha(seed * 1000 + i);
    ledger.push({ ts, sha256: h, prevSha256: prev, file: `${lane.id}/${new Date(ts).toISOString().slice(0, 13)}.json` });
    prev = h;
  }
  return { strategies, cycles, trades, equity, ledger, state: lane.id === 'alts' ? 'paused' : 'running' };
}

const DATA = new Map<LaneId, LaneData>(LANES.map((l, i) => [l.id, buildLane(l, 11 + i)]));

let momentId = 1;
const MOMENTS: Moment[] = [];
const CONTROL: Control[] = [];
{
  let cid = 1;
  for (const lane of LANES) {
    const d = DATA.get(lane.id)!;
    for (const c of d.cycles) {
      if (c.promoted.length && c.n === 1) MOMENTS.push({ id: momentId++, lane: lane.id, ts: c.endedAt!, kind: 'first_promotion', title: `${lane.name}: first promotion`, body: `${c.promoted[0]} replaced ${c.retired[0]} after beating it on unseen data. The loop has started to change itself.`, strategyId: c.promoted[0]! });
      if (c.n % 4 === 0) MOMENTS.push({ id: momentId++, lane: lane.id, ts: c.endedAt!, kind: 'new_best_ci', title: `${lane.name}: new best CI ${c.bestCI?.toFixed(2)}`, body: `A strategy born in cycle ${c.n} scores ${c.bestCI?.toFixed(2)} against the seed generation on data it never saw.`, strategyId: c.promoted[0] ?? null });
      if (c.n === 7) MOMENTS.push({ id: momentId++, lane: lane.id, ts: c.endedAt!, kind: 'all_died_holdout', title: `${lane.name}: every candidate failed on new data`, body: 'Every idea this cycle looked good on old data and failed on new data. Nothing was promoted.', strategyId: null });
      if (c.n === 10) MOMENTS.push({ id: momentId++, lane: lane.id, ts: c.endedAt!, kind: 'ceiling', title: `${lane.name}: ceiling flag raised`, body: 'Population CI has moved less than 0.01 for three cycles. The primitives may be exhausted.', strategyId: null });
    }
    CONTROL.push({ id: cid++, lane: lane.id, ts: LANE_START + 3 * 86_400_000, action: 'pause', actor: 'ouro', note: 'weekly drill' });
    CONTROL.push({ id: cid++, lane: lane.id, ts: LANE_START + 3 * 86_400_000 + 600_000, action: 'approval_on', actor: 'ouro', note: 'weekly drill' });
    CONTROL.push({ id: cid++, lane: lane.id, ts: LANE_START + 3 * 86_400_000 + 7_200_000, action: 'reject', actor: 'ouro', note: 'cycle 3 rejected in the drill' });
    CONTROL.push({ id: cid++, lane: lane.id, ts: LANE_START + 3 * 86_400_000 + 7_300_000, action: 'approval_off', actor: 'ouro', note: '' });
    CONTROL.push({ id: cid++, lane: lane.id, ts: LANE_START + 3 * 86_400_000 + 7_400_000, action: 'resume', actor: 'ouro', note: '' });
    if (lane.id === 'alts') CONTROL.push({ id: cid++, lane: lane.id, ts: NOW - 3_600_000, action: 'budget_pause', actor: 'budget', note: 'daily budget of 1 USD reached; resumes at 00:00 UTC' });
  }
  MOMENTS.sort((a, b) => a.ts - b.ts).forEach((m, i) => (m.id = i + 1));
  momentId = MOMENTS.length + 1;
}

/* ------------------------------------ SSE event script ------------------------------------ */

type ArenaEvent = { id: number; lane: LaneId; ts: number; type: string; payload: Record<string, unknown> };
let eventId = 1000;
const RECENT: ArenaEvent[] = [];
const scriptRng = rng(99);
let scriptStep = 0;
let scriptCycle = 13;
let scriptStrategy = 200;

function nextEvent(lane: LaneId): ArenaEvent {
  const d = DATA.get(lane)!;
  const live = [...d.strategies.values()].filter((s) => s.status === 'live');
  const pick = live[Math.floor(scriptRng() * live.length)]!;
  const ts = Date.now();
  const steps = ['collect', 'rank', 'diagnose', 'generate', 'trial', 'validate', 'promote'];
  const i = scriptStep++ % 16;
  let type = 'trade:close';
  let payload: Record<string, unknown> = {};
  if (i === 0) {
    type = 'cycle:start';
    payload = { cycle: scriptCycle };
  } else if (i >= 1 && i <= 7) {
    type = 'cycle:step';
    payload = { cycle: scriptCycle, step: steps[i - 1], detail: `${steps[i - 1]}: ${live.length} live strategies, ${40 * live.length} episodes` };
    if (i === 3) {
      RECENT.push({ id: eventId++, lane, ts, type: 'critique', payload: { cycle: scriptCycle, patterns: [PATTERNS[scriptCycle % PATTERNS.length]], summary: 'The weak strategies trade the quiet hours. The strong ones wait for volume above average.' } });
    }
  } else if (i === 8 || i === 9) {
    type = 'candidate';
    const id = `s-${String(scriptStrategy++).padStart(4, '0')}`;
    const promoted = i === 9;
    payload = { cycle: scriptCycle, id, origin: promoted ? 'mutate' : 'fresh', parents: promoted ? [pick.id] : [], describe: DESCRIBES[scriptStrategy % DESCRIBES.length], code: pick.code, params: pick.params, bounds: pick.bounds, stage: promoted ? 'promoted' : 'holdout', reason: promoted ? null : 'holdout', trainScore: 0.12, holdoutScore: promoted ? 0.2 : -0.02 };
    if (promoted) {
      const weakest = live[live.length - 1]!;
      const born: Strategy = { ...pick, id, origin: 'mutate', parents: [pick.id], children: [], bornCycle: scriptCycle, ci: 0.9, status: 'live', rowId: 9000 + scriptStrategy, trades: 0, forwardTrades: 0, forwardScore: null, equity: [], ciHistory: [{ cycle: scriptCycle, ci: 0.9 }], openPositions: [] };
      d.strategies.set(id, born);
      pick.children.push(id);
      weakest.status = 'retired';
      weakest.diedCycle = scriptCycle;
      RECENT.push({ id: eventId++, lane, ts, type: 'promote', payload: { cycle: scriptCycle, id, replaces: weakest.id } });
      RECENT.push({ id: eventId++, lane, ts, type: 'retire', payload: { cycle: scriptCycle, id: weakest.id, reason: 'replaced' } });
    }
  } else if (i === 10) {
    type = 'cycle:end';
    payload = { cycle: scriptCycle, outcome: 'promoted', popCI: 0.5 + scriptRng() * 0.2, bestCI: 1.3, velocity: 0.02, ceiling: false, usage: { inputTokens: 35_000, outputTokens: 7_000, calls: 5, usd: 0.21 } };
    scriptCycle++;
  } else if (i === 11) {
    type = 'moment';
    const m: Moment = { id: momentId++, lane, ts, kind: 'new_best_ci', title: `${lane} lane: new best CI 1.30`, body: 'A mutation born this cycle beat every seed on data it never saw.', strategyId: pick.id };
    MOMENTS.push(m);
    payload = { ...m };
  } else if (i === 12) {
    type = 'trade:open';
    payload = { strategyId: pick.id, asset: 'BTC', side: 'long', size: 0.05, price: 61_000 + scriptRng() * 500, ts };
  } else if (i === 13) {
    type = 'llm';
    payload = { cycle: scriptCycle, purpose: 'generator', model: MODEL, inputTokens: 4_100, outputTokens: 900, ms: 3200 };
  } else {
    type = 'trade:close';
    payload = { strategyId: pick.id, asset: 'ETH', outcome: { pnl: (scriptRng() - 0.45) * 0.3, fees: 0.035, drawdown: 0.05, holdBars: 4, closedTs: ts }, score: (scriptRng() - 0.45) * 0.3, ts };
  }
  const ev = { id: eventId++, lane, ts, type, payload };
  RECENT.push(ev);
  if (RECENT.length > 600) RECENT.splice(0, RECENT.length - 600);
  return ev;
}

/* ------------------------------------ http ------------------------------------ */

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function json(res: ServerResponse, body: unknown, status = 200, cache = 'max-age=5'): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'content-encoding': 'gzip' });
  res.end(zlib.gzipSync(text));
}

function num(v: string | null, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? n : d;
}

function laneOf(id: string): LaneData | undefined {
  return DATA.get(id as LaneId);
}

function summary(laneId: LaneId) {
  const lane = LANES.find((l) => l.id === laneId)!;
  const d = DATA.get(laneId)!;
  const last = d.cycles[d.cycles.length - 1]!;
  const live = [...d.strategies.values()].filter((s) => s.status === 'live').length;
  return {
    lane: laneId,
    status: d.state,
    uptimeMs: Date.now() - LANE_START,
    cycles: d.cycles.length,
    born: d.strategies.size,
    live,
    popCI: last.popCI,
    bestCI: last.bestCI,
    velocity: last.velocity,
    ceiling: last.ceiling,
    spendTodayUsd: laneId === 'alts' ? 1 : 0.42,
    tokensToday: { in: 121_000, out: 28_000 },
    budgetUsd: 1,
    sdkVersion: SDK,
    model: MODEL,
    lastBarTs: Date.now() - (laneId === 'alts' ? 2 * lane.tfMs : 4 * 60_000),
    lastCycleTs: last.endedAt,
  };
}

const sseClients = new Set<ServerResponse>();
let sseCap = 500;
/** Lets a test flip the server into "too many connections" mode. */
export function setStreamCapacity(n: number): void {
  sseCap = n;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/^\/arena\/api/, '');
  const q = url.searchParams;
  if (req.method !== 'GET') return json(res, { error: 'read only' }, 405);

  if (p === '/health') {
    const lanes: Record<string, unknown> = {};
    for (const l of LANES) {
      const d = DATA.get(l.id)!;
      const s = summary(l.id);
      lanes[l.id] = { state: d.state, lastBarTs: s.lastBarTs, lastCycleTs: s.lastCycleTs, wsConnected: l.id !== 'alts', pid: 1000 + LANES.indexOf(l), startedAt: LANE_START, seenAt: Date.now() };
    }
    return json(res, { ok: true, ts: Date.now(), version: '0.1.0', sdkVersion: SDK, disk: { percent: 14 }, lanes }, 200, 'no-store');
  }
  if (p === '/lanes') {
    return json(
      res,
      LANES.map((l) => ({ id: l.id, name: l.name, goal: `Maximise realised PnL after fees on ${l.assets.join(' and ')} ${l.tf} perps, max drawdown 8%`, assets: l.assets, tf: l.tf, packs: l.packs, model: MODEL, sdkVersion: SDK, status: DATA.get(l.id)!.state, createdAt: LANE_START })),
    );
  }
  let m = /^\/lanes\/([a-z]+)\/(summary|population|cycles|tree|graveyard|equity)$/.exec(p);
  if (m) {
    const d = laneOf(m[1]!);
    if (!d) return json(res, { error: 'unknown lane' }, 404);
    const laneId = m[1] as LaneId;
    const kind = m[2]!;
    if (kind === 'summary') return json(res, summary(laneId));
    if (kind === 'population') {
      const last = d.cycles.length;
      const rows = [...d.strategies.values()]
        .filter((s) => s.status === 'live')
        .sort((a, b) => (b.ci ?? -9) - (a.ci ?? -9))
        .map((s) => ({ id: s.id, origin: s.origin, bornCycle: s.bornCycle, ci: s.ci, holdoutScore: s.holdoutScore, forwardScore: s.forwardScore, trades: s.trades, forwardTrades: s.forwardTrades, cyclesSurvived: last - s.bornCycle, describe: s.describe, status: s.status }));
      return json(res, rows);
    }
    if (kind === 'cycles') {
      const limit = Math.min(100, num(q.get('limit'), 20));
      const before = num(q.get('before'), Infinity);
      const items = d.cycles
        .filter((c) => c.n < before)
        .sort((a, b) => b.n - a.n)
        .slice(0, limit)
        .map(({ steps: _s, candidateRows: _c, ...c }) => c);
      const lastN = items[items.length - 1]?.n ?? null;
      return json(res, { items, nextBefore: lastN !== null && d.cycles.some((c) => c.n < lastN) ? lastN : null });
    }
    if (kind === 'tree') {
      const nodes = [...d.strategies.values()].map((s) => ({ id: s.id, parents: s.parents, born: s.bornCycle, died: s.diedCycle, status: s.status, ci: s.ci, origin: s.origin }));
      const live = [...d.strategies.values()].filter((s) => s.status === 'live').sort((a, b) => (b.ci ?? -9) - (a.ci ?? -9));
      const best = live[0];
      const lineage: string[] = [];
      let cur = best;
      while (cur) {
        lineage.unshift(cur.id);
        cur = cur.parents[0] ? d.strategies.get(cur.parents[0]) : undefined;
      }
      return json(res, { nodes, bestId: best?.id ?? null, bestLineage: lineage });
    }
    if (kind === 'graveyard') {
      const cursor = num(q.get('cursor'), Infinity);
      const dead = [...d.strategies.values()]
        .filter((s) => s.status !== 'live' && s.rowId < cursor)
        .sort((a, b) => b.rowId - a.rowId);
      const page = dead.slice(0, 20);
      const items = page.map((s) => ({ id: s.id, origin: s.origin, born: s.bornCycle, died: s.diedCycle ?? s.bornCycle, lifespan: s.status === 'rejected' ? 0 : (s.diedCycle ?? 0) - s.bornCycle, describe: s.describe, reason: s.rejectReason ?? 'replaced', holdoutScore: s.holdoutScore, ci: s.ci }));
      return json(res, { items, nextCursor: dead.length > 20 ? page[page.length - 1]!.rowId : null });
    }
    if (kind === 'equity') {
      const range = (q.get('range') ?? '7d') as '24h' | '7d' | '30d' | 'all';
      const span = range === '24h' ? 86_400_000 : range === '7d' ? 7 * 86_400_000 : range === '30d' ? 30 * 86_400_000 : Infinity;
      const points = d.equity.filter((e) => NOW - e.ts <= span);
      return json(res, { range, points });
    }
  }
  m = /^\/lanes\/([a-z]+)\/cycles\/(\d+)$/.exec(p);
  if (m) {
    const d = laneOf(m[1]!);
    const c = d?.cycles.find((x) => x.n === Number(m![2]));
    if (!d || !c) return json(res, { error: 'unknown cycle' }, 404);
    const { candidateRows, ...rest } = c;
    return json(res, { ...rest, candidates: candidateRows });
  }
  m = /^\/lanes\/([a-z]+)\/strategies\/([\w-]+)(\/trades)?$/.exec(p);
  if (m) {
    const d = laneOf(m[1]!);
    const s = d?.strategies.get(m[2]!);
    if (!d || !s) return json(res, { error: 'unknown strategy' }, 404);
    if (m[3]) return json(res, d.trades.filter((t) => t.strategyId === s.id).sort((a, b) => b.closedAt - a.closedAt).map(({ strategyId: _x, ...t }) => t));
    const { rowId: _r, ...rec } = s;
    return json(res, { ...rec, openPositions: s.openPositions.filter((o) => Date.now() - o.openedAt >= 15 * 60_000) });
  }
  if (p === '/moments') {
    const lane = q.get('lane');
    const cursor = num(q.get('cursor'), Infinity);
    const all = MOMENTS.filter((x) => (!lane || x.lane === lane) && x.id < cursor).sort((a, b) => b.id - a.id);
    const items = all.slice(0, 20);
    return json(res, { items, nextCursor: all.length > 20 ? items[items.length - 1]!.id : null });
  }
  if (p === '/control') {
    const lane = q.get('lane');
    return json(res, CONTROL.filter((x) => !lane || x.lane === lane).sort((a, b) => b.id - a.id).slice(0, 200));
  }
  if (p === '/ledger') {
    const lane = q.get('lane');
    const lanes: Record<string, unknown> = {};
    for (const l of LANES) {
      if (lane && l.id !== lane) continue;
      const d = DATA.get(l.id)!;
      lanes[l.id] = { latest: d.ledger[d.ledger.length - 1] ?? null, count: d.ledger.length, chainOk: true };
    }
    return json(res, { repo: 'https://github.com/ourointelligence/arena-ledger', lanes });
  }
  m = /^\/og\/([a-z]+)\/([\w-]+)\.png$/.exec(p);
  if (m) {
    const d = laneOf(m[1]!);
    if (!d?.strategies.has(m[2]!)) return json(res, { error: 'unknown strategy' }, 404);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
    res.end(PNG_1x1);
    return;
  }
  if (p === '/stream') {
    if (sseClients.size >= sseCap) return json(res, { error: 'too many connections' }, 503, 'no-store');
    const lane = (q.get('lane') ?? 'core') as LaneId;
    if (!DATA.has(lane)) return json(res, { error: 'unknown lane' }, 404);
    const rate = Math.max(0.1, Math.min(50, num(q.get('rate'), 1)));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    sseClients.add(res);
    const send = (ev: ArenaEvent) => res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    const lastId = Number(req.headers['last-event-id'] ?? q.get('lastEventId') ?? 0);
    if (lastId) for (const ev of RECENT.filter((e) => e.id > lastId && e.lane === lane).slice(0, 500)) send(ev);
    const tick = setInterval(() => {
      const before = RECENT.length;
      const ev = nextEvent(lane);
      // nextEvent may have pushed companion events before the one it returns
      for (const extra of RECENT.slice(before, RECENT.length - 1)) send(extra);
      send(ev);
    }, 1000 / rate);
    const beat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(tick);
      clearInterval(beat);
      sseClients.delete(res);
    });
    return;
  }
  json(res, { error: 'not found' }, 404);
}

export function startMockApi(port = 8788): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        handle(req, res);
      } catch (err) {
        json(res, { error: (err as Error).message }, 500);
      }
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`mock api: port ${port} already in use, assuming a mock is running`);
        resolve(server);
      } else reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`mock api: http://127.0.0.1:${port}/arena/api`);
      resolve(server);
    });
  });
}

const invokedDirectly = process.argv[1] && /mock-api\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  const port = Number(process.env['ARENA_MOCK_PORT'] ?? process.argv[2] ?? 8788);
  void startMockApi(port);
}
