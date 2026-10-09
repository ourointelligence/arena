import type { PrimitivePack } from '@ourointelligence/sdk';
import { primitives } from '@ourointelligence/sdk';
import { flow } from '@arena/flow';

export type LaneId = 'core' | 'alts' | 'flow';

export type LaneDefinition = {
  id: LaneId;
  name: string;
  assets: string[];
  tf: string;
  packs: PrimitivePack[];
  packNames: string[];
  /** Attach funding and open interest to every bar and accrue funding on paper. */
  assetCtx: boolean;
};

/** Settings every lane shares, exactly as the product documentation lists them. */
export const SHARED = {
  goal: (assets: string[], tf: string) => `Maximise realised PnL after fees on ${assets.join(' and ')} ${tf} perps, max drawdown 8%`,
  score: (ep: { outcome: { pnl: number; fees: number; drawdown: number } }) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown,
  population: 8,
  cycleEvery: 40,
  cycleMaxWait: '6h',
  minTradesPerWindow: 3,
  holdout: 0.3,
  margin: 0.05,
  retireShare: 0.25,
  guards: { maxDrawdownPct: 8, maxPositionPct: 10, maxProposalsPerCycle: 6, requireApproval: false },
  paper: { feeBps: 3.5, slippageBps: 2 },
  backfill: 3000,
  warmupBars: 300,
  replay: 'bars' as const,
  ensemble: 'weighted' as const,
} as const;

export const core: LaneDefinition = {
  id: 'core',
  name: 'Core',
  assets: ['BTC', 'ETH'],
  tf: '15m',
  packs: [primitives.ta, primitives.volume, primitives.time],
  packNames: ['ta', 'volume', 'time'],
  assetCtx: false,
};

export const alts: LaneDefinition = {
  id: 'alts',
  name: 'Alts',
  assets: ['SOL', 'HYPE'],
  tf: '1h',
  packs: [primitives.ta, primitives.volume, primitives.time],
  packNames: ['ta', 'volume', 'time'],
  assetCtx: false,
};

export const flowLane: LaneDefinition = {
  id: 'flow',
  name: 'Flow',
  assets: ['BTC', 'ETH'],
  tf: '15m',
  packs: [primitives.ta, primitives.volume, primitives.time, flow],
  packNames: ['ta', 'volume', 'time', 'flow'],
  assetCtx: true,
};

export const lanes: Record<LaneId, LaneDefinition> = { core, alts, flow: flowLane };

export function laneById(id: string): LaneDefinition {
  const lane = lanes[id as LaneId];
  if (!lane) throw new Error(`unknown lane "${id}"; expected one of ${Object.keys(lanes).join(', ')}`);
  return lane;
}
