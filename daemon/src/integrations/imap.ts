// IMAP (iCloud, Outlook, custom domains) + SMTP for sending, behind the one Mailbox interface.
// The cursor is `<uidvalidity>:<last uid>` of INBOX: a changed UIDVALIDITY means the server
// renumbered the folder, so the next sync starts again from the date window.
import { ImapFlow } from 'imapflow';
import {
  type Cursor,
  type Mailbox,
  MailboxError,
  type MailMessage,
  type OutgoingMessage,
  parseMessage,
  type SentReceipt,
  type SyncOptions,
} from './mailbox.ts';
import { type SmtpOptions, smtpSend } from './smtp.ts';

export interface ImapOptions {
  address: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  user: string;
  password: string;
  /** Tests only: accept a self-signed certificate. */
  allowSelfSigned?: boolean;
}

export function parseImapCursor(cursor: Cursor): { validity: string; uid: number } | null {
  const m = cursor?.match(/^(\d+):(\d+)$/);
  return m?.[1] && m[2] ? { validity: m[1], uid: Number(m[2]) } : null;
}

export class ImapMailbox implements Mailbox {
  readonly address: string;
  private readonly o: ImapOptions;

  constructor(o: ImapOptions) {
    this.o = o;
    this.address = o.address;
  }

  async sync(cursor: Cursor, s: SyncOptions): Promise<{ messages: MailMessage[]; next: Cursor }> {
    const client = new ImapFlow({
      host: this.o.imap.host,
      port: this.o.imap.port,
      secure: this.o.imap.secure,
      auth: { user: this.o.user, pass: this.o.password },
      logger: false,
      disableAutoIdle: true,
      ...(this.o.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    });
    try {
      await client.connect();
    } catch (err) {
      throw new MailboxError(`IMAP ${this.o.imap.host}: ${(err as Error).message}`);
    }
    try {
      const box = await client.mailboxOpen('INBOX', { readOnly: true });
      const validity = String(box.uidValidity);
      const at = parseImapCursor(cursor);
      let uids: number[];
      if (at && at.validity === validity) {
        const found = await client.search({ uid: `${at.uid + 1}:*` }, { uid: true });
        // `n:*` always matches the last message, even when it's older than n.
        uids = (found || []).filter((u) => u > at.uid);
      } else {
        uids = (await client.search({ since: s.since }, { uid: true })) || [];
      }
      uids.sort((a, b) => a - b);
      if (s.limit && uids.length > s.limit) uids = uids.slice(-s.limit);
      const messages: MailMessage[] = [];
      let last = at && at.validity === validity ? at.uid : 0;
      if (uids.length) {
        for await (const m of client.fetch(
          uids.join(','),
          { uid: true, source: true },
          { uid: true },
        )) {
          s.signal?.throwIfAborted();
          if (m.source) messages.push(await parseMessage(`${validity}:${m.uid}`, m.source));
          last = Math.max(last, m.uid);
        }
      } else if (!at || at.validity !== validity) {
        // Nothing in the window: start from the folder's current end.
        last = Math.max(0, Number(box.uidNext) - 1);
      }
      messages.sort((a, b) => a.date.getTime() - b.date.getTime());
      return { messages, next: `${validity}:${last}` };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  send(msg: OutgoingMessage): Promise<SentReceipt> {
    const smtp: SmtpOptions = {
      ...this.o.smtp,
      user: this.o.user,
      password: this.o.password,
      ...(this.o.allowSelfSigned ? { allowSelfSigned: true } : {}),
    };
    return smtpSend(smtp, this.address, msg);
  }
}
