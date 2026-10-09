import type { ControlRow, Cycle, CycleDetail, Equity, EquityRange, GraveRow, Health, Lane, Ledger, Moment, Paged, PopulationRow, Strategy, Summary, Trade, Tree } from './types.ts';

export const API_BASE = '/arena/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined | null>): Promise<T> {
  const url = new URL(API_BASE + path, location.origin);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, `${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  health: () => get<Health>('/health'),
  lanes: () => get<Lane[]>('/lanes'),
  summary: (lane: string) => get<Summary>(`/lanes/${lane}/summary`),
  population: (lane: string) => get<PopulationRow[]>(`/lanes/${lane}/population`),
  cycles: (lane: string, limit = 20, before?: number) => get<{ items: Cycle[]; nextBefore: number | null }>(`/lanes/${lane}/cycles`, { limit, before }),
  cycle: (lane: string, n: number) => get<CycleDetail>(`/lanes/${lane}/cycles/${n}`),
  tree: (lane: string) => get<Tree>(`/lanes/${lane}/tree`),
  graveyard: (lane: string, cursor?: number | null) => get<Paged<GraveRow>>(`/lanes/${lane}/graveyard`, { cursor }),
  strategy: (lane: string, id: string) => get<Strategy>(`/lanes/${lane}/strategies/${id}`),
  trades: (lane: string, id: string) => get<Trade[]>(`/lanes/${lane}/strategies/${id}/trades`),
  equity: (lane: string, range: EquityRange) => get<Equity>(`/lanes/${lane}/equity`, { range }),
  moments: (lane?: string, cursor?: number | null) => get<Paged<Moment>>('/moments', { lane, cursor }),
  control: (lane?: string) => get<ControlRow[]>('/control', { lane }),
  ledger: (lane?: string) => get<Ledger>('/ledger', { lane }),
  ogUrl: (lane: string, id: string) => `${API_BASE}/og/${lane}/${id}.png`,
  streamUrl: (lane: string) => `${API_BASE}/stream?lane=${encodeURIComponent(lane)}`,
};
