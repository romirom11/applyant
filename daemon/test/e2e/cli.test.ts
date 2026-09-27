// Spawns applyantd on a temp APPLYANT_HOME and drives it only through the `applyant` CLI.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SiteServer, startSiteServer } from '../helpers/site-server.ts';

const DAEMON_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SECRET = 'jev_e2e_5d1c9b7a3e2f4a6b';

let site: SiteServer;
let home: string;
let daemon: ChildProcess;
let daemonOutput = '';
let exited: Promise<number | null>;

const env = () => ({
  ...process.env,
  APPLYANT_HOME: home,
  APPLYANT_POLL_MS: '50',
  APPLYANT_NAV_TIMEOUT_MS: '15000',
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], input?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['src/cli/index.ts', ...args],
      { cwd: DAEMON_DIR, env: env(), timeout: 30_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

async function cliJson<T>(args: string[]): Promise<T> {
  const res = await cli([...args, '--json']);
  if (res.code !== 0) throw new Error(`applyant ${args.join(' ')} failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface PostingJson {
  id: number;
  stage: string;
  canonicalUrl: string;
  title: string | null;
  verifyNote: string | null;
  sources: Array<{ kind: string; url: string }>;
}

beforeAll(async () => {
  site = await startSiteServer();
  home = mkdtempSync(join(tmpdir(), 'applyant-e2e-'));
  daemon = spawn(process.execPath, ['src/main.ts'], { cwd: DAEMON_DIR, env: env() });
  daemon.stdout?.on('data', (d) => {
    daemonOutput += d;
  });
  daemon.stderr?.on('data', (d) => {
    daemonOutput += d;
  });
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

describe('applyant CLI against a live daemon', () => {
  it('writes a private endpoint file and rejects calls without the token', async () => {
    const file = join(home, 'endpoint.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    const endpoint = JSON.parse(readFileSync(file, 'utf8'));
    expect(endpoint).toMatchObject({ host: '127.0.0.1', pid: daemon.pid });
    const url = `http://127.0.0.1:${endpoint.port}/applyant.v1.ApplyantService/ListPostings`;
    const noToken = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(wrongToken.status).toBe(401);
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
      body: '{}',
    });
    expect(ok.status).toBe(200);
  });

  it('jobs add → verify_posting → verified / failed_verification', async () => {
    const live = await cliJson<{ created: boolean; posting: PostingJson }>([
      'jobs',
      'add',
      site.url('/live.html?utm_source=e2e'),
    ]);
    expect(live.created).toBe(true);
    expect(live.posting.stage).toBe('found');
    expect(live.posting.canonicalUrl).toBe(site.url('/live.html'));

    const gone = await cliJson<{ created: boolean; posting: PostingJson }>([
      'jobs',
      'add',
      site.url('/gone.html'),
    ]);

    const list = await waitFor('both postings verified', async () => {
      const rows = await cliJson<PostingJson[]>(['jobs', 'list']);
      return rows.every((r) => r.stage !== 'found') ? rows : undefined;
    });
    expect(list.find((r) => r.id === live.posting.id)).toMatchObject({
      stage: 'verified',
      title: 'Senior AI Engineer',
      verifyNote: 'apply form on page',
    });
    expect(list.find((r) => r.id === gone.posting.id)).toMatchObject({
      stage: 'failed_verification',
      verifyNote: 'HTTP 404',
    });

    const verifiedOnly = await cliJson<PostingJson[]>(['jobs', 'list', '--stage', 'verified']);
    expect(verifiedOnly.map((r) => r.id)).toEqual([live.posting.id]);

    const table = await cli(['jobs', 'list']);
    expect(table.stdout).toMatch(/ID\s+STAGE\s+COMPANY\s+TITLE\s+URL/);
    expect(table.stdout).toMatch(/failed_verification/);

    // The same page with other tracking params is the same posting, with a second source.
    const again = await cliJson<{ created: boolean; posting: PostingJson }>([
      'jobs',
      'add',
      site.url('/live.html#apply'),
    ]);
    expect(again).toMatchObject({ created: false, posting: { id: live.posting.id } });
    const shown = await cliJson<PostingJson>(['jobs', 'show', String(live.posting.id)]);
    expect(shown.sources.map((s) => s.url)).toEqual([
      site.url('/live.html?utm_source=e2e'),
      site.url('/live.html#apply'),
    ]);

    const text = await cli(['jobs', 'show', String(live.posting.id)]);
    expect(text.stdout).toContain('Senior AI Engineer · Acme AI');
    expect(text.stdout).toContain('apply form on page');

    const events = (
      await cli(['runs', 'show', '--json', '--posting', String(gone.posting.id)])
    ).stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.event ?? e.stage)).toEqual([
      'found',
      'queued',
      'started',
      'progress',
      'failed_verification',
      'done',
    ]);
  });

  it('reports bad input clearly', async () => {
    const bad = await cli(['jobs', 'add', 'ftp://example.com/job']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/only http\(s\) URLs/);
    const missing = await cli(['jobs', 'show', '9999']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/posting 9999 not found/);
  });

  it('runs show --follow streams task events as they happen', async () => {
    const follow = spawn(
      process.execPath,
      ['src/cli/index.ts', 'runs', 'show', '--follow', '-n', '1'],
      {
        cwd: DAEMON_DIR,
        env: env(),
      },
    );
    let out = '';
    follow.stdout.on('data', (d) => {
      out += d;
    });
    try {
      // Let it print the one past event and subscribe.
      await waitFor('follow started', async () => (out.length > 0 ? true : undefined));
      const added = await cliJson<{ posting: PostingJson }>([
        'jobs',
        'add',
        site.url('/apply-link.html'),
      ]);
      const id = added.posting.id;
      await waitFor('streamed verification', async () =>
        out.includes(`posting ${id} → verified`) ? true : undefined,
      );
      expect(out).toMatch(new RegExp(`task \\d+ verify_posting\\(${id}\\)\\s+started`));
      expect(out).toContain(`apply form at ${site.url('/form.html')}`);
    } finally {
      follow.kill('SIGINT');
    }
  });

  it('stores secrets write-only and never leaks values into logs or other files', async () => {
    const set = await cli(['secrets', 'set', 'jev'], `${SECRET}\n`);
    expect(set.code).toBe(0);
    expect(set.stdout + set.stderr).not.toContain(SECRET);
    expect(await cliJson<string[]>(['secrets', 'list'])).toEqual(['jev']);
    expect(statSync(join(home, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'secrets.json'), 'utf8')).toContain(SECRET);

    const bad = await cli(['secrets', 'set', 'Bad Name'], 'x\n');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/invalid secret name/);

    // Stop the daemon so every file is flushed, then scan everything except the secrets file.
    daemon.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(join(home, 'endpoint.json'))).toBe(false);
    expect(daemonOutput).toContain('applyantd stopped');
    expect(daemonOutput).not.toContain(SECRET);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const others = walk(home).filter((f) => !f.endsWith('secrets.json'));
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) {
      expect(readFileSync(file).includes(SECRET), file).toBe(false);
      expect(statSync(file).mode & 0o077, file).toBe(0);
    }
  });
});
