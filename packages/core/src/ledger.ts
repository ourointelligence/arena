import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Canonical JSON: keys sorted at every level, no whitespace, numbers exactly as JSON.stringify writes them. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export type ChainEntry = { ts: number; sha256: string; prev_sha256: string | null; file?: string };

/** Read every entry of a chain.jsonl file (missing file = empty chain). Corrupt lines are skipped. */
export function readChain(file: string): ChainEntry[] {
  if (!fs.existsSync(file)) return [];
  const out: ChainEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChainEntry);
    } catch {
      // skip
    }
  }
  return out;
}

/** Append { ts, sha256, prev_sha256, file } to chain.jsonl, linking to the previous entry's hash. Returns the entry. */
export function appendChain(file: string, entry: { ts: number; sha256: string; file?: string }): ChainEntry {
  const prev = readChain(file);
  const last = prev[prev.length - 1];
  const row: ChainEntry = { ts: entry.ts, sha256: entry.sha256, prev_sha256: last ? last.sha256 : null };
  if (entry.file) row.file = entry.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

export type ChainVerification = { ok: boolean; checked: number; firstBad: number | null; reason?: string };

/**
 * Recompute every snapshot hash and every prev link of a chain. `snapshotsDir` holds the files named in each entry
 * (or `<ISO ts>.json` when the entry has no file name). Returns the index of the first bad entry.
 */
export function verifyChain(chainFile: string, snapshotsDir: string): ChainVerification {
  const entries = readChain(chainFile);
  let prev: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if ((e.prev_sha256 ?? null) !== prev) return { ok: false, checked: i, firstBad: i, reason: 'prev link mismatch' };
    const name = e.file ?? `${new Date(e.ts).toISOString()}.json`;
    const file = path.join(snapshotsDir, path.basename(name));
    if (!fs.existsSync(file)) return { ok: false, checked: i, firstBad: i, reason: `missing ${path.basename(name)}` };
    const actual = sha256Hex(fs.readFileSync(file));
    if (actual !== e.sha256) return { ok: false, checked: i, firstBad: i, reason: `hash mismatch in ${path.basename(name)}` };
    prev = e.sha256;
  }
  return { ok: true, checked: entries.length, firstBad: null };
}

/** File name for the snapshot of one hour: 2026-10-09T13.json (minutes dropped, one per hour). */
export function snapshotFileName(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 13)}.json`;
}
