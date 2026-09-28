// Read-only knowledge lookups for the application writer: search_facts (hybrid retrieval over
// the question the writer is working on) and get_project (one project's facts). Rejected facts
// never come back. Whatever they return becomes citable for that run.
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { ReadDb } from '../../db/client.ts';
import type { ReadExec } from '../../db/read-pool.ts';
import { facts, projects } from '../../db/schema.ts';
import { findProject } from '../../domain/knowledge/projects.ts';
import { type FactRef, factLine, retrieveFacts } from '../../domain/knowledge/retrieve.ts';
import type { Embedder } from '../../models/embeddings.ts';
import type { McpTool } from '../server.ts';

export const SEARCH_FACTS = 'search_facts';
export const GET_PROJECT = 'get_project';
/** Facts get_project returns at most (confirmed first). */
export const PROJECT_FACT_LIMIT = 60;

export interface KnowledgeToolDeps {
  read: ReadDb;
  readPool: ReadExec;
  embedder: Embedder;
}

export function knowledgeTools(d: KnowledgeToolDeps): McpTool<FactRef>[] {
  const searchFacts: McpTool<FactRef> = {
    name: SEARCH_FACTS,
    description:
      "Search the candidate's knowledge base for facts about their work (keyword + semantic). Returns up to 10 facts with ids you may cite.",
    input: { query: z.string().describe('What to look for, e.g. "Kubernetes in production"') },
    async run(args, signal) {
      const query = String(args.query ?? '').trim();
      if (!query) return { text: 'Give a query.', items: [] };
      let vector: Float32Array | null = null;
      try {
        [vector = null] = await d.embedder.embed([query], 'query', signal);
      } catch {
        // Keyword search alone still works.
      }
      const hits = await retrieveFacts(d.readPool, { text: query, vector }, 10);
      const items: FactRef[] = hits.map(({ score: _score, ...f }) => f);
      return {
        text: items.length ? items.map(factLine).join('\n') : 'No facts found.',
        items,
      };
    },
  };

  const getProject: McpTool<FactRef> = {
    name: GET_PROJECT,
    description:
      "One of the candidate's projects (by id, slug or name) with its facts, confirmed ones first. Returns ids you may cite.",
    input: { project: z.string().describe('Project id, slug or name') },
    async run(args) {
      const p = findProject(d.read, String(args.project ?? ''));
      if (!p) return { text: `No project "${String(args.project ?? '')}".`, items: [] };
      const rows = d.read
        .select({
          id: facts.id,
          text: facts.text,
          status: facts.status,
          kind: facts.kind,
          projectId: facts.projectId,
          project: projects.name,
          period: projects.period,
        })
        .from(facts)
        .leftJoin(projects, eq(facts.projectId, projects.id))
        .where(and(eq(facts.projectId, p.id), ne(facts.status, 'rejected')))
        .all();
      rows.sort(
        (a, b) =>
          Number(a.status !== 'confirmed') - Number(b.status !== 'confirmed') || a.id - b.id,
      );
      const items = rows.slice(0, PROJECT_FACT_LIMIT);
      const head = [
        `${p.name} (${p.slug})${p.period ? ` · ${p.period}` : ''}${p.role ? ` · role: ${p.role}` : ''}`,
        p.summary ?? '',
        p.stack.length ? `stack: ${p.stack.join(', ')}` : '',
        `${rows.length} facts${rows.length > items.length ? ` (first ${items.length})` : ''}:`,
      ].filter(Boolean);
      return { text: [...head, ...items.map(factLine)].join('\n'), items };
    },
  };

  return [searchFacts, getProject];
}
