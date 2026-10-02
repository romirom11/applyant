// deliver_application: fills and submits the real, live application form through its channel,
// once the candidate has approved it. Result: `applied` (stage + applied_at + a receipt of
// exactly what was sent) or `needs_candidate` with a hand-off — the browser window is left open
// and filled when delivery got stuck mid-form. Like every handler, this never writes: it
// returns a commit the queue applies under the lease.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Page } from 'playwright';
import { captchaStep } from '../../browser/captcha.ts';
import {
  detectChallenge,
  type Guardrails,
  PlatformBusy,
  PlatformCapReached,
  type PlatformKey,
  PlatformPaused,
  platformName,
  platformOf,
} from '../../browser/guardrails.ts';
import { type DeliverContext, type DeliverOutcome, DeliveryStale } from '../../channels/channel.ts';
import {
  type ApplicationRow,
  type ApplicationStage,
  type ApplyForm,
  applications,
  fieldValues,
  type PostingRow,
  postings,
  receipts,
  tasks,
} from '../../db/schema.ts';
import type { MailAccess } from '../../integrations/mail-service.ts';
import type { Handler, HandlerContext, HandOff, Outcome, Tx } from '../../queue/types.ts';
import { getStandardProfile } from '../knowledge/profile.ts';
import { waitForSecurityCode } from './security-code.ts';
import {
  ApplicationError,
  applicationView,
  applyTarget,
  applyTargets,
  emitStage,
  requestPrepare,
} from './store.ts';

export { applyTarget, applyTargets };

/** Failed delivery attempts (a thrown error, not a hand-off) are retried this many times. */
export const DELIVER_ATTEMPTS = 3;

const noop: Outcome = { kind: 'done', commit: () => {} };

export const deliverApplication: Handler<'deliver_application'> = async (task, ctx) => {
  const app = ctx.read.select().from(applications).where(eq(applications.id, task.entityId)).get();
  if (app?.stage !== 'approved') return noop;
  const posting = ctx.read.select().from(postings).where(eq(postings.id, app.postingId)).get();
  if (!posting) return noop;
  // An earlier run got as far as pressing submit (or sending) and never saw how it ended: a
  // crash, a restart, the browser closing. Sending again could apply twice, so the candidate
  // checks first.
  if (app.submitAttemptedAt) return needsCandidate(app, interruptedReason(app.submitAttemptedAt));

  // An email or Telegram target (phases 13, 15) goes through its channel whatever the row was
  // created with.
  const channelKey =
    posting.formStatus === 'email' || posting.formStatus === 'telegram'
      ? posting.formStatus
      : app.channel;
  const channel = ctx.deps.channels[channelKey];
  if (!channel) return needsCandidate(app, `no "${channelKey}" delivery channel yet`);

  const view = applicationView(ctx.read, app.id);
  const profile = getStandardProfile(ctx.read);
  const mail = ctx.deps.mail ?? null;
  const cvProblem = tailoredCvChanged(view);
  if (cvProblem) return needsCandidate(app, cvProblem);

  // The company's own form when the posting also has one (TDD: "listings prefer the original
  // form"); Read used the same target, so the prepared fields match it.
  const target = channelKey === 'web_form' ? applyTarget(ctx.read, posting) : null;
  const platform = target ? platformOf(target) : null;
  const guard = platform ? (ctx.deps.guardrails ?? null) : null;
  if (platform && !guard) {
    return needsCandidate(app, `${platformName(platform)} delivery needs the platform guardrails`);
  }
  // CapMonster only off the guarded platforms: a captcha on LinkedIn/Xing is a challenge.
  const solver =
    !platform && ctx.deps.captcha && (await ctx.deps.captcha.configured().catch(() => false))
      ? ctx.deps.captcha
      : null;
  const progress = (message: string) => ctx.progress({ message });
  const deliverCtx: DeliverContext = {
    taskId: task.id,
    signal: ctx.signal,
    progress,
    begin: () => {
      const now = ctx.read
        .select({ stage: applications.stage, attempted: applications.submitAttemptedAt })
        .from(applications)
        .where(eq(applications.id, app.id))
        .get();
      if (now?.stage !== 'approved' || now.attempted) throw new DeliveryStale();
    },
    submitting: () => {
      const recorded = ctx.record((tx) => {
        tx.db
          .update(applications)
          .set({ submitAttemptedAt: tx.now })
          .where(eq(applications.id, app.id))
          .run();
      });
      if (!recorded) throw new Error('the delivery lost its lease before submitting');
    },
    profile,
    ...(mail ? { securityCode: securityCodeReader(mail, ctx) } : {}),
    ...(platform
      ? {
          captcha: async (page: Page) => {
            const step = await captchaStep(page, null);
            return step.kind === 'handoff'
              ? {
                  ...step,
                  challenge: `${step.reason.replace(/ is on this step.*$/, '')} on ${platformName(platform)}`,
                }
              : step;
          },
          challenge: (page: Page) => detectChallenge(page, platform),
        }
      : solver
        ? { captcha: (page: Page) => captchaStep(page, solver, { signal: ctx.signal, progress }) }
        : {}),
  };
  const sending =
    target && target !== posting.applyUrl ? { ...posting, applyUrl: target } : posting;
  const send = () => channel.deliver(app, sending as PostingRow, view, deliverCtx);

  let outcome: DeliverOutcome;
  try {
    outcome =
      guard && platform ? await guardedDelivery(guard, platform, send, task.id, ctx) : await send();
  } catch (err) {
    if (err instanceof DeliveryStale) return noop;
    if (submitAttempted(ctx, app.id)) {
      // It failed (or was interrupted) after submit was pressed: never a silent second try.
      const at = submitAttempted(ctx, app.id) as Date;
      return needsCandidate(app, interruptedReason(at, firstLine(err)));
    }
    ctx.signal.throwIfAborted();
    if (err instanceof PlatformPaused) return needsCandidate(app, err.message);
    if (err instanceof PlatformCapReached) return deferDelivery(app, err.message, err.until);
    if (err instanceof PlatformBusy) {
      return deferDelivery(app, err.message, new Date(ctx.now().getTime() + 15 * 60_000));
    }
    const reason = firstLine(err);
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
          messageId: receipt.messageId ?? null,
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

function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split('\n')[0] || 'delivery failed';
}

function submitAttempted(ctx: HandlerContext, applicationId: number): Date | null {
  return (
    ctx.read
      .select({ at: applications.submitAttemptedAt })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .get()?.at ?? null
  );
}

/** The hand-off for a delivery that pressed submit and never saw the result. */
function interruptedReason(at: Date, why?: string): string {
  return `Applyant pressed submit at ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC and was interrupted before it saw the result${why ? ` (${why})` : ''}. The application may already be sent: check your inbox or the site. If it arrived, mark it as submitted; if not, try delivery again`;
}

/**
 * A delivery on LinkedIn/Xing: in the platform's lane, within its cap, paced. A challenge on the
 * page pauses the platform; the candidate gets the hand-off.
 */
async function guardedDelivery(
  guard: Guardrails,
  platform: PlatformKey,
  send: () => Promise<DeliverOutcome>,
  taskId: number,
  ctx: HandlerContext,
): Promise<DeliverOutcome> {
  const outcome = await guard.run(platform, 'apply', () => send(), {
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    taskId,
  });
  if (outcome.kind === 'needs_candidate' && outcome.challenge) {
    guard.pause(platform, outcome.challenge);
    return {
      ...outcome,
      handOff: {
        ...outcome.handOff,
        reason: `${outcome.challenge}: never sent to a captcha solver. ${platformName(platform)} is paused until you answer it in the browser window and run \`applyant platforms resume ${platform}\``,
      },
    };
  }
  return outcome;
}

/** Stages whose application can still change form: nothing has been approved or sent. */
const SWITCHABLE: ApplicationStage[] = ['preparing', 'ready_for_review', 'needs_candidate'];

/**
 * Switches the application between the platform's form and the company's own. The form is read
 * again from its new target and the application prepared again for it, as after any form
 * change: values are keyed by the form's own fields, so what was prepared (and overridden) for
 * the old form isn't sent to the new one; the old form's values come back if it's switched back.
 */
export function setApplyForm(tx: Tx, app: ApplicationRow, form: ApplyForm): ApplicationRow {
  if (!SWITCHABLE.includes(app.stage)) {
    throw new ApplicationError(
      `application ${app.id} is ${app.stage}: its form can only change before approval`,
    );
  }
  const posting = tx.db.select().from(postings).where(eq(postings.id, app.postingId)).get();
  if (!posting) throw new ApplicationError(`application ${app.id} has no posting`);
  const targets = applyTargets(tx.db, posting);
  if (!targets[form]) {
    throw new ApplicationError(
      form === 'platform'
        ? `posting ${posting.id} isn't on LinkedIn or Xing: there's no platform form`
        : `posting ${posting.id} has no company form known (only ${targets.platform})`,
    );
  }
  const before = applyTarget(tx.db, posting);
  tx.db
    .update(applications)
    .set({ applyForm: form, updatedAt: tx.now })
    .where(eq(applications.id, app.id))
    .run();
  const row = tx.db.select().from(applications).where(eq(applications.id, app.id)).get() ?? app;
  if (applyTarget(tx.db, posting) === before) return row;
  // The old form's read goes; preparing waits for the new one (prepare enqueues read_form).
  tx.db
    .update(postings)
    .set({ form: null, formStatus: null, formNote: null, formReadAt: null })
    .where(eq(postings.id, posting.id))
    .run();
  return requestPrepare(tx, row, {
    rewrite: false,
    why:
      form === 'platform'
        ? `switched to the ${platformName(platformOf(targets.platform ?? '') ?? 'linkedin')} form`
        : "switched to the company's own form",
  });
}

/** Over a platform's daily cap (or the candidate is using it): the delivery runs again later. */
function deferDelivery(app: ApplicationRow, reason: string, after: Date): Outcome {
  return {
    kind: 'done',
    commit: (tx) => {
      const current = tx.db.select().from(applications).where(eq(applications.id, app.id)).get();
      if (current?.stage !== 'approved') return;
      tx.db
        .update(applications)
        .set({ note: `delivery waits: ${reason}`.slice(0, 1000), updatedAt: tx.now })
        .where(eq(applications.id, app.id))
        .run();
      tx.enqueue('deliver_application', app.id, { runAfter: after });
    },
  };
}

/**
 * The security-code step's mailbox read: the connected mailbox, polled for a code sent after
 * the submission (DeliverContext.securityCode).
 */
function securityCodeReader(
  mail: MailAccess,
  ctx: HandlerContext,
): (since: Date) => Promise<string | null> {
  return async (since) => {
    const box = await mail.open();
    if (!box) return null;
    return waitForSecurityCode(box, {
      since,
      timeoutMs: mail.codeTimeoutMs,
      pollMs: mail.codePollMs,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
    });
  };
}

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

/** Whether the application's latest delivery ended in a hand-off. */
function handedOff(tx: Tx, applicationId: number): boolean {
  const last = tx.db
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.kind, 'deliver_application'), eq(tasks.entityId, applicationId)))
    .orderBy(desc(tasks.id))
    .get();
  return last?.status === 'needs_candidate';
}

/**
 * Startup catch-up: an approved application with no receipt yet, and no hand-off waiting on the
 * candidate, gets delivery enqueued.
 */
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
    // A delivery that stopped for the candidate stays with the candidate: they may have finished
    // the form by hand already. Only they start it again ("Try delivery again").
    if (handedOff(tx, r.id)) continue;
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
