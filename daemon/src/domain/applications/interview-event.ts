// Interview invites → Google Calendar (phase 13). An email labelled `interview` and linked to
// an application (matched on its own, or assigned by the candidate) queues `interview_event`.
// The handler makes one event on the candidate's primary calendar, linked to the application
// and the company, and records it on the email. It never makes a second one: the email already
// has an event → nothing to do; the event id comes from the email (gcal.eventIdFor), so a retry
// or a re-sync finds the existing event instead; one the candidate deleted stays deleted.
//
// The time comes from the invite's calendar attachment (.ics). An invite with no time (a
// "pick a slot" link) makes no event: the application still moves to interview, and the email
// shows under Interviews in the app; the confirmation the scheduling tool sends later usually
// carries the .ics.
import { eq } from 'drizzle-orm';
import {
  applications,
  type EmailCalendar,
  type EmailRow,
  emails,
  postings,
} from '../../db/schema.ts';
import { CalendarError, eventIdFor } from '../../integrations/gcal.ts';
import type { Handler, Tx } from '../../queue/types.ts';

/** Queues the calendar event for an interview email linked to an application, once. */
export function queueInterviewEvent(tx: Tx, email: EmailRow): boolean {
  if (email.label !== 'interview' || email.applicationId === null) return false;
  if (email.calendar?.status === 'created' || email.calendar?.status === 'cancelled') return false;
  tx.enqueue('interview_event', email.id);
  return true;
}

function record(emailId: number, calendar: EmailCalendar, message: string) {
  return (tx: Tx) => {
    tx.db.update(emails).set({ calendar }).where(eq(emails.id, emailId)).run();
    tx.emit({ kind: 'mail', entityId: emailId, stage: 'calendar', message });
  };
}

export const interviewEvent: Handler<'interview_event'> = async (task, ctx) => {
  const email = ctx.read.select().from(emails).where(eq(emails.id, task.entityId)).get();
  const nothing = { kind: 'done' as const, commit: () => {} };
  if (email?.label !== 'interview' || email.applicationId === null) return nothing;
  if (email.calendar?.status === 'created' || email.calendar?.status === 'cancelled')
    return nothing;
  const app = ctx.read
    .select({
      id: applications.id,
      title: postings.title,
      company: postings.company,
      url: postings.canonicalUrl,
    })
    .from(applications)
    .innerJoin(postings, eq(postings.id, applications.postingId))
    .where(eq(applications.id, email.applicationId))
    .get();
  if (!app) return nothing;
  const skip = (note: string) => ({
    kind: 'done' as const,
    commit: record(
      email.id,
      { status: 'skipped', eventId: null, link: null, note },
      `no calendar event for "${email.subject}": ${note}`,
    ),
  });
  const calendar = await ctx.deps.mail?.calendar?.().catch(() => null);
  if (!calendar) return skip('no Google account connected (Calendar needs the Gmail connection)');
  const invite = email.invite;
  if (!invite) return skip('the email has no time (no calendar invite attached)');

  const role = [app.title, app.company].filter(Boolean).join(' at ');
  const eventId = eventIdFor(`email:${email.mailboxId}:${email.messageKey}`);
  try {
    ctx.progress({ message: `calendar: ${role || `application ${app.id}`}` });
    const res = await calendar.upsertEvent(
      {
        id: eventId,
        summary: `Interview: ${role || invite.summary || `application ${app.id}`}`,
        description: [
          invite.summary && invite.summary !== role ? invite.summary : null,
          `Application ${app.id} in Applyant${app.company ? ` · ${app.company}` : ''}`,
          app.url ? `Posting: ${app.url}` : null,
          `Invite: "${email.subject}" from ${email.fromAddress}`,
        ]
          .filter(Boolean)
          .join('\n'),
        location: invite.location,
        start: invite.start,
        end: invite.end,
        links: { applicationId: app.id, company: app.company, emailId: email.id },
      },
      ctx.signal,
    );
    const status = res.cancelled ? 'cancelled' : 'created';
    return {
      kind: 'done',
      commit: record(
        email.id,
        {
          status,
          eventId: res.id,
          link: res.link,
          note: res.created ? null : 'already on the calendar',
        },
        res.cancelled
          ? `the interview event for application ${app.id} was deleted from the calendar; not made again`
          : `interview on the calendar: ${role || `application ${app.id}`}`,
      ),
    };
  } catch (err) {
    ctx.signal.throwIfAborted();
    const reason = (err as Error).message.split('\n')[0] ?? 'calendar failed';
    if (task.attempts + 1 < 3 && !(err instanceof CalendarError && /HTTP 4\d\d/.test(reason))) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason,
      };
    }
    return skip(reason);
  }
};
