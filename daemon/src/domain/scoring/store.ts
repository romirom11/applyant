// Applying score() to stored postings. Runs inside a write transaction (a task commit or an
// RPC), reading preferences, feedback and rates through the same handle, so a preference
// changed during a slow matcher run is still honoured at commit time.
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Conn, Db } from '../../db/client.ts';
import {
  type PostingDecision,
  type PostingRow,
  type PostingStage,
  postingFeedback,
  postings,
  tasks,
} from '../../db/schema.ts';
import type { EventBus } from '../../queue/events.ts';
import { runInTx } from '../../queue/tx.ts';
import type { Tx } from '../../queue/types.ts';
import { ensureApplication } from '../applications/store.ts';
import { type CompanyScoreInfo, companyKey, companyScoreInfo } from '../companies/store.ts';
import {
  effectiveWeights,
  feedbackMultipliers,
  listFeedback,
  reasonComponent,
  weakestComponent,
} from './feedback.ts';
import { loadRates } from './fx.ts';
import { getPreferences, type Preferences } from './prefs.ts';
import { score } from './score.ts';
import { effectiveExtraction } from './structured.ts';
import type { ScoreResult, Weights } from './types.ts';

/** Stages a posting can be (re-)scored in. */
export const SCORABLE_STAGES: PostingStage[] = ['verified', 'scored', 'skipped'];

export interface ScoringContext {
  prefs: Preferences;
  /** Feedback multipliers per component (1 = no nudge). */
  multipliers: Weights;
  weights: Weights;
  fx: ReturnType<typeof loadRates>;
  /** Researched companies' red flags, by companyKey. */
  companies: Map<string, CompanyScoreInfo>;
}

export function scoringContext(conn: Conn): ScoringContext {
  const prefs = getPreferences(conn);
  const multipliers = feedbackMultipliers(listFeedback(conn));
  return {
    prefs,
    multipliers,
    weights: effectiveWeights(prefs.weights, multipliers),
    fx: loadRates(conn),
    companies: companyScoreInfo(conn),
  };
}

export function scorePostingRow(row: PostingRow, ctx: ScoringContext): ScoreResult | null {
  const effective = effectiveExtraction(row);
  if (!effective || !row.matches) return null;
  return score(
    {
      posting: effective.extraction,
      matches: row.matches,
      fx: ctx.fx,
      locations: row.locations,
      company: ctx.companies.get(companyKey(row.company)) ?? null,
    },
    ctx.prefs,
    ctx.weights,
  );
}

function save(conn: Conn, id: number, result: ScoreResult, now: Date): void {
  conn
    .update(postings)
    .set({
      score: result.score,
      coreFit: result.coreFit,
      breakdown: result.breakdown,
      dealbreakers: result.dealbreakers,
      scoredAt: now,
    })
    .where(eq(postings.id, id))
    .run();
}

/** Scores one posting from its cached extraction and matches. */
export function rescorePosting(
  conn: Conn,
  id: number,
  now: Date,
  ctx = scoringContext(conn),
): ScoreResult | null {
  const row = conn.select().from(postings).where(eq(postings.id, id)).get();
  if (!row) return null;
  const result = scorePostingRow(row, ctx);
  if (result) save(conn, id, result, now);
  return result;
}

/** Re-runs score() over every posting that has an extraction and matches. No model calls. */
export function rescoreAll(conn: Conn, now: Date): number {
  const ctx = scoringContext(conn);
  const rows = conn
    .select()
    .from(postings)
    .where(and(isNotNull(postings.extraction), isNotNull(postings.matches)))
    .all();
  let n = 0;
  for (const row of rows) {
    const result = scorePostingRow(row, ctx);
    if (!result) continue;
    if (
      result.score !== row.score ||
      JSON.stringify(result.breakdown) !== JSON.stringify(row.breakdown) ||
      JSON.stringify(result.dealbreakers) !== JSON.stringify(row.dealbreakers)
    ) {
      save(conn, row.id, result, now);
      n++;
    }
  }
  return n;
}

/**
 * Enqueues score_posting for the given postings (or every verified, scored or skipped one).
 * Postings that already have one waiting or running are left alone.
 */
export function requestScoring(
  db: Db,
  bus: EventBus,
  ids: number[],
  now: Date,
  o: { refresh?: boolean } = {},
): number[] {
  return runInTx(db, bus, { now }, (tx) => {
    const rows = ids.length
      ? ids.map((id) => {
          const row = tx.db.select().from(postings).where(eq(postings.id, id)).get();
          if (!row) throw new DecisionError(`posting ${id} not found`);
          return row;
        })
      : tx.db.select().from(postings).where(inArray(postings.stage, SCORABLE_STAGES)).all();
    const enqueued: number[] = [];
    for (const row of rows) {
      if (!SCORABLE_STAGES.includes(row.stage)) {
        if (ids.length) throw new DecisionError(`posting ${row.id} is ${row.stage}, not verified`);
        continue;
      }
      const busy = tx.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.kind, 'score_posting'),
            eq(tasks.entityId, row.id),
            inArray(tasks.status, ['queued', 'running']),
          ),
        )
        .get();
      if (busy) continue;
      if (o.refresh) {
        // The page is read again and re-extracted; matches stay, reused by cache key.
        tx.db
          .update(postings)
          .set({ text: null, jsonLd: null, extractionKey: null })
          .where(eq(postings.id, row.id))
          .run();
      }
      tx.enqueue('score_posting', row.id);
      enqueued.push(row.id);
    }
    return enqueued;
  });
}

/** Verified postings that were never scored (verified before scoring existed, or failed). */
export function unscoredPostings(conn: Conn): number[] {
  return conn
    .select({ id: postings.id })
    .from(postings)
    .where(
      and(eq(postings.stage, 'verified'), isNull(postings.scoredAt), isNull(postings.scoreNote)),
    )
    .all()
    .map((r) => r.id);
}

export class DecisionError extends Error {}

export interface DecisionResult {
  posting: PostingRow;
  /** Postings whose score changed because the feedback moved a weight. */
  rescored: number;
}

/**
 * The candidate skips a posting (with a reason) or marks it interested. The call is kept as
 * feedback (one per posting: a later call replaces an earlier one) and every score is
 * re-computed with the nudged weights.
 */
export function recordDecision(
  db: Db,
  bus: EventBus,
  input: { id: number; decision: PostingDecision; reason: string | null; now: Date },
): DecisionResult {
  return runInTx(db, bus, { now: input.now }, (tx) => decide(tx, input));
}

function decide(
  tx: Tx,
  input: { id: number; decision: PostingDecision; reason: string | null },
): DecisionResult {
  const row = tx.db.select().from(postings).where(eq(postings.id, input.id)).get();
  if (!row) throw new DecisionError(`posting ${input.id} not found`);
  const reason = input.reason?.trim() || null;

  let stage: PostingStage = row.stage;
  if (input.decision === 'skipped') stage = 'skipped';
  else if (row.stage === 'skipped') stage = row.score !== null ? 'scored' : 'verified';

  tx.db
    .update(postings)
    .set({ stage, decision: input.decision, decisionReason: reason, decidedAt: tx.now })
    .where(eq(postings.id, row.id))
    .run();
  tx.db.delete(postingFeedback).where(eq(postingFeedback.postingId, row.id)).run();
  tx.db
    .insert(postingFeedback)
    .values({
      postingId: row.id,
      kind: input.decision,
      reason,
      component:
        input.decision === 'skipped' ? reasonComponent(reason) : weakestComponent(row.breakdown),
      createdAt: tx.now,
    })
    .run();
  if (stage !== row.stage) {
    tx.emit({
      kind: 'posting.stage',
      postingId: row.id,
      stage,
      message:
        input.decision === 'skipped' ? `skipped${reason ? `: ${reason}` : ''}` : 'interested',
    });
  }
  const rescored = rescoreAll(tx.db, tx.now);
  // Marking a posting interested starts its application (a skip leaves an existing one alone).
  if (input.decision === 'interested' && (stage === 'scored' || stage === 'verified')) {
    ensureApplication(tx, row.id, 'you marked it interested');
  }
  const posting = tx.db.select().from(postings).where(eq(postings.id, row.id)).get();
  if (!posting) throw new DecisionError(`posting ${input.id} vanished`);
  return { posting, rescored };
}
