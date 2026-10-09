import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A mock Hyperliquid: POST /info (candleSnapshot, metaAndAssetCtxs, fundingHistory) and a WebSocket candle feed.
 * Prices are a deterministic random walk per coin. "Now" for the mock is a cursor that starts `behindIntervals`
 * bars before the real clock and advances one bar per tick, so every emitted candle is already closed.
 * POST /control { action: 'drop' | 'skip' | 'pause' | 'resume' | 'state', n? } steers it from tests.
 */
export type MockOptions = {
  coins?: string[];
  intervals?: string[];
  tickMs?: number;
  behindIntervals?: number;
  seed?: number;
  port?: number;
};

const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };

type Candle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };

export type MockHL = {
  infoUrl: string;
  wsUrl: string;
  port: number;
  control(action: 'drop' | 'skip' | 'pause' | 'resume', n?: number): void;
  state(): { cursor: Record<string, number>; emitted: number; sockets: number };
  close(): Promise<void>;
};

export async function startMockHL(opts: MockOptions = {}): Promise<MockHL> {
  const coins = opts.coins ?? ['BTC', 'ETH', 'SOL', 'HYPE'];
  const tickMs = opts.tickMs ?? 100;
  const behind = opts.behindIntervals ?? 2000;
  const base: Record<string, number> = { BTC: 80_000, ETH: 3_000, SOL: 150, HYPE: 30 };
  // deterministic prices per coin, interval and bar index, with no dependence on earlier bars (closed form plus hashed noise)
  const origin = Date.UTC(2025, 0, 1);
  const hash = (n: number, salt: number) => {
    let x = Math.imul(n ^ (salt * 0x9e3779b1), 0x85ebca6b) ^ (opts.seed ?? 1);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const close = (coin: string, interval: string, idx: number) => {
    const b = base[coin] ?? 100;
    const salt = coin.length * 131 + interval.length * 17;
    const trend = 1 + 0.12 * Math.sin(idx / 160 + salt) + 0.05 * Math.sin(idx / 23 + salt * 2) + 0.015 * Math.sin(idx / 5);
    return b * trend * (1 + (hash(idx, salt) - 0.5) * 0.01);
  };
  const price = (coin: string, interval: string, idx: number) => {
    const o = close(coin, interval, idx - 1);
    const c = close(coin, interval, idx);
    const salt = coin.length * 131 + interval.length * 17;
    const h = Math.max(o, c) * (1 + hash(idx, salt + 1) * 0.004);
    const l = Math.min(o, c) * (1 - hash(idx, salt + 2) * 0.004);
    const v = 40 + hash(idx, salt + 3) * 120;
    return { o, h, l, c, v };
  };
  const candle = (coin: string, interval: string, t: number): Candle => {
    const ms = INTERVAL_MS[interval] ?? 900_000;
    const idx = Math.floor((t - origin) / ms);
    const p = price(coin, interval, idx);
    return { t, T: t + ms - 1, s: coin, i: interval, o: String(p.o), c: String(p.c), h: String(p.h), l: String(p.l), v: String(p.v), n: 10 };
  };

  // the mock clock: one cursor per interval (all coins of an interval share it)
  const cursor: Record<string, number> = {};
  const cursorFor = (interval: string) => {
    const ms = INTERVAL_MS[interval] ?? 900_000;
    if (cursor[interval] === undefined) cursor[interval] = Math.floor((Date.now() - behind * ms) / ms) * ms;
    return cursor[interval]!;
  };

  const sockets = new Set<WebSocket>();
  const subs = new Map<WebSocket, Array<{ coin: string; interval: string }>>();
  let paused = false;
  let emitted = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (v: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
      let msg: any;
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      if (req.url === '/control') {
        control(msg.action, msg.n);
        return json(state());
      }
      if (req.url !== '/info') return json({ error: 'not found' }, 404);
      if (msg.type === 'candleSnapshot') {
        const { coin, interval, startTime, endTime } = msg.req;
        const ms = INTERVAL_MS[interval] ?? 900_000;
        const last = cursorFor(interval); // nothing after the mock's now
        const out: Candle[] = [];
        for (let t = Math.ceil(startTime / ms) * ms; t <= Math.min(endTime, last) && out.length < 5000; t += ms) out.push(candle(coin, interval, t));
        return json(out);
      }
      if (msg.type === 'metaAndAssetCtxs') {
        const ctxs = coins.map((c) => {
          const t = cursorFor('15m');
          const p = candle(c, '15m', t);
          return { funding: '0.0000125', openInterest: String(1000 + ((t / 900_000) % 50) * 3), premium: '0.0004', markPx: p.c, oraclePx: String(Number(p.c) * 0.9995), midPx: p.c };
        });
        return json([{ universe: coins.map((name) => ({ name, szDecimals: 3 })) }, ctxs]);
      }
      if (msg.type === 'fundingHistory') {
        const { coin, startTime, endTime } = msg;
        const out: Array<{ coin: string; fundingRate: string; premium: string; time: number }> = [];
        const end = Math.min(endTime ?? Date.now(), cursorFor('15m'));
        for (let t = Math.ceil(startTime / 3_600_000) * 3_600_000; t <= end && out.length < 500; t += 3_600_000) out.push({ coin, fundingRate: '0.0000125', premium: '0.0004', time: t });
        return json(out);
      }
      return json({ error: `unknown type ${msg.type}` }, 400);
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    subs.set(ws, []);
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.method === 'ping') ws.send(JSON.stringify({ channel: 'pong' }));
      if (msg.method === 'subscribe' && msg.subscription?.type === 'candle') subs.get(ws)!.push({ coin: msg.subscription.coin, interval: msg.subscription.interval });
    });
    ws.on('close', () => {
      sockets.delete(ws);
      subs.delete(ws);
    });
  });

  const tick = () => {
    if (paused) return;
    const done = new Set<string>();
    for (const [ws, list] of subs) {
      for (const s of list) {
        const key = `${s.interval}`;
        if (!done.has(key)) {
          done.add(key);
          cursor[s.interval] = cursorFor(s.interval) + (INTERVAL_MS[s.interval] ?? 900_000);
        }
      }
      for (const s of list) {
        const t = cursorFor(s.interval);
        if (t + (INTERVAL_MS[s.interval] ?? 900_000) > Date.now()) continue; // never emit a still-forming candle
        ws.send(JSON.stringify({ channel: 'candle', data: candle(s.coin, s.interval, t) }));
        emitted++;
      }
    }
  };
  const timer = setInterval(tick, tickMs);

  const control = (action: string, n = 1) => {
    if (action === 'drop') for (const ws of sockets) ws.terminate();
    else if (action === 'skip') for (const k of Object.keys(cursor)) cursor[k] = cursor[k]! + n * (INTERVAL_MS[k] ?? 900_000);
    else if (action === 'pause') paused = true;
    else if (action === 'resume') paused = false;
  };
  const state = () => ({ cursor: { ...cursor }, emitted, sockets: sockets.size });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    infoUrl: `http://127.0.0.1:${port}/info`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    port,
    control,
    state,
    close: () =>
      new Promise<void>((r) => {
        clearInterval(timer);
        for (const ws of sockets) ws.terminate();
        wss.close(() => server.close(() => r()));
      }),
  };
}
