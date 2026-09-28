// The MCP endpoint: a per-task token scopes the tools and caps the calls. The fourth
// search_facts call of a writer task is refused by the server, not by the prompt.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directExec } from '../src/db/read-pool.ts';
import { facts } from '../src/db/schema.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import type { FactRef } from '../src/domain/knowledge/retrieve.ts';
import { McpHub } from '../src/mcp/server.ts';
import { GET_PROJECT, knowledgeTools, SEARCH_FACTS } from '../src/mcp/tools/knowledge.ts';
import { HashEmbedder } from '../src/models/embeddings.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog } from './helpers/deps.ts';
import { mcpClient } from './helpers/mcp-client.ts';

describe('MCP endpoint caps and scoping', () => {
  let t: TempDb;
  let hub: McpHub;
  const now = new Date('2026-09-27T10:00:00Z');

  beforeEach(async () => {
    t = tempDb();
    const p = createProject(t.db, { name: 'Harbor', period: '2021–2024' }, now);
    const add = (text: string, status: 'confirmed' | 'unconfirmed' | 'rejected') =>
      t.db
        .insert(facts)
        .values({
          projectId: p.id,
          text,
          kind: 'personal_contribution',
          status,
          origin: 'extracted',
        })
        .returning()
        .get();
    add('Built the Kubernetes deployment pipeline for the ingestion service', 'confirmed');
    add('Wrote the Python ingestion workers', 'unconfirmed');
    add('Designed the whole Kubernetes platform alone', 'rejected');
    hub = new McpHub({
      tools: knowledgeTools({
        read: t.read,
        readPool: directExec(t.read),
        embedder: new HashEmbedder(),
      }),
      log: quietLog,
    });
    await hub.start();
  });

  afterEach(async () => {
    await hub.close();
    t.cleanup();
  });

  it('refuses the 4th lookup of a task capped at 3, and reports what the tools returned', async () => {
    const got: FactRef[] = [];
    const grant = hub.grant<FactRef>({
      taskId: 1,
      tools: [SEARCH_FACTS, GET_PROJECT],
      maxCalls: 3,
      onResult: (_tool, items) => got.push(...items),
    });
    expect(grant.tools.allowed).toEqual([
      'mcp__applyant__search_facts',
      'mcp__applyant__get_project',
    ]);
    const client = await mcpClient(grant.tools);
    try {
      expect((await client.tools()).sort()).toEqual([GET_PROJECT, SEARCH_FACTS]);
      const first = await client.call(SEARCH_FACTS, { query: 'Kubernetes deployment' });
      expect(first.isError).toBe(false);
      expect(first.text).toMatch(/#1 \[personal_contribution · confirmed · Harbor, 2021–2024\]/);
      // Rejected facts never come back.
      expect(first.text).not.toMatch(/whole Kubernetes platform/);
      expect((await client.call(GET_PROJECT, { project: 'harbor' })).isError).toBe(false);
      expect((await client.call(SEARCH_FACTS, { query: 'Python' })).isError).toBe(false);
      const fourth = await client.call(SEARCH_FACTS, { query: 'anything else' });
      expect(fourth.isError).toBe(true);
      expect(fourth.text).toMatch(/at most 3 lookups/);
    } finally {
      await client.close();
    }
    expect(grant.calls().map((c) => `${c.tool}:${c.outcome}`)).toEqual([
      'search_facts:ok',
      'get_project:ok',
      'search_facts:ok',
      'search_facts:refused',
    ]);
    expect([...new Set(got.map((f) => f.id))].sort()).toEqual([1, 2]);
    grant.revoke();
  });

  it('only the granted tools exist, and a revoked or unknown token is rejected', async () => {
    const grant = hub.grant({ taskId: 2, tools: [SEARCH_FACTS], maxCalls: 1 });
    const client = await mcpClient(grant.tools);
    expect(await client.tools()).toEqual([SEARCH_FACTS]);
    await client.close();
    grant.revoke();
    await expect(mcpClient(grant.tools)).rejects.toThrow();
    const res = await fetch(hub.url, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
