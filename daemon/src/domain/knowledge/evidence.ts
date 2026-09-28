// Evidence: where a fact came from. Every extracted fact has at least one row, pointing at
// its source and a locator inside it (page, section, commit:<sha>, pr:#n, path:<file>).
import { eq, inArray } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { evidence, type SourceKind, sources } from '../../db/schema.ts';

export interface EvidenceView {
  factId: number;
  sourceId: number | null;
  sourceKind: SourceKind | null;
  sourceLocator: string | null;
  locator: string | null;
  excerpt: string | null;
}

export function addEvidence(
  conn: Conn,
  factId: number,
  sourceId: number | null,
  items: Array<{ locator: string | null; excerpt: string | null }>,
): void {
  const seen = new Set<string>();
  const rows = (items.length ? items : [{ locator: null, excerpt: null }]).filter((e) => {
    const key = `${e.locator ?? ''}\u0000${e.excerpt ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const e of rows) {
    conn
      .insert(evidence)
      .values({
        factId,
        sourceId,
        locator: e.locator?.slice(0, 300) ?? null,
        excerpt: e.excerpt?.slice(0, 400) ?? null,
      })
      .run();
  }
}

export function evidenceFor(conn: Conn, factIds: number[]): Map<number, EvidenceView[]> {
  const out = new Map<number, EvidenceView[]>();
  if (factIds.length === 0) return out;
  const rows = conn
    .select({
      factId: evidence.factId,
      sourceId: evidence.sourceId,
      sourceKind: sources.kind,
      sourceLocator: sources.locator,
      locator: evidence.locator,
      excerpt: evidence.excerpt,
    })
    .from(evidence)
    .leftJoin(sources, eq(evidence.sourceId, sources.id))
    .where(inArray(evidence.factId, factIds))
    .orderBy(evidence.id)
    .all();
  for (const row of rows) {
    const list = out.get(row.factId) ?? [];
    list.push(row);
    out.set(row.factId, list);
  }
  return out;
}
