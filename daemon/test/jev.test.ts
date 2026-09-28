// The Jev client (HTTP contract, retries, key handling) and AgentRunner.decide(): Jev first,
// unsure or missing answers re-asked of the fallback model in one run.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewAgentRunRow } from '../src/db/schema.ts';
import { AgentRunner } from '../src/models/agent-runner.ts';
import type { ChoiceQuestion } from '../src/models/decide.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { JEV_URL, JevClient, JevError } from '../src/models/providers/jev.ts';
import { quietLog } from './helpers/deps.ts';

const KEY = 'ts_test_4f1e2d3c5b6a7980';

function fakeFetch(
  replies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 500, body: { error: 'no reply' } };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const secretsWith = (key: string | null) => ({ get: async () => key });

describe('JevClient', () => {
  it('POSTs state and typed questions with the key as a bearer token', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          model: 'jev-1.13.0',
          answers: {
            q: {
              type: 'choice',
              choice: 'b',
              confidence: 0.9,
              probabilities: { a: 0.05, b: 0.95 },
            },
          },
          usage: { input_tokens: 120, output_tokens: 20 },
        },
      },
    ]);
    const jev = new JevClient({ secrets: secretsWith(KEY), fetch: f.fn });
    const res = await jev.ask(
      {
        state: 'hello',
        questions: {
          q: { type: 'choice', instructions: 'which?', criteria: { a: null, b: 'bee' } },
        },
      },
      new AbortController().signal,
    );
    expect(res).toEqual({
      model: 'jev-1.13.0',
      answers: {
        q: { type: 'choice', choice: 'b', confidence: 0.9, probabilities: { a: 0.05, b: 0.95 } },
      },
      usage: { input_tokens: 120, output_tokens: 20 },
    });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    if (!call) throw new Error('no request');
    expect(call.url).toBe(JEV_URL);
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      state: 'hello',
      model: 'jev-latest',
      questions: { q: { type: 'choice', instructions: 'which?', criteria: { a: null, b: 'bee' } } },
    });
  });

  it('retries 429 and 529 (honouring retry-after), then gives up with the status', async () => {
    const slept: number[] = [];
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 529 },
      { status: 529 },
      { status: 529 },
    ]);
    const jev = new JevClient({
      secrets: secretsWith(KEY),
      fetch: f.fn,
      retries: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const err = await jev
      .ask({ state: 's', questions: {} }, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).status).toBe(529);
    expect(f.calls).toHaveLength(4);
    expect(slept[0]).toBe(2000);
  });

  it('is off without a key, and a 401 never echoes the key', async () => {
    expect(await new JevClient({ secrets: secretsWith(null) }).available()).toBe(false);
    expect(await new JevClient({ secrets: secretsWith(KEY) }).available()).toBe(true);
    const f = fakeFetch([{ status: 401, body: { detail: 'invalid api key' } }]);
    const err = (await new JevClient({ secrets: secretsWith(KEY), fetch: f.fn })
      .ask({ state: 's', questions: {} }, new AbortController().signal)
      .catch((e: unknown) => e)) as JevError;
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(KEY);
  });
});

describe('AgentRunner.decide', () => {
  let dir: string;
  let runs: NewAgentRunRow[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-decide-'));
    runs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const questions: Record<string, ChoiceQuestion> = {
    a: {
      instructions: { field: { label: 'Email' }, question: 'what?' },
      options: { email: null, phone: null },
    },
    b: {
      instructions: { field: { label: 'Mobile' }, question: 'what?' },
      options: { email: null, phone: null },
    },
  };

  function runner(
    jev: ConstructorParameters<typeof AgentRunner>[0]['jev'],
    claude = new FakeProvider('claude'),
  ) {
    return new AgentRunner({
      providers: [claude],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => {
        runs.push(row);
      },
      log: quietLog,
      jev,
    });
  }

  const jevAnswering = (answers: Record<string, { choice: string; confidence: number }>) => {
    const asked: string[][] = [];
    return {
      asked,
      async available() {
        return true;
      },
      async ask(req: { questions: Record<string, unknown> }) {
        asked.push(Object.keys(req.questions));
        return {
          model: 'jev-1.13.0',
          answers: Object.fromEntries(
            Object.keys(req.questions)
              .filter((id) => answers[id])
              .map((id) => [
                id,
                { type: 'choice' as const, probabilities: {}, ...answers[id] } as never,
              ]),
          ),
          usage: { input_tokens: 500, output_tokens: 0 },
        };
      },
    };
  };

  it('keeps sure Jev answers and re-asks only the unsure ones of claude:haiku', async () => {
    const jev = jevAnswering({
      a: { choice: 'email', confidence: 0.97 },
      b: { choice: 'email', confidence: 0.5 },
    });
    const claude = new FakeProvider('claude', [
      { output: { answers: [{ question: 'b', choice: 'phone' }] } },
    ]);
    const res = await runner(jev, claude).decide('field_classify', {
      state: { form: 'x' },
      questions,
      taskId: 7,
      signal: new AbortController().signal,
    });
    expect(res.answers).toEqual({
      a: { choice: 'email', confidence: 0.97, by: 'jev', sure: true },
      b: { choice: 'phone', confidence: 1, by: 'claude:haiku', sure: true },
    });
    expect(jev.asked).toEqual([['a', 'b']]);
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]?.model).toBe('haiku');
    expect(claude.requests[0]?.prompt).toContain('[b]');
    expect(claude.requests[0]?.prompt).not.toContain('[a]');
    // Both runs are recorded; the Jev one with its (tiny) cost and a log without the key.
    expect(runs.map((r) => [r.role, r.provider, r.outcome])).toEqual([
      ['field_classify', 'jev', 'ok'],
      ['field_classify', 'claude', 'ok'],
    ]);
    expect(runs[0]?.costUsd).toBeCloseTo(500 * 42e-9, 12);
    const log = readFileSync(String(runs[0]?.logPath), 'utf8');
    expect(log).toContain('"Mobile"');
  });

  it('without Jev every question goes to the fallback in one run', async () => {
    const claude = new FakeProvider('claude', [
      {
        output: {
          answers: [
            { question: 'a', choice: 'email' },
            { question: 'b', choice: 'phone' },
          ],
        },
      },
    ]);
    const res = await runner(null, claude).decide('field_classify', {
      state: 's',
      questions,
      taskId: null,
      signal: new AbortController().signal,
    });
    expect(Object.values(res.answers).map((a) => [a.choice, a.by])).toEqual([
      ['email', 'claude:haiku'],
      ['phone', 'claude:haiku'],
    ]);
    expect(claude.requests).toHaveLength(1);
  });

  it('a fallback answer outside the options is rejected, leaving the question unsure', async () => {
    const claude = new FakeProvider('claude', [
      {
        output: {
          answers: [
            { question: 'a', choice: 'fax' },
            { question: 'b', choice: 'phone' },
          ],
        },
      },
    ]);
    const res = await runner(null, claude).decide('field_classify', {
      state: 's',
      questions,
      taskId: null,
      signal: new AbortController().signal,
    });
    expect(res.answers).toEqual({});
    expect(res.problems.join()).toMatch(/"fax" is not an option of question a/);
  });

  it('a Jev failure falls back; a fallback limit is reported, not thrown', async () => {
    const broken = {
      async available() {
        return true;
      },
      async ask(): Promise<never> {
        throw new JevError('Jev HTTP 500', 500);
      },
    };
    const claude = new FakeProvider('claude', [
      { limit: "You've hit your session limit · resets 3:45pm" },
    ]);
    const res = await runner(broken, claude).decide('option_match', {
      state: 's',
      questions,
      taskId: null,
      signal: new AbortController().signal,
    });
    expect(res.answers).toEqual({});
    expect(res.limit?.provider).toBe('claude');
    expect(res.problems[0]).toBe('jev: Jev HTTP 500');
  });
});
