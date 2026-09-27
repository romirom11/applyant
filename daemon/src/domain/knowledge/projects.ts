// Projects: the unit a candidate's experience is told in (Solovei, Ordi, ...). Sources and
// facts hang off them. The CLI refers to a project by its slug or id.
import { asc, eq, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { facts, type ProjectRow, projects, sources } from '../../db/schema.ts';

export class ProjectError extends Error {}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґё]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'project';
}

function uniqueSlug(conn: Conn, base: string): string {
  let slug = base;
  for (
    let n = 2;
    conn.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
    n++
  ) {
    slug = `${base}-${n}`;
  }
  return slug;
}

export interface NewProject {
  name: string;
  slug?: string | null;
  summary?: string | null;
  role?: string | null;
  period?: string | null;
  stack?: string[];
}

export function createProject(conn: Conn, input: NewProject, now: Date): ProjectRow {
  const name = input.name.trim();
  if (!name) throw new ProjectError('a project needs a name');
  if (input.slug) {
    const slug = slugify(input.slug);
    if (findProject(conn, slug)) throw new ProjectError(`a project "${slug}" already exists`);
  }
  const slug = input.slug ? slugify(input.slug) : uniqueSlug(conn, slugify(name));
  if (/^\d+$/.test(slug)) throw new ProjectError('a project slug cannot be only digits');
  return conn
    .insert(projects)
    .values({
      slug,
      name,
      summary: input.summary?.trim() || null,
      role: input.role?.trim() || null,
      period: input.period?.trim() || null,
      stack: cleanStack(input.stack ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

function cleanStack(stack: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stack) {
    const t = s.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(0, 40);
}

/** By id, slug, or (case-insensitive) name. */
export function findProject(conn: Conn, ref: string): ProjectRow | null {
  const r = ref.trim();
  if (/^\d+$/.test(r)) {
    return (
      conn
        .select()
        .from(projects)
        .where(eq(projects.id, Number(r)))
        .get() ?? null
    );
  }
  return (
    conn.select().from(projects).where(eq(projects.slug, r.toLowerCase())).get() ??
    conn.select().from(projects).where(sql`lower(${projects.name}) = ${r.toLowerCase()}`).get() ??
    null
  );
}

export function requireProject(conn: Conn, ref: string): ProjectRow {
  const p = findProject(conn, ref);
  if (!p) throw new ProjectError(`no project "${ref}" (see \`applyant candidate project list\`)`);
  return p;
}

/**
 * Fills fields the project doesn't have yet from an extraction. What the candidate typed
 * (or an earlier sync filled) is never overwritten; stack entries are merged.
 */
export function fillProject(
  conn: Conn,
  project: ProjectRow,
  found: { summary: string | null; role: string | null; period: string | null; stack: string[] },
  now: Date,
): void {
  const stack = cleanStack([...project.stack, ...found.stack]);
  const set = {
    summary: project.summary ?? (found.summary?.trim() || null),
    role: project.role ?? (found.role?.trim() || null),
    period: project.period ?? (found.period?.trim() || null),
    stack,
  };
  const changed =
    set.summary !== project.summary ||
    set.role !== project.role ||
    set.period !== project.period ||
    stack.length !== project.stack.length;
  if (changed) {
    conn
      .update(projects)
      .set({ ...set, updatedAt: now })
      .where(eq(projects.id, project.id))
      .run();
  }
}

export interface ProjectSummary extends ProjectRow {
  sources: number;
  facts: number;
  unconfirmed: number;
  confirmed: number;
}

export function listProjects(conn: Conn): ProjectSummary[] {
  const rows = conn.select().from(projects).orderBy(asc(projects.name)).all();
  const factCounts = conn
    .select({
      projectId: facts.projectId,
      status: facts.status,
      n: sql<number>`count(*)`,
    })
    .from(facts)
    .groupBy(facts.projectId, facts.status)
    .all();
  const sourceCounts = conn
    .select({ projectId: sources.projectId, n: sql<number>`count(*)` })
    .from(sources)
    .groupBy(sources.projectId)
    .all();
  return rows.map((p) => {
    const fc = factCounts.filter((c) => c.projectId === p.id);
    const count = (status?: string) =>
      fc.filter((c) => !status || c.status === status).reduce((a, c) => a + Number(c.n), 0);
    return {
      ...p,
      sources: Number(sourceCounts.find((c) => c.projectId === p.id)?.n ?? 0),
      facts: count('unconfirmed') + count('confirmed'),
      unconfirmed: count('unconfirmed'),
      confirmed: count('confirmed'),
    };
  });
}
