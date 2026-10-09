import path from 'node:path';

export type RunnerEnv = {
  dataDir: string;
  runDir: string;
  dbPath: string;
  llm: string;
  model: string;
  budgetUsd: number;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  /** Fast mode for tests: small windows so cycles happen within minutes. */
  fast: boolean;
  /** Use the scripted fake model instead of a provider. */
  fakeLlm: boolean;
  hlWsUrl: string | undefined;
  hlInfoUrl: string | undefined;
  staleAfterIntervals: number | undefined;
  /** Hyperliquid REST weight per minute for this lane. Default 200 (half the limit, split three ways). */
  weightPerMinute: number | undefined;
  heartbeatMs: number;
  /** Test only: SIGKILL the process when this cycle step starts. */
  killAtStep: string | undefined;
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : d;
}

export function readEnv(e: NodeJS.ProcessEnv = process.env): RunnerEnv {
  const dataDir = e['ARENA_DATA_DIR'] ?? '/var/lib/arena';
  return {
    dataDir,
    runDir: e['ARENA_RUN_DIR'] ?? '/run/arena',
    dbPath: e['ARENA_DB'] ?? path.join(dataDir, 'arena.db'),
    llm: e['OURO_LLM'] ?? 'anthropic',
    model: e['OURO_MODEL'] ?? '',
    budgetUsd: num(e['ARENA_BUDGET_USD_PER_LANE'], 1),
    pricing: { inputPerMTok: num(e['ARENA_PRICE_IN_PER_MTOK'], 3), outputPerMTok: num(e['ARENA_PRICE_OUT_PER_MTOK'], 15) },
    fast: e['ARENA_FAST'] === '1',
    fakeLlm: e['ARENA_FAKE_LLM'] === '1',
    hlWsUrl: e['ARENA_HL_WS_URL'],
    hlInfoUrl: e['ARENA_HL_INFO_URL'],
    staleAfterIntervals: e['ARENA_STALE_INTERVALS'] ? num(e['ARENA_STALE_INTERVALS'], 2) : undefined,
    weightPerMinute: e['ARENA_WEIGHT_PER_MINUTE'] ? num(e['ARENA_WEIGHT_PER_MINUTE'], 200) : undefined,
    heartbeatMs: num(e['ARENA_HEARTBEAT_MS'], 15_000),
    killAtStep: e['ARENA_TEST_KILL_STEP'] || undefined,
  };
}
