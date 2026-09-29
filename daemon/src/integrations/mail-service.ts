// The connected mailbox: which one it is (the `mailboxes` row), how to open it (Gmail or IMAP,
// credentials from `Secrets`), and connecting one. Handlers reach it through `Deps.mail`.
import { eq } from 'drizzle-orm';
import type { Conn, Db } from '../db/client.ts';
import { type MailboxRow, type MailboxSettings, mailboxes } from '../db/schema.ts';
import { DRIVE_API, type DriveApi, GoogleDrive } from '../domain/knowledge/sources/drive.ts';
import type { Secrets } from '../secrets/secrets.ts';
import type { Logger } from '../util/log.ts';
import { type Calendar, GCAL_API, GoogleCalendar } from './gcal.ts';
import { GmailMailbox } from './gmail.ts';
import {
  type Consent,
  GOOGLE_CLIENT_SECRET_SECRET,
  GOOGLE_ENDPOINTS,
  GoogleAuth,
  type GoogleClient,
  type GoogleEndpoints,
  startGoogleConsent,
} from './google-oauth.ts';
import { ImapMailbox } from './imap.ts';
import { type Mailbox, MailboxError } from './mailbox.ts';

/** The IMAP/SMTP password (an app password on iCloud and Gmail) lives here in `Secrets`. */
export const MAIL_PASSWORD_SECRET = 'mail.password';

export interface GoogleConfig extends GoogleEndpoints {
  /** The owner's "Desktop app" OAuth client (config / APPLYANT_GOOGLE_CLIENT_ID). */
  clientId: string | null;
  clientSecret: string | null;
  gmailApi: string;
  calendarApi: string;
  driveApi: string;
}

export const DEFAULT_GOOGLE: GoogleConfig = {
  ...GOOGLE_ENDPOINTS,
  clientId: null,
  clientSecret: null,
  gmailApi: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendarApi: GCAL_API,
  driveApi: DRIVE_API,
};

/** What handlers use (the security-code step, the email channel, sync_mail). */
export interface MailAccess {
  /** The connected mailbox, or null when none is (or it isn't ready). */
  open(): Promise<Mailbox | null>;
  /** How far back the first sync reads. */
  readonly sinceDays: number;
  /** How long delivery waits for an emailed security code. */
  readonly codeTimeoutMs: number;
  readonly codePollMs: number;
  /**
   * The candidate's Google Calendar (interview events), when the connected mailbox is a Google
   * account; null otherwise. Optional so test doubles without a calendar needn't say so.
   */
  calendar?(): Promise<Calendar | null>;
}

export function connectedMailbox(conn: Conn): MailboxRow | null {
  return conn.select().from(mailboxes).where(eq(mailboxes.status, 'connected')).get() ?? null;
}

export function currentMailbox(conn: Conn): MailboxRow | null {
  return conn.select().from(mailboxes).orderBy(mailboxes.id).get() ?? null;
}

export interface MailServiceOptions {
  read: Conn;
  secrets: Secrets;
  google?: Partial<GoogleConfig>;
  fetch?: typeof fetch;
  sinceDays?: number;
  codeTimeoutMs?: number;
  codePollMs?: number;
  /** Tests: accept the local test servers' self-signed certificates. */
  allowSelfSigned?: boolean;
}

export class MailService implements MailAccess {
  readonly sinceDays: number;
  readonly codeTimeoutMs: number;
  readonly codePollMs: number;
  private readonly o: MailServiceOptions;
  readonly google: GoogleConfig;

  constructor(o: MailServiceOptions) {
    this.o = o;
    this.google = { ...DEFAULT_GOOGLE, ...o.google };
    this.sinceDays = o.sinceDays ?? 7;
    this.codeTimeoutMs = o.codeTimeoutMs ?? 3 * 60_000;
    this.codePollMs = o.codePollMs ?? 10_000;
  }

  /** The Google client: the mailbox row's client id wins over config's; the secret from Secrets. */
  async googleClient(clientId?: string | null): Promise<GoogleClient> {
    const id = clientId ?? this.google.clientId;
    if (!id) {
      throw new MailboxError(
        'no Google OAuth client id: create a "Desktop app" client in Google Cloud, then `applyant mail connect gmail --client-id <id>` (or set APPLYANT_GOOGLE_CLIENT_ID)',
      );
    }
    const secret =
      (await this.o.secrets.get(GOOGLE_CLIENT_SECRET_SECRET)) ?? this.google.clientSecret;
    return {
      clientId: id,
      clientSecret: secret,
      authUrl: this.google.authUrl,
      tokenUrl: this.google.tokenUrl,
    };
  }

  async open(): Promise<Mailbox | null> {
    const row = connectedMailbox(this.o.read);
    if (!row) return null;
    return this.mailboxFor(row);
  }

  async calendar(): Promise<Calendar | null> {
    const row = connectedMailbox(this.o.read);
    if (row?.kind !== 'gmail') return null;
    const client = await this.googleClient(row.settings.clientId);
    return new GoogleCalendar({
      auth: new GoogleAuth({
        client,
        secrets: this.o.secrets,
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      }),
      api: this.google.calendarApi,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  /** The candidate's Google Drive (knowledge sources), when a Google account is connected. */
  async drive(): Promise<DriveApi | null> {
    const row = connectedMailbox(this.o.read);
    if (row?.kind !== 'gmail') return null;
    const client = await this.googleClient(row.settings.clientId);
    return new GoogleDrive({
      auth: new GoogleAuth({
        client,
        secrets: this.o.secrets,
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      }),
      api: this.google.driveApi,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  async mailboxFor(row: Pick<MailboxRow, 'kind' | 'address' | 'settings'>): Promise<Mailbox> {
    if (row.kind === 'gmail') {
      const client = await this.googleClient(row.settings.clientId);
      return new GmailMailbox({
        address: row.address,
        auth: new GoogleAuth({
          client,
          secrets: this.o.secrets,
          ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
        }),
        api: this.google.gmailApi,
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      });
    }
    const s = row.settings;
    if (!s.imap || !s.smtp) throw new MailboxError('the mailbox has no IMAP/SMTP settings');
    const password = await this.o.secrets.get(MAIL_PASSWORD_SECRET);
    if (!password) throw new MailboxError('the mailbox password is missing from secrets');
    return new ImapMailbox({
      address: row.address,
      imap: s.imap,
      smtp: s.smtp,
      user: s.user ?? row.address,
      password,
      ...(this.o.allowSelfSigned ? { allowSelfSigned: true } : {}),
    });
  }

  /**
   * Connects an IMAP/SMTP mailbox: the login is checked with a first, empty sync (which also
   * sets the cursor to "now", so only mail from the last `sinceDays` is read on the first run).
   */
  async connectImap(
    db: Db,
    o: { address: string; settings: MailboxSettings; password: string; now: Date },
  ): Promise<MailboxRow> {
    const box = new ImapMailbox({
      address: o.address,
      imap: o.settings.imap ?? { host: '', port: 993, secure: true },
      smtp: o.settings.smtp ?? { host: '', port: 465, secure: true },
      user: o.settings.user ?? o.address,
      password: o.password,
      ...(this.o.allowSelfSigned ? { allowSelfSigned: true } : {}),
    });
    await box.sync(null, { since: o.now, limit: 1 });
    await this.o.secrets.set(MAIL_PASSWORD_SECRET, o.password);
    return replaceMailbox(db, {
      kind: 'imap',
      address: o.address,
      settings: o.settings,
      status: 'connected',
      now: o.now,
    });
  }

  /**
   * Starts Google's consent for Gmail (+ Calendar + Drive). The row is `connecting` until the
   * browser comes back; then it's `connected` under the account's address, or `failed`.
   */
  async connectGmail(
    db: Db,
    o: { clientId?: string | null; clientSecret?: string | null; now: () => Date; log: Logger },
  ): Promise<{ row: MailboxRow; consent: Consent }> {
    if (o.clientSecret) await this.o.secrets.set(GOOGLE_CLIENT_SECRET_SECRET, o.clientSecret);
    const client = await this.googleClient(o.clientId ?? null);
    const consent = await startGoogleConsent({
      client,
      secrets: this.o.secrets,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
    const row = replaceMailbox(db, {
      kind: 'gmail',
      address: '',
      settings: { clientId: client.clientId },
      status: 'connecting',
      now: o.now(),
    });
    consent.done
      .then(async () => {
        const gmail = (await this.mailboxFor({
          kind: 'gmail',
          address: '',
          settings: { clientId: client.clientId },
        })) as GmailMailbox;
        const profile = await gmail.profile();
        db.update(mailboxes)
          .set({
            address: profile.emailAddress.toLowerCase(),
            status: 'connected',
            note: null,
            updatedAt: o.now(),
          })
          .where(eq(mailboxes.id, row.id))
          .run();
        o.log.info('gmail connected', { address: profile.emailAddress });
      })
      .catch((err: Error) => {
        db.update(mailboxes)
          .set({ status: 'failed', note: err.message.slice(0, 500), updatedAt: o.now() })
          .where(eq(mailboxes.id, row.id))
          .run();
        o.log.warn('gmail connect failed', { err: err.message });
      });
    return { row, consent };
  }
}

/** One mailbox at a time: connecting another replaces it (its stored emails go with it). */
export function replaceMailbox(
  db: Db,
  o: {
    kind: MailboxRow['kind'];
    address: string;
    settings: MailboxSettings;
    status: MailboxRow['status'];
    now: Date;
  },
): MailboxRow {
  return db.transaction((tx) => {
    const existing = tx.select().from(mailboxes).get();
    if (existing && (existing.kind !== o.kind || existing.address !== o.address || !o.address)) {
      tx.delete(mailboxes).run();
    }
    const same = tx.select().from(mailboxes).get();
    if (same) {
      return tx
        .update(mailboxes)
        .set({ settings: o.settings, status: o.status, note: null, updatedAt: o.now })
        .where(eq(mailboxes.id, same.id))
        .returning()
        .get();
    }
    return tx
      .insert(mailboxes)
      .values({
        kind: o.kind,
        address: o.address,
        settings: o.settings,
        status: o.status,
        createdAt: o.now,
        updatedAt: o.now,
      })
      .returning()
      .get();
  });
}
