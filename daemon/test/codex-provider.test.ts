// The codex provider against a fake `codex` executable (test/fixtures/bin/codex): the SDK
// spawns exactly the path Applyant resolved, the exec JSONL stream is read into a structured
// result, and a usage limit (codex exits 1) becomes pause_provider without spending an attempt.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentRuns, providerPauses, tasks } from '../src/db/schema.ts';
import { type ProviderRequest, toStrictJsonSchema } from '../src/models/agent-runner.ts';
import {
  CodexProvider,
  codexEnv,
  parseFinalMessage,
  userMcpServerNames,
} from '../src/models/providers/codex.ts';
import { setRoleRoute } from '../src/models/roles.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Handler } from '../src/queue/types.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/bin/codex', import.meta.url));

const schema = z.object({ answer: z.string(), confidence: z.number().nullable() }).strict();

interface Start {
  argv: string[];
  cwd: string;
  env: string[];
  prompt: string;
  schema: unknown;
}

describe('CodexProvider (fake `codex` executable)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-codex-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function provider(mode: string, now = new Date(2026, 8, 28, 10, 0)) {
    const argvFile = join(dir, 'argv.jsonl');
    const outputFile = join(dir, 'output.json');
    writeFileSync(outputFile, JSON.stringify({ answer: 'from fake codex', confidence: 0.5 }));
    const p = new CodexProvider({
      resolvePath: () => FAKE_CODEX,
      now: () => now,
      userMcpServers: () => ['context7', 'unityMCP'],
      env: () =>
        codexEnv({
          ...process.env,
          // As if the daemon had been started from inside a Codex session.
          CODEX_THREAD_ID: 'parent-thread',
          CODEX_SANDBOX: 'seatbelt',
          FAKE_CODEX_ARGV: argvFile,
          FAKE_CODEX_MODE: mode,
          FAKE_CODEX_OUTPUT: outputFile,
        }),
    });
    const starts = (): Start[] =>
      readFileSync(argvFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Start);
    return { p, starts };
  }

  const req = (cwd: string, extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
    role: 'search_planner',
    model: 'gpt-6-sol',
    system: 'You plan searches.',
    prompt: 'Find boards.',
    jsonSchema: toStrictJsonSchema(schema),
    cwd,
    tools: null,
    webSearch: false,
    input: null,
    signal: new AbortController().signal,
    onEvent: () => {},
    onProgress: () => {},
    ...extra,
  });

  it('spawns exactly the path it was given, read-only, with the schema and model', async () => {
    const { p, starts } = provider('ok');
    const events: Array<{ type?: string }> = [];
    const res = await p.run(req(dir, { onEvent: (e) => events.push(e as { type?: string }) }));
    expect(res).toMatchObject({
      kind: 'ok',
      output: { answer: 'from fake codex', confidence: 0.5 },
      model: 'gpt-6-sol',
      usage: { inputTokens: 21000, outputTokens: 180, costUsd: null },
    });
    const [start] = starts();
    // argv[0] is node (the script's interpreter), argv[1] the executable the SDK spawned.
    expect(start?.argv[1]).toBe(FAKE_CODEX);
    const args = start?.argv.slice(2) ?? [];
    expect(args.slice(0, 2)).toEqual(['exec', '--experimental-json']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--model',
        'gpt-6-sol',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--output-schema',
        'notify=[]',
        'mcp_servers.context7.enabled=false',
        'mcp_servers.unityMCP.enabled=false',
        'web_search="disabled"',
        'approval_policy="never"',
      ]),
    );
    expect(args[args.indexOf('--cd') + 1]).toBe(dir);
    expect(start?.cwd).toBe(realpathSync(process.cwd()));
    // The strict schema reaches codex as --output-schema; the role's system prompt leads.
    expect(start?.schema).toEqual(toStrictJsonSchema(schema));
    expect(start?.prompt.startsWith('You plan searches.')).toBe(true);
    expect(start?.prompt).toContain('Find boards.');
    // A parent Codex session's variables were not passed on.
    expect(start?.env).not.toContain('CODEX_THREAD_ID');
    expect(start?.env).not.toContain('CODEX_SANDBOX');
    // The whole stream is logged, the non-fatal notice included; it doesn't fail the run.
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'item.completed',
      'turn.started',
      'item.completed',
      'turn.completed',
    ]);
  });

  it('turns on live web search for roles that search, and reports each search', async () => {
    const { p, starts } = provider('ok');
    const progress: string[] = [];
    const res = await p.run(req(dir, { webSearch: true, onProgress: (m) => progress.push(m) }));
    expect(res.kind).toBe('ok');
    expect(starts()[0]?.argv).toContain('web_search="live"');
    expect(progress).toContain('web search: site:jobs.ashbyhq.com "AI Engineer"');
  });

  it('reads a final message wrapped in a code fence', async () => {
    const { p } = provider('fenced');
    expect(await p.run(req(dir))).toMatchObject({
      kind: 'ok',
      output: { answer: 'from fake codex' },
    });
    expect(parseFinalMessage('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('turns "try again at 3:45 PM" into a limit with the reset time', async () => {
    const { p } = provider('limit');
    expect(await p.run(req(dir))).toMatchObject({
      kind: 'limit',
      resetsAt: new Date(2026, 8, 28, 15, 45),
    });
  });

  it('reads "try again in 2 hours 5 minutes"', async () => {
    const now = new Date(2026, 8, 28, 10, 0);
    const { p } = provider('limit-in', now);
    expect(await p.run(req(dir))).toMatchObject({
      kind: 'limit',
      resetsAt: new Date(now.getTime() + (2 * 60 + 5) * 60_000),
    });
  });

  it('recognises a limit codex only printed before exiting 1', async () => {
    const { p } = provider('limit-exit');
    expect(await p.run(req(dir))).toMatchObject({
      kind: 'limit',
      resetsAt: new Date(2026, 9, 3, 9, 0),
    });
  });

  it('reports other failures as errors', async () => {
    const { p } = provider('error');
    const res = await p.run(req(dir));
    expect(res.kind).toBe('error');
    expect(res.kind === 'error' && res.message).toMatch(/stream disconnected/);
  });

  it("gives a role's MCP tools to codex as its own servers, with only the allowed tools", () => {
    const p = new CodexProvider({ userMcpServers: () => [] });
    const config = p.config(
      req(dir, {
        tools: {
          servers: {
            applyant: {
              type: 'http',
              url: 'http://127.0.0.1:4555/mcp',
              headers: { authorization: 'Bearer t' },
            },
          },
          allowed: ['mcp__applyant__search_facts', 'mcp__applyant__get_project'],
        },
      }),
    );
    expect(config).toEqual({
      notify: [],
      mcp_servers: {
        applyant: {
          url: 'http://127.0.0.1:4555/mcp',
          http_headers: { authorization: 'Bearer t' },
          enabled_tools: ['search_facts', 'get_project'],
        },
      },
    });
  });

  it("reads only the names of the candidate's MCP servers from their config.toml", () => {
    const home = join(dir, 'codex-home');
    mkdirSync(home);
    writeFileSync(
      join(home, 'config.toml'),
      [
        'model = "gpt-6-sol"',
        '[mcp_servers.context7]',
        'command = "npx"',
        '[mcp_servers.context7.env]',
        'KEY = "secret"',
        '[mcp_servers."with-dash"]',
        'url = "http://127.0.0.1:8080/mcp"',
        '[mcp_servers.unity.tools.run_tests]',
        'approval_mode = "approve"',
      ].join('\n'),
    );
    expect(userMcpServerNames({ CODEX_HOME: home }).sort()).toEqual([
      'context7',
      'unity',
      'with-dash',
    ]);
    expect(userMcpServerNames({ CODEX_HOME: join(dir, 'none') })).toEqual([]);
  });
});

describe('a codex usage limit pauses codex, not the queue', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  it('requeues at the reset time without attempts++ and holds only codex tasks', async () => {
    const now = new Date(2026, 8, 28, 10, 0);
    const provider = new CodexProvider({
      resolvePath: () => FAKE_CODEX,
      now: () => now,
      userMcpServers: () => [],
      env: () => codexEnv({ ...process.env, FAKE_CODEX_MODE: 'limit' }),
    });
    const deps = testDeps({ dir: t.dir, db: t.db, providers: [provider], now: () => now });
    const plan: Handler<'plan_search'> = async (task, ctx) => {
      const res = await ctx.deps.models.run('search_planner', {
        schema,
        system: 's',
        prompt: 'p',
        taskId: task.id,
        signal: ctx.signal,
        webSearch: true,
      });
      if (res.kind === 'limit')
        return { kind: 'pause_provider', provider: res.provider, until: res.until };
      throw new Error(res.kind === 'failed' ? res.reason : 'unexpected ok');
    };
    const verified: number[] = [];
    const bus = new EventBus();
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps,
      handlers: handlers({
        plan_search: plan,
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
      now: () => now,
    });
    const [first] = runInTx(t.db, bus, { now }, (tx) => [
      tx.enqueue('plan_search', 1),
      tx.enqueue('verify_posting', 7),
    ]);
    const row = () =>
      t.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, first ?? 0))
        .get();
    // Tagged with the provider search_planner routes to.
    expect(row()?.provider).toBe('codex');
    worker.start();
    try {
      await worker.idle();
      const until = new Date(2026, 8, 28, 15, 45);
      expect(row()).toMatchObject({ status: 'queued', attempts: 0, runAfter: until });
      expect(t.db.select().from(providerPauses).get()).toMatchObject({ provider: 'codex', until });
      expect(verified).toEqual([7]);
      expect(t.db.select().from(agentRuns).get()).toMatchObject({
        role: 'search_planner',
        provider: 'codex',
        outcome: 'limit',
      });
    } finally {
      await worker.stop();
    }
  });

  it('a role moved to codex has its queued tasks retagged', () => {
    const bus = new EventBus();
    const now = new Date();
    const id = runInTx(t.db, bus, { now }, (tx) => tx.enqueue('interview_turn', 1));
    const provider = () => t.db.select().from(tasks).where(eq(tasks.id, id)).get()?.provider;
    expect(provider()).toBe('claude');
    setRoleRoute(t.db, 'interviewer', 'codex', now);
    expect(provider()).toBe('codex');
    // …and new tasks of its kinds are tagged with it.
    const next = runInTx(t.db, bus, { now }, (tx) => tx.enqueue('interview_open', 2));
    expect(t.db.select().from(tasks).where(eq(tasks.id, next)).get()?.provider).toBe('codex');
  });
});
