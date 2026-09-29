// One Mailbox adapter serves three uses: replies that track status (mail-status.ts), emailed
// security codes during delivery (security-code.ts), and email applications (channels/email.ts).
// Google accounts go through the Gmail API (gmail.ts); every other provider through IMAP + SMTP
// (imap.ts · smtp.ts). Credentials never live here: passwords and OAuth tokens are in `Secrets`.

import { type AddressObject, simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';

export interface MailMessage {
  /** The provider's id: a Gmail message id, or `<uidvalidity>:<uid>` on IMAP. */
  key: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string | null;
  to: string[];
  subject: string;
  /** Plain text (HTML turned to text when that's all there is). */
  text: string;
  date: Date;
  /** The calendar invite it carries (a text/calendar part: an .ics), if any. */
  calendar?: string | null;
}

/** Where the last sync stopped (Gmail historyId, IMAP `<uidvalidity>:<uid>`); null = never. */
export type Cursor = string | null;

export interface SyncOptions {
  /** With no cursor: how far back to read. */
  since: Date;
  signal?: AbortSignal;
  /** At most this many messages per sync (newest kept). */
  limit?: number;
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; path: string }>;
}

export interface SentReceipt {
  messageId: string;
  /** The exact MIME message sent (kept with the receipt). */
  raw: Buffer;
  accepted: string[];
}

export interface Mailbox {
  readonly address: string;
  /** New messages since `cursor` (or since `o.since` when there's none), oldest first. */
  sync(cursor: Cursor, o: SyncOptions): Promise<{ messages: MailMessage[]; next: Cursor }>;
  send(msg: OutgoingMessage): Promise<SentReceipt>;
}

export class MailboxError extends Error {}

/** The one MIME message both transports send: nodemailer's composer, so SMTP and Gmail match. */
export async function composeMessage(
  from: string,
  msg: OutgoingMessage,
): Promise<{ raw: Buffer; messageId: string }> {
  const mail = new MailComposer({
    from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({ filename: a.filename, path: a.path })),
  }).compile();
  const raw = await mail.build();
  return { raw, messageId: mail.messageId() };
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((o) => o.value.map((v) => v.address ?? '').filter(Boolean));
}

/** A raw RFC 822 message → MailMessage. */
export async function parseMessage(key: string, raw: Buffer | string): Promise<MailMessage> {
  const m = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const from = m.from?.value[0];
  const refs = m.references;
  return {
    key,
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: Array.isArray(refs) ? refs : refs ? [refs] : [],
    fromAddress: (from?.address ?? '').toLowerCase(),
    fromName: from?.name || null,
    to: addresses(m.to),
    subject: m.subject ?? '',
    text: (m.text ?? (typeof m.html === 'string' ? htmlToText(m.html) : '')).trim(),
    date: m.date ?? new Date(),
    calendar: calendarPart(m.attachments),
  };
}

/** The first text/calendar (or .ics) part, as text. */
function calendarPart(parts: Array<{ contentType: string; filename?: string; content: Buffer }>) {
  const ics = parts.find(
    (a) =>
      /^(text\/calendar|application\/ics)/i.test(a.contentType) || /\.ics$/i.test(a.filename ?? ''),
  );
  return ics ? ics.content.toString('utf8').slice(0, 50_000) : null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
}
