// Knowledge sources: adding them and asking for a (re-)sync. Both enqueue `sync_source`.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { Conn, Db } from '../../../db/client.ts';
import { type SourceKind, type SourceRow, sources, tasks } from '../../../db/schema.ts';
import type { EventBus } from '../../../queue/events.ts';
import { runInTx } from '../../../queue/tx.ts';
import type { Tx } from '../../../queue/types.ts';
import { requireProject } from '../projects.ts';
import { driveFileId } from './drive.ts';
import { canonicalRepoLocator } from './github.ts';
import { SourceReadError } from './material.ts';

export class SourceError extends Error {}

/** Source kinds that have a reader. Manual facts come from the interview. */
export const READABLE_KINDS: readonly SourceKind[] = ['file', 'url', 'github', 'drive'];

export function normaliseLocator(kind: SourceKind, locator: string, hasProject: boolean): string {
  const l = locator.trim();
  switch (kind) {
    case 'file': {
      if (!isAbsolute(l)) throw new SourceError(`file sources need an absolute path, got "${l}"`);
      if (!existsSync(l) || !statSync(l).isFile()) throw new SourceError(`no file at ${l}`);
      return l;
    }
    case 'url': {
      let url: URL;
      try {
        url = new URL(l);
      } catch {
        throw new SourceError(`not a URL: "${l}"`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new SourceError(`only http(s) URLs can be sources: "${l}"`);
      }
      url.hash = '';
      return url.toString();
    }
    case 'github': {
      if (!hasProject) {
        throw new SourceError(
          'a GitHub repository belongs to a project: `candidate source add <project> github <url>`',
        );
      }
      try {
        return canonicalRepoLocator(l);
      } catch (err) {
        if (err instanceof SourceReadError) throw new SourceError(err.message);
        throw err;
      }
    }
    case 'drive': {
      try {
        return driveFileId(l);
      } catch (err) {
        if (err instanceof SourceReadError) throw new SourceError(err.message);
        throw err;
      }
    }
    default:
      throw new SourceError(
        `${kind} sources can't be read yet (supported: ${READABLE_KINDS.join(', ')})`,
      );
  }
}

export interface AddSourceInput {
  /** Project id/slug/name, or null for a profile-level source (a CV). */
  project: string | null;
  kind: SourceKind;
  locator: string;
  now: Date;
}

export function addSource(
  db: Db,
  bus: EventBus,
  input: AddSourceInput,
): { source: SourceRow; created: boolean } {
  return runInTx(db, bus, { now: input.now }, (tx) => {
    const project = input.project ? requireProject(tx.db, input.project) : null;
    const locator = normaliseLocator(input.kind, input.locator, project !== null);
    const existing = tx.db
      .select()
      .from(sources)
      .where(
        and(
          project ? eq(sources.projectId, project.id) : isNull(sources.projectId),
          eq(sources.kind, input.kind),
          eq(sources.locator, locator),
        ),
      )
      .get();
    if (existing) return { source: existing, created: false };
    const source = tx.db
      .insert(sources)
      .values({ projectId: project?.id ?? null, kind: input.kind, locator, createdAt: tx.now })
      .returning()
      .get();
    enqueueSyncTask(tx, source.id);
    return { source, created: true };
  });
}

/** Enqueues a sync unless one is already queued or running for the source. */
function enqueueSyncTask(tx: Tx, sourceId: number): boolean {
  const pending = tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'sync_source'),
        eq(tasks.entityId, sourceId),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
  if (pending) return false;
  tx.enqueue('sync_source', sourceId);
  return true;
}

export interface SyncRequest {
  /** A project ref, or a source kind ("github"), or empty for every source. */
  target: string | null;
  /** Re-extract even when the material hasn't changed. */
  force: boolean;
  now: Date;
}

export function requestSync(
  db: Db,
  bus: EventBus,
  req: SyncRequest,
): { sources: SourceRow[]; enqueued: number[] } {
  return runInTx(db, bus, { now: req.now }, (tx) => {
    const where: SQL[] = [inArray(sources.kind, [...READABLE_KINDS])];
    const target = req.target?.trim() || null;
    if (target) {
      if ((READABLE_KINDS as readonly string[]).includes(target)) {
        where.push(eq(sources.kind, target as SourceKind));
      } else if (target === 'profile') {
        where.push(isNull(sources.projectId));
      } else {
        where.push(eq(sources.projectId, requireProject(tx.db, target).id));
      }
    }
    const rows = tx.db
      .select()
      .from(sources)
      .where(and(...where))
      .orderBy(asc(sources.id))
      .all();
    const enqueued: number[] = [];
    for (const s of rows) {
      if (req.force) {
        tx.db.update(sources).set({ contentHash: null }).where(eq(sources.id, s.id)).run();
      }
      if (enqueueSyncTask(tx, s.id)) enqueued.push(s.id);
    }
    return { sources: rows, enqueued };
  });
}

export function listSources(conn: Conn, projectId?: number | null): SourceRow[] {
  const q = conn.select().from(sources);
  const filtered =
    projectId === undefined
      ? q
      : q.where(projectId === null ? isNull(sources.projectId) : eq(sources.projectId, projectId));
  return filtered.orderBy(asc(sources.id)).all();
}
