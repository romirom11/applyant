// Replies move applications on: fixture emails through the sync_mail handler, classified by a
// fake on-device classifier. Unsure or unmatched mail lands in the ask queue; mail that isn't
// about an application is never stored (or classified); email_classify never falls back to a
// cloud model unless the candidate routes it there.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApplicationStage,
  applications,
  emails,
  events,
  mailboxes,
  postings,
} from '../src/db/schema.ts';
import {
  askQueue,
  assignEmail,
  baseDomain,
  decide,
  matchEmail,
  nextStage,
  syncMail,
  trackedApplications,
} from '../src/domain/applications/mail-status.ts';
import type { ProviderRequest } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { loadRouting, setRoleRoute } from '../src/models/roles.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Task } from '../src/queue/types.ts';
import { eventToPb } from '../src/rpc/mapping.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { testDeps } from './helpers/deps.ts';
import { FakeMailbox, fakeMail } from './helpers/mail.ts';

const NOW = new Date('2026-09-29T10:00:00Z');

/** The fake on-device model: the label and confidence are written into the subject line. */
function fakeApple(): FakeProvider {
  const reply = (req: ProviderRequest) => {
    const subject = String(req.input?.subject ?? '');
    const m = subject.match(/\[(\w+) ([\d.]+)\]/);
    return {
      kind: 'ok' as const,
      output: { label: m?.[1] ?? 'unknown', confidence: Number(m?.[2] ?? 0), language: 'en' },
      model: 'foundation-models',
      usage: null,
    };
  };
  return new FakeProvider('apple', [], reply);
}

describe('mail status', () => {
  let t: TempDb;
  let bus: EventBus;
  let box: FakeMailbox;
  let mailboxId: number;

  function addApp(
    company: string,
    url: string,
    title: string,
    stage: ApplicationStage = 'applied',
  ) {
    const p = t.db
      .insert(postings)
      .values({ stage: 'scored', canonicalUrl: url, title, company })
      .returning()
      .get();
    return t.db
      .insert(applications)
      .values({ postingId: p.id, stage, appliedAt: NOW })
      .returning()
      .get();
  }

  const stageOf = (id: number) =>
    t.db.select().from(applications).where(eq(applications.id, id)).get()?.stage;

  async function sync(providers: FakeProvider[]) {
    const deps = {
      ...testDeps({ dir: t.dir, db: t.db, providers, routing: () => loadRouting(t.read) }),
      mail: fakeMail(box),
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
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done') runInTx(t.db, bus, { now: NOW }, (tx) => outcome.commit(tx));
  }

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    box = new FakeMailbox('me@example.org');
    mailboxId = t.db
      .insert(mailboxes)
      .values({ kind: 'imap', address: 'me@example.org', settings: {}, status: 'connected' })
      .returning()
      .get().id;
  });
  afterEach(() => t.cleanup());

  it('moves applications on from sure, matched replies', async () => {
    const helix = addApp('Helix Labs GmbH', 'https://jobs.helixlabs.io/ai-engineer', 'AI Engineer');
    const tally = addApp(
      'Tallyhall',
      'https://boards.greenhouse.io/tallyhall/jobs/1',
      'Founding Engineer',
    );
    const orbit = addApp('Orbit', 'https://orbit.dev/careers/backend', 'Backend Engineer');
    box.add({
      fromAddress: 'people@helixlabs.io',
      subject: 'Your application [interview 0.92]',
      text: 'We would love to invite you to a tech call next week.',
    });
    // An ATS sender, matched by the company's name.
    box.add({
      fromAddress: 'no-reply@greenhouse.io',
      fromName: 'Tallyhall Hiring',
      subject: 'Update on your application [rejection 0.9]',
      text: 'Thank you for your interest in Tallyhall. We decided not to move forward.',
    });
    // Unsure: asked about, nothing moves.
    box.add({
      fromAddress: 'talent@orbit.dev',
      subject: 'Following up [interview 0.4]',
      text: 'Quick question about your application.',
    });
    // A newsletter: never classified, never stored.
    box.add({ fromAddress: 'news@shop.example', subject: 'Sale [other 0.99]', text: 'Buy now' });

    const apple = fakeApple();
    const claude = new FakeProvider('claude');
    await sync([apple, claude]);

    expect(stageOf(helix.id)).toBe('interview');
    expect(stageOf(tally.id)).toBe('rejected');
    expect(stageOf(orbit.id)).toBe('applied');
    expect(apple.requests).toHaveLength(3);
    expect(claude.requests).toHaveLength(0);
    const rows = t.db.select().from(emails).all();
    expect(rows.map((r) => [r.fromAddress, r.status, r.label])).toEqual([
      ['people@helixlabs.io', 'matched', 'interview'],
      ['no-reply@greenhouse.io', 'matched', 'rejection'],
      ['talent@orbit.dev', 'ask', 'interview'],
    ]);
    const ask = askQueue(t.read);
    expect(ask).toHaveLength(1);
    expect(ask[0]?.candidates.map((c) => c.id)).toEqual([orbit.id]);

    // The candidate answers: it's an interview for Orbit.
    const emailId = ask[0]?.email.id ?? 0;
    runInTx(t.db, bus, { now: NOW }, (tx) => assignEmail(tx, emailId, orbit.id, 'interview'));
    expect(stageOf(orbit.id)).toBe('interview');
    expect(askQueue(t.read)).toHaveLength(0);

    // The app notifies for moves a mail sync made, not for the candidate's own answer.
    const moves = t.db
      .select()
      .from(events)
      .where(eq(events.kind, 'application.stage'))
      .all()
      .map((row) => {
        const pb = eventToPb(row);
        return pb.payload.case === 'application'
          ? [Number(pb.payload.value.applicationId), row.stage, pb.payload.value.fromMail]
          : null;
      });
    expect(moves).toEqual([
      [helix.id, 'interview', true],
      [tally.id, 'rejected', true],
      [orbit.id, 'interview', false],
    ]);

    // The cursor moved: a second sync reads nothing again.
    await sync([fakeApple()]);
    expect(t.db.select().from(emails).all()).toHaveLength(3);
  });

  it('asks about a sure label that fits no single application', async () => {
    addApp('Acme', 'https://acme.io/jobs/1', 'Backend Engineer');
    addApp('Acme', 'https://acme.io/jobs/2', 'Frontend Engineer');
    box.add({
      fromAddress: 'jobs@acme.io',
      subject: 'Your application at Acme [rejection 0.95]',
      text: 'Unfortunately we will not proceed.',
    });
    await sync([fakeApple()]);
    const [row] = t.db.select().from(emails).all();
    expect(row?.status).toBe('ask');
    expect(row?.candidates).toHaveLength(2);
    expect(
      t.db
        .select()
        .from(applications)
        .all()
        .map((a) => a.stage),
    ).toEqual(['applied', 'applied']);
  });

  it('never falls back to a cloud model: no on-device model → the ask queue', async () => {
    const app = addApp('Helix', 'https://helix.io/jobs/1', 'AI Engineer');
    box.add({
      fromAddress: 'hr@helix.io',
      subject: 'Offer [offer 0.99]',
      text: 'We are happy to offer you the role.',
    });
    const claude = new FakeProvider('claude', [], {
      output: { label: 'offer', confidence: 0.99, language: 'en' },
    });
    await sync([claude]);
    expect(claude.requests).toHaveLength(0);
    const [row] = t.db.select().from(emails).all();
    expect(row?.status).toBe('ask');
    expect(row?.classifiedBy).toBeNull();
    expect(row?.note).toMatch(/couldn't be classified/);
    expect(stageOf(app.id)).toBe('applied');
  });

  it('uses a cloud model only when the candidate routes email_classify there', async () => {
    const app = addApp('Helix', 'https://helix.io/jobs/1', 'AI Engineer');
    setRoleRoute(t.db, 'email_classify', 'claude:haiku', NOW);
    box.add({
      fromAddress: 'hr@helix.io',
      subject: 'Congratulations',
      text: 'We are happy to offer you the role.',
    });
    const claude = new FakeProvider('claude', [], {
      output: { label: 'offer', confidence: 0.95, language: 'en' },
    });
    await sync([fakeApple(), claude]);
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]?.model).toBe('haiku');
    expect(claude.requests[0]?.prompt).toContain('Congratulations');
    expect(stageOf(app.id)).toBe('offer');
    expect(t.db.select().from(emails).get()?.classifiedBy).toBe('claude:haiku');
  });

  it('matches, decides and moves by the rules', () => {
    expect(baseDomain('jobs.helixlabs.io')).toBe('helixlabs.io');
    expect(baseDomain('careers.acme.co.uk')).toBe('acme.co.uk');
    expect(nextStage('applied', 'interview')).toBe('interview');
    expect(nextStage('offer', 'interview')).toBeNull();
    expect(nextStage('interview', 'rejection')).toBe('rejected');
    expect(nextStage('approved', 'rejection')).toBeNull();
    expect(nextStage('applied', 'acknowledgement')).toBeNull();

    const app = addApp('Helix', 'https://helix.io/jobs/1', 'AI Engineer');
    const apps = trackedApplications(t.read);
    const reply = matchEmail(
      {
        key: 'x',
        messageId: null,
        inReplyTo: '<sent@me>',
        references: [],
        fromAddress: 'someone@gmail.com',
        fromName: null,
        to: [],
        subject: 'Re: Application',
        text: 'Thanks!',
        date: NOW,
      },
      apps.map((a) => ({ ...a, sentMessageId: '<sent@me>' })),
    );
    expect(reply).toMatchObject({ ids: [app.id], sure: true });
    const cls = {
      label: 'other' as const,
      confidence: 0.9,
      language: null,
      by: 'apple',
      problem: null,
    };
    expect(decide(cls, { ids: [], sure: false, strong: false, why: null }, 0.7)).toBeNull();
  });

  it('a status moves only on a strong match, and never on mail from before the application', () => {
    const app = addApp('Helix', 'https://helix.io/jobs/1', 'AI Engineer');
    const apps = trackedApplications(t.read);
    const mail = (over: Partial<Parameters<typeof matchEmail>[0]>) => ({
      key: 'k',
      messageId: null,
      inReplyTo: null,
      references: [],
      fromAddress: 'digest@jobnews.example',
      fromName: null,
      to: [],
      subject: 'This week',
      text: 'Helix is hiring again.',
      date: NOW,
      ...over,
    });
    const rejection = {
      label: 'rejection' as const,
      confidence: 0.95,
      language: null,
      by: 'apple',
      problem: null,
    };
    // The company's name in somebody else's mail: asked about, never a rejection on its own.
    const weak = matchEmail(mail({}), apps);
    expect(weak).toMatchObject({ ids: [app.id], sure: true, strong: false });
    expect(decide(rejection, weak, 0.7)).toMatchObject({ status: 'ask', applicationId: null });
    // The company's own domain is a strong match.
    const own = matchEmail(mail({ fromAddress: 'people@helix.io' }), apps);
    expect(own.strong).toBe(true);
    expect(decide(rejection, own, 0.7)).toMatchObject({ status: 'matched', applicationId: app.id });
    // Mail from a week before the application was sent isn't about it.
    const old = matchEmail(
      mail({ fromAddress: 'people@helix.io', date: new Date(NOW.getTime() - 7 * 86_400_000) }),
      apps,
    );
    expect(old.ids).toEqual([]);
    // A rejected application is still followed, and a later invite moves it on.
    expect(nextStage('rejected', 'interview')).toBe('interview');
    expect(nextStage('rejected', 'rejection')).toBeNull();
  });
});
