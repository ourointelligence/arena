/**
 * Shared Arena types: lane ids, the SDK 0.2.0 event payloads Arena subscribes to, and one row type per arena.db table.
 */

export type LaneId = 'core' | 'alts' | 'flow';

export const LANE_IDS: readonly LaneId[] = ['core', 'alts', 'flow'] as const;

export function isLaneId(v: unknown): v is LaneId {
  return v === 'core' || v === 'alts' || v === 'flow';
}

/* ------------------------------ SDK shapes ------------------------------ */

export type Bar = {
  ts: number;
  asset: string;
  tf: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  ext?: Record<string, number>;
  stale?: boolean;
};

export type Side = 'long' | 'short' | 'flat';

export type Decision = { side: Side; size: number; stop?: number; tp?: number; tag?: string } | null;

export type Outcome = {
  pnl: number;
  fees: number;
  drawdown: number;
  holdBars: number;
  closedTs: number;
  funding?: number;
  raw?: unknown;
};

/** What the paper executor puts in outcome.raw. */
export type PaperOutcomeRaw = {
  asset: string;
  side: 'long' | 'short';
  entry: number;
  exit: number;
  size: number;
  reason: string;
  openedTs: number;
};

export type Origin = 'seed' | 'mutate' | 'crossbreed' | 'fresh' | 'user';

export type Bounds = Record<string, { min: number; max: number; step: number }>;

export type CycleStep = 'collect' | 'rank' | 'diagnose' | 'generate' | 'trial' | 'validate' | 'promote';

export type CycleOutcome = 'promoted' | 'no_change' | 'pending' | 'error';

export type CandidateStage = 'sandbox' | 'guards' | 'trial' | 'holdout' | 'promoted' | 'pending';

export type LLMPurpose = 'seed' | 'critic' | 'generator';

export type LLMUsage = { inputTokens: number; outputTokens: number };

export type LLMUsageTotal = LLMUsage & { calls: number; usd?: number };

/* ------------------------------ SDK events ------------------------------ */

export type EventMap = {
  bar: { asset: string; tf: string; bar: Bar };
  decision: { strategyId: string; asset: string; decision: Decision };
  'trade:open': { strategyId: string; asset: string; side: 'long' | 'short'; size: number; price: number; ts: number };
  'trade:close': { strategyId: string; asset: string; outcome: Outcome; score: number; ts: number };
  'cycle:start': { cycle: number };
  'cycle:step': { cycle: number; step: CycleStep; detail: string };
  critique: { cycle: number; patterns: string[]; summary: string };
  candidate: {
    cycle: number;
    id: string;
    origin: Origin;
    parents: string[];
    describe: string;
    code: string;
    params: Record<string, number>;
    bounds: Bounds;
    stage: CandidateStage;
    reason: string | null;
    trainScore: number | null;
    holdoutScore: number | null;
  };
  promote: { cycle: number; id: string; replaces: string };
  retire: { cycle: number; id: string; reason: string };
  'cycle:end': {
    cycle: number;
    outcome: CycleOutcome;
    popCI: number;
    bestCI: number;
    velocity: number;
    ceiling: boolean;
    usage: LLMUsageTotal;
  };
  pending: { cycle: number };
  approved: { cycle: number };
  rejected: { cycle: number };
  rollback: { toCycle: number };
  llm: { cycle: number; purpose: LLMPurpose; model: string; inputTokens: number; outputTokens: number; ms: number };
  error: { scope: string; message: string };
};

export type SdkEventType = keyof EventMap;

/** Events Arena adds on top of the SDK ones. */
export type ArenaExtraEventMap = {
  control: ControlRow;
  budget: { lane: LaneId; action: 'pause' | 'resume'; usd: number; budgetUsd: number };
  moment: MomentRow;
};

export type ArenaEventMap = EventMap & ArenaExtraEventMap;

export type ArenaEventType = keyof ArenaEventMap;

export type ArenaEvent = {
  [K in ArenaEventType]: { id?: number; lane: LaneId; ts: number; type: K; payload: ArenaEventMap[K] };
}[ArenaEventType];

export const SDK_EVENT_TYPES: readonly SdkEventType[] = [
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

/** Event types that are streamed live only and never written to the events table. */
export const UNSTORED_EVENT_TYPES: ReadonlySet<string> = new Set(['bar', 'decision']);

/* ------------------------------ table rows ------------------------------ */

export type LaneStatus = 'running' | 'paused' | 'pending' | 'error' | 'stopped';

export type LaneRow = {
  id: LaneId;
  name: string;
  goal: string;
  assets: string[];
  tf: string;
  packs: string[];
  model: string;
  sdk_version: string;
  status: LaneStatus;
  created_at: number;
};

export type CycleRow = {
  lane_id: LaneId;
  n: number;
  started_at: number | null;
  ended_at: number | null;
  outcome: CycleOutcome | 'rejected' | null;
  diagnosis: string | null;
  patterns: string[];
  pop_ci: number | null;
  best_ci: number | null;
  velocity: number | null;
  ceiling: boolean;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
};

export type StrategyStatus = 'live' | 'retired' | 'rejected' | 'rolled_back' | 'pending';

export type StrategyRow = {
  lane_id: LaneId;
  id: string;
  origin: Origin;
  born_cycle: number;
  parents: string[];
  describe: string;
  code: string;
  params: Record<string, number>;
  bounds: Bounds;
  status: StrategyStatus;
  died_cycle: number | null;
  reject_reason: string | null;
  train_score: number | null;
  holdout_score: number | null;
  ci: number | null;
  trades: number;
  forward_score: number | null;
  forward_trades: number;
  model: string | null;
  created_at: number;
};

export type CandidateRow = {
  lane_id: LaneId;
  cycle: number;
  strategy_id: string;
  origin: Origin;
  stage: CandidateStage;
  reason: string | null;
  train_score: number | null;
  holdout_score: number | null;
};

export type TradeRow = {
  id: string;
  lane_id: LaneId;
  strategy_id: string;
  asset: string;
  side: 'long' | 'short';
  size: number;
  opened_at: number;
  closed_at: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  funding: number;
  drawdown: number;
  score: number;
};

export type EquityRow = { lane_id: LaneId; ts: number; ensemble_equity: number; benchmark_equity: number };

export type EventRow = { id: number; lane_id: LaneId; ts: number; type: string; payload: string };

export type MomentKind =
  | 'best_ci'
  | 'first_promotion'
  | 'born_100'
  | 'born_500'
  | 'all_died_holdout'
  | 'ceiling_raised'
  | 'ceiling_cleared'
  | 'lineage_10'
  | 'forward_beats_holdout'
  | 'pause'
  | 'resume'
  | 'approve'
  | 'reject'
  | 'rollback'
  | 'budget_pause';

export type MomentRow = {
  id: number;
  lane_id: LaneId;
  ts: number;
  kind: MomentKind;
  title: string;
  body: string;
  strategy_id: string | null;
};

export type SnapshotRow = { id: number; lane_id: LaneId; ts: number; sha256: string; prev_sha256: string | null; file: string };

export type SpendRow = { day: string; lane_id: LaneId; tokens_in: number; tokens_out: number; usd: number };

export type ControlAction =
  | 'pause'
  | 'resume'
  | 'approval_on'
  | 'approval_off'
  | 'approve'
  | 'reject'
  | 'rollback'
  | 'budget'
  | 'budget_pause'
  | 'budget_resume'
  | 'drill';

export type ControlRow = { id: number; lane_id: LaneId; ts: number; action: ControlAction; actor: string; note: string | null };

export type LaneStateRow = {
  lane_id: LaneId;
  state: LaneStatus;
  last_bar_ts: number | null;
  last_cycle_ts: number | null;
  ws_connected: boolean;
  pid: number | null;
  started_at: number | null;
  seen_at: number | null;
  sdk_version: string | null;
  model: string | null;
  budget_usd: number | null;
  approval_on: boolean;
};

export type CycleStepRow = { id: number; lane_id: LaneId; cycle: number; ts: number; step: CycleStep; detail: string };

export type StrategyCiRow = { lane_id: LaneId; strategy_id: string; cycle: number; ci: number };

export type Pricing = { inputPerMTok: number; outputPerMTok: number };

export function usdFor(usage: LLMUsage, pricing: Pricing | undefined): number {
  if (!pricing) return 0;
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

/** UTC day key, YYYY-MM-DD. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
