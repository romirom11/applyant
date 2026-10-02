// Interview invites → Google Calendar, against a local fake of the Calendar API (the two
// endpoints used). The time comes from the invite's .ics; the event is linked to the
// application and the company; re-syncs, retries and a second assignment never duplicate it;
// an event the candidate deleted is never made again.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applications, emails, mailboxes, postings, tasks } from '../src/db/schema.ts';
import { interviewEvent } from '../src/domain/applications/interview-event.ts';
import { assignEmail, syncMail } from '../src/domain/applications/mail-status.ts';
import { eventIdFor, GoogleCalendar, parseInvite } from '../src/integrations/gcal.ts';
import { parseMessage } from '../src/integrations/mailbox.ts';
import type { ProviderRequest } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { loadRouting } from '../src/models/roles.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Task } from '../src/queue/types.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { testDeps } from './helpers/deps.ts';
import { FakeMailbox, fakeMail } from './helpers/mail.ts';

const NOW = new Date('2026-09-29T10:00:00Z');

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:abc-123@helixlabs.io',
  'DTSTART;TZID=Europe/Berlin:20261007T140000',
  'DTEND;TZID=Europe/Berlin:20261007T144500',
  'SUMMARY:Helix Labs \\, technical interview',
  'LOCATION:https://meet.example/helix-',
  ' abc',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

interface FakeCalendar {
  origin: string;
  server: Server;
  events: Map<string, Record<string, unknown>>;
  inserts: number;
  auth: string[];
}

async function fakeCalendar(): Promise<FakeCalendar> {
  const cal: FakeCalendar = {
    origin: '',
    server: null as never,
    events: new Map(),
    inserts: 0,
    auth: [],
  };
  cal.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      cal.auth.push(String(req.headers.authorization));
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/calendars/primary/events' && req.method === 'POST') {
        cal.inserts++;
        const ev = JSON.parse(body) as Record<string, unknown>;
        const id = String(ev.id);
        if (!/^[0-9a-v]{5,1024}$/.test(id)) return send(400, { error: { message: 'Invalid id' } });
        if (cal.events.has(id))
          return send(409, { error: { message: 'The requested identifier already exists.' } });
        const stored = { ...ev, status: 'confirmed', htmlLink: `https://calendar.example/e/${id}` };
        cal.events.set(id, stored);
        return send(200, stored);
      }
      const m = u.pathname.match(/^\/calendars\/primary\/events\/(\w+)$/);
      if (m?.[1] && req.method === 'GET') {
        const ev = cal.events.get(m[1]);
        return ev ? send(200, ev) : send(404, { error: { message: 'Not Found' } });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => cal.server.listen(0, '127.0.0.1', r));
  cal.origin = `http://127.0.0.1:${(cal.server.address() as AddressInfo).port}`;
  return cal;
}

describe('invites', () => {
  it('reads time, place and title from an .ics (TZID, UTC, all-day, no end)', () => {
    expect(parseInvite(ICS)).toEqual({
      start: { dateTime: '2026-10-07T14:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-10-07T14:45:00', timeZone: 'Europe/Berlin' },
      summary: 'Helix Labs , technical interview',
      location: 'https://meet.example/helix-abc',
      uid: 'abc-123@helixlabs.io',
    });
    const utc = parseInvite('BEGIN:VEVENT\nDTSTART:20261007T120000Z\nEND:VEVENT');
    expect(utc?.start).toEqual({ dateTime: '2026-10-07T12:00:00Z' });
    expect(utc?.end).toEqual({ dateTime: '2026-10-07T13:00:00Z' });
    const day = parseInvite('BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261007\nEND:VEVENT');
    expect(day?.start).toEqual({ date: '2026-10-07' });
    expect(day?.end).toEqual({ date: '2026-10-08' });
  });

  it('ignores cancellations, missing times and zones Google cannot read', () => {
    expect(parseInvite(null)).toBeNull();
    expect(parseInvite(ICS.replace('METHOD:REQUEST', 'METHOD:CANCEL'))).toBeNull();
    expect(parseInvite('BEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT')).toBeNull();
    expect(
      parseInvite('BEGIN:VEVENT\nDTSTART;TZID=W. Europe Standard Time:20261007T140000\nEND:VEVENT'),
    ).toBeNull();
  });

  it('finds the .ics in an incoming message', async () => {
    const raw = await new MailComposer({
      from: 'jobs@helixlabs.io',
      to: 'me@example.org',
      subject: 'Invitation: technical interview',
      text: 'See the invite.',
      icalEvent: { method: 'REQUEST', content: ICS },
    })
      .compile()
      .build();
    const msg = await parseMessage('1', raw);
    expect(parseInvite(msg.calendar)?.start.dateTime).toBe('2026-10-07T14:00:00');
    const plain = await parseMessage('2', 'From: a@b.c\r\nSubject: hi\r\n\r\nhello');
    expect(plain.calendar).toBeNull();
  });

  it('event ids are valid base32hex and stable per email', () => {
    const id = eventIdFor('email:1:abc');
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(eventIdFor('email:1:abc')).toBe(id);
    expect(eventIdFor('email:1:abd')).not.toBe(id);
  });
});

describe('interview events', () => {
  let t: TempDb;
  let bus: EventBus;
  let cal: FakeCalendar;
  let box: FakeMailbox;
  let mailboxId: number;
  let calendarOn: boolean;

  const auth = { accessToken: async () => 'at-cal' };
  const mail = () =>
    fakeMail(box, {
      calendar: async () => (calendarOn ? new GoogleCalendar({ auth, api: cal.origin }) : null),
    });

  function addApp(company: string, url: string, title: string) {
    const p = t.db
      .insert(postings)
      .values({ stage: 'scored', canonicalUrl: url, title, company })
      .returning()
      .get();
    return t.db
      .insert(applications)
      .values({ postingId: p.id, stage: 'applied', appliedAt: NOW })
      .returning()
      .get();
  }

  const queued = () =>
    t.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.kind, 'interview_event'), eq(tasks.status, 'queued')))
      .all();

  async function runEvent(emailId: number, attempts = 0) {
    const task: Task<'interview_event'> = {
      id: 1,
      kind: 'interview_event',
      entityId: emailId,
      runId: null,
      provider: null,
      attempts,
    };
    const deps = { ...testDeps({ dir: t.dir, db: t.db }), mail: mail() };
    const outcome = await interviewEvent(task, {
      deps,
      read: t.read,
      signal: new AbortController().signal,
      progress: () => {},
      record: () => true,
      now: () => NOW,
    });
    if (outcome.kind === 'done') runInTx(t.db, bus, { now: NOW }, (tx) => outcome.commit(tx));
    return outcome;
  }

  async function sync() {
    const apple = new FakeProvider('apple', [], (req: ProviderRequest) => {
      const m = String(req.input?.subject ?? '').match(/\[(\w+) ([\d.]+)\]/);
      return {
        kind: 'ok' as const,
        output: { label: m?.[1] ?? 'unknown', confidence: Number(m?.[2] ?? 0), language: 'en' },
        model: 'foundation-models',
        usage: null,
      };
    });
    const deps = {
      ...testDeps({ dir: t.dir, db: t.db, providers: [apple], routing: () => loadRouting(t.read) }),
      mail: mail(),
    };
    const task: Task<'sync_mail'> = {
      id: 1,
      kind: 'sync_mail',
      entityId: mailboxId,
      runId: null,
      provider: 'apple',
      attempts: 0,
    };
    const outcome = await syncMail(task, {
      deps,
      read: t.read,
      signal: new AbortController().signal,
      progress: () => {},
      record: () => true,
      now: () => NOW,
    });
    if (outcome.kind === 'done') runInTx(t.db, bus, { now: NOW }, (tx) => outcome.commit(tx));
  }

  const emailBySubject = (s: string) =>
    t.db
      .select()
      .from(emails)
      .all()
      .find((e) => e.subject.includes(s));

  beforeEach(async () => {
    t = tempDb();
    bus = new EventBus();
    cal = await fakeCalendar();
    calendarOn = true;
    box = new FakeMailbox('me@gmail.com');
    mailboxId = t.db
      .insert(mailboxes)
      .values({ kind: 'gmail', address: 'me@gmail.com', settings: {}, status: 'connected' })
      .returning()
      .get().id;
  });
  afterEach(async () => {
    await new Promise<void>((r) => cal.server.close(() => r()));
    t.cleanup();
  });

  it('a matched invite becomes one event, linked to the application and company', async () => {
    const app = addApp('Helix Labs GmbH', 'https://jobs.helixlabs.io/ai-engineer', 'AI Engineer');
    box.add({
      fromAddress: 'jobs@helixlabs.io',
      subject: 'Interview for AI Engineer [interview 0.9]',
      text: 'We would like to talk. The invite is attached.',
      calendar: ICS,
      date: NOW,
    });
    await sync();
    const email = emailBySubject('Interview for AI Engineer');
    expect(email?.applicationId).toBe(app.id);
    expect(email?.invite?.start).toEqual({
      dateTime: '2026-10-07T14:00:00',
      timeZone: 'Europe/Berlin',
    });
    expect(queued().map((q) => q.entityId)).toEqual([email?.id]);

    await runEvent(email?.id ?? 0);
    expect(cal.events.size).toBe(1);
    const [ev] = [...cal.events.values()];
    expect(ev?.summary).toBe('Interview: AI Engineer at Helix Labs GmbH');
    expect(ev?.start).toEqual({ dateTime: '2026-10-07T14:00:00', timeZone: 'Europe/Berlin' });
    expect(ev?.location).toBe('https://meet.example/helix-abc');
    expect(String(ev?.description)).toContain(
      `Application ${app.id} in Applyant · Helix Labs GmbH`,
    );
    expect(ev?.extendedProperties).toEqual({
      private: {
        applyantApplicationId: String(app.id),
        applyantEmailId: String(email?.id),
        applyantCompany: 'Helix Labs GmbH',
      },
    });
    expect(cal.auth.every((a) => a === 'Bearer at-cal')).toBe(true);
    const after = emailBySubject('Interview for AI Engineer');
    expect(after?.calendar).toMatchObject({ status: 'created', eventId: ev?.id });
    expect(after?.calendar?.link).toContain('calendar.example');

    // Run again (a retry after a lost lease, or a queued duplicate): nothing new.
    await runEvent(email?.id ?? 0);
    expect(cal.inserts).toBe(1);
    // A re-sync of the same mail stores nothing and queues nothing.
    runInTx(t.db, bus, { now: NOW }, (tx) => tx.db.delete(tasks).run());
    await sync();
    expect(queued()).toEqual([]);
    expect(cal.events.size).toBe(1);
  });

  it('an event made before the email recorded it is found, not duplicated', async () => {
    addApp('Helix Labs GmbH', 'https://jobs.helixlabs.io/ai-engineer', 'AI Engineer');
    box.add({
      fromAddress: 'jobs@helixlabs.io',
      subject: 'Interview [interview 0.9]',
      text: 'Invite attached.',
      calendar: ICS,
      date: NOW,
    });
    await sync();
    const email = emailBySubject('Interview');
    // The insert went through but the commit was lost: clear what the email knows.
    await runEvent(email?.id ?? 0);
    runInTx(t.db, bus, { now: NOW }, (tx) =>
      tx.db
        .update(emails)
        .set({ calendar: null })
        .where(eq(emails.id, email?.id ?? 0))
        .run(),
    );
    await runEvent(email?.id ?? 0);
    expect(cal.inserts).toBe(2);
    expect(cal.events.size).toBe(1);
    expect(emailBySubject('Interview')?.calendar).toMatchObject({
      status: 'created',
      note: 'already on the calendar',
    });

    // Deleted by the candidate on their calendar: never made again.
    const [id] = [...cal.events.keys()];
    cal.events.set(id ?? '', { ...cal.events.get(id ?? ''), status: 'cancelled' });
    runInTx(t.db, bus, { now: NOW }, (tx) =>
      tx.db
        .update(emails)
        .set({ calendar: null })
        .where(eq(emails.id, email?.id ?? 0))
        .run(),
    );
    await runEvent(email?.id ?? 0);
    expect(emailBySubject('Interview')?.calendar?.status).toBe('cancelled');
    expect(cal.events.get(id ?? '')?.status).toBe('cancelled');
  });

  it('an invite assigned from the ask queue gets its event; no time or no Google → skipped', async () => {
    const a = addApp(
      'Tallyhall',
      'https://boards.greenhouse.io/tallyhall/jobs/1',
      'Founding Engineer',
    );
    const b = addApp(
      'Tallyhall',
      'https://boards.greenhouse.io/tallyhall/jobs/2',
      'Staff Engineer',
    );
    box.add({
      fromAddress: 'no-reply@greenhouse.io',
      subject: 'Tallyhall: next steps [interview 0.9]',
      text: 'Tallyhall would like to meet you.',
      calendar: ICS,
      date: NOW,
    });
    box.add({
      fromAddress: 'no-reply@greenhouse.io',
      subject: 'Tallyhall: pick a slot [interview 0.9]',
      text: 'Tallyhall would like to meet you. Pick a time: https://cal.example/tallyhall',
      date: NOW,
    });
    await sync();
    // Two Tallyhall applications: asked about, so no event yet.
    expect(queued()).toEqual([]);
    const withIcs = emailBySubject('next steps');
    const noTime = emailBySubject('pick a slot');
    runInTx(t.db, bus, { now: NOW }, (tx) => {
      assignEmail(tx, withIcs?.id ?? 0, a.id, null);
      assignEmail(tx, noTime?.id ?? 0, b.id, null);
    });
    expect(
      queued()
        .map((q) => q.entityId)
        .sort(),
    ).toEqual([withIcs?.id, noTime?.id].sort());
    await runEvent(withIcs?.id ?? 0);
    await runEvent(noTime?.id ?? 0);
    expect(cal.events.size).toBe(1);
    expect([...cal.events.values()][0]?.summary).toBe('Interview: Founding Engineer at Tallyhall');
    expect(emailBySubject('pick a slot')?.calendar).toMatchObject({
      status: 'skipped',
      note: 'the email has no time (no calendar invite attached)',
    });

    // Assigned again (the candidate corrects nothing but presses it twice): no second event.
    runInTx(t.db, bus, { now: NOW }, (tx) => {
      tx.db.delete(tasks).run();
      assignEmail(tx, withIcs?.id ?? 0, a.id, null);
    });
    expect(queued()).toEqual([]);

    // An IMAP mailbox (no Google account): skipped, nothing sent anywhere.
    calendarOn = false;
    runInTx(t.db, bus, { now: NOW }, (tx) =>
      tx.db
        .update(emails)
        .set({ calendar: null })
        .where(eq(emails.id, noTime?.id ?? 0))
        .run(),
    );
    const before = cal.inserts;
    await runEvent(noTime?.id ?? 0);
    expect(cal.inserts).toBe(before);
    expect(emailBySubject('pick a slot')?.calendar?.note).toMatch(/no Google account/);
  });

  it('a Calendar error is retried, then recorded', async () => {
    addApp('Helix Labs GmbH', 'https://jobs.helixlabs.io/ai-engineer', 'AI Engineer');
    box.add({
      fromAddress: 'jobs@helixlabs.io',
      subject: 'Interview [interview 0.9]',
      text: 'Invite attached.',
      calendar: ICS,
      date: NOW,
    });
    await sync();
    const email = emailBySubject('Interview');
    await new Promise<void>((r) => cal.server.close(() => r()));
    cal.server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"backend error"}}');
    });
    await new Promise<void>((r) =>
      cal.server.listen(Number(new URL(cal.origin).port), '127.0.0.1', r),
    );
    expect((await runEvent(email?.id ?? 0, 0)).kind).toBe('retry');
    const last = await runEvent(email?.id ?? 0, 2);
    expect(last.kind).toBe('done');
    expect(emailBySubject('Interview')?.calendar).toMatchObject({ status: 'skipped' });
    expect(emailBySubject('Interview')?.calendar?.note).toMatch(/HTTP 503/);
  });
});
