// Correcting an application's status by hand: the allowed moves, the refusals, the manual
// event, the reached-interview timestamps, and that nothing is delivered.
import { Code, ConnectError } from '@connectrpc/connect';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applications, events, postings, tasks } from '../src/db/schema.ts';
import { refuseStage, setApplicationStage } from '../src/domain/applications/manual-stage.ts';
import { ApplicationStage } from '../src/gen/applyant/v1/applyant_pb.js';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { applicationRpcs } from '../src/rpc/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

describe('setting an application status by hand', () => {
  let t: TempDb;
  let bus: EventBus;
  const now = new Date('2026-09-30T10:00:00Z');

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
  });
  afterEach(() => t.cleanup());

  const addApp = (stage: (typeof applications.$inferInsert)['stage'], n = 1) => {
    const posting = t.db
      .insert(postings)
      .values({ stage: 'scored', canonicalUrl: `https://jobs.example.com/${n}`, title: 'Engineer' })
      .returning()
      .get();
    return t.db.insert(applications).values({ postingId: posting.id, stage }).returning().get();
  };
  const set = (id: number, to: Parameters<typeof setApplicationStage>[2]) =>
    runInTx(t.db, bus, { now }, (tx) => setApplicationStage(tx, id, to));
  const app = (id: number) => t.db.select().from(applications).where(eq(applications.id, id)).get();

  it('refuses what cannot be true', () => {
    expect(refuseStage({ id: 1, stage: 'ready_for_review' }, 'interview', false)).toMatch(
      /hasn't been sent \(ready_for_review\), so it can't be interview; set it to applied first/,
    );
    expect(refuseStage({ id: 1, stage: 'applied' }, 'approved', false)).toMatch(
      /isn't a status you set by hand/,
    );
    expect(refuseStage({ id: 1, stage: 'applied' }, 'applied', false)).toMatch(/already applied/);
    expect(refuseStage({ id: 1, stage: 'approved' }, 'applied', true)).toMatch(/being delivered/);
    expect(refuseStage({ id: 1, stage: 'preparing' }, 'applied', false)).toMatch(/being prepared/);
    expect(refuseStage({ id: 1, stage: 'ready_for_review' }, 'applied', false)).toBeNull();
    expect(refuseStage({ id: 1, stage: 'rejected' }, 'interview', false)).toBeNull();
    expect(refuseStage({ id: 1, stage: 'offer' }, 'withdrawn', false)).toBeNull();
  });

  it('moves it, records a manual event, keeps reached interview, never delivers', () => {
    const a = addApp('ready_for_review');
    // Sent outside Applyant.
    expect(set(a.id, 'applied')).toMatchObject({ stage: 'applied', appliedAt: now });
    set(a.id, 'interview');
    expect(app(a.id)).toMatchObject({ stage: 'interview', interviewAt: now, offerAt: null });
    // A later rejection keeps that it reached interview.
    set(a.id, 'rejected');
    expect(app(a.id)).toMatchObject({ stage: 'rejected', interviewAt: now });
    // Undoing a misread reply goes back to applied and forgets the interview.
    set(a.id, 'applied');
    expect(app(a.id)).toMatchObject({ stage: 'applied', interviewAt: null, appliedAt: now });
    set(a.id, 'withdrawn');
    expect(app(a.id)?.stage).toBe('withdrawn');

    const stageEvents = t.db
      .select()
      .from(events)
      .where(eq(events.kind, 'application.stage'))
      .all()
      .map((e) => e.message);
    expect(stageEvents).toEqual([
      `application ${a.id}: ready_for_review → applied (set by hand)`,
      `application ${a.id}: applied → interview (set by hand)`,
      `application ${a.id}: interview → rejected (set by hand)`,
      `application ${a.id}: rejected → applied (set by hand)`,
      `application ${a.id}: applied → withdrawn (set by hand)`,
    ]);
    expect(t.db.select().from(tasks).all()).toEqual([]);
  });

  it('SetApplicationStage: FailedPrecondition with the reason; refused while delivering', () => {
    const rpc = applicationRpcs({ db: t.db, bus, now: () => now }) as Required<
      ReturnType<typeof applicationRpcs>
    >;
    const a = addApp('ready_for_review', 1);
    const call = (id: number, stage: ApplicationStage) => {
      try {
        rpc.setApplicationStage({ applicationId: BigInt(id), stage } as never, {} as never);
        return null;
      } catch (err) {
        return err as ConnectError;
      }
    };
    const refused = call(a.id, ApplicationStage.OFFER);
    expect(refused?.code).toBe(Code.FailedPrecondition);
    expect(refused?.rawMessage).toMatch(/hasn't been sent/);

    const approved = addApp('approved', 2);
    runInTx(t.db, bus, { now }, (tx) => tx.enqueue('deliver_application', approved.id));
    expect(call(approved.id, ApplicationStage.APPLIED)?.rawMessage).toMatch(/being delivered/);

    expect(call(a.id, ApplicationStage.APPLIED)).toBeNull();
    expect(call(a.id, ApplicationStage.WITHDRAWN)).toBeNull();
    expect(app(a.id)?.stage).toBe('withdrawn');
    expect(call(999, ApplicationStage.APPLIED)?.code).toBe(Code.NotFound);
    expect(call(a.id, ApplicationStage.UNSPECIFIED)).toBeInstanceOf(ConnectError);
  });
});
