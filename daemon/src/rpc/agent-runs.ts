// Model runs (agent_runs): what each role ran, on which model, for how long and for what. The
// app's Agent runs section and `applyant runs models` read them.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { ServiceImpl } from '@connectrpc/connect';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { agentRuns, applications, companies, postings, sources, tasks } from '../db/schema.ts';
import {
  type AgentRun,
  AgentRunSchema,
  type ApplyantService,
} from '../gen/applyant/v1/applyant_pb.js';
import { isTaskKind, TASK_ENTITY } from '../queue/types.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

const titleAt = (title: string | null, company: string | null): string | undefined =>
  title && company ? `${title} at ${company}` : (title ?? company ?? undefined);

/** Names for the entities the runs were for: postings, applications (their posting), companies. */
function labels(db: Db, refs: Array<{ kind: string; id: number }>): Map<string, string> {
  const out = new Map<string, string>();
  const ids = (kind: string) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
  const postingIds = ids('posting');
  if (postingIds.length) {
    for (const p of db
      .select({ id: postings.id, title: postings.title, company: postings.company })
      .from(postings)
      .where(inArray(postings.id, postingIds))
      .all()) {
      const l = titleAt(p.title, p.company);
      if (l) out.set(`posting:${p.id}`, l);
    }
  }
  const appIds = ids('application');
  if (appIds.length) {
    for (const a of db
      .select({ id: applications.id, title: postings.title, company: postings.company })
      .from(applications)
      .innerJoin(postings, eq(postings.id, applications.postingId))
      .where(inArray(applications.id, appIds))
      .all()) {
      const l = titleAt(a.title, a.company);
      if (l) out.set(`application:${a.id}`, l);
    }
  }
  const companyIds = ids('company');
  if (companyIds.length) {
    for (const c of db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, companyIds))
      .all()) {
      out.set(`company:${c.id}`, c.name);
    }
  }
  const sourceIds = ids('source');
  if (sourceIds.length) {
    for (const s of db
      .select({ id: sources.id, locator: sources.locator })
      .from(sources)
      .where(inArray(sources.id, sourceIds))
      .all()) {
      out.set(`source:${s.id}`, s.locator.split('/').filter(Boolean).at(-1) ?? s.locator);
    }
  }
  return out;
}

export function listAgentRuns(db: Db, opts: { limit: number; role?: string | null }): AgentRun[] {
  const limit = Math.min(Math.max(opts.limit || 100, 1), 500);
  const rows = db
    .select({ run: agentRuns, taskKind: tasks.kind, entityId: tasks.entityId })
    .from(agentRuns)
    .leftJoin(tasks, eq(tasks.id, agentRuns.taskId))
    .where(opts.role ? eq(agentRuns.role, opts.role) : undefined)
    .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
    .limit(limit)
    .all();
  const entityKind = (k: string | null) => (k && isTaskKind(k) ? TASK_ENTITY[k] : undefined);
  const names = labels(
    db,
    rows.flatMap((r) => {
      const kind = entityKind(r.taskKind);
      return kind && r.entityId ? [{ kind, id: r.entityId }] : [];
    }),
  );
  return rows.map(({ run, taskKind, entityId }) => {
    const kind = entityKind(taskKind);
    return create(AgentRunSchema, {
      id: BigInt(run.id),
      role: run.role,
      provider: run.provider,
      model: run.model ?? undefined,
      startedAt: timestampFromDate(run.startedAt),
      durationMs: BigInt(run.durationMs),
      inputTokens: run.inputTokens === null ? undefined : BigInt(run.inputTokens),
      outputTokens: run.outputTokens === null ? undefined : BigInt(run.outputTokens),
      costUsd: run.costUsd ?? undefined,
      outcome: run.outcome,
      error: run.error ?? undefined,
      taskId: run.taskId === null ? undefined : BigInt(run.taskId),
      taskKind: taskKind ?? undefined,
      entityKind: kind,
      entityId: kind && entityId ? BigInt(entityId) : undefined,
      entityLabel: kind && entityId ? names.get(`${kind}:${entityId}`) : undefined,
    });
  });
}

export function agentRunRpcs(c: RpcContext): Pick<Impl, 'listAgentRuns'> {
  return {
    listAgentRuns(req) {
      return { runs: listAgentRuns(c.db, { limit: req.limit, role: req.role?.trim() || null }) };
    },
  };
}
