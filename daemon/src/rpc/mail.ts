// Mailbox RPCs: connect (Gmail consent or IMAP/SMTP), status, sync now, and the
// "Which application is this?" queue. validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { count, eq } from 'drizzle-orm';
import type { Conn } from '../db/client.ts';
import {
  EMAIL_LABELS,
  type EmailLabel,
  type EmailRow,
  emails,
  type MailboxRow,
} from '../db/schema.ts';
import {
  askQueue,
  assignEmail,
  MailError,
  requestMailSync,
} from '../domain/applications/mail-status.ts';
import { ApplicationError } from '../domain/applications/store.ts';
import {
  type ApplyantService,
  type Email,
  EmailSchema,
  type Mailbox,
  MailboxSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import { currentMailbox, type MailService } from '../integrations/mail-service.ts';
import { MailboxError } from '../integrations/mailbox.ts';
import { runInTx } from '../queue/tx.ts';
import type { Logger } from '../util/log.ts';
import { appStageToPb } from './mapping.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

export interface MailRpcContext extends RpcContext {
  mail: MailService | null;
  log: Logger;
}

export function mailboxToPb(conn: Conn, row: MailboxRow): Mailbox {
  const asking =
    conn.select({ n: count() }).from(emails).where(eq(emails.status, 'ask')).get()?.n ?? 0;
  return create(MailboxSchema, {
    kind: row.kind,
    address: row.address,
    status: row.status,
    syncedAt: row.syncedAt ? timestampFromDate(row.syncedAt) : undefined,
    note: row.note ?? undefined,
    asking,
  });
}

export function emailToPb(
  row: EmailRow,
  candidates: Array<{
    id: number;
    stage: string;
    title: string | null;
    company: string | null;
  }> = [],
): Email {
  return create(EmailSchema, {
    id: BigInt(row.id),
    fromAddress: row.fromAddress,
    fromName: row.fromName ?? undefined,
    subject: row.subject,
    snippet: row.text.replace(/\s+/g, ' ').trim().slice(0, 280),
    receivedAt: timestampFromDate(row.receivedAt),
    label: row.label,
    confidence: row.confidence ?? undefined,
    classifiedBy: row.classifiedBy ?? undefined,
    applicationId: row.applicationId ? BigInt(row.applicationId) : undefined,
    status: row.status,
    note: row.note ?? undefined,
    candidates: candidates.map((c) => ({
      applicationId: BigInt(c.id),
      title: c.title ?? undefined,
      company: c.company ?? undefined,
      stage: appStageToPb(c.stage),
    })),
    inviteStart: row.invite?.start.dateTime ?? row.invite?.start.date ?? undefined,
    inviteTimeZone: row.invite?.start.timeZone ?? undefined,
    calendarStatus: row.calendar?.status ?? undefined,
    calendarLink: row.calendar?.link ?? undefined,
    calendarNote: row.calendar?.note ?? undefined,
  });
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailError || err instanceof ApplicationError) {
      throw new ConnectError(err.message, Code.InvalidArgument);
    }
    if (err instanceof MailboxError) throw new ConnectError(err.message, Code.FailedPrecondition);
    throw err;
  }
}

const port = (p: number, fallback: number) => (p > 0 && p < 65536 ? p : fallback);

export function mailRpcs(
  c: MailRpcContext,
): Pick<Impl, 'connectMailbox' | 'getMailbox' | 'syncMailbox' | 'listMailQueue' | 'assignEmail'> {
  const service = () => {
    if (!c.mail) throw new ConnectError('the mailbox is not available', Code.Unavailable);
    return c.mail;
  };
  return {
    async connectMailbox(req) {
      const mail = service();
      return guard(async () => {
        if (req.kind.case === 'gmail') {
          const { row, consent } = await mail.connectGmail(c.db, {
            clientId: req.kind.value.clientId ?? null,
            clientSecret: req.kind.value.clientSecret ?? null,
            now: c.now,
            log: c.log,
          });
          return { mailbox: mailboxToPb(c.db, row), authUrl: consent.url };
        }
        if (req.kind.case === 'imap') {
          const v = req.kind.value;
          const address = req.address.trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+$/.test(address)) {
            throw new ConnectError('give the mailbox address', Code.InvalidArgument);
          }
          if (!v.imapHost || !v.smtpHost || !v.password) {
            throw new ConnectError(
              'give the IMAP host, SMTP host and password',
              Code.InvalidArgument,
            );
          }
          const row = await mail.connectImap(c.db, {
            address,
            settings: {
              imap: { host: v.imapHost, port: port(v.imapPort, 993), secure: v.secure },
              smtp: { host: v.smtpHost, port: port(v.smtpPort, 465), secure: v.secure },
              ...(v.username ? { user: v.username } : {}),
            },
            password: v.password,
            now: c.now(),
          });
          requestMailSync(c.db, c.bus, c.now());
          return { mailbox: mailboxToPb(c.db, row) };
        }
        throw new ConnectError('give gmail or imap settings', Code.InvalidArgument);
      });
    },

    getMailbox() {
      const row = currentMailbox(c.db);
      return { mailbox: row ? mailboxToPb(c.db, row) : undefined };
    },

    syncMailbox() {
      if (!currentMailbox(c.db)) {
        throw new ConnectError('no mailbox is connected', Code.FailedPrecondition);
      }
      return { queued: requestMailSync(c.db, c.bus, c.now()) };
    },

    listMailQueue() {
      return {
        emails: askQueue(c.db).map((item) => emailToPb(item.email, item.candidates)),
      };
    },

    async assignEmail(req) {
      const label = req.label?.trim() || null;
      if (label && !(EMAIL_LABELS as readonly string[]).includes(label)) {
        throw new ConnectError(
          `label must be one of ${EMAIL_LABELS.join(', ')}`,
          Code.InvalidArgument,
        );
      }
      return guard(() => {
        const row = runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
          assignEmail(
            tx,
            Number(req.emailId),
            req.applicationId !== undefined ? Number(req.applicationId) : null,
            label as EmailLabel | null,
          ),
        );
        return { email: emailToPb(row) };
      });
    },
  };
}
