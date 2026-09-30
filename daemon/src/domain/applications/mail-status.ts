// Status from the candidate's mailbox. Each sync reads the new mail, keeps only what looks like
// it's about an application (a reply to an application email, a sender on an applied-to
// company's domain or an ATS, a message naming the company), and for each:
//
//   classify   email_classify (on-device by default; a cloud model only if the candidate routed
//              it there — the routing table decides, there's no special case here)
//   match      reply thread > sender domain > company name, over the applications sent so far
//   status     sure label + one application → matched; rejection / interview / offer move it on
//              unsure label, or no single application → the "Which application is this?" queue
//
// Other mail is never stored. The handler reads and classifies with no transaction open; the
// commit stores the emails, moves applications and advances the cursor together.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Conn, Db } from '../../db/client.ts';
import {
  type ApplicationRow,
  type ApplicationStage,
  applications,
  companies,
  type EmailLabel,
  type EmailRow,
  type EmailStatus,
  emails,
  mailboxes,
  postings,
  receipts,
  tasks,
} from '../../db/schema.ts';
import { parseInvite } from '../../integrations/gcal.ts';
import type { MailMessage } from '../../integrations/mailbox.ts';
import type { AgentRunner } from '../../models/agent-runner.ts';
import { describeRoute } from '../../models/roles.ts';
import { emailClassSchema } from '../../models/schemas/email.ts';
import type { EventBus } from '../../queue/events.ts';
import { runInTx } from '../../queue/tx.ts';
import type { Handler, Tx } from '../../queue/types.ts';
import { companyKey } from '../companies/store.ts';
import { queueInterviewEvent } from './interview-event.ts';
import { ApplicationError, emitStage } from './store.ts';

/** Applications whose mail is followed: sent (or about to be), and not closed. */
export const TRACKED_STAGES: ApplicationStage[] = ['approved', 'applied', 'interview', 'offer'];

/** Senders that are an applicant tracking system, not the company itself. */
const ATS_SENDER =
  /(^|\.)(greenhouse\.io|greenhouse-mail\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|workable\.com|workablemail\.com|smartrecruiters\.com|myworkday\.com|myworkdayjobs\.com|recruitee\.com|personio\.de|personio\.com|teamtailor\.com|teamtailor-mail\.com|breezy\.hr|jobvite\.com|bamboohr\.com|join\.com|pinpointhq\.com|rippling\.com|homerun\.co)$/i;

/** Hosts that say nothing about the company (boards, ATS pages, mail providers). */
const SHARED_HOST =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|recruitee\.com|personio\.de|personio\.com|teamtailor\.com|breezy\.hr|jobvite\.com|bamboohr\.com|join\.com|linkedin\.com|xing\.com|indeed\.com|glassdoor\.com|wellfound\.com|gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|icloud\.com|yahoo\.com|proton\.me|protonmail\.com)$/i;

/** example.co.uk → example.co.uk; jobs.example.com → example.com */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts.at(-2) ?? '';
  const two = (parts.at(-1)?.length ?? 0) === 2 && /^(co|com|org|net|ac|gov|ltd|plc)$/.test(sld);
  return parts.slice(two ? -3 : -2).join('.');
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('mailto:')) return url.slice(7).split('?')[0]?.split('@')[1] ?? null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export interface TrackedApplication {
  id: number;
  postingId: number;
  stage: ApplicationStage;
  company: string | null;
  companyKey: string;
  title: string | null;
  /** The company's own base domains (never an ATS or a job board). */
  domains: string[];
  /** Email applications: the sent message's Message-ID. */
  sentMessageId: string | null;
}

export function trackedApplications(conn: Conn): TrackedApplication[] {
  const rows = conn
    .select({ app: applications, posting: postings, messageId: receipts.messageId })
    .from(applications)
    .innerJoin(postings, eq(postings.id, applications.postingId))
    .leftJoin(receipts, eq(receipts.applicationId, applications.id))
    .where(inArray(applications.stage, TRACKED_STAGES))
    .all();
  const websites = new Map(
    conn
      .select({ key: companies.key, profile: companies.profile })
      .from(companies)
      .all()
      .map((c) => [c.key, c.profile?.website ?? null]),
  );
  return rows.map(({ app, posting, messageId }) => {
    const key = companyKey(posting.company);
    const hosts = [posting.canonicalUrl, posting.applyUrl, websites.get(key)]
      .map(hostOf)
      .filter((h): h is string => !!h && !SHARED_HOST.test(h));
    return {
      id: app.id,
      postingId: app.postingId,
      stage: app.stage,
      company: posting.company,
      companyKey: key,
      title: posting.title,
      domains: [...new Set(hosts.map(baseDomain))],
      sentMessageId: messageId ?? null,
    };
  });
}

export interface EmailMatch {
  /** Applications it may belong to, best first. */
  ids: number[];
  /** Exactly one application stands out. */
  sure: boolean;
  why: string | null;
}

function mentions(haystack: string, needle: string): boolean {
  if (needle.length < 3) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/** Which application an email is about: a reply thread, then sender domain, then the name. */
export function matchEmail(msg: MailMessage, apps: TrackedApplication[]): EmailMatch {
  const thread = new Set([msg.inReplyTo, ...msg.references].filter(Boolean));
  const replied = apps.filter((a) => a.sentMessageId && thread.has(a.sentMessageId));
  if (replied.length === 1 && replied[0]) {
    return { ids: [replied[0].id], sure: true, why: 'a reply to your application email' };
  }
  const senderDomain = baseDomain(msg.fromAddress.split('@')[1] ?? '');
  const text = `${msg.fromName ?? ''}\n${msg.subject}\n${msg.text.slice(0, 4000)}`;
  const normText = companyKey(text);
  const scored = apps
    .map((a) => {
      let score = 0;
      const why: string[] = [];
      if (senderDomain && a.domains.includes(senderDomain)) {
        score += 2;
        why.push(`sent from ${senderDomain}`);
      }
      if (a.companyKey && mentions(normText, a.companyKey)) {
        score += 1;
        why.push(`names ${a.company}`);
      }
      if (score > 0 && a.title && mentions(text, a.title)) {
        score += 1;
        why.push(`names the role "${a.title}"`);
      }
      return { a, score, why };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  const top = scored[0];
  if (!top) return { ids: [], sure: false, why: null };
  const tied = scored.filter((x) => x.score === top.score);
  return {
    ids: scored.map((x) => x.a.id),
    sure: tied.length === 1,
    why: top.why.join(', '),
  };
}

/** Only mail that could be about an application is classified and kept. */
export function looksRelevant(msg: MailMessage, match: EmailMatch): boolean {
  if (match.ids.length > 0) return true;
  const host = msg.fromAddress.split('@')[1] ?? '';
  return ATS_SENDER.test(host);
}

export interface Classification {
  label: EmailLabel;
  confidence: number;
  language: string | null;
  /** The route that answered, or null when none could. */
  by: string | null;
  problem: string | null;
}

export const CLASSIFY_SYSTEM = `You read one email the job applicant received and say what it is, for tracking their applications.
Labels: rejection · interview (an invitation to talk, a call, an interview, a test task or next steps) · offer · acknowledgement (the application was received) · security_code (a one-time code to finish submitting an application) · other (not about a job application) · unknown (you can't tell).
Give your confidence from 0 to 1, and the email's language. Answer only from the email.`;

export function classifyPrompt(msg: MailMessage): string {
  return `From: ${msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
Subject: ${msg.subject}

${msg.text.slice(0, 6000)}`;
}

/** email_classify through the routing table; any failure is `unknown` (→ asked about). */
export async function classifyMail(
  models: AgentRunner,
  msg: MailMessage,
  o: { taskId: number | null; signal: AbortSignal; progress?: (m: string) => void },
): Promise<Classification> {
  const res = await models.run('email_classify', {
    schema: emailClassSchema,
    system: CLASSIFY_SYSTEM,
    prompt: classifyPrompt(msg),
    input: { subject: msg.subject, body: msg.text, from: msg.fromAddress },
    taskId: o.taskId,
    signal: o.signal,
    ...(o.progress ? { progress: o.progress } : {}),
  });
  if (res.kind === 'ok') {
    return {
      label: res.output.label,
      confidence: Math.max(0, Math.min(1, res.output.confidence)),
      language: res.output.language,
      by: describeRoute(res.route),
      problem: null,
    };
  }
  const problem = res.kind === 'limit' ? `${res.provider} limit: ${res.message}` : res.reason;
  return { label: 'unknown', confidence: 0, language: null, by: null, problem };
}

/** What a sure label does to an application. */
const LABEL_STAGE: Partial<Record<EmailLabel, ApplicationStage>> = {
  rejection: 'rejected',
  interview: 'interview',
  offer: 'offer',
};

const RANK: Partial<Record<ApplicationStage, number>> = {
  approved: 0,
  applied: 1,
  interview: 2,
  offer: 3,
};

/** Forward only: applied → interview → offer, and rejected from any open stage. */
export function nextStage(current: ApplicationStage, label: EmailLabel): ApplicationStage | null {
  const to = LABEL_STAGE[label];
  if (!to || to === current) return null;
  const from = RANK[current];
  if (from === undefined) return null;
  if (to === 'rejected') return current === 'approved' ? null : 'rejected';
  const rank = RANK[to] ?? -1;
  return rank > from && current !== 'approved' ? to : null;
}

export interface MailDecision {
  status: EmailStatus;
  applicationId: number | null;
  note: string;
}

/**
 * sure label (≥ the role's minConfidence) and one application → matched; otherwise the ask
 * queue. `other` mail that no single application claims is dropped (null).
 */
export function decide(
  cls: Classification,
  match: EmailMatch,
  minConfidence: number,
): MailDecision | null {
  const sureLabel = cls.label !== 'unknown' && cls.confidence >= minConfidence;
  const one = match.sure ? (match.ids[0] ?? null) : null;
  if (!sureLabel) {
    const why = cls.problem
      ? `couldn't be classified on this Mac (${cls.problem})`
      : `unsure what this is (${cls.label}, ${Math.round(cls.confidence * 100)}%)`;
    return { status: 'ask', applicationId: null, note: why };
  }
  if (cls.label === 'other') {
    return one ? { status: 'matched', applicationId: one, note: match.why ?? '' } : null;
  }
  if (one) return { status: 'matched', applicationId: one, note: match.why ?? '' };
  return {
    status: 'ask',
    applicationId: null,
    note:
      match.ids.length > 1
        ? `a ${cls.label.replace('_', ' ')} that could be one of ${match.ids.length} applications`
        : `a ${cls.label.replace('_', ' ')} that matches no application`,
  };
}

// ---- the sync_mail task --------------------------------------------------------------------

export interface MailItem {
  msg: MailMessage;
  cls: Classification;
  match: EmailMatch;
  decision: MailDecision;
}

export const syncMail: Handler<'sync_mail'> = async (task, ctx) => {
  const row = ctx.read.select().from(mailboxes).where(eq(mailboxes.id, task.entityId)).get();
  const mail = ctx.deps.mail;
  if (row?.status !== 'connected' || !mail) return { kind: 'done', commit: () => {} };
  let box: Awaited<ReturnType<typeof mail.open>>;
  let synced: Awaited<ReturnType<NonNullable<typeof box>['sync']>>;
  const since = new Date(ctx.now().getTime() - mail.sinceDays * 86_400_000);
  try {
    box = await mail.open();
    if (!box) return { kind: 'done', commit: () => {} };
    ctx.progress({ message: `reading ${box.address}` });
    synced = await box.sync(row.cursor, { since, signal: ctx.signal, limit: 500 });
  } catch (err) {
    ctx.signal.throwIfAborted();
    const reason = (err as Error).message.split('\n')[0] ?? 'mailbox sync failed';
    if (task.attempts + 1 < 3) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason,
      };
    }
    return {
      kind: 'done',
      commit: (tx) => {
        tx.db
          .update(mailboxes)
          .set({ note: `sync failed: ${reason}`.slice(0, 500), updatedAt: tx.now })
          .where(eq(mailboxes.id, row.id))
          .run();
      },
    };
  }

  const known = new Set(
    ctx.read
      .select({ key: emails.messageKey })
      .from(emails)
      .where(eq(emails.mailboxId, row.id))
      .all()
      .map((r) => r.key),
  );
  const apps = trackedApplications(ctx.read);
  const minConfidence = ctx.deps.models.routing().roles.email_classify.minConfidence ?? 0;
  const items: MailItem[] = [];
  for (const msg of synced.messages) {
    ctx.signal.throwIfAborted();
    if (known.has(msg.key)) continue;
    // Mail the candidate sent (an email application) is never "a reply".
    if (msg.fromAddress === box.address.toLowerCase()) continue;
    const match = matchEmail(msg, apps);
    if (!looksRelevant(msg, match)) continue;
    const cls = await classifyMail(ctx.deps.models, msg, {
      taskId: task.id,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
    });
    const decision = decide(cls, match, minConfidence);
    if (decision) items.push({ msg, cls, match, decision });
  }
  const next = synced.next;
  return {
    kind: 'done',
    commit: (tx) => {
      const counts = storeMail(tx, row.id, items);
      tx.db
        .update(mailboxes)
        .set({ cursor: next, syncedAt: tx.now, note: null, updatedAt: tx.now })
        .where(eq(mailboxes.id, row.id))
        .run();
      if (counts.stored) {
        tx.emit({
          kind: 'mail',
          entityId: row.id,
          stage: 'synced',
          message: `mail: ${counts.stored} repl${counts.stored === 1 ? 'y' : 'ies'} · ${counts.moved} status change${counts.moved === 1 ? '' : 's'} · ${counts.asked} to ask about`,
        });
      }
    },
  };
};

/** Stores the emails and moves applications; returns what happened. */
export function storeMail(
  tx: Tx,
  mailboxId: number,
  items: MailItem[],
): { stored: number; moved: number; asked: number } {
  let stored = 0;
  let moved = 0;
  let asked = 0;
  for (const { msg, cls, match, decision } of items) {
    const inserted = tx.db
      .insert(emails)
      .values({
        mailboxId,
        messageKey: msg.key,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo,
        fromAddress: msg.fromAddress,
        fromName: msg.fromName,
        subject: msg.subject.slice(0, 500),
        text: msg.text.slice(0, 20_000),
        receivedAt: msg.date,
        label: cls.label,
        confidence: cls.by ? cls.confidence : null,
        classifiedBy: cls.by,
        language: cls.language,
        applicationId: decision.applicationId,
        status: decision.status,
        candidates: match.ids.slice(0, 5),
        note: decision.note || null,
        invite: parseInvite(msg.calendar),
        createdAt: tx.now,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!inserted) continue;
    stored++;
    if (decision.status === 'ask') {
      asked++;
      tx.emit({
        kind: 'mail',
        entityId: inserted.id,
        stage: 'ask',
        message: `Which application is this? "${msg.subject}" from ${msg.fromAddress}`,
      });
    }
    if (
      decision.applicationId &&
      moveApplication(tx, decision.applicationId, cls.label, msg, { byMail: true })
    )
      moved++;
    // An interview invite linked to its application → a calendar event (interview-event.ts).
    queueInterviewEvent(tx, inserted);
  }
  return { stored, moved, asked };
}

/**
 * `byMail`: the sync read it (the event carries task_kind `sync_mail`, so the app notifies);
 * unset when the candidate linked the email themselves.
 */
function moveApplication(
  tx: Tx,
  applicationId: number,
  label: EmailLabel,
  msg: MailMessage,
  o: { byMail?: boolean } = {},
) {
  const app = tx.db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!app) return false;
  const to = nextStage(app.stage, label);
  if (!to) return false;
  const row = tx.db
    .update(applications)
    .set({
      stage: to,
      ...(to === 'interview' || to === 'offer' ? { interviewAt: app.interviewAt ?? tx.now } : {}),
      ...(to === 'offer' ? { offerAt: app.offerAt ?? tx.now } : {}),
      updatedAt: tx.now,
    })
    .where(eq(applications.id, app.id))
    .returning()
    .get();
  emitStage(
    tx,
    row,
    to,
    `application ${app.id}: ${to} ("${msg.subject}" from ${msg.fromAddress})`,
    o.byMail ? 'sync_mail' : null,
  );
  return true;
}

// ---- the ask queue and corrections ---------------------------------------------------------

export class MailError extends Error {}

export interface AskItem {
  email: EmailRow;
  candidates: Array<
    Pick<ApplicationRow, 'id' | 'stage'> & { title: string | null; company: string | null }
  >;
}

export function askQueue(conn: Conn): AskItem[] {
  const rows = conn
    .select()
    .from(emails)
    .where(eq(emails.status, 'ask'))
    .orderBy(desc(emails.receivedAt))
    .all();
  return rows.map((email) => ({ email, candidates: candidateApps(conn, email.candidates) }));
}

function candidateApps(conn: Conn, ids: number[]): AskItem['candidates'] {
  if (ids.length === 0) return [];
  const rows = conn
    .select({
      id: applications.id,
      stage: applications.stage,
      title: postings.title,
      company: postings.company,
    })
    .from(applications)
    .innerJoin(postings, eq(postings.id, applications.postingId))
    .where(inArray(applications.id, ids))
    .all();
  return ids.flatMap((id) => rows.filter((r) => r.id === id));
}

export function emailsFor(conn: Conn, applicationId: number): EmailRow[] {
  return conn
    .select()
    .from(emails)
    .where(eq(emails.applicationId, applicationId))
    .orderBy(desc(emails.receivedAt))
    .all();
}

/**
 * The candidate's answer to "Which application is this?": an application (and, if they say
 * so, what the email is), or none. A rejection / interview / offer moves the application on.
 */
export function assignEmail(
  tx: Tx,
  emailId: number,
  applicationId: number | null,
  label: EmailLabel | null,
): EmailRow {
  const email = tx.db.select().from(emails).where(eq(emails.id, emailId)).get();
  if (!email) throw new MailError(`no email ${emailId}`);
  if (applicationId !== null) {
    const app = tx.db.select().from(applications).where(eq(applications.id, applicationId)).get();
    if (!app) throw new ApplicationError(`no application ${applicationId}`);
  }
  const finalLabel = label ?? email.label;
  const row = tx.db
    .update(emails)
    .set({
      status: 'assigned',
      applicationId,
      label: finalLabel,
      note: applicationId === null ? 'not about any application (you said)' : 'linked by you',
    })
    .where(eq(emails.id, emailId))
    .returning()
    .get();
  if (applicationId !== null) {
    moveApplication(tx, applicationId, finalLabel, {
      subject: email.subject,
      fromAddress: email.fromAddress,
    } as MailMessage);
  }
  tx.emit({
    kind: 'mail',
    entityId: emailId,
    stage: 'assigned',
    message:
      applicationId === null
        ? `"${email.subject}": not about an application`
        : `"${email.subject}" → application ${applicationId}`,
  });
  queueInterviewEvent(tx, row);
  return row;
}

/** Queues a sync unless one is waiting or running. Returns whether one was queued. */
export function requestMailSync(db: Db, bus: EventBus, now: Date): boolean {
  return runInTx(db, bus, { now }, (tx) => {
    const box = tx.db.select().from(mailboxes).where(eq(mailboxes.status, 'connected')).get();
    if (!box) return false;
    const busy = tx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, 'sync_mail'),
          eq(tasks.entityId, box.id),
          inArray(tasks.status, ['queued', 'running']),
        ),
      )
      .get();
    if (busy) return false;
    tx.enqueue('sync_mail', box.id);
    return true;
  });
}
