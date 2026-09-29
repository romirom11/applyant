// read_form: open the posting's apply target in a throwaway reader context and store what the
// application form asks for (postings.form). Read-only: nothing is submitted or uploaded to
// the employer (see browser/form-read.ts). The candidate's standard profile values steer the
// dry-fill, so conditional fields are recorded under the branch their answer takes.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { guardReadOnly, readForm } from '../../browser/form-read.ts';
import { type FormRead, fieldCount } from '../../browser/form-types.ts';
import { emailForm } from '../../channels/email.ts';
import type { Db } from '../../db/client.ts';
import {
  type FormStatus,
  type PostingRow,
  type PostingStage,
  postings,
  tasks,
} from '../../db/schema.ts';
import type { EventBus } from '../../queue/events.ts';
import { runInTx } from '../../queue/tx.ts';
import type { Handler, Tx } from '../../queue/types.ts';
import { getStandardProfile } from '../knowledge/profile.ts';
import { FormJudge } from './form-judge.ts';
import { formReadFor } from './store.ts';

/** Navigation failures are retried this many times before the read is marked failed. */
export const READ_FORM_ATTEMPTS = 3;
/** Stages whose postings have a form worth reading. */
export const READABLE_STAGES: PostingStage[] = ['verified', 'scored'];

export function summariseForm(read: FormRead): string {
  const steps = read.requirements.steps.length;
  const { fields, required } = fieldCount(read.requirements);
  return `${steps} step${steps === 1 ? '' : 's'} · ${fields} fields (${required} required)`;
}

export const readFormHandler: Handler<'read_form'> = async (task, ctx) => {
  const posting = ctx.read.select().from(postings).where(eq(postings.id, task.entityId)).get();
  if (!posting || !READABLE_STAGES.includes(posting.stage))
    return { kind: 'done', commit: () => {} };
  const url = posting.applyUrl ?? posting.canonicalUrl;
  if (url.startsWith('mailto:')) {
    return {
      kind: 'done',
      // The email channel's "form": the message and the CV (phase 13).
      commit: (tx) =>
        save(tx, posting, 'email', `applies by email to ${url.slice(7)}`, emailForm(url)),
    };
  }

  const judge = new FormJudge({
    decide: (role, req) => ctx.deps.models.decide(role, req),
    profile: getStandardProfile(ctx.read),
    job: { title: posting.title, company: posting.company },
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
  });

  let outcome: Awaited<ReturnType<typeof readForm>>;
  let blocked = 0;
  try {
    outcome = await ctx.deps.reader.withPage(
      async (page) => {
        const guard = await guardReadOnly(page.context());
        try {
          return await readForm(page, {
            url,
            judge,
            signal: ctx.signal,
            progress: (message) => ctx.progress({ message }),
          });
        } finally {
          blocked = guard.blocked.length;
        }
      },
      { signal: ctx.signal },
    );
  } catch (err) {
    ctx.signal.throwIfAborted();
    const reason = (err as Error).message.split('\n')[0] ?? 'read failed';
    if (task.attempts + 1 < READ_FORM_ATTEMPTS) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason,
      };
    }
    return { kind: 'done', commit: (tx) => save(tx, posting, 'failed', reason, null) };
  }

  if (outcome.kind === 'no_form') {
    return { kind: 'done', commit: (tx) => save(tx, posting, 'no_form', outcome.note, null) };
  }
  const read = outcome.read;
  if (blocked > 0) read.notes.push(`${blocked} request(s) that could send data were blocked`);
  if (judge.unsure.length) {
    read.notes.push(
      `unsure what ${judge.unsure.length} field(s) ask for: ${judge.unsure.slice(0, 5).join(' · ')}`,
    );
  }
  return {
    kind: 'done',
    commit: (tx) => save(tx, posting, 'verified', summariseForm(read), read),
  };
};

function save(
  tx: Tx,
  posting: PostingRow,
  status: FormStatus,
  note: string,
  read: FormRead | null,
): void {
  tx.db
    .update(postings)
    .set({ form: read, formStatus: status, formNote: note.slice(0, 500), formReadAt: tx.now })
    .where(eq(postings.id, posting.id))
    .run();
  const current = tx.db
    .select({ stage: postings.stage })
    .from(postings)
    .where(eq(postings.id, posting.id))
    .get();
  tx.emit({
    kind: 'posting.form',
    postingId: posting.id,
    stage: current?.stage ?? posting.stage,
    message:
      status === 'verified'
        ? `apply form verified: ${note}`
        : `apply form ${status.replace('_', ' ')}: ${note}`,
  });
  // An application waiting for this form (or prepared from an older read) is prepared now.
  formReadFor(tx, posting.id);
}

/**
 * Enqueues read_form for the given postings (or every readable one never read). Postings that
 * already have one waiting or running are left alone. Returns the enqueued ids.
 */
export function requestFormRead(db: Db, bus: EventBus, ids: number[], now: Date): number[] {
  return runInTx(db, bus, { now }, (tx) => {
    const rows = ids.length
      ? tx.db.select().from(postings).where(inArray(postings.id, ids)).all()
      : tx.db
          .select()
          .from(postings)
          .where(and(inArray(postings.stage, READABLE_STAGES), isNull(postings.formReadAt)))
          .all();
    const out: number[] = [];
    for (const row of rows) {
      if (!READABLE_STAGES.includes(row.stage)) continue;
      const busy = tx.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.kind, 'read_form'),
            eq(tasks.entityId, row.id),
            inArray(tasks.status, ['queued', 'running']),
          ),
        )
        .get();
      if (busy) continue;
      tx.enqueue('read_form', row.id);
      out.push(row.id);
    }
    return out;
  });
}
