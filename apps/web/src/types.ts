// Shapes from docs/api-contract.md. The page consumes nothing else.

export type LaneId = 'core' | 'alts' | 'flow';
export type LaneState = 'running' | 'paused' | 'pending' | 'error' | 'stopped';

export type Health = {
  ok: boolean;
  ts: number;
  version: string;
  sdkVersion: string;
  disk: { percent: number };
  lanes: Record<string, { state: LaneState; lastBarTs: number | null; lastCycleTs: number | null; wsConnected: boolean; pid?: number; startedAt?: number; seenAt?: number }>;
};

export type Lane = {
  id: LaneId;
  name: string;
  goal: string;
  assets: string[];
  tf: string;
  packs: string[];
  model: string;
  sdkVersion: string;
  status: LaneState;
  createdAt: number;
};

export type Summary = {
  lane: LaneId;
  status: LaneState;
  uptimeMs: number;
  cycles: number;
  born: number;
  live: number;
  popCI: number | null;
  bestCI: number | null;
  velocity: number | null;
  ceiling: boolean;
  spendTodayUsd: number;
  tokensToday: { in: number; out: number };
  budgetUsd: number;
  sdkVersion: string;
  model: string;
  lastBarTs: number | null;
  lastCycleTs: number | null;
};

export type PopulationRow = {
  id: string;
  origin: string;
  bornCycle: number;
  ci: number | null;
  holdoutScore: number | null;
  forwardScore: number | null;
  trades: number;
  forwardTrades: number;
  cyclesSurvived: number;
  describe: string;
  status: string;
};

export type CycleOutcome = 'promoted' | 'no_change' | 'pending' | 'rejected' | 'error';

export type Cycle = {
  n: number;
  startedAt: number;
  endedAt: number | null;
  outcome: CycleOutcome;
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
};

export type CycleStep = { ts: number; step: string; detail: string };

export type Candidate = {
  id: string;
  origin: string;
  parents: string[];
  describe: string;
  stage: string;
  reason: string | null;
  trainScore: number | null;
  holdoutScore: number | null;
};

export type CycleDetail = Omit<Cycle, 'candidates'> & { steps: CycleStep[]; candidates: Candidate[] };

export type TreeNode = {
  id: string;
  parents: string[];
  born: number;
  died: number | null;
  status: string;
  ci: number | null;
  origin: string;
};

export type Tree = { nodes: TreeNode[]; bestId: string | null; bestLineage: string[] };

export type GraveRow = {
  id: string;
  origin: string;
  born: number;
  died: number;
  lifespan: number;
  describe: string;
  reason: string;
  holdoutScore: number | null;
  ci: number | null;
};

export type Paged<T> = { items: T[]; nextCursor: number | null };

export type Strategy = {
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
};

export type Trade = {
  id: number;
  asset: string;
  side: string;
  size: number;
  openedAt: number;
  closedAt: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  funding: number;
  drawdown: number;
  score: number;
};

export type EquityRange = '24h' | '7d' | '30d' | 'all';
export type Equity = { range: EquityRange; points: Array<{ ts: number; ensemble: number; benchmark: number }> };

export type Moment = { id: number; lane: LaneId; ts: number; kind: string; title: string; body: string; strategyId: string | null };

export type ControlRow = { id: number; lane: LaneId; ts: number; action: string; actor: string; note: string };

export type Ledger = {
  repo: string;
  lanes: Record<string, { latest: { ts: number; sha256: string; prevSha256: string | null; file: string } | null; count: number; chainOk: boolean }>;
};

export type ArenaEvent = { id: number; lane: LaneId; ts: number; type: string; payload: Record<string, unknown> };
