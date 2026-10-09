import type { ArenaEvent } from './types.ts';

export type StreamMode = 'connecting' | 'live' | 'polling' | 'stopped';
export type StreamHandler = (ev: ArenaEvent) => void;

/** Backoff schedule for reconnects: 1 s, 2 s, 4 s ... capped at 30 s. Exported for tests. */
export function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

/**
 * Server-sent events with reconnect backoff and a polling fallback. When the server answers 503 (too many
 * connections) the stream switches to polling mode: the page refreshes its data every 10 s and the stream retries
 * the connection once a minute.
 */
export class EventStream {
  private source: EventSource | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastId: string | null = null;
  private mode: StreamMode = 'stopped';
  private readonly handlers = new Set<StreamHandler>();
  private readonly modeHandlers = new Set<(m: StreamMode) => void>();
  private url: string | null = null;

  constructor(private readonly onPoll: () => void, private readonly pollMs = 10_000) {}

  on(fn: StreamHandler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  onMode(fn: (m: StreamMode) => void): void {
    this.modeHandlers.add(fn);
  }

  get state(): StreamMode {
    return this.mode;
  }

  start(url: string): void {
    this.stop();
    this.url = url;
    this.attempt = 0;
    this.lastId = null;
    void this.connect();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.source?.close();
    this.source = null;
    this.setMode('stopped');
  }

  private setMode(m: StreamMode): void {
    if (this.mode === m) return;
    this.mode = m;
    for (const fn of this.modeHandlers) fn(m);
  }

  private async probe(url: string): Promise<number> {
    // EventSource hides HTTP status codes, so ask once with fetch and abort immediately.
    const ctl = new AbortController();
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ctl.signal });
      const status = res.status;
      ctl.abort();
      return status;
    } catch {
      return 0;
    }
  }

  private async connect(): Promise<void> {
    if (!this.url) return;
    const url = this.url;
    this.setMode('connecting');
    const status = await this.probe(url);
    if (this.url !== url) return;
    if (status === 503) return this.startPolling();
    const full = this.lastId ? `${url}&lastEventId=${encodeURIComponent(this.lastId)}` : url;
    const es = new EventSource(full);
    this.source = es;
    es.onopen = () => {
      this.attempt = 0;
      this.stopPolling();
      this.setMode('live');
    };
    es.onerror = () => {
      es.close();
      if (this.source !== es) return;
      this.source = null;
      this.attempt++;
      const delay = backoffMs(this.attempt);
      if (this.attempt >= 3) this.startPolling(false);
      this.timer = setTimeout(() => void this.connect(), delay);
    };
    const dispatch = (e: MessageEvent) => {
      if (e.lastEventId) this.lastId = e.lastEventId;
      let ev: ArenaEvent;
      try {
        ev = JSON.parse(e.data as string) as ArenaEvent;
      } catch {
        return;
      }
      for (const fn of this.handlers) {
        try {
          fn(ev);
        } catch (err) {
          console.error('stream handler failed', err);
        }
      }
    };
    for (const type of EVENT_TYPES) es.addEventListener(type, dispatch as EventListener);
    es.onmessage = dispatch;
  }

  private startPolling(retryLater = true): void {
    this.setMode('polling');
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        try {
          this.onPoll();
        } catch (err) {
          console.error('poll failed', err);
        }
      }, this.pollMs);
    }
    if (retryLater) this.timer = setTimeout(() => void this.connect(), 60_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

export const EVENT_TYPES = [
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
  'control',
  'budget',
  'moment',
] as const;
