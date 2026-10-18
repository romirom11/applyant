// The ATS index grows from what searches match: a job search across every company finds a job
// that fits, and its company's board joins the index, read at the next crawl and then every
// few hours. So does the board behind any matched job page (an HN post, a RemoteOK apply link)
// and behind a verified posting's apply link. The watch list doesn't grow this way any more.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atsCompanies, postings, searchSources } from '../src/db/schema.ts';
import { knowBoards } from '../src/domain/search/ats-index/store.ts';
import { setCompanyEnabled } from '../src/domain/search/ats-index/views.ts';
import { boardOf, MAX_SEEN_BOARDS_PER_RUN, watchSeen } from '../src/domain/search/watchlist.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { recordedFetch, roleReplies, type SearchHarness, searchHarness } from './helpers/search.ts';

const now = new Date('2026-10-17T12:00:00Z');

describe('boards behind matched jobs', () => {
  let t: TempDb;
  let h: SearchHarness | null;
  beforeEach(() => {
    t = tempDb();
    h = null;
  });
  afterEach(async () => {
    await h?.stop();
    t.cleanup();
  });

  const indexed = () =>
    t.db
      .select()
      .from(atsCompanies)
      .orderBy(atsCompanies.id)
      .all()
      .map((c) => ({
        board: `${c.ats}:${c.token}`,
        name: c.name,
        via: c.foundVia,
        note: c.foundNote,
        status: c.status,
      }));
  const agentSources = () =>
    t.db.select().from(searchSources).where(eq(searchSources.origin, 'agent')).all();

  it('a job search finds jobs at companies nobody knew: they become postings, their boards join the index', async () => {
    h = searchHarness(t, { fetch: recordedFetch(roleReplies()), now: () => now });
    const run = await h.run({
      name: 'Laravel',
      queries: ['laravel -junior'],
      sources: ['board:smartrecruiters-search'],
    });
    const row = h.runRow(run);
    expect(row?.results[0]).toMatchObject({
      sourceKey: 'board:smartrecruiters-search',
      listed: 5,
      matched: 5,
      added: 5,
      complete: false,
    });
    expect(row?.note).toBe('5 listed · 5 matched · 5 new · 4 boards joined the ATS index');
    expect(
      t.db
        .select()
        .from(postings)
        .all()
        .map((p) => p.canonicalUrl),
    ).toContain('https://jobs.smartrecruiters.com/JobsForHumanity/744000074527197');
    expect(indexed()).toEqual([
      {
        board: 'smartrecruiters:ALTEN',
        name: 'ALTEN',
        via: 'smartrecruiters-search',
        note: 'has "Développeur Full Stack Vue.js / PHP Laravel" ("Laravel" matched it on SmartRecruiters job search · every company)',
        status: 'new',
      },
      expect.objectContaining({ board: 'smartrecruiters:SQLI1', name: 'SQLI' }),
      expect.objectContaining({
        board: 'smartrecruiters:JobsForHumanity',
        name: 'Jobs for Humanity',
      }),
      expect.objectContaining({ board: 'smartrecruiters:Shebaxyz3', name: 'Sheba.xyz' }),
    ]);
    // Read at the next crawl; the watch list stays the candidate's.
    expect(
      t.db
        .select()
        .from(atsCompanies)
        .all()
        .map((c) => c.nextReadAt),
    ).toEqual(Array(4).fill(now));
    expect(agentSources()).toEqual([]);

    // The next run finds them known already.
    const again = await h.again(1);
    expect(h.runRow(again)?.note).toBe('5 listed · 5 matched · 0 new');
    expect(indexed()).toHaveLength(4);
  });

  it("a matched job page's board, from any source; the board a listing came from isn't seen again", async () => {
    h = searchHarness(t, {
      fetch: recordedFetch({
        'https://remoteok.com/api': [
          { legal: 'notice' },
          {
            id: '1',
            position: 'Senior AI Engineer',
            company: 'Acme AI',
            url: 'https://remoteok.com/remote-jobs/1',
            apply_url: 'https://jobs.ashbyhq.com/acme-ai/7458d4e9-da2e-47bd-98cb-adfda43d42b2',
          },
          {
            id: '2',
            position: 'AI Engineer',
            company: 'Blog Co',
            url: 'https://remoteok.com/remote-jobs/2',
            // A link to an ATS host that isn't a job page: no board.
            apply_url: 'https://www.greenhouse.io/blog/hiring',
          },
          {
            id: '3',
            position: 'Office Manager',
            company: 'Elsewhere',
            url: 'https://remoteok.com/remote-jobs/3',
            apply_url: 'https://jobs.lever.co/elsewhere/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7',
          },
        ],
      }),
      now: () => now,
    });
    await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['board:remoteok'] });
    // Only the job that matched: an office manager's board isn't one for this candidate.
    expect(indexed()).toEqual([
      {
        board: 'ashby:acme-ai',
        name: 'Acme AI',
        via: 'posting',
        note: 'has "Senior AI Engineer" ("AI" matched it on RemoteOK)',
        status: 'new',
      },
    ]);
  });

  it('at most MAX_SEEN_BOARDS_PER_RUN new ones at once; one the index knows (in any case, on or off) stays as it is', () => {
    const bus = new EventBus();
    const [acme, offco] = runInTx(t.db, bus, { now }, (tx) =>
      knowBoards(tx, [
        { board: { ats: 'lever', token: 'Acme' }, via: 'common-crawl' },
        { board: { ats: 'greenhouse', token: 'offco' }, via: 'common-crawl' },
      ]),
    );
    setCompanyEnabled(t.db, offco?.id ?? 0, false);
    const job = (url: string, title = 'AI Engineer') => ({
      listing: { url, applyUrl: null, title, company: null },
      where: '"AI" matched it on HN',
    });
    const added = runInTx(t.db, bus, { now }, (tx) =>
      watchSeen(tx, [
        job('https://jobs.lever.co/acme/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7'),
        job('https://job-boards.greenhouse.io/offco/jobs/123'),
        ...Array.from({ length: MAX_SEEN_BOARDS_PER_RUN + 2 }, (_, i) =>
          job(`https://job-boards.greenhouse.io/co${i}/jobs/${1000 + i}`),
        ),
      ]),
    );
    expect(added.map((c) => c.token)).toEqual(
      Array.from({ length: MAX_SEEN_BOARDS_PER_RUN }, (_, i) => `co${i}`),
    );
    const byId = (id: number) =>
      t.db.select().from(atsCompanies).where(eq(atsCompanies.id, id)).get();
    expect(byId(acme?.id ?? 0)).toMatchObject({ token: 'Acme', foundVia: 'common-crawl' });
    expect(byId(offco?.id ?? 0)?.enabled).toBe(false);
  });

  it("a verified posting's apply link on an ATS board (a LinkedIn job applying through Greenhouse)", () => {
    const bus = new EventBus();
    // What verify_posting passes once a posting is live.
    const added = runInTx(t.db, bus, { now }, (tx) =>
      watchSeen(
        tx,
        [
          {
            listing: {
              url: 'https://www.linkedin.com/jobs/view/4100000001',
              applyUrl: 'https://job-boards.eu.greenhouse.io/acmeai/jobs/4001234?gh_src=li',
              title: 'Staff AI Engineer',
              company: 'Acme AI',
            },
            where: 'posting 7 applies there',
          },
        ],
        1,
      ),
    );
    expect(added.map((c) => [c.ats, c.token, c.name, c.foundNote])).toEqual([
      ['greenhouse', 'acmeai', 'Acme AI', 'has "Staff AI Engineer" (posting 7 applies there)'],
    ]);
  });

  it('the board a listing is on: its reader names it, or its job page or apply link shows it', () => {
    const l = (url: string, applyUrl: string | null = null) => ({ url, applyUrl });
    expect(boardOf({ ...l('https://apply.workable.com/j/996BE00528'), board: null })).toBeNull();
    expect(
      boardOf({
        ...l('https://apply.workable.com/j/996BE00528'),
        board: { ats: 'workable', token: 'intetics-2' },
      }),
    ).toEqual({ ats: 'workable', token: 'intetics-2' });
    expect(
      boardOf(
        l(
          'https://remoteok.com/remote-jobs/1',
          'https://jobs.lever.co/acme/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7/apply',
        ),
      ),
    ).toEqual({ ats: 'lever', token: 'acme' });
    expect(boardOf(l('https://jobs.smartrecruiters.com/Acme/744000074527197'))).toEqual({
      ats: 'smartrecruiters',
      token: 'Acme',
    });
    expect(boardOf(l('https://job-boards.greenhouse.io/acme'))).toBeNull();
  });
});
