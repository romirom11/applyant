// Google's installed-app flow against a local fake token endpoint: loopback redirect on
// 127.0.0.1, PKCE (S256), state checked, tokens stored in Secrets and refreshed before they
// expire. Then Gmail sync and send through a local fake of the four REST endpoints used.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../src/db/schema.ts';
import { ConnectMailboxRequestSchema } from '../src/gen/applyant/v1/applyant_pb.js';
import { GmailMailbox } from '../src/integrations/gmail.ts';
import {
  GOOGLE_SCOPES,
  GoogleAuth,
  type GoogleClient,
  loadTokens,
  startGoogleConsent,
} from '../src/integrations/google-oauth.ts';
import { MailService } from '../src/integrations/mail-service.ts';
import { EventBus } from '../src/queue/events.ts';
import { mailRpcs, mailServer } from '../src/rpc/mail.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog } from './helpers/deps.ts';

interface Hit {
  path: string;
  body: string;
  auth: string | undefined;
}

async function fakeGoogle(): Promise<{
  origin: string;
  hits: Hit[];
  server: Server;
  raw: Map<string, string>;
}> {
  const hits: Hit[] = [];
  const raw = new Map<string, string>();
  let refreshes = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits.push({ path: `${u.pathname}${u.search}`, body, auth: req.headers.authorization });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'authorization_code') {
          return send(200, {
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3600,
            scope: GOOGLE_SCOPES.join(' '),
          });
        }
        if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'rt-1') {
          refreshes++;
          return send(200, { access_token: `at-refreshed-${refreshes}`, expires_in: 3600 });
        }
        return send(400, { error: 'invalid_grant' });
      }
      if (u.pathname === '/gmail/profile')
        return send(200, { emailAddress: 'Me@Gmail.com', historyId: '100' });
      if (u.pathname === '/gmail/messages' && req.method === 'GET') {
        return send(200, { messages: [...raw.keys()].map((id) => ({ id })) });
      }
      if (u.pathname === '/gmail/history') {
        return u.searchParams.get('startHistoryId') === 'stale'
          ? send(404, { error: { message: 'gone' } })
          : send(200, {
              history: [{ messagesAdded: [{ message: { id: 'm2' } }] }],
              historyId: '120',
            });
      }
      const m = u.pathname.match(/^\/gmail\/messages\/(\w+)$/);
      if (m?.[1] && raw.has(m[1])) return send(200, { raw: raw.get(m[1]) });
      if (u.pathname === '/gmail/messages/send') return send(200, { id: 'sent-1' });
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, hits, server, raw };
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('Google OAuth (loopback + PKCE) and Gmail', () => {
  let t: TempDb;
  let g: Awaited<ReturnType<typeof fakeGoogle>>;
  let client: GoogleClient;

  beforeEach(async () => {
    t = tempDb();
    g = await fakeGoogle();
    client = {
      clientId: 'desktop-client.apps.googleusercontent.com',
      clientSecret: 'desktop-secret',
      authUrl: `${g.origin}/auth`,
      tokenUrl: `${g.origin}/token`,
    };
  });
  afterEach(async () => {
    await new Promise<void>((r) => g.server.close(() => r()));
    t.cleanup();
  });

  it('runs the consent on 127.0.0.1 with PKCE and stores the tokens in Secrets', async () => {
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    const consent = await startGoogleConsent({ client, secrets, timeoutMs: 10_000 });
    const auth = new URL(consent.url);
    expect(auth.origin + auth.pathname).toBe(`${g.origin}/auth`);
    const q = auth.searchParams;
    expect(q.get('redirect_uri')).toBe(consent.redirectUri);
    expect(consent.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('scope')?.split(' ')).toEqual([...GOOGLE_SCOPES]);
    expect(q.get('access_type')).toBe('offline');

    // A redirect with the wrong state is refused and changes nothing.
    const wrong = await fetch(`${consent.redirectUri}/?code=abc&state=nope`);
    expect(wrong.status).toBe(400);

    // "The browser" comes back with the code.
    const back = await fetch(`${consent.redirectUri}/?code=the-code&state=${q.get('state')}`);
    expect(back.status).toBe(200);
    const tokens = await consent.done;
    expect(tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });

    const exchange = new URLSearchParams(g.hits.find((h) => h.path === '/token')?.body ?? '');
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('redirect_uri')).toBe(consent.redirectUri);
    expect(exchange.get('client_secret')).toBe('desktop-secret');
    const verifier = exchange.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(q.get('code_challenge'));
    expect((await loadTokens(secrets))?.refreshToken).toBe('rt-1');
    expect(await secrets.list()).toEqual(['google.oauth']);

    // The listener is gone after one redirect.
    await expect(fetch(`${consent.redirectUri}/?code=x&state=${q.get('state')}`)).rejects.toThrow();
  });

  it('a declined consent stores nothing', async () => {
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    const consent = await startGoogleConsent({ client, secrets });
    const state = new URL(consent.url).searchParams.get('state');
    const done = consent.done.catch((e: Error) => e);
    await fetch(`${consent.redirectUri}/?error=access_denied&state=${state}`);
    expect(String(await done)).toMatch(/access_denied/);
    expect(await loadTokens(secrets)).toBeNull();
  });

  it('the app connects Gmail through the RPCs: secret to Secrets only, consent, disconnect', async () => {
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    const mail = new MailService({
      read: t.read,
      secrets,
      google: {
        authUrl: `${g.origin}/auth`,
        tokenUrl: `${g.origin}/token`,
        gmailApi: `${g.origin}/gmail`,
      },
    });
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === 'mail') seen.push(e.stage ?? '');
    });
    const rpc = mailRpcs({
      db: t.db,
      bus,
      now: () => new Date('2026-09-30T10:00:00Z'),
      mail,
      log: quietLog,
    });
    const ctx = {} as never;
    const empty = await rpc.getMailbox({} as never, ctx);
    expect(empty.mailbox).toBeUndefined();
    expect(empty.googleClientSecretStored).toBe(false);

    const connect = (secret?: string) =>
      rpc.connectMailbox(
        create(ConnectMailboxRequestSchema, {
          kind: {
            case: 'gmail',
            value: { clientId: 'desktop-client', ...(secret ? { clientSecret: secret } : {}) },
          },
        }),
        ctx,
      );
    const first = await connect('desktop-secret');
    // The secret went to Secrets and comes back nowhere.
    expect(JSON.stringify(first, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      'desktop-secret',
    );
    expect(await secrets.get('google.client_secret')).toBe('desktop-secret');
    expect(first.mailbox).toMatchObject({
      kind: 'gmail',
      status: 'connecting',
      clientId: 'desktop-client',
    });
    const firstUrl = new URL(first.authUrl ?? '');

    // Connect again (the candidate clicked twice): the first consent's listener is closed, and
    // the stored secret is enough.
    const second = await connect();
    const url = new URL(second.authUrl ?? '');
    const status = await rpc.getMailbox({} as never, ctx);
    expect(status).toMatchObject({
      googleClientSecretStored: true,
      googleClientId: 'desktop-client',
    });
    expect(
      JSON.stringify(status, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain('desktop-secret');
    await expect(
      fetch(
        `${firstUrl.searchParams.get('redirect_uri')}/?code=x&state=${firstUrl.searchParams.get('state')}`,
      ),
    ).rejects.toThrow();

    // "The browser" comes back: connected under the account's address.
    const back = await fetch(
      `${url.searchParams.get('redirect_uri')}/?code=the-code&state=${url.searchParams.get('state')}`,
    );
    expect(back.status).toBe(200);
    for (let i = 0; i < 50; i++) {
      if ((await rpc.getMailbox({} as never, ctx)).mailbox?.status === 'connected') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await rpc.getMailbox({} as never, ctx)).mailbox).toMatchObject({
      status: 'connected',
      address: 'me@gmail.com',
    });
    expect((await secrets.list()).sort()).toEqual(['google.client_secret', 'google.oauth']);
    // The app hears it, and the first sync is queued.
    expect(seen).toEqual(['connected']);
    expect(
      t.db
        .select()
        .from(tasks)
        .all()
        .map((x) => x.kind),
    ).toEqual(['sync_mail']);

    // Disconnect: the account's tokens go, the owner's client secret stays.
    expect((await rpc.disconnectMailbox({} as never, ctx)).disconnected).toBe(true);
    const after = await rpc.getMailbox({} as never, ctx);
    expect(after.mailbox).toBeUndefined();
    expect(after.googleClientSecretStored).toBe(true);
    expect(await secrets.list()).toEqual(['google.client_secret']);
    expect((await rpc.disconnectMailbox({} as never, ctx)).disconnected).toBe(false);
    expect(seen).toEqual(['connected', 'disconnected']);

    // A consent still open when disconnecting is cancelled; the mailbox stays gone.
    const pending = new URL((await connect()).authUrl ?? '');
    await rpc.disconnectMailbox({} as never, ctx);
    await expect(
      fetch(
        `${pending.searchParams.get('redirect_uri')}/?code=x&state=${pending.searchParams.get('state')}`,
      ),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect((await rpc.getMailbox({} as never, ctx)).mailbox).toBeUndefined();
    // A cancelled consent says nothing more.
    expect(seen).toEqual(['connected', 'disconnected', 'disconnected']);

    // IMAP without a password is refused before anything is contacted or stored.
    await expect(
      rpc.connectMailbox(
        create(ConnectMailboxRequestSchema, {
          address: 'me@example.org',
          kind: {
            case: 'imap',
            value: { imapHost: 'imap.example.org', smtpHost: 'smtp.example.org' },
          },
        }),
        ctx,
      ),
    ).rejects.toThrow(/password/);
    expect(await secrets.list()).toEqual(['google.client_secret']);

    // IMAP on 993 with SMTP on 587 (iCloud, Outlook): TLS at once for one, STARTTLS for the other.
    expect(mailServer('imap.mail.me.com', 993, true, 'imap')).toEqual({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
    });
    expect(mailServer('smtp.mail.me.com', 587, true, 'smtp').secure).toBe(false);
    expect(mailServer('smtp.x.org', 0, true, 'smtp')).toMatchObject({ port: 465, secure: true });
    expect(mailServer('imap.x.org', 0, false, 'imap')).toMatchObject({ port: 143, secure: false });
    expect(mailServer('imap.x.org', 1993, false, 'imap').secure).toBe(false);
  });

  it('refreshes an expired token, and Gmail syncs and sends with it', async () => {
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    await secrets.set(
      'google.oauth',
      JSON.stringify({
        accessToken: 'old',
        refreshToken: 'rt-1',
        expiresAt: Date.now() - 1000,
        scope: '',
      }),
    );
    const auth = new GoogleAuth({ client, secrets });
    expect(await auth.accessToken()).toBe('at-refreshed-1');
    expect(await auth.accessToken()).toBe('at-refreshed-1');
    expect((await loadTokens(secrets))?.refreshToken).toBe('rt-1');

    g.raw.set(
      'm1',
      b64(
        'From: HR <hr@acme.io>\r\nSubject: Hello\r\nDate: Tue, 29 Sep 2026 09:00:00 +0000\r\nMessage-ID: <a@acme>\r\n\r\nWe got your application.\r\n',
      ),
    );
    g.raw.set(
      'm2',
      b64(
        'From: hr@acme.io\r\nSubject: Interview\r\nIn-Reply-To: <sent@me>\r\nDate: Tue, 29 Sep 2026 10:00:00 +0000\r\n\r\nLet us talk.\r\n',
      ),
    );
    const gmail = new GmailMailbox({ address: 'me@gmail.com', auth, api: `${g.origin}/gmail` });
    const first = await gmail.sync(null, { since: new Date('2026-09-22') });
    expect(first.next).toBe('100');
    expect(first.messages.map((m) => [m.fromAddress, m.subject])).toEqual([
      ['hr@acme.io', 'Hello'],
      ['hr@acme.io', 'Interview'],
    ]);
    const next = await gmail.sync('100', { since: new Date('2026-09-22') });
    expect(next.next).toBe('120');
    expect(next.messages.map((m) => m.inReplyTo)).toEqual(['<sent@me>']);
    // A history id Gmail no longer keeps: back to the date window.
    const stale = await gmail.sync('stale', { since: new Date('2026-09-22') });
    expect(stale.messages).toHaveLength(2);
    expect(g.hits.find((h) => h.path.startsWith('/gmail/messages?'))?.path).toContain('after%3A');

    const sent = await gmail.send({
      to: 'jobs@acme.io',
      subject: 'Application',
      text: 'Hi',
      attachments: [],
    });
    const body = JSON.parse(g.hits.find((h) => h.path === '/gmail/messages/send')?.body ?? '{}');
    expect(Buffer.from(body.raw, 'base64url').toString()).toContain('Subject: Application');
    expect(sent.messageId).toMatch(/^<.+>$/);
    expect(
      g.hits
        .filter((h) => h.path.startsWith('/gmail'))
        .every((h) => h.auth === 'Bearer at-refreshed-1'),
    ).toBe(true);
  });
});
