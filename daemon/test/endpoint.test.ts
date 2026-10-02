// The "already running" check: a live pid alone isn't a running daemon (after a crash and a
// reboot the recorded pid usually belongs to some other process), it must answer on its port.
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { daemonRunning, listens } from '../src/endpoint.ts';

describe('daemonRunning', () => {
  it('needs the recorded port to answer, not only a live pid', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const endpoint = { version: 1 as const, host: '127.0.0.1', port, token: 't', pid: process.pid };
    expect(await daemonRunning(endpoint)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The pid (this test) is alive, but nothing listens there any more: a stale file.
    expect(await listens(endpoint)).toBe(false);
    expect(await daemonRunning(endpoint)).toBe(false);
    // A dead pid is never running.
    expect(await daemonRunning({ ...endpoint, pid: 2 ** 22 + 12345 })).toBe(false);
  });
});
