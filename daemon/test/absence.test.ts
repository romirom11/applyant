// A posting missing from a source is closed only when the source gave its whole list; a failed
// or partial run asks for a re-verification instead, and never closes anything.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EventRow, postings } from '../src/db/schema.ts';
import { addSource } from '../src/domain/search/sources.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { recordedFetch, type SearchHarness, searchHarness } from './helpers/search.ts';

const GH = 'https://boards-api.greenhouse.io/v1/boards/acmeai/jobs?content=true';
const job = (id: number, title: string) => ({
  id,
  title,
  company_name: 'Acme AI',
  absolute_url: `https://job-boards.greenhouse.io/acmeai/jobs/${id}`,
  location: { name: 'Remote, EU' },
  content: `&lt;p&gt;${title} at Acme AI.&lt;/p&gt;`,
});
const board = (...jobs: ReturnType<typeof job>[]) => ({ jobs, meta: { total: jobs.length } });

describe('absence from a source', () => {
  let t: TempDb;
  let h: SearchHarness;
  let clock: Date;
  let events: EventRow[];

  beforeEach(() => {
    t = tempDb();
    clock = new Date('2026-09-28T10:00:00Z');
    h = searchHarness(t, {
      fetch: recordedFetch({
        [GH]: board(job(1, 'Senior AI Engineer'), job(2, 'Staff AI Engineer')),
      }),
      now: () => clock,
    });
    events = [];
    h.bus.subscribe((e) => events.push(e));
    addSource(t.db, { kind: 'greenhouse', locator: 'acmeai' }, clock);
  });
  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  const reply = (body: object, status = 200) =>
    h.fetch.replies.set(GH, {
      status,
      body: JSON.stringify(body),
      contentType: 'application/json',
    });
  const byTitle = (title: string) => {
    const p = t.db.select().from(postings).where(eq(postings.title, title)).get();
    if (!p) throw new Error(`no posting "${title}"`);
    return p;
  };
  const later = (hours: number) => {
    clock = new Date(clock.getTime() + hours * 3_600_000);
  };
  /** As if verification and scoring had run a while ago. */
  const scoredLongAgo = (title: string) =>
    t.db
      .update(postings)
      .set({ stage: 'scored', verifiedAt: new Date(clock.getTime() - 5 * 86_400_000) })
      .where(eq(postings.id, byTitle(title).id))
      .run();
  const reverifyCount = () => h.tasksOf('verify_posting').length;

  it('a complete list without it closes the posting; listing it again reopens it', async () => {
    const first = await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['greenhouse'] });
    expect(h.runRow(first)?.results[0]).toMatchObject({
      listed: 2,
      added: 2,
      complete: true,
      closed: 0,
    });
    scoredLongAgo('Staff AI Engineer');

    reply(board(job(1, 'Senior AI Engineer')));
    later(6);
    const second = await h.again(1);
    const staff = byTitle('Staff AI Engineer');
    expect(staff.stage).toBe('closed');
    expect(staff.verifyNote).toBe(
      'closed: no longer listed on greenhouse:acmeai (its complete list)',
    );
    expect(h.links(staff.id)[0]?.closedAt).toEqual(clock);
    expect(byTitle('Senior AI Engineer').stage).toBe('found');
    expect(h.runRow(second)?.results[0]).toMatchObject({ complete: true, closed: 1, reverify: 0 });
    expect(
      events.some(
        (e) =>
          e.kind === 'posting.stage' &&
          e.stage === 'closed' &&
          e.postingId === staff.id &&
          e.runId === second,
      ),
    ).toBe(true);

    // Re-published: it opens again and is verified from scratch.
    reply(board(job(1, 'Senior AI Engineer'), job(2, 'Staff AI Engineer')));
    later(6);
    const verifies = reverifyCount();
    const third = await h.again(1);
    expect(byTitle('Staff AI Engineer').stage).toBe('found');
    expect(h.links(staff.id)[0]?.closedAt).toBeNull();
    expect(reverifyCount()).toBe(verifies + 1);
    expect(h.runRow(third)?.results[0]).toMatchObject({ reopened: 1, closed: 0 });
  });

  it('a failed run closes nothing and re-verifies what it found there (not too often)', async () => {
    await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['greenhouse'] });
    scoredLongAgo('Senior AI Engineer');
    // Staff was verified an hour ago: not asked again yet.
    t.db
      .update(postings)
      .set({ stage: 'scored', verifiedAt: new Date(clock.getTime() - 3_600_000) })
      .where(eq(postings.id, byTitle('Staff AI Engineer').id))
      .run();
    const before = reverifyCount();
    reply({ error: 'down' }, 500);
    later(6);
    const run = await h.again(1);
    expect(h.runRow(run)).toMatchObject({ status: 'failed' });
    expect(h.runRow(run)?.results[0]).toMatchObject({
      error: expect.stringMatching(/HTTP 500/),
      complete: false,
      closed: 0,
      reverify: 1,
    });
    expect(byTitle('Senior AI Engineer').stage).toBe('scored');
    expect(byTitle('Staff AI Engineer').stage).toBe('scored');
    expect(
      h
        .tasksOf('verify_posting')
        .slice(before)
        .map((x) => x.entityId),
    ).toEqual([byTitle('Senior AI Engineer').id]);
  });

  it('a partial list (a page of the board) closes nothing', async () => {
    await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['greenhouse'] });
    scoredLongAgo('Staff AI Engineer');
    reply({ jobs: [job(1, 'Senior AI Engineer')], meta: { total: 2 } });
    later(6);
    const run = await h.again(1);
    expect(h.runRow(run)?.results[0]).toMatchObject({ complete: false, closed: 0, reverify: 1 });
    expect(byTitle('Staff AI Engineer').stage).toBe('scored');
  });

  it('a posting another source still lists is re-verified, not closed', async () => {
    h.fetch.replies.set('https://remoteok.com/api', {
      body: JSON.stringify([
        { legal: 'notice' },
        {
          id: '77',
          position: 'Staff AI Engineer',
          company: 'Acme AI',
          url: 'https://remoteok.com/remote-jobs/77',
          apply_url: 'https://boards.greenhouse.io/acmeai/jobs/2',
        },
      ]),
    });
    await h.run({
      name: 'AI',
      queries: ['ai engineer'],
      sources: ['greenhouse', 'board:remoteok'],
    });
    const staff = byTitle('Staff AI Engineer');
    expect(h.links(staff.id)).toHaveLength(2);
    scoredLongAgo('Staff AI Engineer');
    reply(board(job(1, 'Senior AI Engineer')));
    later(6);
    const before = reverifyCount();
    const run = await h.again(1);
    expect(byTitle('Staff AI Engineer').stage).toBe('scored');
    expect(h.runRow(run)?.results.find((r) => r.sourceKey === 'greenhouse:acmeai')).toMatchObject({
      closed: 0,
      reverify: 1,
    });
    expect(reverifyCount()).toBe(before + 1);
  });

  it('an empty "complete" list from a board that had postings is not trusted', async () => {
    await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['greenhouse'] });
    reply(board());
    later(6);
    const run = await h.again(1);
    expect(h.runRow(run)?.results[0]).toMatchObject({ listed: 0, complete: false, closed: 0 });
    expect(h.runRow(run)?.results[0]?.note).toContain('not trusted to close postings');
    expect(byTitle('Staff AI Engineer').stage).toBe('found');
  });

  it("absence is judged on the source's whole list, not on what one strategy's queries matched", async () => {
    await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['greenhouse'] });
    // Another strategy reads the same board for other titles: the AI postings are still listed.
    const other = await h.run({
      name: 'Ops',
      queries: ['office manager'],
      sources: ['greenhouse'],
    });
    expect(h.runRow(other)?.results[0]).toMatchObject({ listed: 2, matched: 0, closed: 0 });
    expect(byTitle('Staff AI Engineer').stage).toBe('found');
  });
});
