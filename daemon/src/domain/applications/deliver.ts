// deliver_application: fills and submits the real, live application form through its channel,
// once the candidate has approved it. Result: `applied` (stage + applied_at + a receipt of
// exactly what was sent) or `needs_candidate` with a hand-off — the browser window is left open
// and filled when delivery got stuck mid-form. Like every handler, this never writes: it
// returns a commit the queue applies under the lease.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import type { DeliverOutcome } from '../../channels/channel.ts';
import {
  type ApplicationRow,
  applications,
  fieldValues,
  type PostingRow,
  postings,
  receipts,
  tasks,
} from '../../db/schema.ts';
import type { Handler, HandOff, Outcome, Tx } from '../../queue/types.ts';
import { getStandardProfile } from '../knowledge/profile.ts';
import { ApplicationError, applicationView, emitStage } from './store.ts';

/** Failed delivery attempts (a thrown error, not a hand-off) are retried this many times. */
export const DELIVER_ATTEMPTS = 3;

const noop: Outcome = { kind: 'done', commit: () => {} };

export const deliverApplication: Handler<'deliver_application'> = async (task, ctx) => {
  const app = ctx.read.select().from(applications).where(eq(applications.id, task.entityId)).get();
  if (app?.stage !== 'approved') return noop;
  const posting = ctx.read.select().from(postings).where(eq(postings.id, app.postingId)).get();
  if (!posting) return noop;

  const channel = ctx.deps.channels[app.channel];
  if (!channel) return needsCandidate(app, `no "${app.channel}" delivery channel yet`);

  const view = applicationView(ctx.read, app.id);
  const profile = getStandardProfile(ctx.read);
  const cvProblem = tailoredCvChanged(view);
  if (cvProblem) return needsCandidate(app, cvProblem);

  let outcome: DeliverOutcome;
  try {
    outcome = await channel.deliver(app, posting as PostingRow, view, {
      taskId: task.id,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
      profile,
    });
  } catch (err) {
    ctx.signal.throwIfAborted();
    const reason = ((err as Error).message ?? String(err)).split('\n')[0] ?? 'delivery failed';
    if (task.attempts + 1 < DELIVER_ATTEMPTS) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason,
      };
    }
    return needsCandidate(app, `delivery kept failing: ${reason}`);
  }

  if (outcome.kind === 'applied') {
    const receipt = outcome.receipt;
    return {
      kind: 'done',
      commit: (tx) => {
        const current = tx.db.select().from(applications).where(eq(applications.id, app.id)).get();
        if (current?.stage !== 'approved') return;
        const values = {
          finalUrl: receipt.finalUrl,
          confirmationText: receipt.confirmationText,
          confirmationSnapshotPath: receipt.confirmationSnapshotPath,
          cvPath: receipt.cvPath,
          cvHash: receipt.cvHash,
          salaryValue: receipt.salaryValue,
          fieldValues: receipt.fieldValues,
          submittedAt: receipt.submittedAt,
        };
        tx.db
          .insert(receipts)
          .values({ applicationId: app.id, ...values })
          .onConflictDoUpdate({ target: receipts.applicationId, set: values })
          .run();
        const row = tx.db
          .update(applications)
          .set({ stage: 'applied', appliedAt: receipt.submittedAt, note: null, updatedAt: tx.now })
          .where(eq(applications.id, app.id))
          .returning()
          .get();
        emitStage(tx, row, 'applied', `application ${app.id}: applied`);
      },
    };
  }

  if (outcome.kind === 'new_field') {
    const field = outcome.field;
    const note = `a field only your live application showed ("${field.spec.label}") was added from your profile: check it before approving again`;
    return {
      kind: 'done',
      commit: (tx) => {
        const current = tx.db.select().from(applications).where(eq(applications.id, app.id)).get();
        if (current?.stage !== 'approved') return;
        const existing = tx.db
          .select()
          .from(fieldValues)
          .where(and(eq(fieldValues.applicationId, app.id), eq(fieldValues.fieldRef, field.ref)))
          .get();
        const position =
          Math.max(
            -1,
            ...tx.db
              .select({ position: fieldValues.position })
              .from(fieldValues)
              .where(eq(fieldValues.applicationId, app.id))
              .all()
              .map((r) => r.position),
          ) + 1;
        const set = {
          spec: field.spec,
          value: field.value,
          source: 'profile' as const,
          defaultValue: field.value,
          defaultSource: 'profile' as const,
          note: 'found live at delivery; added from your profile',
        };
        if (existing) {
          tx.db.update(fieldValues).set(set).where(eq(fieldValues.id, existing.id)).run();
        } else {
          tx.db
            .insert(fieldValues)
            .values({ applicationId: app.id, fieldRef: field.ref, position, ...set })
            .run();
        }
        const row = tx.db
          .update(applications)
          .set({ stage: 'ready_for_review', note, updatedAt: tx.now })
          .where(eq(applications.id, app.id))
          .returning()
          .get();
        emitStage(tx, row, 'ready_for_review', `application ${app.id}: ${note}`);
      },
    };
  }

  return needsCandidate(app, outcome.handOff.reason, outcome.handOff);
};

/** The tailored PDF about to be uploaded is byte for byte the one rendered for review. */
function tailoredCvChanged(view: ReturnType<typeof applicationView>): string | null {
  const cv = view.cv;
  if (cv?.mode !== 'tailored' || !cv.pdfPath || !cv.pdfHash) return null;
  const sending = view.fields.some((f) => f.active && f.value === cv.pdfPath);
  if (!sending) return null;
  let hash: string;
  try {
    hash = createHash('sha256').update(readFileSync(cv.pdfPath)).digest('hex');
  } catch {
    return `the tailored CV you approved is missing (${cv.pdfPath}), so nothing was sent`;
  }
  return hash === cv.pdfHash
    ? null
    : `the tailored CV at ${cv.pdfPath} changed after you approved it, so nothing was sent`;
}

function needsCandidate(app: ApplicationRow, reason: string, handOff?: HandOff): Outcome {
  const ho: HandOff = handOff ?? { reason, detail: null };
  return {
    kind: 'needs_candidate',
    handOff: ho,
    commit: (tx) => {
      const current = tx.db.select().from(applications).where(eq(applications.id, app.id)).get();
      if (!current) return;
      tx.db
        .update(applications)
        .set({ note: `delivery: ${reason}`.slice(0, 1000), updatedAt: tx.now })
        .where(eq(applications.id, app.id))
        .run();
      tx.emit({
        kind: 'handoff',
        entityId: app.id,
        postingId: app.postingId,
        message: reason,
      });
    },
  };
}

/** Enqueues delivery, unless one is already queued or running for this application. */
export function enqueueDelivery(tx: Tx, applicationId: number): void {
  const busy = tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'deliver_application'),
        eq(tasks.entityId, applicationId),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
  if (!busy) tx.enqueue('deliver_application', applicationId);
}

/** Startup catch-up: an approved application with no receipt yet gets delivery enqueued. */
export function catchUpDeliveries(tx: Tx): number {
  const rows = tx.db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.stage, 'approved'))
    .all();
  let n = 0;
  for (const r of rows) {
    const delivered = tx.db
      .select({ id: receipts.id })
      .from(receipts)
      .where(eq(receipts.applicationId, r.id))
      .get();
    if (delivered) continue;
    enqueueDelivery(tx, r.id);
    n++;
  }
  return n;
}

/**
 * `applications mark-submitted`: the candidate finished a hand-off in the browser window and
 * pressed submit themselves. The application becomes applied, with a receipt of the prepared
 * values (what the window was filled with) marked as submitted by hand, and the hand-off closes.
 */
export function markSubmittedByHand(tx: Tx, applicationId: number): ApplicationRow {
  const view = applicationView(tx.db, applicationId);
  if (view.app.stage !== 'approved' || !view.handOff) {
    throw new ApplicationError(
      `application ${applicationId} has no delivery waiting on you (it is ${view.app.stage.replace(/_/g, ' ')})`,
    );
  }
  const sent = view.fields
    .filter((f) => f.active && f.value !== null && f.value !== '')
    .map((f) => ({ ref: f.ref, label: f.label, value: f.value, source: f.source }));
  const byRef = new Map(view.fields.map((f) => [f.ref, f]));
  const cv = sent.find((s) => byRef.get(s.ref)?.meaning === 'resume');
  const salary = sent.find((s) => byRef.get(s.ref)?.meaning === 'salary');
  let cvHash: string | null = null;
  if (cv?.value) {
    try {
      cvHash = createHash('sha256').update(readFileSync(cv.value)).digest('hex');
    } catch {
      cvHash = null;
    }
  }
  const values = {
    finalUrl: view.handOff.browser?.url ?? view.posting.formUrl ?? view.posting.canonicalUrl,
    confirmationText: `submitted by you in the browser after a hand-off (${view.handOff.reason})`,
    confirmationSnapshotPath: null,
    cvPath: cv?.value ?? null,
    cvHash,
    salaryValue: salary?.value ?? null,
    fieldValues: sent,
    submittedAt: tx.now,
  };
  tx.db
    .insert(receipts)
    .values({ applicationId, ...values })
    .onConflictDoUpdate({ target: receipts.applicationId, set: values })
    .run();
  // The hand-off is over: its task is done.
  tx.db
    .update(tasks)
    .set({ status: 'done', updatedAt: tx.now })
    .where(
      and(
        eq(tasks.kind, 'deliver_application'),
        eq(tasks.entityId, applicationId),
        eq(tasks.status, 'needs_candidate'),
      ),
    )
    .run();
  const row = tx.db
    .update(applications)
    .set({ stage: 'applied', appliedAt: tx.now, note: null, updatedAt: tx.now })
    .where(eq(applications.id, applicationId))
    .returning()
    .get();
  emitStage(
    tx,
    row,
    'applied',
    `application ${applicationId}: applied (submitted by you in the browser)`,
  );
  return row;
}
