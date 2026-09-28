// Every fact id a draft cites must be one the writer was given, including the facts it fetched
// itself over MCP during the run. A draft citing anything else is invalid output.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directExec } from '../src/db/read-pool.ts';
import { runWriter } from '../src/domain/applications/writer.ts';
import { buildWriterContext } from '../src/domain/applications/writer-context.ts';
import { McpHub } from '../src/mcp/server.ts';
import { knowledgeTools } from '../src/mcp/tools/knowledge.ts';
import type { ProviderRequest, ProviderResult } from '../src/models/agent-runner.ts';
import { HashEmbedder } from '../src/models/embeddings.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { form, type SeededFacts, seedFacts, seedPosting, spec } from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { testRunner } from './helpers/deps.ts';
import { mcpClient } from './helpers/mcp-client.ts';

const now = new Date('2026-09-27T10:00:00Z');

describe('citable facts', () => {
  let t: TempDb;
  let hub: McpHub;
  let f: SeededFacts;
  const embedder = new HashEmbedder();

  beforeEach(async () => {
    t = tempDb();
    f = seedFacts(t.db, now);
    hub = new McpHub({
      tools: knowledgeTools({ read: t.read, readPool: directExec(t.read), embedder }),
      log: (await import('./helpers/deps.ts')).quietLog,
    });
    await hub.start();
  });
  afterEach(async () => {
    await hub.close();
    t.cleanup();
  });

  const context = async () => {
    const pid = seedPosting(
      t.db,
      form([
        spec('Anything else we should know?', 'textarea', { meaning: 'question', required: true }),
      ]),
      { now, matches: [{ text: 'Python', factIds: [f.pipeline] }] },
    );
    const posting = (await import('../src/domain/search/postings.ts')).getPosting(
      t.db,
      pid,
    )?.posting;
    if (!posting) throw new Error('no posting');
    return buildWriterContext(
      t.read,
      { readPool: directExec(t.read), embedder },
      {
        applicationId: 1,
        posting,
        questions: [
          {
            id: 'q1',
            fieldRef: '1:x',
            label: 'Anything else we should know?',
            kind: 'text',
            options: null,
            required: true,
            condition: null,
          },
        ],
        profile: {},
        signal: new AbortController().signal,
      },
    );
  };

  const draft = (factIds: number[]) => ({
    drafts: [
      {
        question: 'q1',
        status: 'answered',
        choice: null,
        sentences: [{ text: 'I maintain an open-source audio library.', factIds }],
        missing: null,
        adaptedFrom: null,
      },
    ],
  });

  it('a fact fetched with get_project during the run is citable', async () => {
    const ctx = await context();
    expect(ctx.citable.has(f.pipeline)).toBe(true);
    const oss = f.oss;
    // Not retrieved for this question and not a requirement match: only a lookup can bring it.
    expect(ctx.citable.has(oss)).toBe(false);
    const writer = async (req: ProviderRequest): Promise<ProviderResult> => {
      if (!req.tools) return { kind: 'error', message: 'no tools', usage: null };
      const client = await mcpClient(req.tools);
      const res = await client.call('get_project', { project: 'harbor' });
      await client.close();
      if (!res.text.includes(`#${oss} `)) return { kind: 'error', message: res.text, usage: null };
      return { kind: 'ok', output: draft([oss]), model: 'opus', usage: null };
    };
    const models = testRunner({ dir: t.dir, providers: [new FakeProvider('claude', [], writer)] });
    const res = await runWriter(
      ctx,
      { models, mcp: hub },
      { taskId: 1, signal: new AbortController().signal },
    );
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(ctx.citable.has(oss)).toBe(true);
    expect(res.output.drafts[0]?.sentences[0]?.factIds).toEqual([oss]);
    expect(res.calls.map((c) => `${c.tool}:${c.outcome}`)).toEqual(['get_project:ok']);
  });

  it('a draft citing a fact it was never given is refused', async () => {
    const ctx = await context();
    const fake = new FakeProvider('claude', [{ output: draft([f.pipeline, 999]) }]);
    const models = testRunner({ dir: t.dir, providers: [fake] });
    const res = await runWriter(
      ctx,
      { models, mcp: hub },
      { taskId: 1, signal: new AbortController().signal },
    );
    expect(res).toMatchObject({ kind: 'failed' });
    if (res.kind === 'failed')
      expect(res.reason).toMatch(/cites fact #999, which it was not given/);
  });

  it('without the MCP endpoint the writer runs with no tools', async () => {
    const ctx = await context();
    const fake = new FakeProvider('claude', [{ output: draft([f.pipeline]) }]);
    const models = testRunner({ dir: t.dir, providers: [fake] });
    const res = await runWriter(
      ctx,
      { models, mcp: null },
      { taskId: 1, signal: new AbortController().signal },
    );
    expect(res.kind).toBe('ok');
    expect(fake.requests[0]?.tools).toBeNull();
  });
});
