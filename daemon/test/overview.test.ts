// Overview: the funnel and the PRD metrics from a hand-made history, per window; the review
// clock starts when GetApplication opens an application waiting for review.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerSentences, answers, applications, facts, postings } from '../src/db/schema.ts';
import { computeOverview, median, type Overview } from '../src/domain/overview.ts';
import { OverviewWindow } from '../src/gen/applyant/v1/applyant_pb.js';
import { EventBus } from '../src/queue/events.ts';
import { overviewRpcs } from '../src/rpc/overview.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-30T12:00:00Z');
const daysAgo = (d: number, minutes = 0) =>
  new Date(now.getTime() - d * 86_400_000 + minutes * 60_000);

describe('overview', () => {
  let t: TempDb;

  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  let n = 0;
  const posting = (v: Partial<typeof postings.$inferInsert> = {}) =>
    t.db
      .insert(postings)
      .values({ stage: 'scored', canonicalUrl: `https://jobs.example.com/${++n}`, ...v })
      .returning()
      .get().id;
  const app = (postingId: number, v: Partial<typeof applications.$inferInsert>) =>
    t.db
      .insert(applications)
      .values({ postingId, stage: 'ready_for_review', ...v })
      .returning()
      .get().id;
  const fact = (
    status: 'confirmed' | 'rejected',
    origin: 'extracted' | 'review_edit' = 'extracted',
    createdAt = daysAgo(1),
  ) =>
    t.db
      .insert(facts)
      .values({ text: `fact ${++n}`, kind: 'skill', status, origin, createdAt })
      .returning()
      .get().id;
  const sentence = (applicationId: number, flag: string, factIds: number[]) => {
    const a = t.db
      .insert(answers)
      .values({
        applicationId,
        questionRef: `q${++n}`,
        question: 'Why us?',
        kind: 'text',
        status: 'answered',
      })
      .returning()
      .get();
    t.db.insert(answerSentences).values({ answerId: a.id, idx: 0, text: 'x', factIds, flag }).run();
  };
  const metric = (o: Overview, key: string) => o.metrics.find((m) => m.key === key);
  const funnel = (o: Overview) => Object.fromEntries(o.funnel.map((s) => [s.key, s.count]));

  const seed = () => {
    const recent = { firstSeenAt: daysAgo(3), verifiedAt: daysAgo(3) };
    // Found, never verified; failed verification.
    posting({ stage: 'found', firstSeenAt: daysAgo(3) });
    posting({ stage: 'failed_verification', ...recent });
    // Scored below the threshold, not decided.
    posting({ ...recent, score: 40 });
    // Skipped from the shortlist (scored 85 ≥ 80).
    posting({
      ...recent,
      score: 85,
      decision: 'skipped',
      decidedAt: daysAgo(2),
      formStatus: 'no_form',
    });
    // Interested, application preparing.
    const p1 = posting({
      ...recent,
      score: 60,
      decision: 'interested',
      decidedAt: daysAgo(2),
      formStatus: 'verified',
    });
    app(p1, { stage: 'preparing' });
    // Reviewed in 10 minutes, approved, applied, interviewed, then rejected.
    const p2 = posting({ ...recent, score: 90, formStatus: 'verified' });
    const a2 = app(p2, {
      stage: 'rejected',
      preparedAt: daysAgo(2),
      reviewStartedAt: daysAgo(2),
      approvedAt: daysAgo(2, 10),
      appliedAt: daysAgo(2, 20),
      interviewAt: daysAgo(1),
    });
    const ok = fact('confirmed');
    sentence(a2, 'none', [ok]);
    // Reviewed in 30 minutes, applied by email; one sent claim cites a fact since rejected.
    const p3 = posting({ ...recent, score: 88, formStatus: 'email' });
    const a3 = app(p3, {
      stage: 'applied',
      preparedAt: daysAgo(2),
      reviewStartedAt: daysAgo(2),
      approvedAt: daysAgo(2, 30),
      appliedAt: daysAgo(2, 40),
    });
    sentence(a3, 'none', [ok]);
    sentence(a3, 'none', [fact('rejected')]);
    fact('confirmed', 'review_edit');
    // An old one (40 days ago): applied with an offer.
    const old = posting({
      firstSeenAt: daysAgo(40),
      verifiedAt: daysAgo(40),
      score: 95,
      formStatus: 'verified',
    });
    app(old, {
      stage: 'offer',
      preparedAt: daysAgo(40),
      approvedAt: daysAgo(40),
      appliedAt: daysAgo(40),
      interviewAt: daysAgo(35),
      offerAt: daysAgo(30),
    });
  };

  it('computes the funnel and the metrics over 7 days', () => {
    seed();
    const o = computeOverview(t.db, '7d', now);
    expect(o.since).toEqual(daysAgo(7));
    expect(funnel(o)).toEqual({
      found: 7,
      verified: 5,
      interested: 3,
      prepared: 2,
      approved: 2,
      applied: 2,
      interview: 1,
      offer: 0,
    });
    // Shortlisted and read: no_form, verified, verified, email → 3 of 4 live.
    expect(metric(o, 'live_forms')).toMatchObject({
      ratio: { numerator: 3, denominator: 4, ratio: 0.75 },
      met: false,
      display: '75% · 3 of 4',
    });
    // Decided: skipped, interested, approved, approved → 3 of 4.
    expect(metric(o, 'interested')).toMatchObject({ value: 0.75, met: true });
    // Reviews of 10 and 30 minutes → median 20.
    expect(metric(o, 'review_time')).toMatchObject({
      value: 20,
      met: false,
      display: '20 min median · 2 reviews',
    });
    expect(metric(o, 'unsupported_claims')).toMatchObject({
      value: 1,
      met: false,
      display: '1 of 3 sent · 1 corrected in review',
    });
    expect(metric(o, 'applications_per_week')).toMatchObject({
      value: 2,
      display: '2.0 / week · 2 sent',
    });
    expect(metric(o, 'interview_rate')).toMatchObject({ value: 0.5, met: null });
  });

  it('all time takes in the old application; an empty window has no data, not failures', () => {
    seed();
    const all = computeOverview(t.db, 'all', now);
    expect(all.since).toBeNull();
    expect(funnel(all)).toMatchObject({ found: 8, applied: 3, interview: 2, offer: 1 });
    expect(metric(all, 'interview_rate')?.ratio).toMatchObject({ numerator: 2, denominator: 3 });
    // 3 sent over the 40 days since the first.
    expect(metric(all, 'applications_per_week')?.value).toBeCloseTo(3 / (40 / 7));

    t.db.delete(applications).run();
    t.db.delete(postings).run();
    const empty = computeOverview(t.db, '30d', now);
    expect(empty.funnel.every((s) => s.count === 0)).toBe(true);
    for (const key of ['live_forms', 'interested', 'review_time', 'unsupported_claims']) {
      expect(metric(empty, key)?.met).toBeNull();
    }
    expect(metric(empty, 'review_time')?.display).toBe('—');
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('GetOverview maps the window; GetApplication starts the review clock once', async () => {
    seed();
    const rpc = overviewRpcs({ db: t.db, bus: new EventBus(), now: () => now }) as Required<
      ReturnType<typeof overviewRpcs>
    >;
    const res = await rpc.getOverview(
      { window: OverviewWindow.OVERVIEW_WINDOW_ALL } as never,
      {} as never,
    );
    expect(res.window).toBe(OverviewWindow.OVERVIEW_WINDOW_ALL);
    expect(res.since).toBeUndefined();
    expect(res.funnel?.map((s) => [s.key, Number(s.count)])[0]).toEqual(['found', 8]);
    const week = await rpc.getOverview(
      {
        window: OverviewWindow.OVERVIEW_WINDOW_UNSPECIFIED,
      } as never,
      {} as never,
    );
    expect(week.window).toBe(OverviewWindow.OVERVIEW_WINDOW_30_DAYS);

    const { applicationRpcs } = await import('../src/rpc/applications.ts');
    let clock = daysAgo(0, -30);
    const apps = applicationRpcs({ db: t.db, bus: new EventBus(), now: () => clock }) as Required<
      ReturnType<typeof applicationRpcs>
    >;
    const p = posting({ firstSeenAt: daysAgo(1), score: 90 });
    const id = app(p, { stage: 'ready_for_review' });
    apps.getApplication({ id: BigInt(id) } as never, {} as never);
    const started = daysAgo(0, -30);
    clock = daysAgo(0, -20);
    apps.getApplication({ id: BigInt(id) } as never, {} as never);
    const row = t.db.select().from(applications).where(eq(applications.id, id)).get();
    expect(row?.reviewStartedAt).toEqual(started);
  });
});
