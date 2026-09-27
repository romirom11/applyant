// `applyant candidate …` against a live daemon whose claude provider spawns the fake
// `claude` executable (the real ClaudeProvider and Agent SDK, no model).
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DAEMON_DIR = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/bin/claude', import.meta.url));

let home: string;
let daemon: ChildProcess;
let exited: Promise<number | null>;
let daemonOutput = '';

const env = () => ({
  ...process.env,
  APPLYANT_HOME: home,
  APPLYANT_POLL_MS: '50',
  APPLYANT_CLAUDE_PATH: FAKE_CLAUDE,
  // Offline lexical embeddings: no model download in tests.
  APPLYANT_EMBEDDER: 'hash',
  FAKE_CLAUDE_ARGV: join(home, 'fake-claude-argv.jsonl'),
  FAKE_CLAUDE_OUTPUT: join(home, 'fake-claude-output.json'),
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
    ).stdin?.end();
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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${daemonOutput}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

interface FactJson {
  id: number;
  project: string | null;
  text: string;
  kind: string;
  status: string;
  evidence: Array<{
    sourceKind: string;
    source: string;
    locator: string | null;
    excerpt: string | null;
  }>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'applyant-e2e-cand-'));
  writeFileSync(
    join(home, 'fake-claude-output.json'),
    JSON.stringify({
      projects: [
        {
          name: 'Nightingale',
          summary: 'Call analytics at Acme Voice',
          role: 'Senior Backend Engineer',
          period: '2021–2024',
          stack: ['Python'],
        },
        {
          name: 'Ledgerly',
          summary: null,
          role: 'Backend Engineer',
          period: '2018–2021',
          stack: ['Go'],
        },
      ],
      facts: [
        {
          text: 'Built the asynchronous call-analysis pipeline in Python',
          kind: 'personal_contribution',
          project: 'Nightingale',
          evidence: [
            {
              locator: 'page 1 · Experience',
              quote: 'Designed and built the asynchronous call-analysis pipeline',
            },
          ],
        },
        {
          text: 'Led a team of 4 engineers',
          kind: 'role',
          project: 'Nightingale',
          evidence: [{ locator: 'page 1 · Experience', quote: null }],
        },
        {
          text: 'Led a team of 10 engineers',
          kind: 'role',
          project: 'Ledgerly',
          evidence: [{ locator: 'page 1', quote: null }],
        },
        {
          text: 'Wrote the invoice reconciliation service in Go',
          kind: 'personal_contribution',
          project: 'Ledgerly',
          evidence: [{ locator: 'page 1 · Experience', quote: null }],
        },
        {
          text: 'Speaks Greek natively',
          kind: 'other',
          project: null,
          evidence: [{ locator: 'page 2 · Languages', quote: 'Greek (native)' }],
        },
      ],
    }),
  );
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
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('applyant candidate', () => {
  it('imports a CV into projects and facts to confirm', async () => {
    expect(await cliJson(['candidate', 'show'])).toMatchObject({
      projects: [],
      profileSources: [],
    });

    const set = await cli(['candidate', 'profile', 'set', 'github_logins', 'alexgh,', 'AlexOther']);
    expect(set.stdout.trim()).toBe('github_logins: alexgh, AlexOther');
    const bad = await cli(['candidate', 'profile', 'set', 'commit_emails', 'not-an-email']);
    expect(bad).toMatchObject({ code: 1 });
    expect(bad.stderr).toMatch(/not an email address/);

    const added = await cli([
      'candidate',
      'project',
      'add',
      'Nightingale',
      '--stack',
      'Python, FastAPI',
    ]);
    expect(added.stdout).toMatch(/Added project nightingale/);

    const source = await cliJson<{
      created: boolean;
      source: { id: number; kind: string; locator: string };
    }>(['candidate', 'source', 'add', 'profile', 'file', 'test/fixtures/cv/cv.pdf']);
    expect(source).toMatchObject({
      created: true,
      source: { kind: 'file', locator: join(DAEMON_DIR, 'test/fixtures/cv/cv.pdf') },
    });

    const facts = await waitFor('facts extracted', async () => {
      const rows = await cliJson<FactJson[]>(['candidate', 'fact', 'list']);
      return rows.length === 5 ? rows : undefined;
    });
    expect(facts.every((f) => f.status === 'unconfirmed')).toBe(true);
    expect(facts.find((f) => f.text.startsWith('Speaks Greek'))).toMatchObject({ project: null });

    // The fake claude was spawned at exactly the configured path.
    const start = JSON.parse(
      readFileSync(join(home, 'fake-claude-argv.jsonl'), 'utf8').split('\n')[0] ?? '{}',
    );
    expect(start.argv[1]).toBe(FAKE_CLAUDE);
    expect(start.argv).toEqual(expect.arrayContaining(['--model', 'sonnet']));

    const projects = await cliJson<
      Array<{ slug: string; facts: number; role: string | null; stack: string[] }>
    >(['candidate', 'project', 'list']);
    expect(projects.map((p) => p.slug)).toEqual(['ledgerly', 'nightingale']);
    expect(projects.find((p) => p.slug === 'nightingale')).toMatchObject({
      facts: 2,
      role: 'Senior Backend Engineer',
      stack: ['Python', 'FastAPI'],
    });

    const listing = await cli(['candidate', 'fact', 'list', 'nightingale']);
    expect(listing.stdout).toMatch(
      /^nightingale\n {2}\? #\d+ {2}Built the asynchronous call-analysis pipeline in Python/,
    );
    expect(listing.stdout).toContain(
      '↳ cv.pdf · page 1 · Experience  "Designed and built the asynchronous call-analysis pipeline"',
    );
    expect(listing.stdout).toMatch(/2 unconfirmed\. Confirm with/);

    const show = await cli(['candidate', 'show']);
    expect(show.stdout).toMatch(/github_logins\s+alexgh, AlexOther/);
    expect(show.stdout).toMatch(
      /5 new facts, 0 already known, 0 dropped · 1 projects created · cv\.pdf/,
    );
  });

  it('confirms, edits and rejects facts', async () => {
    const facts = await cliJson<FactJson[]>(['candidate', 'fact', 'list']);
    const id = (s: string) => String(facts.find((f) => f.text.includes(s))?.id);

    const confirmed = await cli([
      'candidate',
      'fact',
      'confirm',
      id('call-analysis'),
      `#${id('Greek')}`,
    ]);
    expect(confirmed.stdout).toMatch(/✓ #\d+ Built the asynchronous/);
    const edited = await cli([
      'candidate',
      'fact',
      'edit',
      id('team of 10'),
      'Led',
      'a',
      'team',
      'of',
      '3',
      'engineers',
    ]);
    expect(edited.stdout).toMatch(/✓ #\d+ Led a team of 3 engineers/);
    const rejected = await cli(['candidate', 'fact', 'reject', id('invoice')]);
    expect(rejected.stdout).toMatch(/✗ #\d+ Wrote the invoice/);

    const after = await cliJson<FactJson[]>(['candidate', 'fact', 'list', '--status', 'confirmed']);
    expect(after.map((f) => f.text).sort()).toEqual([
      'Built the asynchronous call-analysis pipeline in Python',
      'Led a team of 3 engineers',
      'Speaks Greek natively',
    ]);
    const unknown = await cli(['candidate', 'fact', 'confirm', '9999']);
    expect(unknown).toMatchObject({ code: 1 });
    expect(unknown.stderr).toMatch(/no fact 9999/);
  });

  it('syncs again only when asked, and streams the task events', async () => {
    const sync = await cli(['candidate', 'sync']);
    expect(sync.stdout).toMatch(/#\d+ file\s+queued/);
    await waitFor('unchanged sync', async () => {
      const show = await cliJson<{ profileSources: Array<{ syncNote: string | null }> }>([
        'candidate',
        'show',
      ]);
      return show.profileSources[0]?.syncNote?.startsWith('unchanged') ? true : undefined;
    });
    const starts = readFileSync(join(home, 'fake-claude-argv.jsonl'), 'utf8').trim().split('\n');
    expect(starts).toHaveLength(1);

    const events = (await cli(['runs', 'show', '--json', '-n', '200'])).stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const sync1 = events.filter((e) => e.taskKind === 'sync_source').map((e) => e.event);
    expect(sync1.slice(0, 2)).toEqual(['queued', 'started']);
    expect(events.some((e) => /extractor · claude:sonnet · started/.test(e.message))).toBe(true);
    expect(events.some((e) => /^source \d+: 5 new facts/.test(e.message))).toBe(true);
  });

  it('reports bad input clearly', async () => {
    const noProject = await cli([
      'candidate',
      'source',
      'add',
      'nope',
      'url',
      'https://example.com',
    ]);
    expect(noProject).toMatchObject({ code: 1 });
    expect(noProject.stderr).toMatch(/no project "nope"/);
    const badKind = await cli(['candidate', 'source', 'add', 'nightingale', 'ftp', 'x']);
    expect(badKind.stderr).toMatch(/unknown source kind "ftp"/);
    const missing = await cli(['candidate', 'source', 'add', 'profile', 'file', 'no-such.pdf']);
    expect(missing.stderr).toMatch(/no file at/);
  });
});
