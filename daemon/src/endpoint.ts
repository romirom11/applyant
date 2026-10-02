// The file clients read to reach the daemon: {port, token, pid}, mode 0600.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { writePrivateFile } from './util/fs.ts';

export interface Endpoint {
  version: 1;
  host: string;
  port: number;
  token: string;
  pid: number;
}

export function writeEndpoint(path: string, endpoint: Endpoint): void {
  writePrivateFile(path, `${JSON.stringify(endpoint)}\n`);
}

export function readEndpoint(path: string): Endpoint | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Endpoint;
}

export function removeEndpoint(path: string, pid: number): void {
  const current = (() => {
    try {
      return readEndpoint(path);
    } catch {
      return null;
    }
  })();
  if (current?.pid === pid) rmSync(path, { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether something accepts connections where the endpoint says the daemon listens. */
export function listens(
  endpoint: Pick<Endpoint, 'host' | 'port'>,
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Whether the daemon an endpoint file names is really running. A live pid alone proves
 * nothing: after a crash and a reboot the recorded pid usually belongs to some other process,
 * and the file would keep the daemon from ever starting again. So it must also answer on its port.
 */
export async function daemonRunning(endpoint: Endpoint): Promise<boolean> {
  return isAlive(endpoint.pid) && (await listens(endpoint));
}
