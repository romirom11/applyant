// Facts: everything the agents may say about the candidate. Extracted facts start
// `unconfirmed`; the candidate's own words (a confirm, an edit, later interview answers and
// review edits) are `confirmed`. Rejected facts stay, so a re-sync doesn't bring them back.
import { and, asc, eq, inArray, isNull, ne, type SQL } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  type FactKind,
  type FactRow,
  type FactStatus,
  facts,
  type ProjectRow,
  projects,
} from '../../db/schema.ts';
import { type EvidenceView, evidenceFor } from './evidence.ts';
import type { FactRef } from './retrieve.ts';

export class FactError extends Error {}

/** Case, whitespace and trailing punctuation don't make a different fact. */
export function factKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.;,!]+$/g, '')
    .trim();
}

export const MAX_FACT_LENGTH = 500;

export interface FactFilter {
  /** A project id, `null` for profile-level facts only, or undefined for all. */
  projectId?: number | null;
  status?: FactStatus;
  kind?: FactKind;
}

export interface FactView extends FactRow {
  project: Pick<ProjectRow, 'id' | 'slug' | 'name'> | null;
  evidence: EvidenceView[];
}

export function listFacts(conn: Conn, filter: FactFilter = {}): FactView[] {
  const where: SQL[] = [];
  if (filter.projectId === null) where.push(isNull(facts.projectId));
  else if (filter.projectId !== undefined) where.push(eq(facts.projectId, filter.projectId));
  if (filter.status) where.push(eq(facts.status, filter.status));
  if (filter.kind) where.push(eq(facts.kind, filter.kind));
  const rows = conn
    .select({ fact: facts, project: { id: projects.id, slug: projects.slug, name: projects.name } })
    .from(facts)
    .leftJoin(projects, eq(facts.projectId, projects.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(projects.name), asc(facts.id))
    .all();
  const ev = evidenceFor(
    conn,
    rows.map((r) => r.fact.id),
  );
  return rows.map((r) => ({
    ...r.fact,
    project: r.project?.id ? r.project : null,
    evidence: ev.get(r.fact.id) ?? [],
  }));
}

export function getFact(conn: Conn, id: number): FactView | null {
  const row = conn.select().from(facts).where(eq(facts.id, id)).get();
  if (!row) return null;
  const project = row.projectId
    ? (conn
        .select({ id: projects.id, slug: projects.slug, name: projects.name })
        .from(projects)
        .where(eq(projects.id, row.projectId))
        .get() ?? null)
    : null;
  return { ...row, project, evidence: evidenceFor(conn, [id]).get(id) ?? [] };
}

function requireFact(conn: Conn, id: number): FactRow {
  const row = conn.select().from(facts).where(eq(facts.id, id)).get();
  if (!row) throw new FactError(`no fact ${id}`);
  return row;
}

export function confirmFact(conn: Conn, id: number, now: Date): FactRow {
  requireFact(conn, id);
  return conn
    .update(facts)
    .set({ status: 'confirmed', updatedAt: now })
    .where(eq(facts.id, id))
    .returning()
    .get();
}

export function rejectFact(conn: Conn, id: number, now: Date): FactRow {
  requireFact(conn, id);
  return conn
    .update(facts)
    .set({ status: 'rejected', updatedAt: now })
    .where(eq(facts.id, id))
    .returning()
    .get();
}

/** The new text is the candidate's own, so the fact becomes confirmed. Evidence stays. */
export function editFact(
  conn: Conn,
  id: number,
  text: string,
  now: Date,
  kind?: FactKind,
): FactRow {
  requireFact(conn, id);
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new FactError('a fact needs text');
  if (clean.length > MAX_FACT_LENGTH) {
    throw new FactError(`a fact is at most ${MAX_FACT_LENGTH} characters; split it into several`);
  }
  return conn
    .update(facts)
    .set({
      text: clean,
      status: 'confirmed',
      editedAt: now,
      updatedAt: now,
      ...(kind ? { kind } : {}),
    })
    .where(eq(facts.id, id))
    .returning()
    .get();
}

/** The given facts as agents see them; rejected and unknown ids are left out. */
export function factRefs(conn: Conn, ids: number[]): Map<number, FactRef> {
  const out = new Map<number, FactRef>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = conn
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
      .where(and(inArray(facts.id, unique.slice(i, i + 500)), ne(facts.status, 'rejected')))
      .all();
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}
