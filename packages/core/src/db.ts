import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

export type OpenOptions = { readonly?: boolean; migrate?: boolean };

/**
 * Migrations run in order; each entry runs once and is recorded in the `migrations` table.
 * Never edit an entry that has shipped; add a new one.
 */
export const migrations: Array<{ id: string; sql: string }> = [
  {
    id: '001_init',
    sql: `
CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  assets TEXT NOT NULL,
  tf TEXT NOT NULL,
  packs TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  sdk_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'stopped',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cycles (
  lane_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  outcome TEXT,
  diagnosis TEXT,
  patterns TEXT NOT NULL DEFAULT '[]',
  pop_ci REAL,
  best_ci REAL,
  velocity REAL,
  ceiling INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (lane_id, n)
);
CREATE INDEX IF NOT EXISTS cycles_lane_started ON cycles (lane_id, started_at);
CREATE INDEX IF NOT EXISTS cycles_lane_ended ON cycles (lane_id, ended_at);
CREATE TABLE IF NOT EXISTS strategies (
  lane_id TEXT NOT NULL,
  id TEXT NOT NULL,
  origin TEXT NOT NULL,
  born_cycle INTEGER NOT NULL,
  parents TEXT NOT NULL DEFAULT '[]',
  describe TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',
  bounds TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  died_cycle INTEGER,
  reject_reason TEXT,
  train_score REAL,
  holdout_score REAL,
  ci REAL,
  trades INTEGER NOT NULL DEFAULT 0,
  forward_score REAL,
  forward_trades INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lane_id, id)
);
CREATE INDEX IF NOT EXISTS strategies_lane_created ON strategies (lane_id, created_at);
CREATE INDEX IF NOT EXISTS strategies_lane_status ON strategies (lane_id, status);
CREATE TABLE IF NOT EXISTS candidates (
  lane_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  strategy_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  stage TEXT NOT NULL,
  reason TEXT,
  train_score REAL,
  holdout_score REAL,
  PRIMARY KEY (lane_id, cycle, strategy_id)
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  entry REAL NOT NULL,
  exit REAL NOT NULL,
  pnl REAL NOT NULL,
  fees REAL NOT NULL,
  funding REAL NOT NULL DEFAULT 0,
  drawdown REAL NOT NULL,
  score REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_lane_closed ON trades (lane_id, closed_at);
CREATE INDEX IF NOT EXISTS trades_lane_strategy ON trades (lane_id, strategy_id, closed_at);
CREATE TABLE IF NOT EXISTS equity (
  lane_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ensemble_equity REAL NOT NULL,
  benchmark_equity REAL NOT NULL,
  PRIMARY KEY (lane_id, ts)
);
CREATE INDEX IF NOT EXISTS equity_lane_ts ON equity (lane_id, ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_lane_ts ON events (lane_id, ts);
CREATE INDEX IF NOT EXISTS events_lane_id ON events (lane_id, id);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  strategy_id TEXT,
  key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moments_lane_ts ON moments (lane_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS moments_lane_key ON moments (lane_id, key);
CREATE TABLE IF NOT EXISTS lane_kv (
  lane_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (lane_id, key)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  prev_sha256 TEXT,
  file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_lane_ts ON snapshots (lane_id, ts);
CREATE TABLE IF NOT EXISTS spend (
  day TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, lane_id)
);
CREATE TABLE IF NOT EXISTS control (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS control_lane_ts ON control (lane_id, ts);
CREATE TABLE IF NOT EXISTS lane_state (
  lane_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'stopped',
  last_bar_ts INTEGER,
  last_cycle_ts INTEGER,
  ws_connected INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  started_at INTEGER,
  seen_at INTEGER,
  sdk_version TEXT,
  model TEXT,
  budget_usd REAL,
  approval_on INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cycle_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  step TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS cycle_steps_lane_cycle ON cycle_steps (lane_id, cycle, ts);
CREATE INDEX IF NOT EXISTS cycle_steps_lane_ts ON cycle_steps (lane_id, ts);
CREATE TABLE IF NOT EXISTS strategy_ci (
  lane_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  ci REAL NOT NULL,
  PRIMARY KEY (lane_id, strategy_id, cycle)
);
`,
  },
];

/** Open (and create) arena.db. WAL mode, busy_timeout 5000, foreign keys on, migrations applied. */
export function openDb(file: string, opts: OpenOptions = {}): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const readonly = opts.readonly ?? false;
  const db = new Database(file, { readonly, fileMustExist: readonly });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (!readonly) {
    // three lane processes open a fresh arena.db at the same moment on boot; switching the journal mode and the first
    // migration can hit SQLITE_BUSY outside the busy handler, so retry those steps for a while instead of crashing
    withBusyRetry(() => {
      if (file !== ':memory:') db.pragma('journal_mode = WAL');
    });
    if (opts.migrate ?? true) withBusyRetry(() => migrate(db));
  }
  return db;
}

function withBusyRetry<T>(fn: () => T, attempts = 40, waitMs = 250): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const busy = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked/i.test((err as Error).message ?? '');
      if (!busy || i >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export function migrate(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM migrations').all() as Array<{ id: string }>).map((r) => r.id));
  const applied: string[] = [];
  const insert = db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)');
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, Date.now());
    })();
    applied.push(m.id);
  }
  return applied;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
