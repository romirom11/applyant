// The file clients read to reach the daemon: {port, token, pid}, mode 0600.
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
