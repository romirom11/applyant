// rematch_postings: when knowledge changes, the postings whose matches it can change are
// scored again, and only those.
//
//   a fact change (sync, interview turn, fact edit/reject, review edit)
//     → requestRematch: one queued sweep, REMATCH_DELAY_MS later; a burst of changes before it
//       runs shares it
//   slow:    waits while embed_facts is pending (new text has no vector yet, so retrieval
//            would miss it); then for every open posting (verified or scored, not skipped or
//            closed, no application past review) per requirement retrieval → match keys
//   commit:  score_posting for each posting with a key its stored matches don't have
//
// The keys are the matcher's own cache keys (match.ts), so a posting is re-queued exactly
// when score_posting would ask the matcher something; a confirmed fact changes no key.
// score_posting then prepares a posting that now crosses the threshold, as usual.
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { applications, type PostingRow, postings, tasks } from '../../db/schema.ts';
import type { Handler, Tx } from '../../queue/types.ts';
import { gatherCandidates } from './match.ts';

/** How long a sweep waits for more changes before it runs. */
export const REMATCH_DELAY_MS = 30_000;

/** Application stages whose posting is still worth re-scoring (nothing approved or sent). */
const OPEN_APPLICATION_STAGES = ['preparing', 'ready_for_review', 'needs_candidate'] as const;

/** Queues one sweep unless one is already waiting (which then covers this change too). */
export function requestRematch(tx: Tx, delayMs = REMATCH_DELAY_MS): void {
  const waiting = tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, 'rematch_postings'), eq(tasks.status, 'queued')))
    .get();
  if (waiting) return;
  tx.enqueue('rematch_postings', 0, {
    runId: null,
    runAfter: new Date(tx.now.getTime() + delayMs),
  });
}

function pending(conn: Conn, kind: 'embed_facts' | 'score_posting', entityId?: number): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, kind),
        inArray(tasks.status, ['queued', 'running']),
        entityId === undefined ? undefined : eq(tasks.entityId, entityId),
      ),
    )
    .get();
}

/**
 * Postings a knowledge change may re-score: verified or scored (never skipped, closed or
 * failed), matched before, not marked skipped, with no application or one still in review.
 */
export function rematchCandidates(conn: Conn): PostingRow[] {
  const open = sql.join(
    OPEN_APPLICATION_STAGES.map((s) => sql`${s}`),
    sql`, `,
  );
  return conn
    .select()
    .from(postings)
    .where(
      and(
        inArray(postings.stage, ['verified', 'scored']),
        isNotNull(postings.extraction),
        isNotNull(postings.matches),
        sql`(${postings.decision} IS NULL OR ${postings.decision} <> 'skipped')`,
        sql`NOT EXISTS (SELECT 1 FROM ${applications} a WHERE a.posting_id = ${postings.id} AND a.stage NOT IN (${open}))`,
      ),
    )
    .all();
}

export const rematchPostings: Handler<'rematch_postings'> = async (_task, ctx) => {
  if (pending(ctx.read, 'embed_facts')) {
    // The changed facts aren't in the vector index yet: look again once they are.
    return { kind: 'done', commit: (tx) => requestRematch(tx) };
  }
  const rows = rematchCandidates(ctx.read).filter((p) => !pending(ctx.read, 'score_posting', p.id));
  ctx.progress({ message: `checking ${rows.length} postings against your changed knowledge` });
  const changed: number[] = [];
  for (const posting of rows) {
    ctx.signal.throwIfAborted();
    const requirements = posting.extraction?.requirements ?? [];
    const candidates = await gatherCandidates(requirements, ctx.deps, {
      signal: ctx.signal,
      onEmbedError: (err) => ctx.deps.log.warn('query embedding failed', { err: err.message }),
    });
    const stored = new Set((posting.matches ?? []).map((m) => m.key));
    if (candidates.some((c) => !stored.has(c.key))) changed.push(posting.id);
  }
  return {
    kind: 'done',
    commit: (tx) => {
      const still = new Set(rematchCandidates(tx.db).map((p) => p.id));
      let queued = 0;
      for (const id of changed) {
        if (!still.has(id) || pending(tx.db, 'score_posting', id)) continue;
        tx.enqueue('score_posting', id, { runId: null });
        queued++;
      }
      ctx.deps.log.info('rematch', { checked: rows.length, queued });
    },
  };
};
