// The candidate corrects an application's status by hand (PRD: "every status can be corrected
// by hand, in the app or from the CLI"). Only the statuses the outside world decides can be
// set: applied (sent outside Applyant, or a wrongly read reply undone), interview, offer,
// rejected and withdrawn. The pipeline's own stages (preparing, review, approved) are never set
// here, and nothing is delivered: approving stays the only way to send.
import { and, eq, inArray } from 'drizzle-orm';
import {
  type ApplicationRow,
  type ApplicationStage,
  applications,
  tasks,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { ApplicationError, emitStage, getApplicationRow } from './store.ts';

/** The statuses the candidate can set by hand. */
export const MANUAL_STAGES = ['applied', 'interview', 'offer', 'rejected', 'withdrawn'] as const;
export type ManualStage = (typeof MANUAL_STAGES)[number];

/** Stages of an application that was sent. */
export const SENT_STAGES: ApplicationStage[] = [
  'applied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
];

/** A move that can't be true; the message says why and what to do instead. */
export class StageRefused extends ApplicationError {}

export function isManualStage(stage: string): stage is ManualStage {
  return (MANUAL_STAGES as readonly string[]).includes(stage);
}

/** Why the move is refused, or null when it's allowed. */
export function refuseStage(
  app: Pick<ApplicationRow, 'id' | 'stage'>,
  to: ApplicationStage,
  delivering: boolean,
): string | null {
  if (!isManualStage(to)) {
    return `${to} isn't a status you set by hand (only ${MANUAL_STAGES.join(', ')}); preparing, review and approval follow the pipeline`;
  }
  if (app.stage === to) return `application ${app.id} is already ${to}`;
  if (delivering) {
    return `application ${app.id} is being delivered right now; wait until it's applied or handed off`;
  }
  if (app.stage === 'preparing') {
    return `application ${app.id} is being prepared; wait until it's ready for review`;
  }
  const sent = SENT_STAGES.includes(app.stage);
  if (to !== 'applied' && !sent) {
    return `application ${app.id} hasn't been sent (${app.stage}), so it can't be ${to}; set it to applied first if you sent it yourself, or skip the posting`;
  }
  return null;
}

function deliveryPending(tx: Tx, id: number): boolean {
  return !!tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'deliver_application'),
        eq(tasks.entityId, id),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
}

/**
 * Sets the stage by hand, recorded as a manual `application.stage` event. Reaching interview or
 * offer is kept (for the interview rate) unless the correction goes back below it.
 */
export function setApplicationStage(
  tx: Tx,
  applicationId: number,
  to: ApplicationStage,
): ApplicationRow {
  const app = getApplicationRow(tx.db, applicationId);
  const refused = refuseStage(app, to, deliveryPending(tx, app.id));
  if (refused) throw new StageRefused(refused);
  const reached: Partial<ApplicationRow> = {};
  if (to === 'applied') {
    // Undoing a wrongly read reply: it never got that far.
    reached.interviewAt = null;
    reached.offerAt = null;
    reached.appliedAt = app.appliedAt ?? tx.now;
  } else if (to === 'interview') {
    reached.interviewAt = app.interviewAt ?? tx.now;
    reached.offerAt = null;
  } else if (to === 'offer') {
    reached.interviewAt = app.interviewAt ?? tx.now;
    reached.offerAt = app.offerAt ?? tx.now;
  }
  const row = tx.db
    .update(applications)
    .set({ stage: to, ...reached, updatedAt: tx.now })
    .where(eq(applications.id, app.id))
    .returning()
    .get();
  emitStage(tx, row, to, `application ${app.id}: ${app.stage} → ${to} (set by hand)`);
  return row;
}
