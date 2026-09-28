// Spawns applyantd on a temp APPLYANT_HOME and drives it only through the `applyant` CLI.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SiteServer, startSiteServer } from '../helpers/site-server.ts';

const DAEMON_DIR = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/bin/claude', import.meta.url));

// What the fake `claude` answers as the extractor for the live fixture posting. There are
// no candidate facts in this test, so every requirement is missing without a matcher call.
const EXTRACTION = {
  title: 'Senior AI Engineer',
  company: 'Acme AI',
  summary: 'Build production LLM systems.',
  seniority: 'senior',
  roleFamilies: ['ai_ml', 'backend'],
  requirements: [
    { text: 'Production LLM systems', must: true, kind: 'skill' },
    { text: 'Python', must: true, kind: 'skill' },
    { text: 'TypeScript', must: false, kind: 'skill' },
  ],
  workplace: 'remote',
  remoteRegions: ['europe'],
  remoteCountries: [],
  offices: [],
  salary: {
    min: 60000,
    max: 70000,
    currency: 'EUR',
    period: 'year',
    basis: 'gross',
    text: '€60,000–70,000 a year',
  },
  languages: [{ language: 'en', level: 'professional', required: true }],
  postingLanguage: 'en',
  employment: 'full_time',
  outstaffing: false,
};
const SECRET = 'jev_e2e_5d1c9b7a3e2f4a6b';

// What the fake `claude` answers as application_writer. Field classification has no model in
// this test, so the form's unlabelled-by-HTML name fields reach the writer as questions; the
// writer says only the candidate can answer them, as it must when the facts don't say.
const DRAFTS = ['q1', 'q2'].map((question) => ({
  question,
  status: 'needs_candidate',
  choice: null,
  sentences: [],
  missing: 'Your name as you want it on the application',
  adaptedFrom: null,
}));

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
  // Never the real claude or a model download from tests.
  APPLYANT_CLAUDE_PATH: FAKE_CLAUDE,
  // No codex, and no applyant-native: the tests never touch the real Keychain or login shell.
  APPLYANT_CODEX_PATH: '/nonexistent/codex',
  APPLYANT_NATIVE_PATH: 'off',
  FAKE_CLAUDE_OUTPUT: join(home, 'fake-claude-output.json'),
  APPLYANT_EMBEDDER: 'hash',
  // The secrets test stores a dummy Jev key: it must never reach the real API.
  APPLYANT_JEV_URL: 'http://127.0.0.1:9/v1/systemone',
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

interface AppField {
  number: number;
  label: string;
  value: string | null;
  source: string;
  defaultValue: string | null;
  missing: boolean;
}

interface AppJson {
  id: number;
  postingId: number;
  stage: string;
  title: string | null;
  fields: AppField[];
  answers: Array<{ status: string }>;
}

interface PostingJson {
  id: number;
  stage: string;
  canonicalUrl: string;
  title: string | null;
  verifyNote: string | null;
  sources: Array<{ kind: string; url: string }>;
  score: number | null;
  breakdown: Array<{ key: string; weight: number; value: number; note: string | null }>;
  requirements: Array<{ text: string; must: boolean; verdict: string }>;
  decision: string | null;
}

beforeAll(async () => {
  site = await startSiteServer();
  home = mkdtempSync(join(tmpdir(), 'applyant-e2e-'));
  writeFileSync(
    join(home, 'fake-claude-output.json'),
    JSON.stringify({ $bySchema: { requirements: EXTRACTION, drafts: { drafts: DRAFTS } } }),
    { mode: 0o600 },
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

  it('jobs add → verify_posting → score_posting → scored / failed_verification', async () => {
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

    const list = await waitFor('verified and scored', async () => {
      const rows = await cliJson<PostingJson[]>(['jobs', 'list']);
      return rows.every((r) => r.stage !== 'found' && r.stage !== 'verified') ? rows : undefined;
    });
    expect(list.find((r) => r.id === live.posting.id)).toMatchObject({
      stage: 'scored',
      title: 'Senior AI Engineer',
      verifyNote: 'apply form on page',
      // No preferences and no facts yet: only the (missing) requirements count.
      score: 0,
    });
    expect(list.find((r) => r.id === gone.posting.id)).toMatchObject({
      stage: 'failed_verification',
      verifyNote: 'HTTP 404',
    });

    const scoredOnly = await cliJson<PostingJson[]>(['jobs', 'list', '--stage', 'scored']);
    expect(scoredOnly.map((r) => r.id)).toEqual([live.posting.id]);

    const table = await cli(['jobs', 'list']);
    expect(table.stdout).toMatch(/ID\s+SCORE\s+STAGE\s+COMPANY\s+TITLE\s+FLAGS\s+URL/);
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
    // The extractor ran once, as the fake claude, for the live posting only.
    const extracted = readdirSync(join(home, 'files', 'runs')).filter((f) =>
      f.includes('extractor'),
    );
    expect(extracted).toHaveLength(1);

    expect(events.map((e) => e.event ?? e.stage)).toEqual([
      'found',
      'queued',
      'started',
      'progress',
      'failed_verification',
      'done',
    ]);
  });

  it('reads the application form read-only and prints it with --form', async () => {
    const [scored] = await cliJson<PostingJson[]>(['jobs', 'list', '--stage', 'scored']);
    if (!scored) throw new Error('no scored posting');
    const id = String(scored.id);
    const read = await waitFor('the form read', async () => {
      const p = await cliJson<PostingJson & { formStatus: string | null }>(['jobs', 'show', id]);
      return p.formStatus ? p : undefined;
    });
    expect(read).toMatchObject({
      formStatus: 'verified',
      formNote: '1 step · 4 fields (3 required)',
      applyUrl: site.url('/live.html'),
    });
    const text = await cli(['jobs', 'show', id, '--form']);
    expect(text.stdout).toMatch(/Apply form {3}✓ apply form verified \S+ · 1 step · 4 fields/);
    expect(text.stdout).toContain(
      'Step 1 of 1 · 4 fields · submits with "Submit application" (Read stops here)',
    );
    expect(text.stdout).toMatch(/\* First name {2}· text/);
    expect(text.stdout).toMatch(/ {3}Resume {2}· file/);
    const json = await cliJson<{ form: { steps: Array<{ isFinal: boolean; fields: unknown[] }> } }>(
      ['jobs', 'show', id, '--form'],
    );
    expect(json.form.steps).toEqual([expect.objectContaining({ isFinal: true })]);
    expect(json.form.steps[0]?.fields).toHaveLength(4);
    // Read typed into the form but sent nothing.
    expect(site.writes).toEqual([]);

    const again = await cli(['jobs', 'read-form', id]);
    expect(again.stdout).toMatch(/Reading 1 form\(s\): \d+/);
    const failed = await cliJson<PostingJson[]>(['jobs', 'list', '--stage', 'failed_verification']);
    const refused = await cli(['jobs', 'read-form', String(failed[0]?.id)]);
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toMatch(/only verified or scored postings have a form to read/);
  });

  it('explains the score, re-scores on preference changes and takes skip feedback', async () => {
    const [scored] = await cliJson<PostingJson[]>(['jobs', 'list', '--stage', 'scored']);
    if (!scored) throw new Error('no scored posting');
    const id = String(scored.id);

    const set = async (...args: string[]) => {
      const res = await cli(['candidate', 'prefs', 'set', ...args]);
      if (res.code !== 0) throw new Error(res.stderr);
      return res.stdout;
    };
    expect(await set('salary', '7000 EUR/month')).toMatch(/Saved\. 1 scores changed\./);
    await set('based_in', 'gr');
    await set('remote', 'required');
    await set('languages', 'en:C1,el:native');
    const bad = await cli(['candidate', 'prefs', 'set', 'remote', 'sometimes']);
    expect(bad).toMatchObject({ code: 1 });
    expect(bad.stderr).toMatch(/unknown remote preference "sometimes"/);

    const prefs = await cliJson<{ basedIn: string; salary: { amount: number } }>([
      'candidate',
      'prefs',
      'show',
    ]);
    expect(prefs).toMatchObject({ basedIn: 'GR', salary: { amount: 7000 } });

    const shown = await cliJson<PostingJson>(['jobs', 'show', id]);
    const component = (key: string) => shown.breakdown.find((c) => c.key === key);
    expect(component('salary')).toMatchObject({
      weight: 10,
      value: 0.58,
      note: 'Salary €5,000–5,833/month (€70,000/year) · 17% below target · counts ×0: core fit 0%',
      scale: 0,
    });
    expect(component('location')).toMatchObject({
      value: 1,
      note: 'Remote (europe) · counts ×0: core fit 0%',
    });
    expect(shown.requirements.map((r) => r.verdict)).toEqual(['missing', 'missing', 'missing']);
    // No facts: every must-have is missing, so core fit is 0 and the (perfect) logistics
    // can't lift the score.
    expect(shown.score).toBe(0);

    const text = await cli(['jobs', 'show', id]);
    expect(text.stdout).toMatch(/salary\s+10\s+58% ×0\s+Salary €5,000–5,833\/month/);
    expect(text.stdout).toContain(
      'Core fit 0% (must-haves × role): logistics count ×0, in full from 70%',
    );
    expect(text.stdout).toMatch(/role & seniority\s+-\s+-\s+no role preferences \(not counted\)/);
    expect(text.stdout).toContain('✗ must  Python');

    // Skipping for salary nudges the salary weight up (bounded), which re-scores.
    const skip = await cli(['jobs', 'skip', id, '--reason', 'salary too low']);
    expect(skip.stdout).toMatch(/Skipped posting \d+ \(salary too low\)\. 1 scores changed\./);
    const after = await cliJson<PostingJson>(['jobs', 'show', id]);
    expect(after).toMatchObject({ stage: 'skipped', decision: 'skipped' });
    expect(after.breakdown.find((c) => c.key === 'salary')?.weight).toBe(11);
    const nudged = await cliJson<{ feedbackMultipliers: Record<string, number> }>([
      'candidate',
      'prefs',
      'show',
    ]);
    expect(nudged.feedbackMultipliers.salary).toBe(1.1);

    const back = await cli(['jobs', 'interested', id]);
    expect(back.stdout).toMatch(/Marked posting \d+ as interested/);
    expect((await cliJson<PostingJson>(['jobs', 'show', id])).stage).toBe('scored');
  });

  it('prepares an application, takes per-application values and approves it', async () => {
    const [scored] = await cliJson<PostingJson[]>(['jobs', 'list', '--stage', 'scored']);
    if (!scored) throw new Error('no scored posting');
    // `jobs interested` (previous test) started the application.
    const app = await waitFor('the application to be prepared', async () => {
      const rows = await cliJson<AppJson[]>(['applications', 'list']);
      const a = rows.find((r) => r.postingId === scored.id);
      return a && a.stage !== 'preparing' ? a : undefined;
    });
    const id = String(app.id);
    expect(app).toMatchObject({ stage: 'needs_candidate', title: 'Senior AI Engineer' });
    let full = await cliJson<AppJson>(['applications', 'preview', id]);
    const byLabel = (a: AppJson, label: string) => a.fields.find((f) => f.label === label);
    // Nothing is invented: no profile email yet, and the writer left the names to the candidate.
    expect(byLabel(full, 'Email')).toMatchObject({ value: null, missing: true, source: 'none' });
    expect(full.answers.map((a) => a.status)).toEqual(['needs_candidate', 'needs_candidate']);
    const text = await cli(['applications', 'preview', id]);
    expect(text.stdout).toMatch(/Needs you\n {2}#1 First name/);
    expect(text.stdout).toContain('Approve is blocked:');
    const refused = await cli(['applications', 'approve', id]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/can't be approved yet:[\s\S]*required field\(s\) need a value/);

    expect((await cli(['applications', 'set-field', id, '1', 'Alex'])).stdout).toMatch(
      /#1 First name = Alex \(for this application only\)/,
    );
    await cli(['applications', 'set-field', id, 'Last name', 'Example']);
    // The profile is the default: set it and prepare again; the per-application values stay.
    await cli(['candidate', 'profile', 'set', 'email', 'alex@example.test']);
    expect((await cli(['applications', 'prepare', id])).stdout).toMatch(
      /Preparing application \d+ again/,
    );
    full = await waitFor('re-preparation', async () => {
      const a = await cliJson<AppJson>(['applications', 'preview', id]);
      return a.stage === 'ready_for_review' ? a : undefined;
    });
    expect(byLabel(full, 'Email')).toMatchObject({ value: 'alex@example.test', source: 'profile' });
    expect(byLabel(full, 'First name')).toMatchObject({ value: 'Alex', source: 'override' });
    // One application gets its own email; the profile keeps the default.
    const set = await cliJson<{ field: AppField }>([
      'applications',
      'set-field',
      id,
      'email',
      'jobs@example.test',
    ]);
    expect(set.field).toMatchObject({
      value: 'jobs@example.test',
      source: 'override',
      defaultValue: 'alex@example.test',
    });
    const profile = await cliJson<Record<string, string[]>>(['candidate', 'profile', 'show']);
    expect(profile.email).toEqual(['alex@example.test']);
    const shown = await cli(['applications', 'preview', id]);
    expect(shown.stdout).toMatch(/Email\s+jobs@example\.test\s+this application/);
    expect(shown.stdout).toMatch(/First name\s+Alex\s+this application/);

    const ok = await cli(['applications', 'approve', id]);
    expect(ok.stdout).toMatch(/Approved application \d+ \(Senior AI Engineer · Acme AI\)/);
    expect((await cliJson<AppJson>(['applications', 'preview', id])).stage).toBe('approved');
    expect(
      (await cli(['applications', 'set-field', id, 'email', 'x@example.test'])).stderr,
    ).toMatch(/already approved/);
    const posting = await cliJson<PostingJson & { applicationId: number }>([
      'jobs',
      'show',
      String(scored.id),
    ]);
    expect(posting.applicationId).toBe(app.id);
    // Preparation read nothing it could send: the form was never submitted.
    expect(site.writes).toEqual([]);
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

  it('status reports where the agent CLIs were found, or why not', async () => {
    const status = await cliJson<{
      daemon: { pid: number; home: string };
      claude: {
        found: boolean;
        path: string;
        foundVia: string;
        version: string;
        signedIn: boolean;
      };
      codex: { found: boolean; error: string };
      nativeHelper: boolean;
      secretsBackend: string;
    }>(['status', '--refresh']);
    expect(status.daemon).toMatchObject({ pid: daemon.pid, home });
    expect(status.claude).toMatchObject({
      found: true,
      path: FAKE_CLAUDE,
      foundVia: 'env',
      version: '9.9.9 (Fake Claude)',
      signedIn: true,
    });
    expect(status.codex.found).toBe(false);
    expect(status.codex.error).toMatch(
      /APPLYANT_CODEX_PATH=\/nonexistent\/codex is not an executable/,
    );
    expect(status).toMatchObject({ nativeHelper: false, secretsBackend: 'file' });

    const text = await cli(['status']);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^applyantd ✓ running/);
    expect(text.stdout).toContain(`claude    ✓ ${FAKE_CLAUDE}`);
    expect(text.stdout).toMatch(/codex {5}✗ APPLYANT_CODEX_PATH/);
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
    // The submission browser's Chrome profile (browser/) has its own lock symlinks
    // (SingletonCookie and friends), sometimes dangling once Chrome exits: skip symlinks, only
    // plain files can leak the secret or have the wrong mode.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isSymbolicLink()) return [];
        return e.isDirectory() ? walk(path) : [path];
      });
    const others = walk(home).filter((f) => !f.endsWith('secrets.json'));
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) {
      if (!statSync(file).isFile()) continue;
      expect(readFileSync(file).includes(SECRET), file).toBe(false);
      expect(lstatSync(file).mode & 0o077, file).toBe(0);
    }
  });
});
