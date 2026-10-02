// The Telegram Channel: "write to @recruiter". Like email, Read turns the contact into the same
// Requirements shape a web form has — one step with the message (a cover note, written and
// checked like any answer) and the CV — so preparation, review and approval are unchanged.
// Deliver sends the message and then the approved CV as a document from the candidate's own
// Telegram account (GramJS), and keeps exactly what was sent with the receipt.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ReadFormOptions, ReadFormResult } from '../browser/form-read.ts';
import type { FormRead } from '../browser/form-types.ts';
import type { ApplicationRow, PostingRow } from '../db/schema.ts';
import type { ApplicationView } from '../domain/applications/store.ts';
import type { TelegramAccess } from '../integrations/gramjs.ts';
import { ensurePrivateDir } from '../util/fs.ts';
import type {
  Channel,
  DeliverContext,
  DeliverOutcome,
  DeliveryReceipt,
  ReceiptFieldSent,
} from './channel.ts';

/** Telegram usernames: 5–32 letters, digits and underscores, starting with a letter. */
const USERNAME = /^[a-z][a-z0-9_]{3,31}$/i;
/** t.me paths that are Telegram's own pages, not a user. */
const RESERVED = new Set(['s', 'joinchat', 'addstickers', 'share', 'proxy', 'socks', 'iv', 'c']);

/** A contact as a post writes it ("@hr_anna", "t.me/hr_anna", "https://t.me/hr_anna") → its URL. */
export function telegramContactUrl(contact: string | null | undefined): string | null {
  const c = contact?.trim() ?? '';
  const m =
    /^@([a-z][a-z0-9_]{3,31})$/i.exec(c) ??
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([a-z][a-z0-9_]{3,31})\/?$/i.exec(c);
  const user = m?.[1];
  if (!user || RESERVED.has(user.toLowerCase())) return null;
  return `https://t.me/${user}`;
}

/** The username a Telegram contact URL (`https://t.me/<user>`, `tg://resolve?domain=`) points at. */
export function parseTelegramContact(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'tg:') {
    const d = u.searchParams.get('domain');
    return d && USERNAME.test(d) ? d : null;
  }
  if (!/^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const user = parts[0];
  if (parts.length !== 1 || !user || !USERNAME.test(user) || RESERVED.has(user.toLowerCase())) {
    return null;
  }
  return user;
}

const ref = (role: string, name: string) => ({ frame: [], role, name, nth: 0, css: null });

/** The "form" of a Telegram application: the message and the CV. */
export function telegramForm(url: string): FormRead | null {
  const user = parseTelegramContact(url);
  if (!user) return null;
  return {
    url,
    requirements: {
      steps: [
        {
          fields: [
            {
              ref: ref('textbox', 'Message'),
              label: `Cover note: the Telegram message to @${user}`,
              kind: 'textarea',
              required: true,
              options: null,
              meaning: 'cover_letter',
              revealedBy: null,
            },
            {
              ref: ref('button', 'CV'),
              label: 'CV (sent after the message as a file)',
              kind: 'file',
              required: true,
              options: null,
              meaning: 'resume',
              revealedBy: null,
            },
          ],
          advance: ref('button', 'Send'),
          isFinal: true,
        },
      ],
    },
    notes: [`sent from your Telegram account to @${user}`],
  };
}

export interface TelegramChannelDeps {
  telegram: TelegramAccess | null;
  /** Where sent messages are kept (files/sent). */
  sentDir: string;
}

export class TelegramChannel implements Channel {
  private readonly d: TelegramChannelDeps;

  constructor(deps: TelegramChannelDeps) {
    this.d = deps;
  }

  async read(o: ReadFormOptions): Promise<ReadFormResult> {
    const read = telegramForm(o.url);
    return read
      ? { kind: 'form', read }
      : { kind: 'no_form', note: `not a Telegram contact: ${o.url}`, url: o.url };
  }

  async deliver(
    app: ApplicationRow,
    posting: PostingRow,
    view: ApplicationView,
    ctx: DeliverContext,
  ): Promise<DeliverOutcome> {
    const url = posting.applyUrl ?? posting.canonicalUrl;
    const user = parseTelegramContact(url);
    const stuck = (reason: string): DeliverOutcome => ({
      kind: 'needs_candidate',
      handOff: { reason, detail: null },
    });
    if (!user) return stuck(`the contact isn't a Telegram user (${url})`);
    const active = view.fields.filter((f) => f.active);
    const message = active.find((f) => f.meaning === 'cover_letter')?.value?.trim() ?? '';
    const cvPath = active.find((f) => f.meaning === 'resume')?.value ?? null;
    if (!message) return stuck('the Telegram message is empty');
    if (!cvPath || !existsSync(cvPath)) {
      return stuck(`the CV to send is missing${cvPath ? ` (${cvPath})` : ''}, so nothing was sent`);
    }
    const client = await this.d.telegram?.open();
    if (!client) {
      return stuck(
        'connect your Telegram account to send Telegram applications (Settings → Telegram, or `applyant telegram connect`)',
      );
    }
    const fullName = ctx.profile.full_name;
    const filename = `${fullName ? `${fullName} - ` : ''}CV${extname(cvPath) || '.pdf'}`;
    let sent: { message: number; file: number };
    try {
      ctx.begin();
      ctx.submitting();
      ctx.progress(`sending the message to @${user}`);
      const m = await client.sendMessage(user, { message });
      ctx.progress(`sending the CV to @${user}`);
      const f = await client.sendFile(user, {
        file: cvPath,
        caption: filename,
        forceDocument: true,
      });
      sent = { message: m.id, file: f.id };
    } finally {
      await client.disconnect().catch(() => {});
    }

    ensurePrivateDir(this.d.sentDir);
    const keptPath = join(this.d.sentDir, `application-${app.id}-${Date.now()}.telegram.txt`);
    writeFileSync(
      keptPath,
      `To: @${user}\nMessage id: ${sent.message}\nCV: ${filename} (message id ${sent.file})\n\n${message}\n`,
      { mode: 0o600 },
    );
    const fields: ReceiptFieldSent[] = active
      .filter((f) => f.value)
      .map((f) => ({ ref: f.ref, label: f.label, value: f.value, source: f.source }));
    const receipt: DeliveryReceipt = {
      finalUrl: url,
      confirmationText: `sent on Telegram to @${user} (messages ${sent.message} and ${sent.file})`,
      confirmationSnapshotPath: keptPath,
      cvPath,
      cvHash: createHash('sha256').update(readFileSync(cvPath)).digest('hex'),
      salaryValue: null,
      fieldValues: fields,
      submittedAt: new Date(),
      messageId: `telegram:${user}/${sent.message}`,
    };
    return { kind: 'applied', receipt };
  }
}
