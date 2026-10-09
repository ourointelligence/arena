import fs from 'node:fs';
import path from 'node:path';
import { appendChain, canonicalJson, openDb, sha256Hex, snapshotFileName, verifyChain, type LaneId } from '@arena/core';

export type LedgerDeps = {
  /** Root of the ledger tree: <ledgerDir>/<lane>/<hour>.json and <ledgerDir>/<lane>/chain.jsonl. */
  ledgerDir: string;
  dbPath: string;
  /** Fetch the lane's export (through the control socket in production). */
  exportLane: (lane: LaneId) => Promise<unknown>;
  log?: (line: string) => void;
};

export type LedgerEntry = { lane: LaneId; file: string; sha256: string; prevSha256: string | null; ts: number };

/**
 * One hourly ledger entry for a lane: canonical JSON of the export, written as <ISO hour>.json, hashed, appended to
 * chain.jsonl with the previous hash, and recorded in the snapshots table.
 */
export async function ledgerSnapshot(lane: LaneId, deps: LedgerDeps, now = Date.now()): Promise<LedgerEntry | null> {
  const log = deps.log ?? (() => undefined);
  const laneDir = path.join(deps.ledgerDir, lane);
  fs.mkdirSync(laneDir, { recursive: true });
  let exported: unknown;
  try {
    exported = await deps.exportLane(lane);
  } catch (err) {
    log(`${lane}: no export (${(err as Error).message}); no snapshot`);
    return null;
  }
  const text = canonicalJson(exported);
  const file = snapshotFileName(now);
  fs.writeFileSync(path.join(laneDir, file), text);
  const sha256 = sha256Hex(text);
  const entry = appendChain(path.join(laneDir, 'chain.jsonl'), { ts: now, sha256, file });
  const db = openDb(deps.dbPath);
  try {
    db.prepare('INSERT INTO snapshots (lane_id, ts, sha256, prev_sha256, file) VALUES (?, ?, ?, ?, ?)').run(lane, now, sha256, entry.prev_sha256 ?? null, `${lane}/${file}`);
  } finally {
    db.close();
  }
  log(`${lane}: ${file} sha256 ${sha256} prev ${entry.prev_sha256 ?? 'none'}`);
  return { lane, file, sha256, prevSha256: entry.prev_sha256 ?? null, ts: now };
}

export function verifyLane(ledgerDir: string, lane: LaneId) {
  return verifyChain(path.join(ledgerDir, lane, 'chain.jsonl'), path.join(ledgerDir, lane));
}
