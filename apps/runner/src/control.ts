import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The control socket: one Unix socket per lane at <runDir>/<lane>.sock (a named pipe on Windows), owner the service
 * user, mode 600. Newline-delimited JSON: { id, cmd, args, actor } in, { id, ok, result } or { id, ok: false, error } out.
 */
export type ControlRequest = { id: number; cmd: string; args?: Record<string, unknown>; actor?: string };
export type ControlResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type ControlHandler = (cmd: string, args: Record<string, unknown>, actor: string) => Promise<unknown>;

export function socketPath(runDir: string, lane: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\arena-${lane}`;
  return path.join(runDir, `${lane}.sock`);
}

export function startControlServer(sock: string, handler: ControlHandler): Promise<net.Server> {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    try {
      fs.unlinkSync(sock);
    } catch {
      // not there
    }
  }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        let req: ControlRequest;
        try {
          req = JSON.parse(line) as ControlRequest;
        } catch {
          conn.write(JSON.stringify({ id: 0, ok: false, error: 'bad json' } satisfies ControlResponse) + '\n');
          continue;
        }
        handler(req.cmd, req.args ?? {}, req.actor ?? 'unknown')
          .then((result) => conn.write(JSON.stringify({ id: req.id, ok: true, result } satisfies ControlResponse) + '\n'))
          .catch((err: unknown) => conn.write(JSON.stringify({ id: req.id, ok: false, error: (err as Error)?.message ?? String(err) } satisfies ControlResponse) + '\n'));
      }
    });
    conn.on('error', () => conn.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(sock, 0o600);
        } catch {
          // best effort
        }
      }
      resolve(server);
    });
  });
}

/** One request to a lane's control socket. */
export function controlCall(sock: string, cmd: string, args: Record<string, unknown> = {}, actor = 'cli', timeoutMs = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    const id = Date.now();
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`control call ${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    conn.setEncoding('utf8');
    conn.once('connect', () => conn.write(JSON.stringify({ id, cmd, args, actor } satisfies ControlRequest) + '\n'));
    conn.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      conn.end();
      try {
        const res = JSON.parse(buf.slice(0, nl)) as ControlResponse;
        if (res.ok) resolve(res.result);
        else reject(new Error(res.error));
      } catch (err) {
        reject(err as Error);
      }
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot reach ${sock}: ${err.message}`));
    });
  });
}
