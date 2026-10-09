#!/usr/bin/env node
/**
 * Serve the deterministic fixture database for page tests: pnpm --filter @arena/api run fixture [port]
 * Builds arena.db and ledger files in a temp folder, then serves the API on 127.0.0.1:<port> (default 8788).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixtureDb } from '@arena/core/fixture';
import { startServer } from './server.js';

const port = Number(process.argv[2] ?? process.env['ARENA_FIXTURE_PORT'] ?? 8788);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fixture-'));
const dbFile = path.join(dir, 'arena.db');
const { db, summary } = createFixtureDb(dbFile, { now: Date.now(), ledgerDir: path.join(dir, 'ledger') });
db.close();
console.log(`[fixture] built ${dbFile}: ${JSON.stringify(summary)}`);
const server = startServer({ db: dbFile, host: '127.0.0.1', port, ledgerDir: path.join(dir, 'ledger'), ogCache: path.join(dir, 'og'), dataDir: dir, sdkVersion: '0.2.0' });
const shutdown = () => {
  server.close().finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
