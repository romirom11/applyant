// Hybrid retrieval over facts: BM25 over facts_fts and KNN over facts_vec, fused by
// reciprocal rank (RRF). This is the one hand-typed query (types declared here by hand);
// it runs on the read-worker pool.
import { sql } from 'drizzle-orm';
import type { ReadExec } from '../../db/read-pool.ts';
import type { FactKind, FactStatus } from '../../db/schema.ts';
import { EMBEDDING_DIMS, vectorBlob } from '../../models/embeddings.ts';

export interface FactHit {
  id: number;
  text: string;
  status: FactStatus;
  kind: FactKind;
  projectId: number | null;
  /** Project name and period, for context in prompts. */
  project: string | null;
  period: string | null;
  score: number;
}

export interface RetrieveQuery {
  text: string;
  /** The query embedding; null = keyword search only (no embedder available). */
  vector: Float32Array | null;
}

/** The usual RRF constant: ranks matter, raw scores don't. */
export const RRF_K = 60;

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in into is it its of on or our that the their ' +
    'this to we with you your will who what which within across using use used via etc plus ' +
    'experience experienced years year strong solid good great excellent knowledge ability ' +
    'able skills skill working work understanding familiarity familiar proficiency proficient ' +
    'hands-on hands on least minimum preferred required requirement nice bonus ideally'
  ).split(/\s+/),
);

/**
 * An FTS5 query for free text: every meaningful word as a quoted term, ORed. Quoting keeps
 * FTS syntax characters in the text (`-`, `:`, `"`) from being read as operators.
 */
export function ftsQuery(text: string): string | null {
  const words =
    text
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? [];
  const terms = [
    ...new Set(
      words
        .map((w) => w.replace(/\.+$/, ''))
        .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOPWORDS.has(w)),
    ),
  ];
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

const NOTHING = '"\u0001"';

export async function retrieveFacts(
  exec: ReadExec,
  q: RetrieveQuery,
  limit = 8,
): Promise<FactHit[]> {
  const match = ftsQuery(q.text);
  if (!match && !q.vector) return [];
  // Each side contributes a few times `limit` candidates; rejected facts are dropped after
  // fusion, so the pools leave room for them.
  const pool = limit * 4;
  const unit = new Float32Array(EMBEDDING_DIMS);
  unit[0] = 1;
  const vector = vectorBlob(q.vector ?? unit);
  const useFts = match ? 1 : 0;
  const useVec = q.vector ? 1 : 0;
  return exec.all<FactHit>(sql`
    WITH fts AS (
      SELECT rowid AS id, row_number() OVER (ORDER BY bm25(facts_fts)) AS r
      FROM facts_fts
      WHERE facts_fts MATCH ${match ?? NOTHING} AND ${useFts} = 1
      ORDER BY bm25(facts_fts)
      LIMIT ${pool}
    ),
    vec AS (
      SELECT fact_id AS id, row_number() OVER (ORDER BY distance) AS r
      FROM facts_vec
      WHERE embedding MATCH ${vector} AND k = ${pool}
    ),
    fused AS (
      SELECT id, sum(1.0 / (${RRF_K} + r)) AS score
      FROM (
        SELECT id, r FROM fts
        UNION ALL
        SELECT id, r FROM vec WHERE ${useVec} = 1
      )
      GROUP BY id
    )
    SELECT f.id AS id, f.text AS text, f.status AS status, f.kind AS kind,
           f.project_id AS projectId, p.name AS project, p.period AS period,
           fused.score AS score
    FROM fused
    JOIN facts f ON f.id = fused.id
    LEFT JOIN projects p ON p.id = f.project_id
    WHERE f.status <> 'rejected'
    ORDER BY fused.score DESC, f.id ASC
    LIMIT ${limit}
  `);
}
