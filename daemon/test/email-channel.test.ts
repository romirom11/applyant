// Email applications: an approved application to a mailto: address is sent through SMTP (a
// local test server) with the CV attached, and the receipt keeps the message and the CV's hash.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refKey } from '../src/browser/form-types.ts';
import { EmailChannel, emailForm, emailSubject, parseMailto } from '../src/channels/email.ts';
import { applications, fieldValues, postings, receipts } from '../src/db/schema.ts';
import { deliverApplication } from '../src/domain/applications/deliver.ts';
import { ImapMailbox } from '../src/integrations/imap.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Task } from '../src/queue/types.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { testDeps } from './helpers/deps.ts';
import { fakeMail } from './helpers/mail.ts';

interface Received {
  from: string;
  to: string[];
  user: string | undefined;
  raw: Buffer;
}

async function startSmtp(): Promise<{
  port: number;
  received: Received[];
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  const server = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authOptional: false,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'me@example.org' && auth.password === 'app-password') {
        cb(null, { user: auth.username });
      } else cb(new Error('bad login'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          user: session.user as string | undefined,
          raw: Buffer.concat(chunks),
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.server.address() as { port: number }).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('email channel', () => {
  let t: TempDb;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;

  beforeEach(async () => {
    t = tempDb();
    smtp = await startSmtp();
  });
  afterEach(async () => {
    await smtp.close();
    t.cleanup();
  });

  it('turns a mailto: address into a message + CV "form"', () => {
    expect(parseMailto('mailto:jobs@acme.io?subject=Backend%20role')).toEqual({
      address: 'jobs@acme.io',
      subject: 'Backend role',
    });
    expect(parseMailto('mailto:not-an-address')).toBeNull();
    const form = emailForm('mailto:jobs@acme.io');
    expect(form?.requirements.steps[0]?.fields.map((f) => [f.kind, f.meaning, f.required])).toEqual(
      [
        ['textarea', 'cover_letter', true],
        ['file', 'resume', true],
      ],
    );
    expect(
      emailSubject({ address: 'a@b.co', subject: null }, { title: 'AI Engineer' }, 'Roman Kudin'),
    ).toBe('Application: AI Engineer — Roman Kudin');
  });

  it('sends an approved application over SMTP; the receipt keeps the message and the CV hash', async () => {
    const cv = join(t.dir, 'cv.pdf');
    writeFileSync(cv, '%PDF-1.4 fake CV for the test\n');
    const url = 'mailto:jobs@acme.io';
    const form = emailForm(url);
    if (!form) throw new Error('no form');
    const posting = t.db
      .insert(postings)
      .values({
        stage: 'scored',
        canonicalUrl: 'https://acme.io/jobs/backend',
        applyUrl: url,
        title: 'Backend Engineer',
        company: 'Acme',
        form,
        formStatus: 'email',
        formReadAt: new Date(),
      })
      .returning()
      .get();
    const app = t.db
      .insert(applications)
      .values({
        postingId: posting.id,
        stage: 'approved',
        channel: 'email',
        approvedAt: new Date(),
      })
      .returning()
      .get();
    const [message, resume] = form.requirements.steps[0]?.fields ?? [];
    if (!message || !resume) throw new Error('no fields');
    const note =
      'Hello Acme team,\n\nI would like to apply for the Backend Engineer role.\n\nRoman';
    t.db
      .insert(fieldValues)
      .values([
        {
          applicationId: app.id,
          fieldRef: `1:${refKey(message.ref)}`,
          position: 0,
          spec: message,
          value: note,
          source: 'answer',
          defaultValue: note,
          defaultSource: 'answer',
        },
        {
          applicationId: app.id,
          fieldRef: `1:${refKey(resume.ref)}`,
          position: 1,
          spec: resume,
          value: cv,
          source: 'file',
          defaultValue: cv,
          defaultSource: 'file',
        },
      ])
      .run();

    const box = new ImapMailbox({
      address: 'me@example.org',
      imap: { host: '127.0.0.1', port: 1, secure: false },
      smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
      user: 'me@example.org',
      password: 'app-password',
    });
    const mail = fakeMail(box);
    const deps = {
      ...testDeps({ dir: t.dir, db: t.db }),
      mail,
      channels: { email: new EmailChannel({ mail, sentDir: join(t.dir, 'files', 'sent') }) },
    };
    const task: Task<'deliver_application'> = {
      id: 1,
      kind: 'deliver_application',
      entityId: app.id,
      runId: null,
      provider: null,
      attempts: 0,
    };
    const outcome = await deliverApplication(task, {
      deps,
      read: t.read,
      signal: new AbortController().signal,
      progress: () => {},
      record: () => true,
      now: () => new Date(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done')
      runInTx(t.db, new EventBus(), { now: new Date() }, (tx) => outcome.commit(tx));

    // What the server got: from the mailbox, to the address, authenticated, the CV attached.
    expect(smtp.received).toHaveLength(1);
    const got = smtp.received[0];
    expect(got?.from).toBe('me@example.org');
    expect(got?.to).toEqual(['jobs@acme.io']);
    expect(got?.user).toBe('me@example.org');
    const parsed = await simpleParser(got?.raw ?? Buffer.alloc(0));
    expect(parsed.subject).toBe('Application: Backend Engineer');
    expect(parsed.text?.trim()).toBe(note);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('CV.pdf');
    expect(parsed.attachments[0]?.content.equals(readFileSync(cv))).toBe(true);

    // The application is applied; the receipt has the message id, the CV hash and the .eml.
    expect(t.db.select().from(applications).where(eq(applications.id, app.id)).get()?.stage).toBe(
      'applied',
    );
    const receipt = t.db.select().from(receipts).where(eq(receipts.applicationId, app.id)).get();
    expect(receipt?.messageId).toBe(parsed.messageId);
    expect(receipt?.cvHash).toBe(createHash('sha256').update(readFileSync(cv)).digest('hex'));
    expect(receipt?.finalUrl).toBe(url);
    expect(receipt?.fieldValues.map((f) => f.source)).toEqual(['answer', 'file']);
    // The kept .eml is the message that went out (SMTP only normalises line endings).
    const kept = await simpleParser(readFileSync(receipt?.confirmationSnapshotPath ?? ''));
    expect(kept.messageId).toBe(parsed.messageId);
    expect(kept.attachments[0]?.content.equals(readFileSync(cv))).toBe(true);
  });

  it('hands off without a connected mailbox, and a wrong password sends nothing', async () => {
    const channel = new EmailChannel({ mail: fakeMail(null), sentDir: join(t.dir, 'sent') });
    const outcome = await channel.deliver(
      {} as never,
      { applyUrl: 'mailto:jobs@acme.io', canonicalUrl: 'https://acme.io', title: 'X' } as never,
      { fields: [] } as never,
      {
        taskId: 1,
        signal: new AbortController().signal,
        progress: () => {},
        begin: () => {},
        submitting: () => {},
        profile: {} as never,
      },
    );
    expect(outcome).toMatchObject({ kind: 'needs_candidate' });

    const bad = new ImapMailbox({
      address: 'me@example.org',
      imap: { host: '127.0.0.1', port: 1, secure: false },
      smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
      user: 'me@example.org',
      password: 'wrong',
    });
    await expect(
      bad.send({ to: 'jobs@acme.io', subject: 's', text: 't', attachments: [] }),
    ).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });
});
