// `applyant mail …`: the connected mailbox (Gmail or IMAP/SMTP), and the
// "Which application is this?" queue.
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import type { Email, Mailbox } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso } from './format.ts';
import { positiveInt } from './jobs.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

export function mailboxLine(m: Mailbox): string {
  const synced = iso(m.syncedAt);
  return [
    `${m.kind} ${m.address || '(waiting for Google sign-in)'} · ${m.status}`,
    synced ? `synced ${synced}` : 'not synced yet',
    m.asking ? `${m.asking} to ask about (applyant mail ask)` : '',
    m.note ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function emailJson(e: Email) {
  return {
    id: Number(e.id),
    from: e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress,
    subject: e.subject,
    receivedAt: iso(e.receivedAt),
    label: e.label,
    confidence: e.confidence ?? null,
    classifiedBy: e.classifiedBy ?? null,
    applicationId: e.applicationId !== undefined ? Number(e.applicationId) : null,
    status: e.status,
    note: e.note ?? null,
    candidates: e.candidates.map((c) => ({
      applicationId: Number(c.applicationId),
      title: c.title ?? null,
      company: c.company ?? null,
    })),
  };
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // Printing the URL is enough.
  }
}

export function registerMail(
  program: Command,
  client: () => ApplyantClient,
  readSecret: (name: string) => Promise<string>,
): void {
  const mail = program
    .command('mail')
    .description('the mailbox: replies move applications on, security codes, email applications');

  mail
    .command('status', { isDefault: true })
    .description('the connected mailbox')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().getMailbox({});
      if (opts.json) return json(res.mailbox ?? null);
      out(
        res.mailbox
          ? mailboxLine(res.mailbox)
          : 'no mailbox connected: `applyant mail connect gmail | imap`',
      );
    });

  const connect = mail
    .command('connect')
    .description('connect a mailbox (replaces the current one)');
  connect
    .command('gmail')
    .description('Google sign-in in your browser (Gmail, Calendar and Drive in one consent)')
    .option('--client-id <id>', 'your Google Cloud "Desktop app" OAuth client id')
    .option('--client-secret', "read the client's secret from stdin (or a prompt)")
    .option('--no-open', 'print the sign-in URL without opening the browser')
    .option('--wait <seconds>', 'how long to wait for the sign-in', '300')
    .action(
      async (opts: { clientId?: string; clientSecret?: boolean; open: boolean; wait: string }) => {
        const secret = opts.clientSecret ? await readSecret('the client secret') : undefined;
        const c = client();
        const res = await c.connectMailbox({
          address: '',
          kind: {
            case: 'gmail',
            value: {
              ...(opts.clientId ? { clientId: opts.clientId } : {}),
              ...(secret ? { clientSecret: secret } : {}),
            },
          },
        });
        if (!res.authUrl) throw new Error('the daemon gave no sign-in URL');
        out(
          `Sign in with Google (Applyant's client is unverified: choose Advanced → continue):\n${res.authUrl}`,
        );
        if (opts.open) openInBrowser(res.authUrl);
        const deadline = Date.now() + positiveInt(opts.wait) * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const m = (await c.getMailbox({})).mailbox;
          if (m?.status === 'connected') return out(`connected: ${mailboxLine(m)}`);
          if (m?.status === 'failed') throw new Error(m.note ?? 'Google sign-in failed');
        }
        throw new Error(
          'still waiting for the Google sign-in; `applyant mail status` shows when it lands',
        );
      },
    );
  connect
    .command('imap <address>')
    .description('IMAP + SMTP with an app password (read from stdin, or a prompt)')
    .requiredOption('--imap <host[:port]>', 'IMAP server, e.g. imap.mail.me.com')
    .requiredOption('--smtp <host[:port]>', 'SMTP server, e.g. smtp.mail.me.com:587')
    .option('--user <name>', 'login name, when it is not the address')
    .option('--starttls', 'plain connection upgraded with STARTTLS (ports 143 / 587)')
    .action(
      async (
        address: string,
        opts: { imap: string; smtp: string; user?: string; starttls?: boolean },
      ) => {
        const [imapHost, imapPort] = opts.imap.split(':');
        const [smtpHost, smtpPort] = opts.smtp.split(':');
        const password = await readSecret(`the password for ${address}`);
        const res = await client().connectMailbox({
          address,
          kind: {
            case: 'imap',
            value: {
              imapHost: imapHost ?? '',
              imapPort: Number(imapPort ?? 0),
              smtpHost: smtpHost ?? '',
              smtpPort: Number(smtpPort ?? 0),
              secure: !opts.starttls,
              password,
              ...(opts.user ? { username: opts.user } : {}),
            },
          },
        });
        out(res.mailbox ? `connected: ${mailboxLine(res.mailbox)}` : 'connected');
      },
    );

  mail
    .command('sync')
    .description('read new mail now')
    .action(async () => {
      const res = await client().syncMailbox({});
      out(res.queued ? 'sync queued' : 'a sync is already waiting or running');
    });

  mail
    .command('ask')
    .description('the "Which application is this?" queue')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listMailQueue({});
      if (opts.json) return json(res.emails.map(emailJson));
      if (res.emails.length === 0) return out('nothing to ask about');
      for (const e of res.emails) {
        out(`#${e.id} ${iso(e.receivedAt)?.slice(0, 16) ?? ''} ${e.fromAddress}: ${e.subject}`);
        out(
          `    ${e.label}${e.confidence !== undefined ? ` (${Math.round(e.confidence * 100)}%)` : ''} · ${e.note ?? ''}`,
        );
        if (e.snippet) out(`    ${e.snippet.slice(0, 160)}`);
        for (const c of e.candidates) {
          out(`    → application ${c.applicationId}: ${c.title ?? '?'} at ${c.company ?? '?'}`);
        }
      }
      out('\nAnswer with `applyant mail assign <email> <application | none> [--as <label>]`.');
    });

  mail
    .command('assign <email> <application>')
    .description('say which application an email belongs to ("none" if it belongs to none)')
    .option('--as <label>', 'what it is: rejection | interview | offer | acknowledgement | other')
    .action(async (emailRef: string, appRef: string, opts: { as?: string }) => {
      const none = appRef.toLowerCase() === 'none';
      const res = await client().assignEmail({
        emailId: BigInt(positiveInt(emailRef)),
        ...(none ? {} : { applicationId: BigInt(positiveInt(appRef)) }),
        ...(opts.as ? { label: opts.as } : {}),
      });
      const e = res.email;
      out(
        e?.applicationId !== undefined
          ? `email ${emailRef} → application ${e.applicationId} (${e.label})`
          : `email ${emailRef}: not about an application`,
      );
    });
}
