import type { Source } from '@ourointelligence/sdk';
import { hyperliquid, withAssetCtx } from '@ourointelligence/source-hyperliquid';
import type { HyperliquidEvent, HyperliquidOptions, HyperliquidSource, HyperliquidStats } from '@ourointelligence/source-hyperliquid';

/** Hyperliquid allows 1200 REST weight per minute per IP. Arena uses half of it, split evenly across three lanes. */
export const LANE_WEIGHT_PER_MINUTE = 200;

export type LaneSourceOptions = {
  /** Attach funding, open interest, premium, mark and oracle to every bar (the Flow lane). */
  assetCtx?: boolean;
  /** Weight budget per minute for this lane. Default LANE_WEIGHT_PER_MINUTE. */
  weightPerMinute?: number;
  /** Receives every source notice (gap, reconnect, stale, rate limit, error). */
  onEvent?: (e: HyperliquidEvent) => void;
  /** Bars older than this many intervals at emit time are flagged stale. Default 2. */
  staleAfterIntervals?: number;
  /** Overrides for tests and the mock server. */
  wsUrl?: string;
  infoUrl?: string;
  fetch?: HyperliquidOptions['fetch'];
  WebSocket?: HyperliquidOptions['WebSocket'];
  now?: () => number;
};

export type LaneSource = HyperliquidSource;

/** One Hyperliquid source for one lane: one WebSocket, its own rate budget, optional asset context. */
export function laneSource(opts: LaneSourceOptions = {}): LaneSource {
  const base = hyperliquid({
    rateLimit: { weightPerMinute: opts.weightPerMinute ?? LANE_WEIGHT_PER_MINUTE },
    onEvent: opts.onEvent,
    staleAfterIntervals: opts.staleAfterIntervals,
    wsUrl: opts.wsUrl,
    infoUrl: opts.infoUrl,
    fetch: opts.fetch,
    WebSocket: opts.WebSocket,
    now: opts.now,
  });
  return opts.assetCtx ? (withAssetCtx(base) as HyperliquidSource) : base;
}

export type SourceHealth = {
  connected: boolean;
  lastBarTs: number | null;
  reconnects: number;
  gapsFilled: number;
  weightUsedLastMinute: number;
  requests: number;
};

/** A snapshot of the source for the health endpoint; works for any Source and fills in what it can. */
export function sourceHealth(source: Source): SourceHealth {
  const s = (source as Partial<HyperliquidSource>).stats?.() as HyperliquidStats | undefined;
  if (!s) return { connected: false, lastBarTs: null, reconnects: 0, gapsFilled: 0, weightUsedLastMinute: 0, requests: 0 };
  const last = Object.values(s.lastBarTs ?? {});
  return {
    connected: !!s.connected,
    lastBarTs: last.length ? Math.max(...last) : null,
    reconnects: s.reconnects ?? 0,
    gapsFilled: s.gapsFilled ?? 0,
    weightUsedLastMinute: s.weightUsedLastMinute ?? 0,
    requests: s.requests ?? 0,
  };
}

/** True when the newest bar is older than `intervals` bar lengths; used by the health check. */
export function isStale(lastBarTs: number | null, intervalMs: number, now = Date.now(), intervals = 2): boolean {
  if (lastBarTs === null) return true;
  return now - (lastBarTs + intervalMs) > intervals * intervalMs;
}

export type { HyperliquidEvent, HyperliquidStats };
