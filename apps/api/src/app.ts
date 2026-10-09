import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { isLaneId, type Db, type LaneId } from '@arena/core';
import * as q from './queries.js';
import { cachedCard } from './og.js';

export type AppDeps = {
  db: Db;
  ledgerDir: string;
  ogCache: string;
  dataDir: string;
  version?: string;
  sdkVersion?: string;
  now?: () => number;
  /** Stream tuning (tests shorten these). */
  stream?: { pollMs?: number; heartbeatMs?: number; maxConnections?: number; replayLimit?: number };
};

export const API_PREFIX = '/arena/api';

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const version = deps.version ?? '0.1.0';
  const sdkVersion = deps.sdkVersion ?? '0.2.0';
  const pollMs = deps.stream?.pollMs ?? 1000;
  const heartbeatMs = deps.stream?.heartbeatMs ?? 20_000;
  const maxConnections = deps.stream?.maxConnections ?? 500;
  const replayLimit = deps.stream?.replayLimit ?? 500;
  let connections = 0;

  const app = new Hono();
  const api = new Hono();

  api.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'public, max-age=5');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  const lane = (c: any): LaneId | null => {
    const id = c.req.param('lane');
    return id && isLaneId(id) && q.laneExists(deps.db, id) ? id : null;
  };
  const notFound = (c: any, what: string) => c.json({ error: `${what} not found` }, 404);
  const intParam = (v: string | undefined, fallback: number | null): number | null => {
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };
  const optionalLane = (c: any): LaneId | null | false => {
    const l = c.req.query('lane');
    if (!l) return null;
    return isLaneId(l) && q.laneExists(deps.db, l) ? l : false;
  };

  api.get('/health', (c) => {
    const body = q.health(deps.db, { now: now(), version, sdkVersion, dataDir: deps.dataDir });
    return c.json(body, 200, { 'Cache-Control': 'no-store' });
  });

  api.get('/lanes', (c) => c.json(q.lanes(deps.db)));

  api.get('/lanes/:lane/summary', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    return c.json(q.summary(deps.db, l, now()));
  });

  api.get('/lanes/:lane/population', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    return c.json(q.population(deps.db, l));
  });

  api.get('/lanes/:lane/cycles', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    return c.json(q.cycles(deps.db, l, intParam(c.req.query('limit'), 20) ?? 20, intParam(c.req.query('before'), null)));
  });

  api.get('/lanes/:lane/cycles/:n', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    const n = intParam(c.req.param('n'), null);
    const row = n === null ? null : q.cycle(deps.db, l, n);
    if (!row) return notFound(c, 'cycle');
    return c.json(row);
  });

  api.get('/lanes/:lane/tree', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    return c.json(q.tree(deps.db, l));
  });

  api.get('/lanes/:lane/graveyard', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    return c.json(q.graveyard(deps.db, l, intParam(c.req.query('cursor'), null), intParam(c.req.query('limit'), 50) ?? 50));
  });

  api.get('/lanes/:lane/strategies/:id', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    const s = q.strategy(deps.db, l, c.req.param('id'), now());
    if (!s) return notFound(c, 'strategy');
    return c.json(s);
  });

  api.get('/lanes/:lane/strategies/:id/trades', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    if (!q.strategy(deps.db, l, c.req.param('id'), now())) return notFound(c, 'strategy');
    return c.json(q.strategyTrades(deps.db, l, c.req.param('id')));
  });

  api.get('/lanes/:lane/equity', (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    return c.json(q.equity(deps.db, l, c.req.query('range') ?? '24h', now()));
  });

  api.get('/moments', (c) => {
    const l = optionalLane(c);
    if (l === false) return notFound(c, 'lane');
    return c.json(q.moments(deps.db, l, intParam(c.req.query('cursor'), null), intParam(c.req.query('limit'), 50) ?? 50));
  });

  api.get('/control', (c) => {
    const l = optionalLane(c);
    if (l === false) return notFound(c, 'lane');
    return c.json(q.control(deps.db, l));
  });

  api.get('/ledger', (c) => {
    const l = optionalLane(c);
    if (l === false) return notFound(c, 'lane');
    return c.json(q.ledger(deps.db, l, deps.ledgerDir));
  });

  api.get('/stream', (c) => {
    const l = optionalLane(c);
    if (l === false) return notFound(c, 'lane');
    if (connections >= maxConnections) return c.json({ error: 'too many open streams, poll instead' }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '10' });
    const laneFilter = l;
    const lastHeader = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId');
    let lastId = lastHeader !== undefined && lastHeader !== '' && Number.isFinite(Number(lastHeader)) ? Number(lastHeader) : q.maxEventId(deps.db);
    connections++;
    c.header('X-Accel-Buffering', 'no');
    const signal = c.req.raw.signal;
    return streamSSE(c, async (stream) => {
      let open = true;
      const stop = () => {
        open = false;
      };
      stream.onAbort(stop);
      signal?.addEventListener('abort', stop, { once: true });
      const alive = () => open && !signal?.aborted && deps.db.open;
      try {
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ lastEventId: lastId, ts: now() }) });
        let sinceBeat = 0;
        while (alive()) {
          const rows = q.eventsAfter(deps.db, laneFilter, lastId, replayLimit);
          for (const r of rows) {
            if (!alive()) break;
            await stream.writeSSE({ id: String(r.id), event: r.type, data: JSON.stringify(r) });
            lastId = r.id;
          }
          if (rows.length) sinceBeat = 0;
          await stream.sleep(pollMs);
          sinceBeat += pollMs;
          if (sinceBeat >= heartbeatMs && alive()) {
            await stream.write(`: heartbeat ${now()}\n\n`);
            sinceBeat = 0;
          }
        }
      } catch {
        // the client went away or the database closed; the page reconnects
      }
    });
  });

  api.get('/og/:lane/:file', async (c) => {
    const l = lane(c);
    if (!l) return notFound(c, 'lane');
    const file = c.req.param('file');
    if (!file.endsWith('.png')) return notFound(c, 'card');
    const id = file.slice(0, -4);
    const s = q.strategy(deps.db, l, id, now());
    if (!s) return notFound(c, 'strategy');
    const laneName = q.lanes(deps.db).find((x) => x.id === l)?.name ?? l;
    const png = await cachedCard(deps.ogCache, {
      lane: l,
      laneName,
      id: s.id,
      describe: s.describe,
      ci: s.ci,
      holdoutScore: s.holdoutScore,
      forwardScore: s.forwardScore,
      bornCycle: s.bornCycle,
      status: s.status,
      origin: s.origin,
    });
    return new Response(new Uint8Array(png), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
  });

  api.notFound((c) => c.json({ error: 'not found' }, 404));
  api.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json({ error: 'internal error' }, 500);
  });

  app.route(API_PREFIX, api);
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // Connection accounting for the stream: the counter drops once, whichever comes first, when the body ends,
  // the client cancels, or the request is aborted. The stream response also gets Cache-Control: no-store.
  const inner = app.fetch.bind(app);
  const fetch: typeof app.fetch = async (req, ...rest) => {
    const res = await inner(req, ...rest);
    const url = new URL(req.url);
    if (url.pathname === `${API_PREFIX}/stream` && res.status === 200 && res.body) {
      const body = res.body;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        connections = Math.max(0, connections - 1);
      };
      req.signal?.addEventListener('abort', release, { once: true });
      const counted = new ReadableStream({
        start(controller) {
          const reader = body.getReader();
          const pump = (): Promise<void> =>
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  release();
                  controller.close();
                  return;
                }
                controller.enqueue(value);
                return pump();
              })
              .catch((err) => {
                release();
                try {
                  controller.error(err);
                } catch {
                  // already closed
                }
              });
          void pump();
        },
        cancel() {
          release();
          void body.cancel().catch(() => undefined);
        },
      });
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(counted, { status: res.status, headers });
    }
    return res;
  };
  return { app, fetch, connections: () => connections };
}

export type ArenaApp = ReturnType<typeof createApp>;
