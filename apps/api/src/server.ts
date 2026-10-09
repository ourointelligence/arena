import { serve } from '@hono/node-server';
import { openDb, ARENA_VERSION } from '@arena/core';
import { createApp } from './app.js';

export type ServerConfig = {
  db: string;
  host: string;
  port: number;
  ledgerDir: string;
  ogCache: string;
  dataDir: string;
  sdkVersion: string;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env['ARENA_DATA_DIR'] ?? '/var/lib/arena';
  return {
    db: env['ARENA_DB'] ?? `${dataDir}/arena.db`,
    host: env['ARENA_API_HOST'] ?? '127.0.0.1',
    port: Number(env['ARENA_API_PORT'] ?? 8787),
    ledgerDir: env['ARENA_LEDGER_DIR'] ?? `${dataDir}/ledger`,
    ogCache: env['ARENA_OG_CACHE'] ?? `${dataDir}/og`,
    dataDir,
    sdkVersion: env['ARENA_SDK_VERSION'] ?? '0.2.0',
  };
}

/** Open the database read-only and serve the API. Returns a close function. */
export function startServer(cfg: ServerConfig, opts: { readonly?: boolean } = {}) {
  const db = openDb(cfg.db, { readonly: opts.readonly ?? true });
  const { fetch } = createApp({ db, ledgerDir: cfg.ledgerDir, ogCache: cfg.ogCache, dataDir: cfg.dataDir, version: ARENA_VERSION, sdkVersion: cfg.sdkVersion });
  const server = serve({ fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    console.log(`[api] listening on http://${info.address}:${info.port}/arena/api (db ${cfg.db})`);
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}
