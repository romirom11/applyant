// Review edits enrich knowledge: the candidate's words (an answer sentence, a CV line) become a
// confirmed `review_edit` fact, so the next writer cites them and the same exaggeration doesn't
// come back. Their words aren't verified.
import { eq } from 'drizzle-orm';
import { evidence, type FactKind, facts } from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { MAX_FACT_LENGTH } from '../knowledge/facts.ts';

/**
 * The candidate's words become a confirmed review_edit fact: in `projectId` when given (a CV
 * bullet is its project's), else in the cited facts' project when they share one.
 */
export function reviewFact(
  tx: Tx,
  applicationId: number,
  text: string,
  cited: number[],
  projectId?: number | null,
): number {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
  const rows = cited
    .map((id) =>
      tx.db
        .select({ projectId: facts.projectId, kind: facts.kind })
        .from(facts)
        .where(eq(facts.id, id))
        .get(),
    )
    .filter((r): r is { projectId: number | null; kind: FactKind } => !!r);
  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  const inProject =
    projectId !== undefined && projectId !== null
      ? projectId
      : projectIds.length === 1
        ? (projectIds[0] ?? null)
        : null;
  const kind: FactKind = rows[0]?.kind ?? 'other';
  const fact = tx.db
    .insert(facts)
    .values({
      projectId: inProject,
      text: clean,
      kind,
      status: 'confirmed',
      origin: 'review_edit',
      createdAt: tx.now,
      updatedAt: tx.now,
    })
    .returning({ id: facts.id })
    .get();
  tx.db
    .insert(evidence)
    .values({
      factId: fact.id,
      sourceId: null,
      locator: `review of application ${applicationId}`,
      excerpt: null,
    })
    .run();
  return fact.id;
}
