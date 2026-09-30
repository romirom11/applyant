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
    // What it was connected with; passwords and secrets never leave Secrets.
    clientId: row.settings.clientId ?? undefined,
    imapHost: row.settings.imap?.host,
    imapPort: row.settings.imap?.port ?? 0,
    smtpHost: row.settings.smtp?.host,
    smtpPort: row.settings.smtp?.port ?? 0,
    secure: row.settings.imap?.secure ?? false,
    username: row.settings.user ?? undefined,
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

/**
 * One server's connection: a well-known port says whether TLS starts at once (993, 465) or
 * after STARTTLS (143, 587, 25), so IMAP on 993 with SMTP on 587 (iCloud, Outlook) works;
 * `secure` decides for other ports and picks the default ports.
 */
export function mailServer(
  host: string,
  p: number,
  secure: boolean,
  kind: 'imap' | 'smtp',
): { host: string; port: number; secure: boolean } {
  const n = port(p, kind === 'imap' ? (secure ? 993 : 143) : secure ? 465 : 587);
  const tls = n === 993 || n === 465 ? true : n === 143 || n === 587 || n === 25 ? false : secure;
  return { host: host.trim(), port: n, secure: tls };
}

export function mailRpcs(
  c: MailRpcContext,
): Pick<
  Impl,
  | 'connectMailbox'
  | 'getMailbox'
  | 'disconnectMailbox'
  | 'syncMailbox'
  | 'listMailQueue'
  | 'assignEmail'
> {
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
            // The app waits on this: a mail event says the consent landed (or didn't), and the
            // first sync starts at once, as it does for IMAP.
            onSettled: (row) => {
              runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
                tx.emit({
                  kind: 'mail',
                  entityId: row.id,
                  stage: row.status,
                  message:
                    row.status === 'connected'
                      ? `mailbox connected: ${row.address}`
                      : `mailbox failed: ${row.note ?? ''}`,
                }),
              );
              if (row.status === 'connected') requestMailSync(c.db, c.bus, c.now());
            },
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
              imap: mailServer(v.imapHost, v.imapPort, v.secure, 'imap'),
              smtp: mailServer(v.smtpHost, v.smtpPort, v.secure, 'smtp'),
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

    async getMailbox() {
      const row = currentMailbox(c.db);
      const clientId = row?.settings.clientId ?? c.mail?.google.clientId ?? undefined;
      return {
        mailbox: row ? mailboxToPb(c.db, row) : undefined,
        googleClientSecretStored: (await c.mail?.hasGoogleClientSecret()) ?? false,
        googleClientId: clientId ?? undefined,
      };
    },

    async disconnectMailbox() {
      const disconnected = await service().disconnect(c.db);
      if (disconnected) {
        c.log.info('mailbox disconnected');
        runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
          tx.emit({ kind: 'mail', stage: 'disconnected', message: 'mailbox disconnected' }),
        );
      }
      return { disconnected };
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
