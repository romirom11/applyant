import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentRuns, providerPauses, tasks } from '../src/db/schema.ts';
import { type ProviderRequest, toStrictJsonSchema } from '../src/models/agent-runner.ts';
import { parseLimitMessage, UNKNOWN_RESET_MS } from '../src/models/limits.ts';
import {
  ClaudeNotFoundError,
  ClaudeProvider,
  claudeEnv,
  resolveClaudePath,
} from '../src/models/providers/claude.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Handler } from '../src/queue/types.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps, testRunner } from './helpers/deps.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/bin/claude', import.meta.url));

const answerSchema = z.object({ answer: z.string(), confidence: z.number().nullable() }).strict();

describe('limit messages', () => {
  // Local-time wall clock: the CLI prints reset times in the machine's zone.
  const at = (h: number, m = 0, day = 27) => new Date(2026, 8, day, h, m, 0, 0);

  it('reads "resets 3:45pm" as today, or tomorrow once that has passed', () => {
    const text = "You've hit your session limit · resets 3:45pm";
    expect(parseLimitMessage(text, at(10))).toMatchObject({ resetsAt: at(15, 45), exact: true });
    expect(parseLimitMessage(text, at(16))?.resetsAt).toEqual(at(15, 45, 28));
  });

  it('reads 24-hour times, weekdays and dates', () => {
    expect(
      parseLimitMessage("You've hit your session limit · resets 15:45", at(10))?.resetsAt,
    ).toEqual(at(15, 45));
    // 2026-09-27 is a Sunday.
    expect(
      parseLimitMessage("You've hit your weekly limit · resets Mon 9am", at(10))?.resetsAt,
    ).toEqual(at(9, 0, 28));
    expect(
      parseLimitMessage("You've hit your weekly limit · resets Oct 3, 9am", at(10))?.resetsAt,
    ).toEqual(new Date(2026, 9, 3, 9, 0));
  });

  it('honours an explicit time zone', () => {
    const now = new Date('2026-09-27T08:00:00Z');
    const hit = parseLimitMessage(
      "You've hit your session limit · resets 3pm (Europe/Athens)",
      now,
    );
    // Athens is UTC+3 in September.
    expect(hit?.resetsAt).toEqual(new Date('2026-09-27T12:00:00Z'));
  });

  it('reads the older epoch form', () => {
    expect(parseLimitMessage('Claude AI usage limit reached|1790600000', at(10))?.resetsAt).toEqual(
      new Date(1790600000 * 1000),
    );
  });

  it('falls back to a short wait when no reset time is given', () => {
    const now = at(10);
    const hit = parseLimitMessage("You've hit your Opus limit", now);
    expect(hit).toMatchObject({ exact: false });
    expect(hit?.resetsAt).toEqual(new Date(now.getTime() + UNKNOWN_RESET_MS));
  });

  it('ignores server throttling and ordinary errors', () => {
    const now = at(10);
    expect(
      parseLimitMessage(
        'API Error: Server is temporarily limiting requests (not your usage limit)',
        now,
      ),
    ).toBeNull();
    expect(parseLimitMessage('Failed to authenticate: OAuth session expired', now)).toBeNull();
  });
});

describe('AgentRunner', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  const request = (extra: Partial<Parameters<ReturnType<typeof testRunner>['run']>[1]> = {}) => ({
    schema: answerSchema,
    system: 'You answer.',
    prompt: 'What is 2+2?',
    taskId: 7,
    signal: new AbortController().signal,
    ...extra,
  });

  it('routes the role, validates the output and records the run', async () => {
    const fake = new FakeProvider('claude', [{ output: { answer: '4', confidence: null } }]);
    const runner = testRunner({ dir: t.dir, db: t.db, providers: [fake] });
    const progress: string[] = [];
    const res = await runner.run('extractor', request({ progress: (m) => progress.push(m) }));

    expect(res).toMatchObject({
      kind: 'ok',
      output: { answer: '4' },
      route: { provider: 'claude', model: 'sonnet' },
    });
    const req = fake.requests[0] as ProviderRequest;
    expect(req.model).toBe('sonnet');
    expect(req.jsonSchema).toEqual(toStrictJsonSchema(answerSchema));
    expect(progress[0]).toMatch(/extractor · claude:sonnet · started/);
    expect(progress.at(-1)).toMatch(/extractor · done in/);

    const run = t.db.select().from(agentRuns).get();
    expect(run).toMatchObject({
      taskId: 7,
      role: 'extractor',
      provider: 'claude',
      model: 'sonnet',
      outcome: 'ok',
      inputTokens: 100,
      outputTokens: 20,
    });
    const log = readFileSync(run?.logPath ?? '', 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({
      type: 'applyant.request',
      role: 'extractor',
      prompt: 'What is 2+2?',
    });
    expect(log.at(-1)).toMatchObject({ type: 'applyant.outcome', outcome: 'ok' });
    expect(statSync(run?.logPath ?? '').mode & 0o777).toBe(0o600);
    // Per-run working directories are removed afterwards.
    expect(readdirSync(join(t.dir, 'files', 'work'))).toEqual([]);
  });

  it('fails on output that does not match the schema or the post-parse check', async () => {
    const fake = new FakeProvider('claude', [
      { output: { answer: 4 } },
      { output: { answer: '', confidence: null } },
    ]);
    const runner = testRunner({ dir: t.dir, db: t.db, providers: [fake] });
    const bad = await runner.run('extractor', request());
    expect(bad).toMatchObject({ kind: 'failed' });
    expect(bad.kind === 'failed' && bad.reason).toMatch(/invalid extractor output/);
    const empty = await runner.run(
      'extractor',
      request({
        validate: (o: z.infer<typeof answerSchema>) => (o.answer ? null : 'empty answer'),
      }),
    );
    expect(empty.kind === 'failed' && empty.reason).toMatch(/empty answer/);
    expect(
      t.db
        .select()
        .from(agentRuns)
        .all()
        .map((r) => r.outcome),
    ).toEqual(['invalid_output', 'invalid_output']);
  });

  it('reports a limit with the provider and reset time', async () => {
    const until = new Date('2026-09-27T15:45:00Z');
    const runner = testRunner({
      dir: t.dir,
      db: t.db,
      providers: [
        new FakeProvider('claude', [{ limit: "You've hit your session limit", resetsAt: until }]),
      ],
    });
    expect(await runner.run('extractor', request())).toMatchObject({
      kind: 'limit',
      provider: 'claude',
      until,
    });
    expect(t.db.select().from(agentRuns).get()?.outcome).toBe('limit');
  });

  it('fails a role whose provider is not available (no silent fallback for apple)', async () => {
    const runner = testRunner({ dir: t.dir, providers: [new FakeProvider('claude')] });
    const res = await runner.run('email_classify', request());
    expect(res.kind === 'failed' && res.reason).toMatch(/no provider for role email_classify/);
  });

  it('falls back from jev to claude:haiku when jev is off', async () => {
    const fake = new FakeProvider('claude', [{ output: { answer: 'yes', confidence: 0.9 } }]);
    const runner = testRunner({ dir: t.dir, providers: [fake] });
    const res = await runner.run('field_classify', request());
    expect(res).toMatchObject({ kind: 'ok', route: { provider: 'claude', model: 'haiku' } });
  });

  it('rethrows when the task is aborted (shutdown / lease lost)', async () => {
    const ac = new AbortController();
    const fake = new FakeProvider('claude', [
      async () => {
        ac.abort(new Error('lease lost'));
        return { kind: 'error', message: 'aborted', usage: null };
      },
    ]);
    const runner = testRunner({ dir: t.dir, db: t.db, providers: [fake] });
    await expect(runner.run('extractor', request({ signal: ac.signal }))).rejects.toThrow(
      'lease lost',
    );
    expect(t.db.select().from(agentRuns).get()?.outcome).toBe('aborted');
  });
});

describe('a provider limit pauses the provider, not the queue', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  it('requeues at the reset time without attempts++, holds that provider, runs the rest', async () => {
    let clock = new Date('2026-09-27T10:00:00Z').getTime();
    const now = () => new Date(clock);
    const until = new Date(clock + 3_600_000);
    const fake = new FakeProvider(
      'claude',
      [{ limit: "You've hit your session limit · resets 11am", resetsAt: until }],
      { output: { answer: 'ok', confidence: null } },
    );
    const deps = testDeps({ dir: t.dir, db: t.db, providers: [fake], now });
    const ran: number[] = [];
    const extract: Handler<'sync_source'> = async (task, ctx) => {
      const res = await ctx.deps.models.run('extractor', {
        schema: answerSchema,
        system: 's',
        prompt: `source ${task.entityId}`,
        taskId: task.id,
        signal: ctx.signal,
      });
      if (res.kind === 'limit')
        return { kind: 'pause_provider', provider: res.provider, until: res.until };
      if (res.kind === 'failed') throw new Error(res.reason);
      ran.push(task.entityId);
      return { kind: 'done', commit: () => {} };
    };
    const verified: number[] = [];
    const bus = new EventBus();
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps,
      handlers: handlers({
        sync_source: extract,
        verify_posting: async (task) => {
          verified.push(task.entityId);
          return { kind: 'done', commit: () => {} };
        },
      }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
      now,
    });
    const [first, second] = runInTx(t.db, bus, { now: now() }, (tx) => [
      tx.enqueue('sync_source', 1),
      tx.enqueue('sync_source', 2),
      tx.enqueue('verify_posting', 3),
    ]);
    const row = (id: number | undefined) =>
      t.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, id ?? 0))
        .get();
    // Tasks are tagged with the provider their role routes to.
    expect(row(first)?.provider).toBe('claude');

    worker.start();
    try {
      await worker.idle();
      expect(row(first)).toMatchObject({ status: 'queued', attempts: 0, runAfter: until });
      expect(t.db.select().from(providerPauses).get()).toMatchObject({ provider: 'claude', until });
      // The second claude task was never leased (one limit hit, not two)...
      expect(fake.requests).toHaveLength(1);
      expect(row(second)).toMatchObject({ status: 'queued', attempts: 0 });
      // ...while work for no provider carried on.
      expect(verified).toEqual([3]);

      clock = until.getTime() + 1;
      await worker.idle();
      expect(ran.sort()).toEqual([1, 2]);
      expect(row(first)).toMatchObject({ status: 'done', attempts: 0 });
    } finally {
      await worker.stop();
    }
  });
});

describe('ClaudeProvider (fake `claude` executable)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-claude-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function provider(mode: string, now = new Date(2026, 8, 27, 10, 0)) {
    const argvFile = join(dir, 'argv.jsonl');
    const outputFile = join(dir, 'output.json');
    writeFileSync(outputFile, JSON.stringify({ answer: 'from fake claude', confidence: 0.5 }));
    const p = new ClaudeProvider({
      resolvePath: () => FAKE_CLAUDE,
      now: () => now,
      env: () =>
        claudeEnv({
          ...process.env,
          // As if the daemon had been started from inside a Claude Code session.
          CLAUDECODE: '1',
          CLAUDE_CODE_SESSION_ID: 'parent-session',
          CLAUDE_CODE_OAUTH_TOKEN: 'kept',
          FAKE_CLAUDE_ARGV: argvFile,
          FAKE_CLAUDE_MODE: mode,
          FAKE_CLAUDE_OUTPUT: outputFile,
        }),
    });
    const starts = () =>
      readFileSync(argvFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: string[] });
    return { p, starts };
  }

  const req = (cwd: string): ProviderRequest => ({
    role: 'extractor',
    model: 'sonnet',
    system: 'You answer.',
    prompt: 'What is 2+2?',
    jsonSchema: toStrictJsonSchema(answerSchema),
    cwd,
    signal: new AbortController().signal,
    onEvent: () => {},
    onProgress: () => {},
  });

  it('spawns exactly the path it was given, with the schema, model and no tools', async () => {
    const { p, starts } = provider('ok');
    const events: unknown[] = [];
    const res = await p.run({ ...req(dir), onEvent: (e) => events.push(e) });
    expect(res).toMatchObject({
      kind: 'ok',
      output: { answer: 'from fake claude' },
      model: 'claude-sonnet-5',
      usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.01 },
    });
    const [start] = starts();
    // argv[0] is node (the script's interpreter), argv[1] the executable the SDK spawned.
    expect(start?.argv[1]).toBe(FAKE_CLAUDE);
    const args = start?.argv.slice(2) ?? [];
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--tools', '']));
    const schema = args[args.indexOf('--json-schema') + 1];
    expect(JSON.parse(schema ?? 'null')).toEqual(toStrictJsonSchema(answerSchema));
    expect(args.some((a) => a.startsWith('--setting-sources'))).toBe(true);
    // Only Applyant's MCP servers: the account's claude.ai connectors cost ~550k tokens a run.
    expect(args).toContain('--strict-mcp-config');
    expect(start?.cwd).toBe(dir);
    // The parent session's variables were not passed on; an explicit OAuth token was.
    expect(start?.env).not.toContain('CLAUDECODE');
    expect(start?.env).not.toContain('CLAUDE_CODE_SESSION_ID');
    expect(start?.env).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claudeEnv({}).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(events.some((e) => (e as { type?: string }).type === 'result')).toBe(true);
  });

  it('turns a session-limit reply into a limit with the reset time', async () => {
    const { p } = provider('limit');
    expect(await p.run(req(dir))).toMatchObject({
      kind: 'limit',
      resetsAt: new Date(2026, 8, 27, 15, 45),
      message: "You've hit your session limit · resets 3:45pm",
    });
  });

  it('prefers the reset time of a rejected rate_limit_event', async () => {
    const { p } = provider('limit-event');
    expect(await p.run(req(dir))).toMatchObject({
      kind: 'limit',
      resetsAt: new Date(1790600000 * 1000),
    });
  });

  it('recognises a limit the CLI only printed before exiting', async () => {
    const { p } = provider('exit');
    const res = await p.run(req(dir));
    expect(res).toMatchObject({ kind: 'limit', resetsAt: new Date(2026, 9, 3, 9, 0) });
  });

  it('reports other failures as errors', async () => {
    const { p } = provider('error');
    const res = await p.run(req(dir));
    expect(res.kind).toBe('error');
    expect(res.kind === 'error' && res.message).toMatch(/error_during_execution: boom/);
  });

  it('resolves claude from APPLYANT_CLAUDE_PATH, then PATH', () => {
    expect(resolveClaudePath({ APPLYANT_CLAUDE_PATH: FAKE_CLAUDE, PATH: '' })).toBe(FAKE_CLAUDE);
    expect(resolveClaudePath({ PATH: join(FAKE_CLAUDE, '..'), HOME: dir })).toBe(FAKE_CLAUDE);
    expect(() => resolveClaudePath({ PATH: dir, HOME: dir })).toThrow(ClaudeNotFoundError);
    expect(() => resolveClaudePath({ APPLYANT_CLAUDE_PATH: join(dir, 'nope') })).toThrow(
      /not an executable/,
    );
  });
});
