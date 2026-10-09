import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockHL } from './mock-hl.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, '..');
export const mainJs = path.join(appDir, 'dist', 'main.js');

/** Build the runner once so children run the current sources. */
export function buildRunner(): void {
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsup'], { cwd: appDir, stdio: 'ignore', shell: process.platform === 'win32' });
}

export type TestDirs = { dataDir: string; runDir: string; dbPath: string };

export function makeDirs(prefix: string): TestDirs {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runDir = process.platform === 'win32' ? dataDir : fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}run-`));
  return { dataDir, runDir, dbPath: path.join(dataDir, 'arena.db') };
}

export function childEnv(dirs: TestDirs, mock: MockHL, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARENA_DATA_DIR: dirs.dataDir,
    ARENA_RUN_DIR: dirs.runDir,
    ARENA_DB: dirs.dbPath,
    ARENA_FAST: '1',
    ARENA_FAKE_LLM: '1',
    ARENA_HL_WS_URL: mock.wsUrl,
    ARENA_HL_INFO_URL: mock.infoUrl,
    ARENA_STALE_INTERVALS: '100000',
    ARENA_WEIGHT_PER_MINUTE: '1000000',
    ARENA_HEARTBEAT_MS: '1000',
    ARENA_BUDGET_USD_PER_LANE: '100',
    ...extra,
  };
}

export type Child = { lane: string; proc: ChildProcess; log: string[] };

export function startLane(lane: string, env: NodeJS.ProcessEnv): Child {
  const proc = spawn(process.execPath, [mainJs, lane], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log.push(line);
    if (log.length > 400) log.splice(0, log.length - 400);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  return { lane, proc, log };
}

export function waitExit(proc: ChildProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve({ code: proc.exitCode, signal: proc.signalCode });
    const t = setTimeout(() => proc.kill('SIGKILL'), ms);
    proc.once('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

export async function stopLane(child: Child): Promise<void> {
  if (child.proc.exitCode !== null) return;
  child.proc.kill('SIGTERM');
  await waitExit(child.proc, 60_000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
