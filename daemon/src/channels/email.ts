// The email Channel: "send your CV to jobs@…". Read turns the address into the same
// Requirements shape a web form has — one step with the message (a cover note, written and
// checked like any answer) and the CV attachment — so preparation, review and approval are the
// same as for a form. Deliver sends it from the candidate's connected mailbox with the approved
// CV attached, and keeps the exact MIME message with the receipt.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ReadFormOptions, ReadFormResult } from '../browser/form-read.ts';
import type { FormRead } from '../browser/form-types.ts';
import type { ApplicationRow, PostingRow } from '../db/schema.ts';
import type { ApplicationView } from '../domain/applications/store.ts';
import type { MailAccess } from '../integrations/mail-service.ts';
import { ensurePrivateDir } from '../util/fs.ts';
import type {
  Channel,
  DeliverContext,
  DeliverOutcome,
  DeliveryReceipt,
  ReceiptFieldSent,
} from './channel.ts';

export interface MailtoTarget {
  address: string;
  subject: string | null;
}

export function parseMailto(url: string): MailtoTarget | null {
  if (!url.startsWith('mailto:')) return null;
  const [addr, query] = url.slice(7).split('?');
  const address = decodeURIComponent(addr ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return null;
  const subject = new URLSearchParams(query ?? '').get('subject');
  return { address, subject: subject?.trim() || null };
}

const ref = (role: string, name: string) => ({ frame: [], role, name, nth: 0, css: null });

/** The "form" of an email application: the message and the CV. */
export function emailForm(url: string): FormRead | null {
  const target = parseMailto(url);
  if (!target) return null;
  return {
    url,
    requirements: {
      steps: [
        {
          fields: [
            {
              ref: ref('textbox', 'Message'),
              label: `Cover note: the email's message to ${target.address}`,
              kind: 'textarea',
              required: true,
              options: null,
              meaning: 'cover_letter',
              revealedBy: null,
            },
            {
              ref: ref('button', 'CV'),
              label: 'CV (attached to the email)',
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
    notes: [`sent from your connected mailbox to ${target.address}`],
  };
}

export function emailSubject(
  target: MailtoTarget,
  posting: Pick<PostingRow, 'title'>,
  fullName: string | null,
): string {
  if (target.subject) return target.subject;
  const role = posting.title ? `Application: ${posting.title}` : 'Application';
  return fullName ? `${role} — ${fullName}` : role;
}

export interface EmailChannelDeps {
  mail: MailAccess | null;
  /** Where sent messages are kept (files/sent). */
  sentDir: string;
}

export class EmailChannel implements Channel {
  private readonly d: EmailChannelDeps;

  constructor(deps: EmailChannelDeps) {
    this.d = deps;
  }

  async read(o: ReadFormOptions): Promise<ReadFormResult> {
    const read = emailForm(o.url);
    return read
      ? { kind: 'form', read }
      : { kind: 'no_form', note: `not an email address: ${o.url}`, url: o.url };
  }

  async deliver(
    app: ApplicationRow,
    posting: PostingRow,
    view: ApplicationView,
    ctx: DeliverContext,
  ): Promise<DeliverOutcome> {
    const url = posting.applyUrl ?? posting.canonicalUrl;
    const target = parseMailto(url);
    const stuck = (reason: string): DeliverOutcome => ({
      kind: 'needs_candidate',
      handOff: { reason, detail: null },
    });
    if (!target) return stuck(`the application address isn't an email address (${url})`);
    const box = await this.d.mail?.open();
    if (!box) {
      return stuck('connect a mailbox to send email applications (`applyant mail connect`)');
    }
    const active = view.fields.filter((f) => f.active);
    const message = active.find((f) => f.meaning === 'cover_letter')?.value?.trim() ?? '';
    const cvPath = active.find((f) => f.meaning === 'resume')?.value ?? null;
    if (!message) return stuck('the email has no message to send');
    if (!cvPath || !existsSync(cvPath)) {
      return stuck(
        `the CV to attach is missing${cvPath ? ` (${cvPath})` : ''}, so nothing was sent`,
      );
    }
    const fullName = ctx.profile.full_name;
    const filename = `${fullName ? `${fullName} - ` : ''}CV${extname(cvPath) || '.pdf'}`;
    ctx.progress(`sending to ${target.address} from ${box.address}`);
    const sent = await box.send({
      to: target.address,
      subject: emailSubject(target, posting, fullName),
      text: message,
      attachments: [{ filename, path: cvPath }],
    });
    ensurePrivateDir(this.d.sentDir);
    const emlPath = join(this.d.sentDir, `application-${app.id}-${Date.now()}.eml`);
    writeFileSync(emlPath, sent.raw, { mode: 0o600 });

    const fields: ReceiptFieldSent[] = active
      .filter((f) => f.value)
      .map((f) => ({ ref: f.ref, label: f.label, value: f.value, source: f.source }));
    const receipt: DeliveryReceipt = {
      finalUrl: url,
      confirmationText: `emailed to ${target.address} from ${box.address} (${sent.messageId})`,
      confirmationSnapshotPath: emlPath,
      cvPath,
      cvHash: createHash('sha256').update(readFileSync(cvPath)).digest('hex'),
      salaryValue: null,
      fieldValues: fields,
      submittedAt: new Date(),
      messageId: sent.messageId,
    };
    return { kind: 'applied', receipt };
  }
}
