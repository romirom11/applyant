// Telegram (phase 15): public channels read from recorded t.me/s previews, the extractor
// turning posts into postings (non-job posts skipped), verification of a post, the Telegram
// "form", delivery through a fake GramJS client, and the sign-in flow. Nothing talks to Telegram.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refKey } from '../src/browser/form-types.ts';
import {
  parseTelegramContact,
  TelegramChannel,
  telegramContactUrl,
  telegramForm,
} from '../src/channels/telegram.ts';
import { applications, fieldValues, postings, receipts, searchSources } from '../src/db/schema.ts';
import { deliverApplication } from '../src/domain/applications/deliver.ts';
import { readFormHandler } from '../src/domain/applications/read-form.ts';
import {
  applyUrlOf,
  previewPosts,
  readTelegram,
  telegramChannelOf,
} from '../src/domain/search/readers/telegram.ts';
import { addSource, parseSourceInput } from '../src/domain/search/sources.ts';
import {
  checkTelegramPost,
  embedText,
  telegramPostOf,
} from '../src/domain/search/telegram-post.ts';
import {
  TELEGRAM_SESSION_SECRET,
  type TelegramAccess,
  type TelegramClientLike,
  TelegramService,
} from '../src/integrations/gramjs.ts';
import type { ProviderRequest } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Task } from '../src/queue/types.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { testDeps, testRunner } from './helpers/deps.ts';
import { recordedFetch, searchHarness } from './helpers/search.ts';

const DIR = fileURLToPath(new URL('./fixtures/telegram', import.meta.url));
const page = (f: string) => readFileSync(join(DIR, f), 'utf8');

/** A scripted extractor: Remote IT's "ROLE | WHERE | COMPANY" posts are jobs, the rest aren't. */
function fakeExtractor(): FakeProvider {
  return new FakeProvider('claude', [], (req: ProviderRequest) => {
    const posts = [...req.prompt.matchAll(/<post (\d+)>\n([\s\S]*?)\n<\/post>/g)].map((m) => {
      const text = m[2] ?? '';
      const job = /^([^|\n]+) \| ([^|\n]+) \| ([^#\n<]+)/.exec(text);
      const link = /<(https?:\/\/[^>]+)>/.exec(text)?.[1] ?? null;
      const company = /Company: (.+)/.exec(text)?.[1] ?? job?.[3]?.trim() ?? null;
      const role = job?.[1]?.trim() ?? /🚀 (.+)/.exec(text)?.[1]?.trim() ?? null;
      return {
        post: m[1] ?? '',
        job: role !== null,
        role,
        company,
        salary: null,
        location: job?.[2]?.trim() ?? null,
        remote: job ? /remote/i.test(job[2] ?? '') : null,
        contact: null,
        applyUrl: link,
      };
    });
    return {
      kind: 'ok',
      output: { posts },
      model: req.model,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  });
}

describe('telegram: the channel preview', () => {
  it('reads each post of a recorded t.me/s page with the textPattern recipe', () => {
    const posts = previewPosts(page('remotejobss.html'));
    expect(posts).toHaveLength(20);
    const last = posts.at(-1);
    expect(last?.url).toBe('https://t.me/remotejobss/13313');
    expect(last?.postedAt).toBe('2026-09-29T10:00:06+00:00');
    expect(last?.text).toContain('Company: Invisible Agency');
    // The post's "Apply Now" button is where the job's page is.
    expect(last?.text).toMatch(/Apply Now <https:\/\/remoteok\.com\/remote-jobs\/.+1131456>/);
    const it = previewPosts(page('remoteit.html'));
    expect(it).toHaveLength(17);
    expect(it.at(-1)?.text).toBe(
      'SENIOR GO DEVELOPER | REMOTE RU/BY | QLAN #remote #fulltime #itjob #backend #go <https://teletype.in/@remoteit/6QierIOfHWF>',
    );
  });

  it('knows channels, contacts and where a post says to apply', () => {
    expect(telegramChannelOf('https://t.me/s/remotejobss')).toBe('remotejobss');
    expect(telegramChannelOf('t.me/remotejobss/13313')).toBe('remotejobss');
    expect(telegramChannelOf('@remote_it_jobs')).toBe('remote_it_jobs');
    expect(telegramChannelOf('https://t.me/+AbCdEf123')).toBe('+AbCdEf123');
    expect(telegramChannelOf('https://example.com/x')).toBeNull();
    expect(parseSourceInput(['https://t.me/s/Remoteit'])).toEqual({
      kind: 'telegram',
      locator: 'Remoteit',
      label: null,
    });
    expect(parseSourceInput(['telegram', '@remotejobss']).locator).toBe('remotejobss');
    expect(() => parseSourceInput(['https://t.me/s/'])).toThrow();
    expect(telegramContactUrl('@hr_anna')).toBe('https://t.me/hr_anna');
    expect(parseTelegramContact('https://t.me/hr_anna')).toBe('hr_anna');
    expect(parseTelegramContact('https://t.me/remotejobss/13313')).toBeNull();
    expect(parseTelegramContact('https://t.me/s/remotejobss')).toBeNull();
    expect(applyUrlOf({ applyUrl: 'https://jobs.lever.co/acme/1', contact: '@hr_anna' })).toBe(
      'https://jobs.lever.co/acme/1',
    );
    expect(applyUrlOf({ applyUrl: null, contact: 'jobs@acme.io' })).toBe('mailto:jobs@acme.io');
    expect(applyUrlOf({ applyUrl: null, contact: '@hr_anna' })).toBe('https://t.me/hr_anna');
    expect(applyUrlOf({ applyUrl: 'https://t.me/remotejobss', contact: null })).toBe(
      'https://t.me/remotejobss',
    );
    expect(applyUrlOf({ applyUrl: null, contact: null })).toBeNull();
  });

  it('judges each post once; jobs become listings, other posts are skipped', async () => {
    const calls: string[][] = [];
    const judge = async (_c: string, posts: { id: string; text: string }[]) => {
      calls.push(posts.map((p) => p.id));
      return new Map(
        posts.map((p) => [
          p.id,
          / \| /.test(p.text)
            ? {
                role: p.text.split(' | ')[0] ?? '',
                company: null,
                salary: null,
                location: null,
                remote: null,
                applyUrl: null,
                contact: null,
              }
            : null,
        ]),
      );
    };
    const ctx = {
      fetch: recordedFetch({ 'https://t.me/s/Remoteit': page('remoteit.html') }),
      signal: new AbortController().signal,
      queries: [],
      now: new Date(),
      telegram: { judge, account: null },
    };
    const first = await readTelegram('Remoteit', ctx);
    expect(first.complete).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(17);
    const jobs = first.listings.length;
    expect(jobs).toBeGreaterThan(5);
    expect(Object.values(first.posts).filter((v) => v === null)).toHaveLength(17 - jobs);
    expect(first.listings.at(-1)).toMatchObject({
      url: 'https://t.me/Remoteit/13960',
      externalId: 'telegram:Remoteit/13960',
      title: 'SENIOR GO DEVELOPER',
    });
    const again = await readTelegram('Remoteit', ctx, first.posts);
    expect(calls).toHaveLength(1);
    expect(again.listings).toHaveLength(jobs);
  });

  it('a private channel needs the account; with a fake client its posts are read over MTProto', async () => {
    const ctx = {
      fetch: recordedFetch(),
      signal: new AbortController().signal,
      queries: [],
      now: new Date(),
      telegram: {
        judge: async (_c: string, posts: { id: string }[]) =>
          new Map(posts.map((p) => [p.id, null])),
        account: null,
      },
    };
    await expect(readTelegram('+AbCdEf123', ctx)).rejects.toThrow(/connect your Telegram/);
    const client = fakeClient();
    client.messages = [
      {
        id: 7,
        message: 'Backend Engineer | Remote EU | Acme — write @hr_anna',
        date: 1_790_000_000,
      },
    ];
    const run = await readTelegram('+AbCdEf123', {
      ...ctx,
      telegram: {
        judge: async () =>
          new Map([
            [
              '7',
              {
                role: 'Backend Engineer',
                company: 'Acme',
                salary: '€6k/month',
                location: 'Remote EU',
                remote: true,
                applyUrl: 'https://t.me/hr_anna',
                contact: '@hr_anna',
              },
            ],
          ]),
        account: { open: async () => client },
      },
    });
    expect(run.listings).toHaveLength(1);
    expect(run.listings[0]?.applyUrl).toBe('https://t.me/hr_anna');
    expect(run.listings[0]?.description).toContain('Salary: €6k/month');
    expect(client.disconnected).toBe(1);
  });
});

describe('telegram: search, verification, the form and delivery', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  it('a strategy over a followed channel adds its job posts as found postings', async () => {
    const extractor = fakeExtractor();
    const h = searchHarness(t, {
      fetch: recordedFetch({ 'https://t.me/s/Remoteit': page('remoteit.html') }),
      deps: { models: testRunner({ dir: t.dir, providers: [extractor] }) },
    });
    try {
      addSource(t.db, parseSourceInput(['https://t.me/s/Remoteit']), new Date());
      const runId = await h.run({
        name: 'Backend on Telegram',
        queries: ['developer', 'engineer'],
        locations: [],
        sources: ['telegram'],
      });
      const run = h.runRow(runId);
      expect(run?.status).toBe('done');
      const found = t.db.select().from(postings).all();
      expect(found.length).toBeGreaterThan(3);
      expect(found.every((p) => p.canonicalUrl.startsWith('https://t.me/Remoteit/'))).toBe(true);
      const go = found.find((p) => p.canonicalUrl === 'https://t.me/Remoteit/13960');
      expect(go).toMatchObject({
        stage: 'found',
        title: 'SENIOR GO DEVELOPER',
        company: 'QLAN',
        applyUrl: 'https://teletype.in/@remoteit/6QierIOfHWF',
      });
      expect(go?.listingText).toContain('Role: SENIOR GO DEVELOPER');
      // The broker ad (13955) isn't a job: no posting.
      expect(found.some((p) => p.canonicalUrl.endsWith('/13955'))).toBe(false);
      expect(h.tasksOf('verify_posting')).toHaveLength(found.length);
      expect(extractor.requests).toHaveLength(1);
      const source = t.db
        .select()
        .from(searchSources)
        .where(eq(searchSources.key, 'telegram:Remoteit'))
        .get();
      expect(source?.resolved?.via).toBe('telegram');
      expect(source?.lastComplete).toBe(false);

      // The next run judges nothing again and adds nothing new.
      const strategy = run?.strategyId ?? 0;
      await h.again(strategy);
      expect(extractor.requests).toHaveLength(1);
      expect(t.db.select().from(postings).all()).toHaveLength(found.length);
    } finally {
      await h.stop();
    }
  });

  it('verifies a post: still there, and its contact, address or job page', async () => {
    const fetch = recordedFetch({
      'https://t.me/remotejobss/13313?embed=1&mode=tme': page('remotejobss-13313-embed.html'),
      'https://t.me/remotejobss/99?embed=1&mode=tme': page('post-missing-embed.html'),
    });
    expect(telegramPostOf('https://t.me/remotejobss/13313')).toEqual({
      channel: 'remotejobss',
      id: '13313',
    });
    expect(embedText(page('remotejobss-13313-embed.html'))).toContain('Invisible Agency');
    const signal = new AbortController().signal;
    const opened: string[] = [];
    const open = async (url: string) => {
      opened.push(url);
      return {
        kind: 'live' as const,
        note: 'application form found',
        title: 'Job page',
        company: null,
        text: 'the job page text',
        jsonLd: null,
        applyUrl: `${url}/apply`,
      };
    };
    const base = { title: '3D Modeling', company: 'Invisible Agency', listingText: 'Role: 3D' };
    const byContact = await checkTelegramPost(
      { ...base, canonicalUrl: 'https://t.me/remotejobss/13313', applyUrl: 'https://t.me/hr_anna' },
      { fetch, signal, open },
    );
    expect(byContact).toMatchObject({ kind: 'live', applyUrl: 'https://t.me/hr_anna' });
    const byPage = await checkTelegramPost(
      {
        ...base,
        canonicalUrl: 'https://t.me/remotejobss/13313',
        applyUrl: 'https://acme.io/jobs/1',
      },
      { fetch, signal, open },
    );
    expect(byPage).toMatchObject({
      kind: 'live',
      applyUrl: 'https://acme.io/jobs/1/apply',
      text: 'the job page text',
      title: '3D Modeling',
    });
    expect(opened).toEqual(['https://acme.io/jobs/1']);
    const deleted = await checkTelegramPost(
      { ...base, canonicalUrl: 'https://t.me/remotejobss/99', applyUrl: 'https://t.me/hr_anna' },
      { fetch, signal, open },
    );
    expect(deleted).toMatchObject({ kind: 'dead', note: 'the Telegram post was deleted' });
    const nowhere = await checkTelegramPost(
      { ...base, canonicalUrl: 'https://t.me/remotejobss/13313', applyUrl: null },
      { fetch, signal, open },
    );
    expect(nowhere).toMatchObject({ kind: 'dead', note: 'the post names no way to apply' });
  });

  it('reads a @contact as a message + CV form and delivers through a fake GramJS client', async () => {
    const url = 'https://t.me/hr_anna';
    const posting = t.db
      .insert(postings)
      .values({
        stage: 'scored',
        canonicalUrl: 'https://t.me/Remoteit/13960',
        applyUrl: url,
        title: 'Senior Go Developer',
        company: 'QLAN',
      })
      .returning()
      .get();
    const deps = testDeps({ dir: t.dir, db: t.db });
    const ctx = {
      deps,
      read: t.read,
      signal: new AbortController().signal,
      progress: () => {},
      record: () => true,
      now: () => new Date(),
    };
    const commit = (o: { kind: string; commit?: (tx: never) => void }) => {
      if (o.kind === 'done' && o.commit)
        runInTx(t.db, new EventBus(), { now: new Date() }, (tx) => o.commit?.(tx as never));
    };
    const task = <K extends 'read_form' | 'deliver_application'>(kind: K, entityId: number) =>
      ({ id: 1, kind, entityId, runId: null, provider: null, attempts: 0 }) as Task<K>;
    commit(await readFormHandler(task('read_form', posting.id), ctx));
    const read = t.db.select().from(postings).where(eq(postings.id, posting.id)).get();
    expect(read?.formStatus).toBe('telegram');
    expect(read?.form).toEqual(telegramForm(url));

    const cv = join(t.dir, 'cv.pdf');
    writeFileSync(cv, '%PDF-1.4 fake CV\n');
    const app = t.db
      .insert(applications)
      .values({
        postingId: posting.id,
        stage: 'approved',
        channel: 'telegram',
        approvedAt: new Date(),
      })
      .returning()
      .get();
    const [message, resume] = telegramForm(url)?.requirements.steps[0]?.fields ?? [];
    if (!message || !resume) throw new Error('no fields');
    const note = 'Hi Anna, I would like to apply for the Senior Go Developer role.';
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

    // No account connected: a hand-off, nothing sent.
    const none: TelegramAccess = { open: async () => null };
    deps.channels.telegram = new TelegramChannel({ telegram: none, sentDir: join(t.dir, 'sent') });
    const stuck = await deliverApplication(task('deliver_application', app.id), ctx);
    expect(stuck).toMatchObject({ kind: 'needs_candidate' });
    expect(JSON.stringify(stuck)).toContain('connect your Telegram account');

    const client = fakeClient();
    deps.channels.telegram = new TelegramChannel({
      telegram: { open: async () => client },
      sentDir: join(t.dir, 'sent'),
    });
    t.db.update(applications).set({ stage: 'approved' }).where(eq(applications.id, app.id)).run();
    commit(await deliverApplication(task('deliver_application', app.id), ctx));
    expect(client.sent).toEqual([
      { peer: 'hr_anna', message: note },
      { peer: 'hr_anna', file: cv, caption: 'CV.pdf' },
    ]);
    expect(client.disconnected).toBe(1);
    expect(t.db.select().from(applications).where(eq(applications.id, app.id)).get()?.stage).toBe(
      'applied',
    );
    const receipt = t.db.select().from(receipts).where(eq(receipts.applicationId, app.id)).get();
    expect(receipt?.finalUrl).toBe(url);
    expect(receipt?.messageId).toBe('telegram:hr_anna/101');
    expect(receipt?.cvHash).toBe(createHash('sha256').update(readFileSync(cv)).digest('hex'));
    expect(readFileSync(receipt?.confirmationSnapshotPath ?? '', 'utf8')).toContain(note);
  });
});

describe('telegram: the account', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  it('signs in with phone → code → 2FA password; only the session is kept, in Secrets', async () => {
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    const made: string[] = [];
    const svc = new TelegramService({
      secrets,
      env: {},
      client: async ({ session, apiId }) => {
        made.push(`${apiId}:${session}`);
        return fakeClient();
      },
    });
    await expect(svc.startSignIn('+30 690 000 0000')).rejects.toThrow(/api id and hash/);
    const waiting = await svc.startSignIn('+30 690 000 0000', { apiId: '12345', apiHash: 'abc' });
    expect(waiting.state).toBe('waiting_code');
    const pw = await svc.submitCode('11 111');
    expect(pw).toMatchObject({ state: 'waiting_password', note: 'password hint: pet' });
    const done = await svc.submitPassword('secret');
    expect(done).toMatchObject({ state: 'connected', account: '@roman · Roman' });
    expect(await secrets.get(TELEGRAM_SESSION_SECRET)).toBe('session-string');
    const client = await svc.open();
    expect(client).not.toBeNull();
    expect(made).toEqual(['12345:', '12345:session-string']);
    expect((await svc.disconnect()).state).toBe('disconnected');
    expect(await secrets.get(TELEGRAM_SESSION_SECRET)).toBeNull();
    expect(await svc.open()).toBeNull();
  });

  it('a wrong code ends the sign-in with the reason', async () => {
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    const svc = new TelegramService({ secrets, env: {}, client: async () => fakeClient() });
    await svc.startSignIn('+306900000000', { apiId: '1', apiHash: 'h' });
    await expect(svc.submitCode('99999')).rejects.toThrow(/PHONE_CODE_INVALID/);
    expect((await svc.status()).state).toBe('disconnected');
    expect(await secrets.get(TELEGRAM_SESSION_SECRET)).toBeNull();
  });
});

type FakeClient = TelegramClientLike & {
  sent: Array<Record<string, string>>;
  messages: Array<{ id: number; message: string; date: number }>;
  disconnected: number;
};

/** A GramJS stand-in: code 11111, 2FA password "secret", sends numbered from 101. */
function fakeClient(): FakeClient {
  let next = 101;
  const c: FakeClient = {
    sent: [],
    messages: [],
    disconnected: 0,
    connect: async () => {},
    disconnect: async () => {
      c.disconnected++;
    },
    async start(cb) {
      await cb.phoneNumber();
      const code = await cb.phoneCode();
      if (code !== '11111') {
        const err = new Error('PHONE_CODE_INVALID');
        await cb.onError(err);
        throw err;
      }
      const pw = await cb.password('pet');
      if (pw !== 'secret') throw new Error('PASSWORD_HASH_INVALID');
    },
    getMe: async () => ({ username: 'roman', firstName: 'Roman', phone: '306900000000' }),
    getMessages: async () => c.messages,
    async sendMessage(peer, o) {
      c.sent.push({ peer, message: o.message });
      return { id: next++ };
    },
    async sendFile(peer, o) {
      c.sent.push({ peer, file: o.file, caption: o.caption ?? '' });
      return { id: next++ };
    },
    saveSession: () => 'session-string',
  };
  return c;
}
