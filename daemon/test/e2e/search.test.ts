// Search from the CLI against a live daemon: the built-in boards are listed, a career page is
// added as a source, a strategy finds its postings on its own, a source that's off is never
// read, and the run's events show under `runs show`. The only site is a local test server.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SiteServer, startSiteServer } from '../helpers/site-server.ts';

const DAEMON_DIR = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/bin/claude', import.meta.url));

let site: SiteServer;
let home: string;
let daemon: ChildProcess;
let exited: Promise<number | null>;

const env = () => ({
  ...process.env,
  APPLYANT_HOME: home,
  APPLYANT_POLL_MS: '50',
  APPLYANT_NAV_TIMEOUT_MS: '15000',
  APPLYANT_CLAUDE_PATH: FAKE_CLAUDE,
  FAKE_CLAUDE_MODE: 'error',
  APPLYANT_CODEX_PATH: '/nonexistent/codex',
  APPLYANT_NATIVE_PATH: 'off',
  APPLYANT_EMBEDDER: 'hash',
  APPLYANT_JEV_URL: 'http://127.0.0.1:9/v1/systemone',
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['src/cli/index.ts', ...args],
      { cwd: DAEMON_DIR, env: env(), timeout: 30_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      },
    );
  });
}

async function cliJson<T>(args: string[]): Promise<T> {
  const res = await cli([...args, '--json']);
  if (res.code !== 0) throw new Error(`applyant ${args.join(' ')} failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface RunJson {
  id: number;
  status: string;
  added: number;
  note: string | null;
  sources: Array<{
    source: string;
    listed: number;
    matched: number;
    added: number;
    complete: boolean;
  }>;
}

beforeAll(async () => {
  site = await startSiteServer();
  home = mkdtempSync(join(tmpdir(), 'applyant-e2e-search-'));
  daemon = spawn(process.execPath, ['src/main.ts'], { cwd: DAEMON_DIR, env: env() });
  daemon.stdout?.resume();
  daemon.stderr?.resume();
  exited = new Promise((resolve) => daemon.once('exit', (code) => resolve(code)));
  await waitFor('endpoint file', async () =>
    existsSync(join(home, 'endpoint.json')) ? true : undefined,
  );
});

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await exited;
  }
  await site?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('search from the CLI', () => {
  it('a strategy over a career page finds its postings; a source that is off is not read', async () => {
    const listed = await cliJson<{
      kinds: Array<{ kind: string }>;
      sources: Array<{ key: string; completeList: boolean }>;
    }>(['search', 'sources', 'list']);
    expect(listed.sources.map((s) => s.key)).toEqual([
      'board:hn',
      'board:remoteok',
      'board:wwr',
      'board:remotive',
      'board:himalayas',
      'board:arbeitnow',
      'board:jobicy',
    ]);
    expect(listed.kinds.map((k) => k.kind)).toEqual([
      'greenhouse',
      'ashby',
      'lever',
      'workable',
      'page',
      'board',
    ]);

    const careers = site.url('/careers-jsonld.html');
    const added = await cliJson<{ created: boolean; source: { key: string; kind: string } }>([
      'search',
      'sources',
      'add',
      careers,
      '--label',
      'Acme AI',
    ]);
    expect(added).toMatchObject({
      created: true,
      source: { key: `page:${careers}`, kind: 'page' },
    });

    const strategy = await cliJson<{ id: number; runId: number; sourceKeys: string[] }>([
      'search',
      'strategies',
      'add',
      'Acme engineers',
      '--query',
      'engineer',
      '--sources',
      'page',
      '--every',
      '2h',
    ]);
    expect(strategy.sourceKeys).toEqual([`page:${careers}`]);
    const run = await waitFor('the first run', async () => {
      const runs = await cliJson<RunJson[]>(['search', 'runs']);
      return runs.find((r) => r.id === strategy.runId && r.status !== 'queued');
    });
    expect(run).toMatchObject({ status: 'done', added: 1 });
    expect(run.sources).toEqual([
      expect.objectContaining({
        source: `page:${careers}`,
        listed: 2,
        matched: 1,
        added: 1,
        complete: true,
      }),
    ]);
    const postings = await cliJson<Array<{ canonicalUrl: string; title: string | null }>>([
      'jobs',
      'list',
    ]);
    expect(postings.map((p) => [p.canonicalUrl, p.title])).toEqual([
      [site.url('/live.html'), 'Senior AI Engineer'],
    ]);

    const strategies = await cliJson<
      Array<{ name: string; stats: { found: number }; everyMinutes: number }>
    >(['search', 'strategies']);
    expect(strategies).toEqual([
      expect.objectContaining({
        name: 'Acme engineers',
        everyMinutes: 120,
        stats: expect.objectContaining({ found: 1 }),
      }),
    ]);

    // The run's events carry its id: the search, the posting it found, and its verification.
    const events = await cli(['runs', 'show', String(strategy.runId)]);
    expect(events.stdout).toContain(`search strategy ${strategy.id} queued`);
    expect(events.stdout).toContain('posting 1 → found');
    expect(events.stdout).toContain('verify_posting(1)');

    // Page sources off: the next run reads nothing.
    const off = await cli(['search', 'sources', 'off', 'page']);
    expect(off.stdout).toContain('switched off');
    const again = await cli(['search', 'strategies', 'run', 'Acme engineers']);
    const againId = Number(/as run (\d+)/.exec(again.stdout)?.[1]);
    const second = await waitFor('the second run', async () => {
      const runs = await cliJson<RunJson[]>(['search', 'runs', '--strategy', 'Acme engineers']);
      return runs.find((r) => r.id === againId && r.status !== 'queued');
    });
    expect(second).toMatchObject({
      note: 'no sources to read: every selected source is off',
      sources: [],
    });

    const paused = await cli(['search', 'strategies', 'pause', 'Acme engineers']);
    expect(paused.stdout).toContain('Paused strategy');
    const table = await cli(['search', 'strategies']);
    expect(table.stdout).toMatch(/Acme engineers\s+paused/);
    const bad = await cli(['search', 'strategies', 'add', 'Too often', '--every', '5m']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('at most every 60 minutes');
  });
});
