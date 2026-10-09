import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendChain, canonicalJson, readChain, sha256Hex, snapshotFileName, verifyChain } from '../src/ledger.js';

describe('ledger', () => {
  it('canonical JSON sorts keys at every level and drops whitespace', () => {
    const a = canonicalJson({ b: [{ z: 1, a: 2 }], a: 'x', c: { y: null, x: 1.5 } });
    const b = canonicalJson({ c: { x: 1.5, y: null }, a: 'x', b: [{ a: 2, z: 1 }] });
    expect(a).toBe(b);
    expect(a).toBe('{"a":"x","b":[{"a":2,"z":1}],"c":{"x":1.5,"y":null}}');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('builds a chain and detects tampering', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ledger-'));
    const chain = path.join(dir, 'chain.jsonl');
    const ts0 = Date.UTC(2026, 9, 9, 10, 0, 0);
    for (let i = 0; i < 3; i++) {
      const ts = ts0 + i * 3_600_000;
      const body = canonicalJson({ i, ts });
      const file = snapshotFileName(ts);
      fs.writeFileSync(path.join(dir, file), body);
      appendChain(chain, { ts, sha256: sha256Hex(body), file });
    }
    const entries = readChain(chain);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.prev_sha256).toBeNull();
    expect(entries[1]!.prev_sha256).toBe(entries[0]!.sha256);
    expect(entries[2]!.prev_sha256).toBe(entries[1]!.sha256);
    expect(verifyChain(chain, dir)).toEqual({ ok: true, checked: 3, firstBad: null });
    // tamper with the second snapshot
    fs.writeFileSync(path.join(dir, entries[1]!.file!), canonicalJson({ i: 1, ts: 0 }));
    const bad = verifyChain(chain, dir);
    expect(bad.ok).toBe(false);
    expect(bad.firstBad).toBe(1);
    expect(bad.reason).toMatch(/hash mismatch/);
    // break a link
    fs.writeFileSync(path.join(dir, entries[1]!.file!), canonicalJson({ i: 1, ts: ts0 + 3_600_000 }));
    const lines = fs.readFileSync(chain, 'utf8').trim().split('\n');
    const third = JSON.parse(lines[2]!);
    third.prev_sha256 = 'deadbeef';
    lines[2] = JSON.stringify(third);
    fs.writeFileSync(chain, lines.join('\n') + '\n');
    expect(verifyChain(chain, dir)).toMatchObject({ ok: false, firstBad: 2, reason: 'prev link mismatch' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
